#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Smoke-test a private Work VM by IP, whatever DNS says (deploy/vm/README.md):
#
#   deploy/vm/smoke.sh <vm-ip> [--insecure] [--domain <hostname>] [--redirect <hostname>]...
#     [--idp <provider-id> --authorize-origin <https-origin>]
#
# Every request goes to <vm-ip> with curl --resolve, under the real host names,
# so it works before the DNS cut. --insecure accepts Caddy's own certificate
# (push.sh --internal-tls). Exits non-zero when any check fails.
set -euo pipefail

die() { echo "smoke.sh: $*" >&2; exit 1; }
[ $# -ge 1 ] || die "usage: deploy/vm/smoke.sh <vm-ip> [--insecure] [--domain <hostname>] [--redirect <hostname>]... [--idp <id> --authorize-origin <https-origin>]"
# No ssh here: a <user>@ prefix, as push.sh and secrets.sh take, is dropped.
ip=${1#*@}
shift
insecure=()
DOMAIN=lolly.ing
redirects=()
idp=
authorize_origin=
while [ $# -gt 0 ]; do
  case "$1" in
    --insecure) insecure=(-k) ;;
    --domain|--redirect|--idp|--authorize-origin)
      [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value"
      case "$1" in
        --domain) DOMAIN=$2 ;;
        --redirect) redirects+=("$2") ;;
        --idp) idp=$2 ;;
        --authorize-origin) authorize_origin=$2 ;;
      esac
      shift ;;

    *) echo "smoke.sh: unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

valid_domain() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] && [ ${#1} -le 253 ]
}
valid_domain "$DOMAIN" || die "--domain needs a lowercase DNS hostname"
if [ ${#redirects[@]} = 0 ] && [ "$DOMAIN" = lolly.ing ]; then redirects=(www.lolly.ing); fi
resolve_args=(--resolve "$DOMAIN:443:$ip")
for redirect in ${redirects[@]+"${redirects[@]}"}; do
  valid_domain "$redirect" || die "--redirect needs a lowercase DNS hostname"
  resolve_args+=(--resolve "$redirect:443:$ip")
done
if [ -z "$idp" ] && [ -z "$authorize_origin" ] && [ "$DOMAIN" = lolly.ing ]; then
  idp=primary
  authorize_origin=https://accounts.google.com
fi
if [ -n "$idp" ] || [ -n "$authorize_origin" ]; then
  [[ "$idp" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "set --idp and --authorize-origin together"
  [[ "$authorize_origin" =~ ^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?$ ]] || die "--authorize-origin needs a bare HTTPS origin"
fi
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
    "${resolve_args[@]}" \
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

# A chooser or password form is HTML; a single external provider may redirect.
# Custom domains check a provider only when the operator names its expectation.
chooser_ok() {
  { status_is 200 && grep -qi 'Sign in' "$tmp/chooser.body"; } \
    || { status_is 302 && starts_with "$(header chooser location)" https://; }
}
fetch chooser -H 'Accept: text/html' "$BASE/api/auth/login"
check "/api/auth/login serves sign-in HTML or an HTTPS provider redirect" "status $status" chooser_ok

provider_ok() {
  local location
  location=$(header provider location)
  status_is 302 && starts_with "$location" "$authorize_origin/" && contains "$location" "$CALLBACK"
}
if [ -n "$idp" ]; then
  fetch provider "$BASE/api/auth/login?idp=$idp&returnTo=%2F"
  location=$(header provider location)
  check "/api/auth/login?idp=$idp redirects to $authorize_origin with the $DOMAIN callback" "status $status, location ${location%%\?*}" provider_ok
else
  echo "SKIP  external provider redirect: set --idp and --authorize-origin to check a configured provider"
fi

fetch catalog "$BASE/catalog/tools/index.json"
check "/catalog/tools/index.json refuses a signed-out caller (401)" "status $status" status_is 401

fetch agents "$BASE/api/v1/agents/activity"
check "/api/v1/agents/activity exists and refuses a signed-out caller (401)" "status $status" status_is 401

shell_ok() { status_is 200 && grep -q "const CACHE = 'lolly-" "$tmp/shell.body" && grep -q "self.addEventListener('fetch'" "$tmp/shell.body"; }
fetch shell "$BASE/sw.js"
check "/sw.js is the Lolly service worker" "status $status" shell_ok

app_ok() { status_is 200 && [ -n "$(header app strict-transport-security)" ]; }
fetch app -H 'Accept: text/html' "$BASE/"
check "/ is the Lolly app, with HSTS" "status $status" app_ok

fetch collab --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: c21va2UtdGVzdC1rZXktMTY=' "$BASE/ws/collab/smoke-test"
check "/ws/collab/<id> reaches the collab gateway, which refuses a caller without a session (401)" "status $status" status_is 401

redirect_ok() { status_is 308 && [ "$(header redirect location)" = "$BASE/t/qr-code?x=1" ]; }
for redirect in ${redirects[@]+"${redirects[@]}"}; do
  fetch redirect "https://$redirect/t/qr-code?x=1"
  check "$redirect redirects permanently to $DOMAIN, path and query kept (308)" "status $status, location $(header redirect location)" redirect_ok
done

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
