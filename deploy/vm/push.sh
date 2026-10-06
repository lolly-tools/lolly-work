#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
#
# Deploy this checkout to the lolly.ing VM (deploy/vm/README.md). Run on your
# own machine from anywhere in the repository:
#
#   deploy/vm/push.sh [<user>@]<vm-ip> [--internal-tls]
#
#   <user>          the deploy account provision.sh set up; default LOLLY_VM_USER,
#                   else sles (openSUSE's cloud user; root cannot log in)
#   --internal-tls  serve certificates from Caddy's own authority instead of
#                   Let's Encrypt: for the checks before DNS points at the VM
#                   (smoke.sh --insecure). Push again without it after the DNS cut.
#
# Steps: build packs/lolly-ing if it is missing (Lolly at LOLLY_REV, profile
# suse, og excluded), check the Caddyfile is current and instance.json plus the
# pack pass the production setup checks, copy a clean source export, the pack,
# the Caddyfile, docker-compose.yml and instance.json to /opt/lolly-ing, then
# build and restart the server, reload Caddy and wait for /healthz. Files go
# over as the deploy user, who owns /opt/lolly-ing; docker runs through sudo.
# Secrets are not touched: deploy/vm/secrets.sh writes /opt/lolly-ing/.env.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
LOLLY_DIR=${LOLLY_DIR:-$ROOT/../lolly}
LOLLY_REV=${LOLLY_REV:-ae49bf82f}
PACK=packs/lolly-ing
REMOTE=/opt/lolly-ing

die() { echo "push.sh: $*" >&2; exit 1; }
[ $# -ge 1 ] || die "usage: deploy/vm/push.sh [<user>@]<vm-ip> [--internal-tls]"
target=$1
shift
case "$target" in
  root@*) die "root cannot log in on the VM: use ${LOLLY_VM_USER:-sles}@<vm-ip>, or just <vm-ip>" ;;
  *@*) ;;
  *) target=${LOLLY_VM_USER:-sles}@$target ;;
esac
tls=acme
while [ $# -gt 0 ]; do
  case "$1" in
    --internal-tls) tls=internal ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
cd "$ROOT"
node scripts/check-release-capabilities.ts
command -v rsync >/dev/null || die "rsync is needed"
[ -f deploy/vm/instance.json ] || die "no deploy/vm/instance.json: copy deploy/vm/instance.json.example and fill it in"
render_worker=$(node -e 'const c=JSON.parse(require("node:fs").readFileSync("deploy/vm/instance.json")); console.log(c.render?.worker?.url === "http://render-worker:8791" ? "1" : "0")')

work=$(mktemp -d "${TMPDIR:-/tmp}/lolly-ing-push.XXXXXX")
trap 'rm -rf "$work"' EXIT

# ── 1. The pack ──────────────────────────────────────────────────────────────
if [ ! -f "$PACK/.lolly-pack-source.json" ]; then
  echo "==> building $PACK from Lolly $LOLLY_REV (profile suse, og excluded)"
  git -C "$LOLLY_DIR" rev-parse --git-dir >/dev/null 2>&1 || die "no Lolly checkout at $LOLLY_DIR (set LOLLY_DIR)"
  # A clean clone at the pinned revision, so the pack record names the commit
  # that made it. --shared borrows the checkout's objects; nothing is fetched.
  git clone --quiet --shared --no-checkout "$LOLLY_DIR" "$work/lolly"
  git -C "$work/lolly" checkout --quiet --detach "$LOLLY_REV"
  # brands/suse is a submodule marked `update = none`: clone it from the local
  # checkout as well, at the commit this revision records.
  brand=$(git -C "$work/lolly" rev-parse "$LOLLY_REV:brands/suse")
  rmdir "$work/lolly/brands/suse" 2>/dev/null || true
  git clone --quiet --shared --no-checkout "$LOLLY_DIR/brands/suse" "$work/lolly/brands/suse"
  git -C "$work/lolly/brands/suse" checkout --quiet --detach "$brand"
  node scripts/build-instance-pack.ts --lolly "$work/lolly" --profile suse --out "$PACK" --exclude og
fi
node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (r.incomplete) { console.error("push.sh: " + process.argv[1] + " says the last pack build did not finish; delete the pack and run again"); process.exit(1); }
  if (!String(r.commit).startsWith(process.argv[2])) console.error("push.sh: WARNING the pack was built from Lolly " + String(r.commit).slice(0, 12) + ", not " + process.argv[2] + " (LOLLY_REV)");
' "$PACK/.lolly-pack-source.json" "$LOLLY_REV"

