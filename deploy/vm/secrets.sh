#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Write /opt/lolly-ing/.env on the VM (mode 0600, owned by the deploy user).
# Run by the operator on their own machine, never by an agent:
#
#   deploy/vm/secrets.sh [<user>@]<vm-ip> <catalog-signing-key.pem>
#
# <user> defaults to LOLLY_VM_USER, else sles: the account provision.sh gave
# /opt/lolly-ing to (root cannot log in). docker compose reads the file through
# sudo, as root.
#
# - LW_SESSION_SECRET and LW_LINK_SECRET: paste the values the Vercel project
#   lolly-ing uses, so the VM and the Vercel rollback share them. The session
#   secret also keys the audit log's MACs (audit/chain.ts deriveAuditMacKey):
#   with a different one, every audit row the other host wrote fails
#   verification, sign-ins end and issued share links stop verifying. Left
#   empty on the first run, both are generated ON THE VM with
#   `openssl rand -hex 48` (never printed), with a warning; later runs keep
#   whatever the VM has.
# - The catalog signing key is read from the PEM path, checked against
#   lolly/keys/catalog-signing.pub.jwk.json when that checkout is beside this
#   one, and stored as a one-line private JWK (the server accepts both forms;
#   an env file cannot hold the PEM's line breaks).
# - The Google client secret, the Neon DIRECT database URL and the optional
#   GitHub client secret are asked for without echo. Enter keeps the value the
#   VM already has.
# No value is printed, passed on a command line or written on this machine; they
# travel to the VM on ssh's standard input.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
LOLLY_DIR=${LOLLY_DIR:-$ROOT/../lolly}

die() { echo "secrets.sh: $*" >&2; exit 1; }
[ $# -eq 2 ] || die "usage: deploy/vm/secrets.sh [<user>@]<vm-ip> <catalog-signing-key.pem>"
target=$1
pem=$2
case "$target" in
  root@*) die "root cannot log in on the VM: use ${LOLLY_VM_USER:-sles}@<vm-ip>, or just <vm-ip>" ;;
  *@*) ;;
  *) target=${LOLLY_VM_USER:-sles}@$target ;;
esac
[ -r "$pem" ] || die "cannot read $pem"
command -v node >/dev/null || die "node is needed to convert the signing key"

# The PEM as a private JWK on one line, checked to be ECDSA P-256 and, when the
# Lolly checkout is here, to match the public key the shell pins.
pub="$LOLLY_DIR/keys/catalog-signing.pub.jwk.json"
signing_key=$(node -e '
  const { createPrivateKey } = require("node:crypto");
  const { existsSync, readFileSync } = require("node:fs");
  let k;
  try { k = createPrivateKey(readFileSync(process.argv[1], "utf8")).export({ format: "jwk" }); }
  catch { console.error("secrets.sh: the signing key is not a readable private key"); process.exit(1); }
  if (k.kty !== "EC" || k.crv !== "P-256" || !k.d) { console.error("secrets.sh: the signing key is not an ECDSA P-256 private key"); process.exit(1); }
  if (existsSync(process.argv[2])) {
    const p = JSON.parse(readFileSync(process.argv[2], "utf8"));
    if (p.x !== k.x || p.y !== k.y) { console.error("secrets.sh: this key does not match " + process.argv[2] + "; the shell would refuse every tool"); process.exit(1); }
  } else console.error("secrets.sh: no " + process.argv[2] + " to compare with; set LOLLY_DIR to check the key");
  process.stdout.write(JSON.stringify({ kty: "EC", crv: "P-256", x: k.x, y: k.y, d: k.d }));
' "$pem" "$pub")

ask() { # ask <variable> <prompt>: read without echo into the named variable
  local value
  IFS= read -rs -p "$2: " value
  echo >&2
  printf -v "$1" '%s' "$value"
}
session='' link='' google='' database='' github=''
ask session 'LW_SESSION_SECRET as on Vercel lolly-ing (Enter keeps the VM one, or generates one)'
ask link 'LW_LINK_SECRET as on Vercel lolly-ing (Enter keeps the VM one, or generates one)'
ask google 'Google OAuth client secret (LW_IDP_CLIENT_SECRET, Enter keeps the current one)'
ask database 'Neon DIRECT connection string (DATABASE_URL, Enter keeps the current one)'
ask github 'GitHub OAuth App client secret (LW_IDP_GITHUB_SECRET, optional, Enter keeps or skips)'

if [ -n "$database" ]; then
  case "$database" in
    postgres://*|postgresql://*) ;;
    *) die "DATABASE_URL must start with postgres:// or postgresql://" ;;
  esac
  case "$database" in
    *-pooler.*) die "that is Neon's pooled connection string (its host has -pooler). Use the direct one: the server migrates over it and keeps its own pools." ;;
  esac
