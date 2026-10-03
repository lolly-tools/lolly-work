#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Rotate LW_SESSION_SECRET and LW_LINK_SECRET on the lolly.ing VM and on the
# Vercel rollback project together. Run by the operator on their own machine,
# from this checkout, never by an agent:
#
#   deploy/vm/rotate-secrets.sh [<user>@]<vm-ip> [--vercel-project lolly-ing] [--yes]
#                               [--drop-previous] [--allow-unverified-audit]
#
# <user> defaults to LOLLY_VM_USER, else sles (root cannot log in).
#
# What it does, in order:
#   1. Checks: ssh and passwordless sudo on the VM, /opt/lolly-ing/.env there,
#      code on the VM that has scripts/audit-head.ts and
#      scripts/audit-retire-key.ts, the vercel CLI signed in and able to read
#      the project, and that neither variable on Vercel spans more than the
#      Production environment. It also records the audit log's head inside the
#      running server, which still has the old secret: the seq and public hash
#      of the last row, and whether every row verifies under that secret. The
#      retire-key step later refuses if that row has changed, so nothing up to
#      it can be rewritten in between. A broken hash link stops the rotation;
#      rows that fail only their MAC stop it unless --allow-unverified-audit.
#   2. Generates two fresh values (openssl rand -base64 48) into shell
#      variables. They are never printed, never on a command line, and never
#      written on this machine.
#   3. Replaces both lines in /opt/lolly-ing/.env on the VM. The values travel
#      on ssh's standard input; every other line stays as it was, the file
#      stays 0600 and keeps its owner (sudo is used only when the ssh user
#      cannot write it). LW_SESSION_SECRET_PREVIOUS and LW_LINK_SECRET_PREVIOUS
#      lines are kept and named in a warning, or removed with --drop-previous.
#   4. Sets both sensitive Production variables on the Vercel project, one call
#      each that overwrites in place (`vercel env add NAME production
#      --sensitive --force`, the value on standard input), so a failure never
#      leaves a variable missing. The project is chosen with VERCEL_ORG_ID +
#      VERCEL_PROJECT_ID (the team comes from this checkout's
#      .vercel/project.json unless VERCEL_ORG_ID is set), so nothing is linked
#      and no development variables are pulled.
#   5. Recreates the server container so it reads the new .env (a plain
#      restart would keep the old environment), and waits for /healthz.
#   6. Prints what is left: redeploy Vercel, sign in once, then retire the old
#      audit key with the head recorded in step 1.
#
# The old values are gone after this (Vercel stores sensitive values
# write-only): everyone signs in again, issued share and embed links stop
# verifying, and every audit row written so far fails its MAC until the
# retire-key step records a boundary (docs/audit.md, "Rotating the session
# secret"). If it stops part way, it reports the state of each side (the VM's .env,
# the VM server, each Vercel variable). Running it again starts over with new
# values and replaces whatever the stopped run left.
set -euo pipefail
set +x
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
REMOTE_DIR=/opt/lolly-ing

die() { echo "rotate-secrets.sh: $*" >&2; exit 1; }
usage="usage: deploy/vm/rotate-secrets.sh [<user>@]<vm-ip> [--vercel-project lolly-ing] [--yes] [--drop-previous] [--allow-unverified-audit]"
[ $# -ge 1 ] || die "$usage"
target=$1
shift
project=lolly-ing
assume_yes=0
drop_previous=0
allow_unverified=0
while [ $# -gt 0 ]; do
  case "$1" in
    --vercel-project) [ $# -ge 2 ] && [ -n "$2" ] || die "--vercel-project needs a name"; project=$2; shift ;;
    --yes) assume_yes=1 ;;
    --drop-previous) drop_previous=1 ;;
    --allow-unverified-audit) allow_unverified=1 ;;
    *) die "unknown option $1. $usage" ;;
  esac
  shift
done
case "$target" in
  -*) die "$usage" ;;
  root@*) die "root cannot log in on the VM: use ${LOLLY_VM_USER:-sles}@<vm-ip>, or just <vm-ip>" ;;
  *@*) ;;
  *) target=${LOLLY_VM_USER:-sles}@$target ;;
esac

