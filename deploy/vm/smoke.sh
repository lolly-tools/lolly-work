#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Smoke-test the lolly.ing VM by IP, whatever DNS says (deploy/vm/README.md):
#
#   deploy/vm/smoke.sh <vm-ip> [--insecure]
#
# Every request goes to <vm-ip> with curl --resolve, under the real host names,
# so it works before the DNS cut. --insecure accepts Caddy's own certificate
# (push.sh --internal-tls). Exits non-zero when any check fails.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: deploy/vm/smoke.sh <vm-ip> [--insecure]" >&2; exit 1; }
# No ssh here: a <user>@ prefix, as push.sh and secrets.sh take, is dropped.
ip=${1#*@}
shift
insecure=()
while [ $# -gt 0 ]; do
  case "$1" in
    --insecure) insecure=(-k) ;;
    *) echo "smoke.sh: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

DOMAIN=lolly.ing
BASE="https://$DOMAIN"
CALLBACK="redirect_uri=https%3A%2F%2F$DOMAIN%2Fapi%2Fauth%2Fcallback"
failures=0
status=000
tmp=$(mktemp -d "${TMPDIR:-/tmp}/lolly-ing-smoke.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# fetch <name> <curl args...>: headers and body land in $tmp; sets $status.
fetch() {
  local name=$1
  shift
  status=$(curl -sS --max-time 20 ${insecure[@]+"${insecure[@]}"} \
    --resolve "$DOMAIN:443:$ip" --resolve "www.$DOMAIN:443:$ip" \
    -D "$tmp/$name.headers" -o "$tmp/$name.body" -w '%{http_code}' "$@") || status=000
}
header() { grep -i "^$2:" "$tmp/$1.headers" 2>/dev/null | tail -n 1 | cut -d' ' -f2- | tr -d '\r' || true; }
starts_with() { case "$1" in "$2"*) return 0 ;; esac; return 1; }
contains() { case "$1" in *"$2"*) return 0 ;; esac; return 1; }
# check <description> <detail> <command...>: PASS when the command succeeds.
check() {
  local description=$1 detail=$2
  shift 2
  if "$@"; then echo "PASS  $description"; else echo "FAIL  $description ($detail)"; failures=$((failures + 1)); fi
}
status_is() { [ "$status" = "$1" ]; }

fetch healthz "$BASE/healthz"
check "/healthz answers 200" "status $status" status_is 200

fetch readyz "$BASE/readyz"
check "/readyz answers 200 (database reachable, schema current, setup ready)" "status $status: $(head -c 200 "$tmp/readyz.body")" status_is 200

# With more than one identity provider the plain login URL is a chooser; with
# Google alone it redirects straight there.
chooser_ok() {
  { status_is 200 && grep -q 'Sign in with' "$tmp/chooser.body"; } \
    || { status_is 302 && starts_with "$(header chooser location)" https://accounts.google.com/; }
}
fetch chooser -H 'Accept: text/html' "$BASE/api/auth/login"
check "/api/auth/login serves the sign-in chooser (or, with one provider, redirects to Google)" "status $status" chooser_ok

google_ok() {
  local location
  location=$(header google location)
  status_is 302 && starts_with "$location" https://accounts.google.com/ && contains "$location" "$CALLBACK"
}
fetch google "$BASE/api/auth/login?idp=primary&returnTo=%2F"
location=$(header google location)
check "/api/auth/login?idp=primary redirects to Google with the $DOMAIN callback" "status $status, location ${location%%\?*}" google_ok

fetch catalog "$BASE/catalog/tools/index.json"
check "/catalog/tools/index.json refuses a signed-out caller (401)" "status $status" status_is 401

shell_ok() { status_is 200 && grep -q "const CACHE = 'lolly-" "$tmp/shell.body" && grep -q "self.addEventListener('fetch'" "$tmp/shell.body"; }
fetch shell "$BASE/sw.js"
check "/sw.js is the Lolly service worker" "status $status" shell_ok

app_ok() { status_is 200 && [ -n "$(header app strict-transport-security)" ]; }
fetch app -H 'Accept: text/html' "$BASE/"
check "/ is the Lolly app, with HSTS" "status $status" app_ok

fetch collab --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: c21va2UtdGVzdC1rZXktMTY=' "$BASE/ws/collab/smoke-test"
check "/ws/collab/<id> reaches the collab gateway, which refuses a caller without a session (401)" "status $status" status_is 401

www_ok() { status_is 308 && [ "$(header www location)" = "$BASE/t/qr-code?x=1" ]; }
fetch www "https://www.$DOMAIN/t/qr-code?x=1"
check "www.$DOMAIN redirects permanently to $DOMAIN, path and query kept (308)" "status $status, location $(header www location)" www_ok

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
