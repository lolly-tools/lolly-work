# SPDX-License-Identifier: MPL-2.0
# Shared settings and helpers for the Lolly appliance's first-boot and console
# services. Sourced, never run.

CONF=/etc/lolly/appliance.conf
STATE_DIR=/var/lib/lolly
CRED_DIR=$STATE_DIR/credentials
TLS_DIR=$STATE_DIR/tls
INSTANCE_ENV=$STATE_DIR/instance.env
MANIFESTS=/var/lib/rancher/k3s/server/manifests
INSTANCE_MANIFEST=$MANIFESTS/lolly-work-instance.yaml
RELEASE=/usr/share/lolly-appliance/release.json
KUBECTL=(/usr/local/bin/k3s kubectl)
DEFAULT_OWNER=owner@lolly.local
EMAIL_RE='^[a-z0-9._%+-]+@[a-z0-9.-]+$'
# Local networks that may reach Cockpit (port 9090).
COCKPIT_SOURCES_V4="10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16"
COCKPIT_SOURCES_V6="fc00::/7 fe80::/10"
# The credentials this machine creates at first boot (systemd-creds names).
CREDENTIALS="lolly-session-secret lolly-link-secret lolly-credential-secret lolly-postgres-password lolly-catalog-signing-key lolly-tls-key"

log() { echo "lolly-appliance: $*" >&2; }

# conf_get KEY DEFAULT: read KEY=VALUE from /etc/lolly/appliance.conf without
# executing it. Quotes around the value are removed.
conf_get() {
  local key=$1 default=${2-} value=
  if [ -r "$CONF" ]; then
    value=$(sed -n "s/^[[:space:]]*$key[[:space:]]*=[[:space:]]*//p" "$CONF" | tail -n 1)
    value=${value%\"}; value=${value#\"}; value=${value%\'}; value=${value#\'}
  fi
  printf '%s' "${value:-$default}"
}

# The source address of the default route, else the first global IPv4 address.
primary_ipv4() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
  [ -n "$ip" ] || ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)
  printf '%s' "$ip"
}

all_ipv4() {
  ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -v '^10\.4[23]\.' || true
}

owner_email() {
  local owner
  owner=$(conf_get LOLLY_OWNER_EMAIL "$DEFAULT_OWNER" | tr '[:upper:]' '[:lower:]')
  if ! [[ $owner =~ $EMAIL_RE ]] || [ ${#owner} -gt 254 ]; then
    log "LOLLY_OWNER_EMAIL in $CONF is not an email address; using $DEFAULT_OWNER"
    owner=$DEFAULT_OWNER
  fi
  printf '%s' "$owner"
}

release_field() { # release_field work version: a field of one object in release.json
  sed -n "/^  \"$1\": {/,/^  }/s/.*\"$2\": \"\([^\"]*\)\".*/\1/p" "$RELEASE" | head -n 1
}

wait_for_api() {
  local deadline=$((SECONDS + ${1:-600}))
  until "${KUBECTL[@]}" get --raw=/readyz >/dev/null 2>&1; do
    [ $SECONDS -lt $deadline ] || { log "the Kubernetes API did not become ready"; return 1; }
    sleep 3
  done
}

instance_get() { # instance_get KEY: a value the instance service worked out at boot
  [ -r "$INSTANCE_ENV" ] && sed -n "s/^$1=//p" "$INSTANCE_ENV" | tail -n 1
}

# Lolly Work answers /readyz with 200 through Traefik on this machine.
work_ready() {
  [ "$(curl -sk -o /dev/null -m 5 -w '%{http_code}' https://127.0.0.1/readyz 2>/dev/null)" = 200 ]
}

# Whether the owner address already has a password (the setup link was used).
owner_has_password() {
  local owner=$1 count
  [[ $owner =~ $EMAIL_RE ]] || return 1
  count=$("${KUBECTL[@]}" -n lolly exec lolly-postgres-0 -c postgres -- \
    psql -U lolly -d lollywork -tAc "select count(*) from password_credentials where email = '$owner'" 2>/dev/null || true)
  [ "${count//[[:space:]]/}" = 1 ]
}

# Print a fresh one-time owner setup link (Work's scripts/password-link.ts).
# It works once, for seven days, and replaces any earlier unused link.
issue_owner_link() {
  local owner=$1 out pod
  # The Work pod itself: the deployment's selector also matches its migration Job.
  pod=$("${KUBECTL[@]}" -n lolly get pod -o name --field-selector=status.phase=Running \
    -l app.kubernetes.io/instance=lolly-work,app.kubernetes.io/component=control-plane 2>/dev/null | head -n 1)
  [ -n "$pod" ] || { log "no running Lolly Work pod"; return 1; }
  out=$("${KUBECTL[@]}" -n lolly exec "$pod" -c server -- node scripts/password-link.ts --email "$owner" 2>&1) || {
    log "password-link failed: $(printf '%s' "$out" | tail -n 1)"; return 1; }
  printf '%s\n' "$out" | grep -o 'https://[^[:space:]]*' | head -n 1
}