# The state of each side, reported by on_exit whenever the run stops before
# the end: a failed command (set -e), die, Ctrl-C or a TERM.
finished=0
started=0
st_vm_env="old values (unchanged)"
st_vm_server="running on the old values"
st_vercel_session="old value (unchanged)"
st_vercel_link="old value (unchanged)"
on_exit() {
  local status=$1
  [ "$finished" = 1 ] && return 0
  if [ "$started" = 0 ]; then
    echo "rotate-secrets.sh: stopped (exit $status); nothing changed." >&2
    return 0
  fi
  cat >&2 <<STATE

rotate-secrets.sh: STOPPED PART WAY (exit $status). The state of each side:
  VM $REMOTE_DIR/.env:       $st_vm_env
  VM server:                    $st_vm_server
  Vercel LW_SESSION_SECRET:     $st_vercel_session
  Vercel LW_LINK_SECRET:        $st_vercel_link

The new values were never printed, so they cannot be finished by hand. Run
this script again: it generates a fresh pair and writes it to every side,
which replaces whatever this run left. Until then, a VM .env holding new
values is applied by the next push.sh or container recreate, whatever Vercel
holds. Sessions and links signed by a host on one value do not verify on a
host on another.
STATE
}
trap 'on_exit $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── 1. Checks, before anything changes ───────────────────────────────────────
command -v openssl >/dev/null || die "openssl is needed to generate the secrets"
command -v node >/dev/null || die "node is needed to read JSON from the VM and the vercel CLI"
command -v vercel >/dev/null || die "the vercel CLI is needed (npm i -g vercel), signed in to the team that owns $project"
cd "$ROOT"

org=${VERCEL_ORG_ID:-}
if [ -z "$org" ]; then
  [ -f .vercel/project.json ] || die "no .vercel/project.json in $ROOT to take the Vercel team from: run vercel link here, or set VERCEL_ORG_ID"
  org=$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(".vercel/project.json", "utf8")).orgId || ""))')
  [ -n "$org" ] || die ".vercel/project.json has no orgId: set VERCEL_ORG_ID"
fi
# Every vercel call below names the project this way, so the checkout's own
# link (it may point at a different project) is never used or changed.
vc() { VERCEL_ORG_ID="$org" VERCEL_PROJECT_ID="$project" vercel "$@"; }

echo "==> checking the VM ($target)"
# shellcheck disable=SC2029 # $REMOTE_DIR is a fixed path, expanded here on purpose
ssh -n "$target" "test -f $REMOTE_DIR/.env" \
  || die "no $REMOTE_DIR/.env on the VM: run deploy/vm/provision.sh and deploy/vm/secrets.sh first"
ssh -n "$target" 'sudo -n true' \
  || die "${target%@*} needs passwordless sudo on the VM, for docker"
# shellcheck disable=SC2029
ssh -n "$target" "test -f $REMOTE_DIR/src/scripts/audit-head.ts && test -f $REMOTE_DIR/src/scripts/audit-retire-key.ts" \
  || die "the code on the VM has no scripts/audit-head.ts or scripts/audit-retire-key.ts, which this rotation needs before and after. Deploy this checkout with deploy/vm/push.sh, then run this again."

# Names only: grep -o prints the matched "NAME=" and never the value.
# shellcheck disable=SC2029
previous=$(ssh -n "$target" "f=$REMOTE_DIR/.env; if [ -r \$f ]; then grep -oE '^LW_(SESSION|LINK)_SECRET_PREVIOUS=' \$f; else sudo -n grep -oE '^LW_(SESSION|LINK)_SECRET_PREVIOUS=' \$f; fi || true" | tr -d '=' | tr '\n' ' ')
previous=${previous% }
session_previous_kept=0
if [ -n "$previous" ]; then
  if [ "$drop_previous" = 1 ]; then
    echo "    the VM .env sets $previous; --drop-previous removes them"
  else
    echo "NOTE: the VM .env also sets $previous. Sessions and links signed with those older values stay valid after this rotation. Pass --drop-previous to remove them too." >&2
    case " $previous " in *" LW_SESSION_SECRET_PREVIOUS "*) session_previous_kept=1 ;; esac
  fi
fi

