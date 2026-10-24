#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Restore rehearsal, restore step. Verifies the recovered archive, creates the
# application role and a database with the source's locale on the sidecar,
# restores the archive as that role in one transaction, records which
# migrations it holds, and bounds every later transaction on the copy by the
# lock budget.
# It connects only to the sidecar's Unix socket. Bash builtins and the
# PostgreSQL client tools only: the image needs no awk, grep or jq.
set -euo pipefail
umask 077

programs=${REHEARSAL_PROGRAMS:-/programs}
archive=${REHEARSAL_ARCHIVE:-/archive}/database.dump
socket=${REHEARSAL_SOCKET:-/socket}
evidence=${REHEARSAL_EVIDENCE:-/evidence}
major=$(<"$programs/postgres-major")
port=$(<"$programs/postgres-port")
database=$(<"$programs/database")
role=$(<"$programs/app-role")
budget=$(<"$programs/lock-budget-seconds")
expected_sha=$(<"$programs/archive-sha256")
expected_size=$(<"$programs/archive-size")

die() { printf '{"step":"restore","status":"FAILED","reason":"%s"}\n' "$1"; exit 1; }
for name in PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE PGOPTIONS; do unset "$name"; done
export HOME=${TMPDIR:-/tmp} PGHOST=$socket PGPORT=$port PGUSER=rehearsal PGCONNECT_TIMEOUT=10

[[ "$major" =~ ^[0-9]{2}$ && "$port" =~ ^[0-9]{4,5}$ && "$budget" =~ ^[0-9]{1,3}$ ]] || die "bad settings"
[[ "$database" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "bad names"
[[ "$expected_sha" =~ ^[0-9a-f]{64}$ && "$expected_size" =~ ^[1-9][0-9]{0,9}$ ]] || die "bad archive identity"
for tool in psql pg_restore sha256sum; do command -v "$tool" >/dev/null || die "missing $tool"; done
[[ "$(pg_restore --version)" =~ \(PostgreSQL\)\ ${major}\. ]] || die "pg_restore is not PostgreSQL $major"

# 1. The archive is exactly the verified backup, and a dump from the same major version.
[ -f "$archive" ] && [ ! -L "$archive" ] || die "no recovered archive"
actual=$(sha256sum "$archive")
actual=${actual%% *}
actual=${actual#\\}
[ "$actual" = "$expected_sha" ] || die "archive checksum differs from the backup record"
size=$(wc -c <"$archive")
[ "$((size))" = "$expected_size" ] || die "archive size differs from the backup record"
pg_restore --list "$archive" >"$HOME/archive.list" 2>"$HOME/archive.err" || die "archive is not a PostgreSQL custom-format dump"
dumped=false
pattern="^;[[:space:]]*Dumped from database version: ${major}\."
while IFS= read -r line; do
  if [[ "$line" =~ $pattern ]]; then dumped=true; break; fi
done <"$HOME/archive.list"
[ "$dumped" = true ] || die "archive does not come from PostgreSQL $major"

# 2. The sidecar: reachable over the socket only, the expected major version.
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
  if psql -X -qAt -d postgres -c 'select 1' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
[ "$ready" = true ] || die "rehearsal server not reachable"
q() { psql -X -qAt -v ON_ERROR_STOP=1 "$@"; }
[ -z "$(q -d postgres -c "select current_setting('listen_addresses')")" ] || die "rehearsal server listens on TCP"
server_version=$(q -d postgres -c "select current_setting('server_version_num')")
[[ "$server_version" =~ ^${major}[0-9]{4}$ ]] || die "rehearsal server is not PostgreSQL $major"

# 3. A fresh role and database. A second run in the same Pod finds them and stops.
[ "$(q -d postgres -c "select count(*) from pg_database where datname = '$database'")" = 0 ] || die "rehearsal database already exists"
q -d postgres -v role="$role" -v db="$database" >/dev/null <<'SQL' || die "could not create the rehearsal database"
CREATE ROLE :"role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE :"db" OWNER :"role" TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';
SQL

# 4. Restore as the application role (not a superuser), without the source's owners or grants.
started=$SECONDS
pg_restore --no-password --exit-on-error --single-transaction --no-owner --no-privileges \
  --role="$role" --dbname="$database" "$archive" >"$HOME/restore.log" 2>&1 || die "pg_restore failed"
restore_seconds=$((SECONDS - started))

# 5. The migrations the backup holds; none of the pending files may be among them.
q -d "$database" -U "$role" -c 'select name from schema_migrations order by name' >"$evidence/applied-before.txt" 2>"$HOME/applied.err" \
  || die "the backup has no schema_migrations table"
pending=' '
if [ -s "$programs/pending.txt" ]; then
  while IFS= read -r wanted; do pending+="$wanted "; done <"$programs/pending.txt"
fi
names=''
while IFS= read -r name; do
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$ ]] || die "unexpected name in the restored schema_migrations"
  [[ "$pending" != *" $name "* ]] || die "the backup already records a pending migration"
  names+="\"$name\","
done <"$evidence/applied-before.txt"

# 6. Every transaction on the copy, from here until the verify step resets it,
#    is cut off at the lock budget. A migration file that would hold its locks
#    longer on the live database fails here instead.
q -d postgres -v db="$database" -v budget="${budget}s" >/dev/null <<'SQL' || die "could not set the lock budget"
ALTER DATABASE :"db" SET transaction_timeout = :'budget';
SQL

tables=$(q -d "$database" -c "select count(*) from information_schema.tables where table_schema = 'public'")
printf '{"step":"restore","status":"RESTORED","database":"%s","serverVersion":"%s","listenAddresses":"","publicTables":%s,"restoreSeconds":%s,"archiveSha256":"%s","archiveSize":%s,"appliedBefore":[%s]}\n' \
  "$database" "$server_version" "$tables" "$restore_seconds" "$actual" "$expected_size" "${names%,}"
