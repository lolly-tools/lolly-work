#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Restore rehearsal, PostgreSQL sidecar. Runs a fresh cluster on emptyDir that
# listens on a Unix socket only (no TCP), for the other containers of this Pod.
# It never has a network listener, a password or a connection to any other
# database. Its log never carries statements (so no row data); the driver reads
# it only for "terminating connection due to transaction timeout", the sign
# that a migration file ran past the lock budget.
set -euo pipefail
umask 077

programs=${REHEARSAL_PROGRAMS:-/programs}
data=${REHEARSAL_PGDATA:-/pgdata/cluster}
socket=${REHEARSAL_SOCKET:-/socket}
major=$(<"$programs/postgres-major")
port=$(<"$programs/postgres-port")

die() { printf '{"step":"postgres","status":"FAILED","reason":"%s"}\n' "$1"; exit 1; }
for name in PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE PGOPTIONS; do unset "$name"; done
export HOME=${TMPDIR:-/tmp}

[ "$(id -u)" != 0 ] || die "refusing to run as root"
for tool in initdb postgres; do command -v "$tool" >/dev/null || die "missing $tool"; done
version=$(postgres --version)
[[ "$version" =~ \(PostgreSQL\)\ ${major}\. ]] || die "server is not PostgreSQL $major"

# initdb needs a passwd entry for its user. Some images ship none for UID 1000;
# use the image's nss_wrapper with a temporary entry, never the real account file.
if command -v getent >/dev/null && ! getent passwd "$(id -u)" >/dev/null 2>&1; then
  wrapper=''
  for candidate in /usr/lib64/libnss_wrapper.so /usr/lib/libnss_wrapper.so /usr/lib/x86_64-linux-gnu/libnss_wrapper.so /usr/lib/aarch64-linux-gnu/libnss_wrapper.so; do
    if [ -f "$candidate" ]; then wrapper=$candidate; break; fi
  done
  [ -n "$wrapper" ] || die "no passwd entry for this user and no nss_wrapper"
  printf 'rehearsal:x:%s:%s::%s:/bin/bash\n' "$(id -u)" "$(id -g)" "$HOME" >"$HOME/nss-passwd"
  printf 'rehearsal:x:%s:\n' "$(id -g)" >"$HOME/nss-group"
  export LD_PRELOAD=$wrapper NSS_WRAPPER_PASSWD=$HOME/nss-passwd NSS_WRAPPER_GROUP=$HOME/nss-group
fi

if [ ! -s "$data/PG_VERSION" ]; then
  # A restart of this sidecar keeps the cluster; a first start creates it.
  if ! initdb --pgdata="$data" --username=rehearsal --auth-local=trust --auth-host=reject \
    --encoding=UTF8 --locale-provider=builtin --builtin-locale=C.UTF-8 --no-instructions >"$HOME/initdb.log" 2>&1; then
    die "initdb failed"
  fi
  cat >>"$data/postgresql.conf" <<CONF
listen_addresses = ''
unix_socket_directories = '$socket'
unix_socket_permissions = 0700
port = $port
max_connections = 20
shared_buffers = '64MB'
log_min_messages = warning
log_min_error_statement = panic
log_error_verbosity = terse
log_statement = 'none'
CONF
fi
exec postgres -D "$data"