echo "==> recording the audit head on the VM (read-only, inside the running server)"
head_rc=0
# shellcheck disable=SC2029
head_json=$(ssh -n "$target" "cd $REMOTE_DIR && sudo -n docker compose exec -T server node scripts/audit-head.ts --json") || head_rc=$?
[ "$head_rc" = 0 ] || [ "$head_rc" = 2 ] \
  || die "could not read the audit head on the VM (exit $head_rc). The server must be running (docker compose ps) from an image built with scripts/audit-head.ts (deploy/vm/push.sh)."
# Public fields only: seq, hash, verdicts. "-" marks an absent value.
head_fields=$(printf '%s' "$head_json" | node -e '
  let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => {
    let h;
    try { h = JSON.parse(s.trim().split("\n").pop()); } catch { process.exit(1); }
    if (!Number.isInteger(h.seq) || !/^[0-9a-f]{64}$/.test(h.hash)) process.exit(1);
    const v = (x) => (x === undefined || x === null ? "-" : String(x));
    console.log([h.seq, h.hash, h.chainIntact, h.linksIntact, h.keyChecked, v(h.badSeq), v(h.linksBadSeq)].join(" "));
  });') || die "the audit head the VM printed is not the expected JSON"
read -r head_seq head_hash head_intact head_links head_keyed head_bad head_links_bad <<EOF
$head_fields
EOF
if [ "$head_links" != true ]; then
  die "the audit log's hash chain is already broken at #$head_links_bad, before any rotation. That is an edit or a deletion, not a key change: investigate it first (docs/audit.md)."
fi
if [ "$head_intact" = true ] && [ "$head_keyed" = true ]; then
  echo "    audit head #$head_seq ($head_hash): every row verifies under the VM's current secret"
elif [ "$allow_unverified" = 1 ]; then
  echo "NOTE: audit rows do not all verify under the VM's current secret (first failure #$head_bad); going ahead (--allow-unverified-audit). Head #$head_seq is recorded and pins every row up to it." >&2
else
  die "audit rows do not all verify under the VM's current LW_SESSION_SECRET (first failure #$head_bad), so this check cannot vouch for them. The hash links hold. Expected when the VM's value never matched the one those rows were written with (secrets.sh generated it), or when an earlier run of this script already switched the server. Run again with --allow-unverified-audit to go ahead; head #$head_seq is still recorded and pins every row up to it."
fi

echo "==> checking the Vercel project $project"
vc whoami >/dev/null || die "the vercel CLI is not signed in (vercel login)"
# Names and environments only: the JSON carries plain values too, so it goes
# straight into node and only "NAME target,target" lines come out.
targets=$(vc env ls production --format json | node -e '
  let s = ""; process.stdin.on("data", (c) => { s += c; }).on("end", () => {
    let envs;
    try { envs = JSON.parse(s).envs; } catch { console.error("rotate-secrets.sh: vercel env ls gave no JSON"); process.exit(1); }
    for (const e of envs) if (e.key === "LW_SESSION_SECRET" || e.key === "LW_LINK_SECRET") {
      console.log(e.key + " " + [].concat(e.target || []).join(","));
    }
  });') || die "cannot list the environment variables of Vercel project $project (team $org)"
while read -r name envs; do
  [ -n "$name" ] || continue
  [ "$envs" = production ] \
    || die "$name on $project applies to $envs, not only production. Replacing it for production would change it there too; split it in the dashboard first."
done <<EOF
$targets
EOF

if [ "$assume_yes" != 1 ]; then
  echo
  echo "This replaces LW_SESSION_SECRET and LW_LINK_SECRET on $target and on Vercel $project (production)."
  echo "Everyone signs in again, issued share and embed links stop verifying, and the audit log needs"
  echo "the retire-key step afterwards. The old values cannot be recovered."
  IFS= read -r -p "Type rotate to continue: " answer </dev/tty
  [ "$answer" = rotate ] || die "stopped at the prompt"
fi

# ── 2. New values, in variables only ─────────────────────────────────────────
session=$(openssl rand -base64 48 | tr -d '\n')
link=$(openssl rand -base64 48 | tr -d '\n')
for value in "$session" "$link"; do
  [ "${#value}" -ge 64 ] || die "openssl gave a short value"
  case "$value" in *"'"*) die "a generated value contains a quote" ;; esac
