#!/bin/bash
# SPDX-License-Identifier: MPL-2.0
# health-checker plugin for the Lolly appliance: a host update that breaks
# Lolly Work rolls the host back.
#
# health-checker runs every plugin at each boot. When one fails on the first
# boot of a new root snapshot (a transactional-update), it makes the last
# snapshot that booted well the default again and reboots into it. This plugin
# judges only that boot: Lolly Work must answer /healthz and /readyz over
# HTTPS (and, on the k3s profile, K3s's API must be ready) within
# LOLLY_HEALTH_TIMEOUT seconds (default 900). On any other boot it reports and
# passes: the first boot has nothing older to go back to, and a problem on a
# snapshot that already booted well belongs to Lolly Work (lolly-update), not
# to the host, so it must not send the machine into health-checker's
# emergency mode.
. /usr/libexec/lolly-appliance/common.sh

STATE_FILE=/var/lib/misc/health-check.state

say() { echo "lolly-appliance health: $*"; logger -t lolly-appliance-health -- "$*" 2>/dev/null || true; }

# Whether this is the first boot of a snapshot newer than the last good one,
# by the same test health-checker uses before it rolls back.
new_snapshot() {
  local last default current
  [ -r "$STATE_FILE" ] || return 1
  last=$(sed -n 's/^LAST_WORKING_BTRFS_ID=\([0-9]*\)$/\1/p' "$STATE_FILE" | tail -n 1)
  default=$(btrfs subvolume get-default / 2>/dev/null | awk '{print $2}')
  current=$(findmnt --output OPTIONS --noheadings / | sed -e 's|.*subvolid=\([0-9]\+\).*|\1|g')
  [ -n "$last" ] && [ -n "$default" ] && [ "$default" = "$current" ] && [ "$last" != "$default" ]
}

http_code() {
  curl -sk -o /dev/null -m 5 -w '%{http_code}' "https://127.0.0.1$1" 2>/dev/null
}

lolly_ready() {
  if [ "$PROFILE" = k3s ]; then
    [ "$("${KUBECTL[@]}" get --raw=/readyz 2>/dev/null)" = ok ] || return 1
  else
    systemctl is-active --quiet lolly-postgres.service lolly-work.service lolly-caddy.service || return 1
  fi
  [ "$(http_code /healthz)" = 200 ] && [ "$(http_code /readyz)" = 200 ]
}

check() {
  local timeout deadline
  if ! new_snapshot; then
    if lolly_ready; then say "Lolly Work is ready (a known snapshot: not judged)"; else say "Lolly Work is not ready yet (a known snapshot: not judged)"; fi
    return 0
  fi
  timeout=$(conf_get LOLLY_HEALTH_TIMEOUT 900)
  [[ $timeout =~ ^[0-9]+$ ]] || timeout=900
  say "first boot of a new snapshot: waiting up to $timeout s for Lolly Work ($PROFILE profile)"
  deadline=$((SECONDS + timeout))
  until lolly_ready; do
    if [ $SECONDS -ge $deadline ]; then
      say "Lolly Work did not become ready on the new snapshot; failing the health check so the host rolls back"
      return 1
    fi
    sleep 5
  done
  say "Lolly Work is ready on the new snapshot after $SECONDS s"
}

stop_lolly() {
  if [ "$PROFILE" = k3s ]; then
    systemctl stop k3s.service
  else
    systemctl stop lolly-caddy.service lolly-work.service lolly-postgres.service
  fi
}

case "$1" in
  check) check ;;
  stop) stop_lolly ;;
  *) echo "Usage: $0 {check|stop}"; exit 1 ;;
esac