fi
for value in "$session" "$link"; do
  if [ -n "$value" ] && [ "${#value}" -lt 32 ]; then die "LW_SESSION_SECRET and LW_LINK_SECRET need at least 32 characters"; fi
done
for value in "$session" "$link" "$google" "$database" "$github" "$signing_key"; do
  case "$value" in *"'"*) die "a value contains a single quote, which the env file cannot hold" ;; esac
done

# Runs on the VM: merge what was given (standard input, KEY=value lines) with
# what the file already has, generate the two signing secrets once, and replace
# the file atomically with mode 0600. Prints key names only.
# Read with read -d '' rather than inside $(...): bash 3.2 (macOS) misparses
# some scripts inside a command substitution.
read -r -d '' remote <<'REMOTE' || true
set -euo pipefail
umask 077
dir=${LW_VM_DIR:-/opt/lolly-ing}
[ -d "$dir" ] || { echo "no $dir: run deploy/vm/provision.sh first" >&2; exit 1; }
[ -w "$dir" ] || { echo "$(id -un) cannot write $dir: run deploy/vm/provision.sh, which gives it to the deploy user" >&2; exit 1; }
managed="DATABASE_URL LW_SESSION_SECRET LW_LINK_SECRET LW_IDP_CLIENT_SECRET LW_IDP_GITHUB_SECRET LW_CATALOG_SIGNING_KEY"
while IFS= read -r line; do
  key=${line%%=*}
  case " $managed " in
    *" $key "*) printf -v "given_$key" '%s' "${line#*=}" ;;
  esac
done
tmp=$(mktemp "$dir/.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
existing() { [ -f "$dir/.env" ] && grep -E "^$1=" "$dir/.env" | tail -n 1 || true; }
for key in $managed; do
  name="given_$key"
  if [ -n "${!name:-}" ]; then
    printf "%s='%s'\n" "$key" "${!name}" >> "$tmp"
  elif line=$(existing "$key") && [ -n "$line" ]; then
    printf '%s\n' "$line" >> "$tmp"
  elif [ "$key" = LW_SESSION_SECRET ] || [ "$key" = LW_LINK_SECRET ]; then
    printf "%s='%s'\n" "$key" "$(openssl rand -hex 48)" >> "$tmp"
    echo "WARNING: generated a new $key here. It differs from the Vercel project's: audit rows written there fail verification here, sign-ins and share links do not carry over, and a rollback to Vercel needs this value set there." >&2
  fi
done
# Any other setting already in the file (LW_BACKGROUND_POLL_MS, say) stays.
if [ -f "$dir/.env" ]; then
  grep -vE "^($(echo "$managed" | tr ' ' '|'))=" "$dir/.env" >> "$tmp" || true
fi
chmod 600 "$tmp"
mv "$tmp" "$dir/.env"
trap - EXIT
mode=$(stat -c %a "$dir/.env" 2>/dev/null || stat -f %Lp "$dir/.env")
echo "wrote $dir/.env (mode $mode): $(grep -oE '^[A-Z_]+=' "$dir/.env" | tr -d '=' | tr '\n' ' ')"
for key in DATABASE_URL LW_IDP_CLIENT_SECRET LW_CATALOG_SIGNING_KEY; do
  grep -qE "^$key=" "$dir/.env" || echo "MISSING: $key (run secrets.sh again and enter it)" >&2
done
REMOTE
encoded=$(printf '%s' "$remote" | base64 | tr -d '\n')

# shellcheck disable=SC2029 # $encoded is meant to expand here
{
  [ -n "$session" ] && printf 'LW_SESSION_SECRET=%s\n' "$session"
  [ -n "$link" ] && printf 'LW_LINK_SECRET=%s\n' "$link"
  [ -n "$database" ] && printf 'DATABASE_URL=%s\n' "$database"
  [ -n "$google" ] && printf 'LW_IDP_CLIENT_SECRET=%s\n' "$google"
  [ -n "$github" ] && printf 'LW_IDP_GITHUB_SECRET=%s\n' "$github"
  printf 'LW_CATALOG_SIGNING_KEY=%s\n' "$signing_key"
} | ssh "$target" "bash -c \"\$(echo $encoded | base64 -d)\""