# ── 2. Local checks: no network, no real secrets ─────────────────────────────
echo "==> checking deploy/vm/Caddyfile, instance.json and the pack"
node scripts/build-caddyfile.ts --check
caddy_source=deploy/vm/Caddyfile
check_config=deploy/vm/instance.json
shell_release=
if node -e 'process.exit(JSON.parse(require("node:fs").readFileSync("deploy/vm/instance.json")).instance.shellDir ? 0 : 1)'; then
  node scripts/build-caddyfile.ts --serve-shell --out "$work/Caddyfile"
  caddy_source="$work/Caddyfile"
  [ -n "${LOLLY_SHELL_DIST:-}" ] || die "set LOLLY_SHELL_DIST to the qualified shell dist for a native shell deploy"
  [ -f "$LOLLY_SHELL_DIST/index.html" ] || die "LOLLY_SHELL_DIST has no index.html"
  # Setup runs on this machine; the persisted path belongs to the container.
  check_config="$work/instance-check.json"
  node -e '
    const fs=require("node:fs"), path=require("node:path");
    const c=JSON.parse(fs.readFileSync(process.argv[1]));
    if (c.instance.shellDir !== "/app/shell/current") throw new Error("VM native shellDir must be /app/shell/current");
    c.instance.shellDir=path.resolve(process.argv[2]);
    fs.writeFileSync(process.argv[3],JSON.stringify(c),{mode:0o600});
  ' deploy/vm/instance.json "$LOLLY_SHELL_DIST" "$check_config"
  shell_release=$(node scripts/shell-release-id.ts "$LOLLY_SHELL_DIST")
fi
# The setup checks need secret-shaped values to judge the rest; these are
# throwaway ones and the database is never contacted.
env -i PATH="$PATH" HOME="$HOME" NODE_ENV=production LW_CONFIG="$check_config" \
  LW_SESSION_SECRET="$(openssl rand -hex 48)" LW_LINK_SECRET="$(openssl rand -hex 48)" \
  LW_RENDER_WORKER_SECRET="$(openssl rand -hex 48)" \
  DATABASE_URL=postgres://setup-check.invalid/none \
  node scripts/check-setup.ts | sed -n '/^{/,$p' > "$work/setup.json" || true
# shellcheck disable=SC2016 # the ${...} below are JavaScript template literals
node -e '
  const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  for (const c of r.checks) if (c.status === "fail" || c.status === "warning") console.error(`push.sh: ${c.status} ${c.id}: ${c.message}`);
  for (const t of r.pack.tools.filter((t) => !t.valid)) console.error(`push.sh: tool ${t.id}: ${t.diagnostics.join(" ")}`);
  if (!r.ready) { console.error("push.sh: the production setup checks fail; fix the above first"); process.exit(1); }
' "$work/setup.json"

