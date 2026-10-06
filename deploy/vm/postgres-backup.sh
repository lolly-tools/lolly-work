#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Portable logical backups for a database migration or a restore drill.
set -euo pipefail
umask 077

die() { echo "postgres-backup: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: postgres-backup.sh backup <new-file.dump>
       postgres-backup.sh verify <file.dump>
       postgres-backup.sh restore <file.dump> --confirm-database <empty-database>

Connection: PGSERVICE, or PGHOST + PGDATABASE (with PGUSER and PGPASSFILE).
Restore requires an empty database and never drops existing objects.
USAGE
}

command=${1:-}
file=${2:-}
case "$command" in
  backup|verify) [ "$#" = 2 ] || { usage; exit 1; } ;;
  restore) [ "$#" = 4 ] && [ "$3" = --confirm-database ] || { usage; exit 1; } ;;
  *) usage; exit 1 ;;
esac
[ -n "$file" ] || die "Name a backup file."
case "$file" in /*) ;; *) file="$PWD/$file" ;; esac
command -v pg_restore >/dev/null || die "Install PostgreSQL client tools."

digest() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
verify() {
  [ -f "$file" ] && [ ! -L "$file" ] || die "Backup must be a regular file."
  [ -f "$file.sha256" ] && [ ! -L "$file.sha256" ] || die "Backup checksum is missing."
  expected=$(cat "$file.sha256")
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || die "Invalid backup checksum."
  [ "$(digest "$file")" = "$expected" ] || die "Backup checksum does not match."
  pg_restore --list "$file" >/dev/null
}
connection() {
  [ -n "${PGSERVICE:-}" ] || { [ -n "${PGHOST:-}" ] && [ -n "${PGDATABASE:-}" ]; } ||
    die "Set PGSERVICE, or PGHOST and PGDATABASE; no default database is used."
}

if [ "$command" = verify ]; then
  verify
  echo "Backup checksum and archive verified."
elif [ "$command" = backup ]; then
  connection
  command -v pg_dump >/dev/null || die "Install PostgreSQL client tools."
  [ ! -e "$file" ] && [ ! -L "$file" ] && [ ! -e "$file.sha256" ] && [ ! -L "$file.sha256" ] ||
    die "Backup destination already exists."
  temporary=$(mktemp "$file.partial.XXXXXXXX")
  checksum=$(mktemp "$file.sha256.partial.XXXXXXXX")
  trap 'rm -f -- "$temporary" "$checksum"' EXIT
  pg_dump --no-password --format=custom --no-owner --no-privileges --file="$temporary"
  pg_restore --list "$temporary" >/dev/null
  digest "$temporary" > "$checksum"
  # A hard link refuses a concurrent replacement rather than overwriting it.
  ln "$temporary" "$file"
  ln "$checksum" "$file.sha256"
  echo "Backup saved with a SHA-256 checksum. Copy both files to independent storage."
else
  verify
  connection
  command -v psql >/dev/null || die "Install PostgreSQL client tools."
  target=$(psql --no-password -X -qAt --set=ON_ERROR_STOP=1 --command='SELECT current_database()')
  [ -n "$target" ] && [ "$target" = "$4" ] || die "Connected database does not match --confirm-database."
  [[ "$target" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] || die "Use a database name containing letters, digits, underscores or hyphens."
  case "$target" in postgres|template0|template1) die "Restore into a dedicated Lolly database." ;; esac
  objects=$(psql --no-password -X -qAt --set=ON_ERROR_STOP=1 --command="SELECT
    (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname NOT IN ('public', 'information_schema')) +
    (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') +
    (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema') +
    (SELECT count(*) FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema')")
  [ "$objects" = 0 ] || die "Destination database contains objects; nothing was restored."
  pg_restore --no-password --exit-on-error --single-transaction --no-owner --no-privileges --dbname="$target" "$file"
  echo "Restore completed in one transaction. Run migrations and application acceptance checks before cutover."
fi
