#!/usr/bin/env bash
# CI-only host BuildKit. No bootstrap container pull or system installation.
set -euo pipefail

readonly BUILDKIT_VERSION='v0.33.1'
readonly BUILDKIT_COMMIT='8c91502cf280bd70a0c50912ce251c46a8881d9f'
readonly BUILDKIT_SHA256='4e044bcd62a0c0bbe6a8c94d73989de2bfe4c04dbc0f9d6021cf96b72cd1d965'
readonly BUILDKIT_BYTES=93348488
readonly BUILDKIT_URL="https://github.com/moby/buildkit/releases/download/$BUILDKIT_VERSION/buildkit-$BUILDKIT_VERSION.linux-amd64.tar.gz"

fail() { printf 'ci-buildkit: %s\n' "$*" >&2; exit 1; }

set_paths() {
  [[ -n "${RUNNER_TEMP:-}" && "$RUNNER_TEMP" = /* && -d "$RUNNER_TEMP" && ! -L "$RUNNER_TEMP" ]] || fail 'RUNNER_TEMP must be a real absolute directory'
  [[ "$RUNNER_TEMP" != *$'\n'* && "$RUNNER_TEMP" != *$'\r'* ]] || fail 'invalid temporary path'
  [[ "${GITHUB_RUN_ID:-}" =~ ^[1-9][0-9]*$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[1-9][0-9]*$ && "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ && "${GITHUB_JOB:-}" = package ]] || fail 'expected the packaging CI job identity'
  root="${RUNNER_TEMP%/}/lolly-ci-buildkit"
  bin="$root/tools/bin"
  endpoint="unix://$root/buildkitd.sock"
  owner="$GITHUB_RUN_ID:$GITHUB_RUN_ATTEMPT:$GITHUB_JOB:$GITHUB_SHA"
}

# The fixed argv and process start time guard against stopping an unrelated PID.
argv_matches() {
  local file="$1" arg i=0
  local -a actual=() expected=("$bin/buildkitd" --root "$root/data" --addr "$endpoint" --group "$gid" --oci-worker=true --containerd-worker=false --oci-worker-binary "$bin/buildkit-runc" --config "$root/buildkitd.toml")
  while IFS= read -r -d '' arg; do actual+=("$arg"); done < "$file"
  [[ -z "$arg" ]] || return 1
  [[ "${#actual[@]}" = "${#expected[@]}" ]] || return 1
  for arg in "${expected[@]}"; do
    [[ "${actual[$i]}" = "$arg" ]] || return 1
    i=$((i + 1))
  done
}

proc_exists() { [[ -e "/proc/$1" ]]; }

worker_output_valid() {
  grep -q 'linux/amd64' "$1" &&
    grep -Eq 'org\.mobyproject\.buildkit\.worker\.executor:.*oci' "$1"
}

pid_matches() {
  [[ -r "/proc/$pid/stat" && -r "/proc/$pid/cmdline" ]] || return 1
  [[ "$(sudo -n readlink -- "/proc/$pid/exe")" = "$bin/buildkitd" ]] || return 1
  [[ "$(awk '{print $22}' "/proc/$pid/stat")" = "$started" ]] || return 1
  argv_matches "/proc/$pid/cmdline"
}

stop() {
  set_paths
  [[ -e "$root" ]] || return 0
  [[ -d "$root" && ! -L "$root" && "$(stat -c %u "$root")" = "$(id -u)" ]] || fail 'temporary directory ownership changed'
  [[ -f "$root/owner" && ! -L "$root/owner" && "$(cat "$root/owner")" = "$owner" ]] || fail 'temporary job identity changed'
  [[ ! -e "$root/stopped" ]] || return 0
  if [[ -s "$root/pid" ]]; then
    [[ -f "$root/pid" && ! -L "$root/pid" ]] || fail 'unsafe process identity file'
    pid="$(cat "$root/pid")"
    [[ "$pid" =~ ^[1-9][0-9]*$ && "$pid" != 1 ]] || fail 'invalid daemon PID'
    if proc_exists "$pid"; then
      [[ -f "$root/started" && ! -L "$root/started" && -f "$root/gid" && ! -L "$root/gid" ]] || fail 'missing process identity'
      started="$(cat "$root/started")"; gid="$(cat "$root/gid")"
      [[ "$started" =~ ^[1-9][0-9]*$ && "$gid" =~ ^[0-9]+$ ]] || fail 'invalid process identity'
      pid_matches || fail 'daemon PID no longer matches the owned executable, argv and start time'
      sudo -n kill -TERM -- "$pid" || [[ ! -e "/proc/$pid" ]] || fail 'cannot signal the owned daemon'
      local attempt
      for attempt in {1..10}; do proc_exists "$pid" || break; sleep 1; done
      if proc_exists "$pid"; then
        pid_matches || fail 'daemon identity changed during shutdown'
        sudo -n kill -KILL -- "$pid" || [[ ! -e "/proc/$pid" ]] || fail 'cannot stop the owned daemon'
        for attempt in {1..10}; do proc_exists "$pid" || break; sleep 1; done
      fi
      ! proc_exists "$pid" || fail 'daemon did not stop within the shutdown bound'
    fi
  fi
  [[ ! -L "$root/data" ]] || fail 'temporary data path became a symlink'
  sudo -n rm -rf --one-file-system -- "$root/data" || fail 'cannot remove owned temporary build data'
  printf 'stopped\n' > "$root/stopped"
  printf 'ci-buildkit: owned daemon stopped; diagnostics remain in %s\n' "$root"
}

start() {
  set_paths
  [[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]] || fail 'requires the Linux amd64 packaging runner'
  [[ -n "${GITHUB_OUTPUT:-}" ]] || fail 'GITHUB_OUTPUT is required'
  [[ ! -e "$root" && ! -L "$root" ]] || fail 'temporary builder already exists'
  umask 077
  mkdir "$root"
  printf '%s\n' "$owner" > "$root/owner"
  gid="$(id -g)"
  printf '%s\n' "$gid" > "$root/gid"
  # EXIT runs after a failing function's local variables have been unwound.
  builder_ready=false
  trap 'if [[ "$builder_ready" != true ]]; then stop || true; fi' EXIT
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 --output "$root/buildkit.tar.gz" "$BUILDKIT_URL"
  [[ "$(wc -c < "$root/buildkit.tar.gz" | tr -d '[:space:]')" = "$BUILDKIT_BYTES" ]] || fail 'release archive size differs'
  printf '%s  %s\n' "$BUILDKIT_SHA256" "$root/buildkit.tar.gz" | sha256sum --check --strict
  mkdir "$root/tools"
  tar --extract --gzip --file "$root/buildkit.tar.gz" --directory "$root/tools" --no-same-owner --no-same-permissions
  local tool version ctl_version runc_version
  for tool in buildkitd buildctl buildkit-runc; do
    [[ -f "$bin/$tool" && -x "$bin/$tool" && ! -L "$bin/$tool" ]] || fail "bundled $tool is missing or unsafe"
  done
  version="$("$bin/buildkitd" --version)"
  [[ "$version" = *"$BUILDKIT_VERSION"* && "$version" = *"$BUILDKIT_COMMIT"* ]] || fail 'BuildKit release version or source differs'
  ctl_version="$("$bin/buildctl" --version)"
  [[ "$ctl_version" = *"$BUILDKIT_VERSION"* && "$ctl_version" = *"$BUILDKIT_COMMIT"* ]] || fail 'buildctl release version or source differs'
  runc_version="$("$bin/buildkit-runc" --version)"
  [[ "$runc_version" = *'runc version 1.4.3'* || "$runc_version" = *'runc version v1.4.3'* ]] || fail 'bundled runc version differs'
  "$bin/buildkitd" --help > "$root/help.log"
  grep -q -- '--group' "$root/help.log" || fail 'BuildKit lacks Unix socket group support'
  cat > "$root/buildkitd.toml" <<'TOML'
[registry."docker.io"]
  mirrors = ["public.ecr.aws/docker"]
TOML
  : > "$root/pid"
  # Write the daemon's own PID, not the sudo supervisor PID, then exec it.
  sudo -n bash -c 'printf "%s\n" "$$" > "$1"; shift; exec "$@"' \
    bash "$root/pid" "$bin/buildkitd" --root "$root/data" --addr "$endpoint" --group "$gid" \
    --oci-worker=true --containerd-worker=false --oci-worker-binary "$bin/buildkit-runc" \
    --config "$root/buildkitd.toml" > "$root/daemon.log" 2>&1 &
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if [[ -s "$root/pid" ]]; then
      pid="$(cat "$root/pid")"
      [[ "$pid" =~ ^[1-9][0-9]*$ && "$pid" != 1 ]] || fail 'invalid daemon PID'
      if [[ -r "/proc/$pid/stat" && "$(sudo -n readlink -- "/proc/$pid/exe" || true)" = "$bin/buildkitd" ]]; then
        started="$(awk '{print $22}' "/proc/$pid/stat")"
        printf '%s\n' "$started" > "$root/started"
        pid_matches || fail 'daemon launch identity differs'
        if timeout 5 "$bin/buildctl" --addr "$endpoint" debug workers --verbose > "$root/workers.log" 2>&1 && \
          worker_output_valid "$root/workers.log"; then
          builder_ready=true
          printf 'endpoint=%s\n' "$endpoint" >> "$GITHUB_OUTPUT"
          printf 'ci-buildkit: %s; owned OCI worker ready\n' "$version"
          trap - EXIT
          return 0
        fi
      fi
    fi
    sleep 1
  done
  tail -n 80 "$root/daemon.log" >&2
  fail 'owned OCI worker did not become ready'
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
  case "${1:-}" in
    start) start ;;
    stop) stop ;;
    *) fail 'usage: ci-buildkit.sh start|stop'; exit 2 ;;
  esac
fi