# ── 3. A clean source export ─────────────────────────────────────────────────
# Tracked files plus untracked ones git does not ignore, minus local-only trees:
# plans, build output, dependencies, data packs (the image carries packs/demo)
# and the optional full Lolly checkout under vendor/lolly.
echo "==> exporting the source"
git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do
  case "$f" in
    plans/*|.vercel/*|node_modules/*|*/node_modules/*|vendor/lolly|vendor/lolly/*) continue ;;
    packs/demo/*) ;;
    packs/*) continue ;;
  esac
  # Files and symbolic links (packs/demo/catalog is one); a deleted tracked file is skipped.
  if [ -f "$f" ] || [ -L "$f" ]; then printf '%s\0' "$f"; fi
done | rsync -a --from0 --files-from=- ./ "$work/src/"

# ── 4. Copy to the VM ────────────────────────────────────────────────────────
echo "==> copying to $target:$REMOTE"
# $REMOTE is a fixed path, expanded here on purpose.
# shellcheck disable=SC2029
ssh -n "$target" "test -d $REMOTE && test -w $REMOTE" \
  || die "no $REMOTE on the VM that ${target%@*} can write: run deploy/vm/provision.sh first"
ssh -n "$target" 'sudo -n true' \
  || die "${target%@*} needs passwordless sudo on the VM, for docker (the cloud image's default user has it)"
# shellcheck disable=SC2029
ssh -n "$target" "mkdir -p $REMOTE/src $REMOTE/packs/lolly-ing $REMOTE/caddy"
# The files keep this machine's modes: macOS's rsync (openrsync) accepts
# --chmod and ignores it. The deploy script below makes them readable on the VM.
rsync -az --delete "$work/src/" "$target:$REMOTE/src/"
rsync -az --delete "$PACK/" "$target:$REMOTE/packs/lolly-ing/"
if [ -n "$shell_release" ]; then
  # Reuse identical assets and retain old browser bundles for open clients.
  ssh -n "$target" "mkdir -p $REMOTE/shell/$shell_release"
  rsync -az --checksum --link-dest="$REMOTE/shell/current" "$LOLLY_SHELL_DIST/" "$target:$REMOTE/shell/$shell_release/"
  ssh -n "$target" "if [ -d $REMOTE/shell/current/_app ]; then cp -aln $REMOTE/shell/current/_app/. $REMOTE/shell/$shell_release/_app/; fi; ln -sfn $shell_release $REMOTE/shell/current-next; mv -Tf $REMOTE/shell/current-next $REMOTE/shell/current"
fi
rsync -az deploy/vm/docker-compose.yml deploy/vm/instance.json "$target:$REMOTE/"
rsync -az "$caddy_source" "$target:$REMOTE/caddy/Caddyfile"

# ── 5. Build, restart, reload, wait ──────────────────────────────────────────
echo "==> deploying (TLS: $tls)"
# The script travels on ssh's command line, and ssh's standard input is
# /dev/null (-n). Fed to `bash -s` instead, bash reads the script as it runs,
# so a command that reads standard input (docker compose run and exec attach
# it by default) would swallow the rest: nothing deployed, yet exit status 0.
IFS= read -r -d '' remote <<'REMOTE_SCRIPT' || true
set -euo pipefail
# Docker as root through sudo: provision.sh puts the deploy user in the docker
# group, but only sessions that start after that carry it; sudo works always.
docker() { sudo -n docker "$@"; }
cd /opt/lolly-ing
[ -f .env ] || { echo "push.sh: no /opt/lolly-ing/.env: run deploy/vm/secrets.sh first" >&2; exit 1; }
# Secrets: the deploy user's alone. compose reads the file as root through sudo.
chmod 600 .env
# The server runs as the image's node user. It reads the pack, instance.json
# and src/engine-pin.json through bind mounts, and the image's files keep the
# modes they have in src/ (COPY, then USER node). rsync brought the operator's
# modes (a pack built under umask 077 is 0600), so open them to reading here;
# /opt/lolly-ing itself stays 0700.
chmod -R go+rX src packs/lolly-ing
chmod go+r instance.json
if [ "$1" = internal ]; then echo 'LW_CADDY_GLOBAL=local_certs' > caddy.env; else echo 'LW_CADDY_GLOBAL=' > caddy.env; fi
docker compose config --quiet
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null
if [ "${2:-0}" = 1 ]; then
  docker compose --profile render build render-worker
  docker compose --profile render up -d --no-deps render-worker
  for attempt in 1 2 3 4 5; do
    if docker compose exec -T render-worker node -e 'fetch("http://127.0.0.1:8791/healthz",{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' </dev/null; then break; fi
    [ "$attempt" = 5 ] && { echo "push.sh: the render worker did not start" >&2; exit 1; }
    sleep 2
  done
fi
docker compose build server
# SIGTERM, then up to stop_grace_period for the drain of live collab rooms.
docker compose up -d --no-deps --force-recreate server
echo "waiting for the server (migrations run at boot)"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null http://127.0.0.1:8787/healthz; then ok=1; break; fi
  sleep 3
done
if [ "${ok:-0}" != 1 ]; then
  docker compose logs --tail 80 server >&2
  echo "push.sh: the server did not answer /healthz within 3 minutes" >&2
  exit 1
fi
docker compose up -d --no-deps caddy
for attempt in 1 2 3 4 5 6; do
  if docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null 2>/dev/null; then break; fi
  [ "$attempt" = 6 ] && { echo "push.sh: caddy reload failed" >&2; docker compose logs --tail 40 caddy >&2; exit 1; }
  sleep 2
done
if [ "$1" = internal ]; then insecure=-k; else insecure=; fi
for _ in $(seq 1 20); do
  # shellcheck disable=SC2086
  if curl -fsS $insecure -o /dev/null --resolve lolly.ing:443:127.0.0.1 https://lolly.ing/healthz; then echo "healthy through Caddy"; exit 0; fi
  sleep 3
done
echo "push.sh: the server is up but https://lolly.ing/healthz through Caddy is not (certificate not issued yet? DNS not pointing here?)" >&2
docker compose logs --tail 40 caddy >&2
exit 1
REMOTE_SCRIPT
encoded=$(printf '%s' "$remote" | base64 | tr -d '\n')
ssh -n "$target" "bash -c \"\$(echo $encoded | base64 -d)\" push-remote $tls $render_worker"
echo "==> deployed. Next: deploy/vm/smoke.sh ${target#*@}$( [ "$tls" = internal ] && printf ' --insecure' )"