done

# ── 3. The VM's .env ─────────────────────────────────────────────────────────
echo "==> writing the new values into $REMOTE_DIR/.env on the VM"
# Runs on the VM: rotate-env <itself, base64> <drop-previous 0|1> [via-sudo].
# Reads two KEY=value lines on standard input, rewrites the two keys in place
# and keeps every other line (the *_PREVIOUS ones too, unless told to drop
# them). Re-runs itself through sudo when the ssh user cannot write the file.
# Prints key names only.
# Read with read -d '' rather than inside $(...): bash 3.2 (macOS) misparses
# some scripts inside a command substitution.
read -r -d '' remote_env <<'REMOTE' || true
set -euo pipefail
set +x
umask 077
dir=/opt/lolly-ing
file=$dir/.env
drop=${2:-0}
[ -f "$file" ] || { echo "no $file" >&2; exit 1; }
if ! { [ -w "$dir" ] && [ -w "$file" ]; }; then
  [ "${3:-}" != via-sudo ] || { echo "cannot write $file even through sudo" >&2; exit 1; }
  exec sudo -n bash -c "$(printf '%s' "$1" | base64 -d)" rotate-env "$1" "$drop" via-sudo
fi
session='' link=''
while IFS= read -r line; do
  case "$line" in
    LW_SESSION_SECRET=*) session=${line#*=} ;;
    LW_LINK_SECRET=*) link=${line#*=} ;;
  esac
done
if [ "${#session}" -lt 32 ] || [ "${#link}" -lt 32 ]; then
  echo "did not receive both values; $file is unchanged" >&2
  exit 1
fi
tmp=$(mktemp "$dir/.env.XXXXXX")
trap 'rm -f "$tmp"' EXIT
seen_session=0 seen_link=0 kept=0 dropped=''
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    LW_SESSION_SECRET=*)
      [ "$seen_session" = 0 ] && printf "LW_SESSION_SECRET='%s'\n" "$session"
      seen_session=1 ;;
    LW_LINK_SECRET=*)
      [ "$seen_link" = 0 ] && printf "LW_LINK_SECRET='%s'\n" "$link"
      seen_link=1 ;;
    LW_SESSION_SECRET_PREVIOUS=*|LW_LINK_SECRET_PREVIOUS=*)
      if [ "$drop" = 1 ]; then dropped="$dropped ${line%%=*}"; else printf '%s\n' "$line"; kept=$((kept + 1)); fi ;;
    *) printf '%s\n' "$line"; kept=$((kept + 1)) ;;
  esac
done < "$file" > "$tmp"
[ "$seen_session" = 1 ] || printf "LW_SESSION_SECRET='%s'\n" "$session" >> "$tmp"
[ "$seen_link" = 1 ] || printf "LW_LINK_SECRET='%s'\n" "$link" >> "$tmp"
chmod 600 "$tmp"
chown --reference="$file" "$tmp" 2>/dev/null || true
mv "$tmp" "$file"
trap - EXIT
mode=$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")
owner=$(stat -c %U "$file" 2>/dev/null || stat -f %Su "$file")
echo "updated $file (mode $mode, owner $owner): LW_SESSION_SECRET and LW_LINK_SECRET replaced, $kept other lines kept${dropped:+, removed$dropped}"
REMOTE
encoded_env=$(printf '%s' "$remote_env" | base64 | tr -d '\n')
started=1
st_vm_env="UNKNOWN: the write did not finish; the file holds either all the old values or all the new ones (it is replaced by one rename)"
# shellcheck disable=SC2029 # $encoded_env and $drop_previous are meant to expand here
{
  printf 'LW_SESSION_SECRET=%s\n' "$session"
  printf 'LW_LINK_SECRET=%s\n' "$link"
} | ssh "$target" "bash -c \"\$(echo $encoded_env | base64 -d)\" rotate-env $encoded_env $drop_previous"
st_vm_env="NEW values (applied when the server container is recreated)"

# ── 4. The Vercel project ────────────────────────────────────────────────────
# One call per variable: --force overwrites in place (the API's upsert), so a
# failure leaves the old value rather than no value.
echo "==> setting LW_SESSION_SECRET on Vercel $project (production)"
st_vercel_session="UNKNOWN: the update did not finish; it holds the old value or the new one"
printf '%s' "$session" | vc env add LW_SESSION_SECRET production --sensitive --force >/dev/null
st_vercel_session="NEW value (applies at the next production deployment)"
echo "==> setting LW_LINK_SECRET on Vercel $project (production)"
st_vercel_link="UNKNOWN: the update did not finish; it holds the old value or the new one"
printf '%s' "$link" | vc env add LW_LINK_SECRET production --sensitive --force >/dev/null
st_vercel_link="NEW value (applies at the next production deployment)"
unset session link

# ── 5. Apply on the VM ───────────────────────────────────────────────────────
echo "==> recreating the server container on the VM"
read -r -d '' remote_restart <<'REMOTE' || true
set -euo pipefail
# Docker as root through sudo, as push.sh does.
compose() { sudo -n docker compose "$@"; }
cd /opt/lolly-ing
# Recreate, not restart: only a new container reads env_file again.
compose up -d --no-deps --force-recreate server
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null http://127.0.0.1:8787/healthz; then echo "the server answers /healthz"; exit 0; fi
  sleep 3
done
compose logs --tail 80 server >&2
echo "the server did not answer /healthz within 3 minutes" >&2
exit 3
REMOTE
encoded_restart=$(printf '%s' "$remote_restart" | base64 | tr -d '\n')
st_vm_server="UNKNOWN: the recreate did not finish; it runs on the old values or the new ones"
restart_rc=0
# shellcheck disable=SC2029
ssh -n "$target" "bash -c \"\$(echo $encoded_restart | base64 -d)\"" || restart_rc=$?
case "$restart_rc" in
  0) st_vm_server="recreated on the new values, answering /healthz" ;;
  3) st_vm_server="recreated on the new values, but /healthz did not answer within 3 minutes (logs above)"; exit 1 ;;
  *) st_vm_server="UNKNOWN: the recreate failed (exit $restart_rc); check docker compose ps on the VM"; exit 1 ;;
esac
finished=1

# ── 6. What is left ──────────────────────────────────────────────────────────
today=$(date +%F)
exec_env=''
previous_note=''
if [ "$session_previous_kept" = 1 ]; then
  exec_env=' -e LW_SESSION_SECRET_PREVIOUS='
  previous_note='
     -e LW_SESSION_SECRET_PREVIOUS= keeps the older value the .env still holds out of
     the check: it is not the value this rotation replaced.'
fi
expect=''
if [ "$head_seq" -ge 1 ]; then expect=" --expect-head $head_seq:$head_hash"; fi
cat <<NEXT

Done: both secrets replaced on the VM (running) and on Vercel $project (not yet deployed).
Audit head recorded before the rotation: #$head_seq $head_hash

Next, in this order:

  1. Redeploy the Vercel rollback so its production deployment reads the new values.
     Until then it still signs with the old ones, and any audit row it writes would
     come after the boundary in step 3 and fail verification. Either Redeploy the
     current production deployment of $project in the Vercel dashboard, or:
       VERCEL_ORG_ID=$org VERCEL_PROJECT_ID=$project vercel ls --environment production --limit 1
       vercel redeploy <that deployment's URL> --target production

  2. Sign in once on lolly.ing. That writes an audit row under the new key, which
     shows retire-key that the server runs the secret it is given.

  3. Retire the old audit key, once, on the VM (first with --dry-run to see the count):
       ssh $target 'cd $REMOTE_DIR && sudo docker compose exec -T$exec_env server node scripts/audit-retire-key.ts --reason "secret rotation $today"$expect --dry-run'
       ssh $target 'cd $REMOTE_DIR && sudo docker compose exec -T$exec_env server node scripts/audit-retire-key.ts --reason "secret rotation $today"$expect'
     --expect-head is the head recorded above: the command refuses if that row has
     changed since. If it refuses, read what it says and docs/audit.md before reaching
     for an override.$previous_note

  4. Check: the boot line in the server log, and lw audit head, read
       intact=true (N rows signed with a retired key before ...)
NEXT
