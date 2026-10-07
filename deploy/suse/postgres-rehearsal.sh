#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# PostgreSQL 18 cutover preparation; restore and creation are rehearsal-only.
set -euo pipefail
umask 077

die() { echo "postgres-rehearsal: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: postgres-rehearsal.sh inspect
       postgres-rehearsal.sh backup <new-file.dump>
       postgres-rehearsal.sh init-target --confirm-database lolly_rehearsal_<suffix>
       postgres-rehearsal.sh restore <file.dump> --confirm-database lolly_rehearsal_<suffix>

Set PGSERVICE, PGSERVICEFILE and PGPASSFILE to private libpq connection files.
Use the direct source connection for inspect/backup. Creation and restore only
accept explicitly named rehearsal databases. No database is dropped.
USAGE
}

mode=${1:-}
case "$mode" in
  inspect) [ "$#" = 1 ] || { usage; exit 1; } ;;
  backup) [ "$#" = 2 ] || { usage; exit 1; } ;;
  init-target) [ "$#" = 3 ] && [ "$2" = --confirm-database ] || { usage; exit 1; }; target=$3 ;;
  restore) [ "$#" = 4 ] && [ "$3" = --confirm-database ] || { usage; exit 1; }; target=$4 ;;
  *) usage; exit 1 ;;
esac
if [ "$mode" = init-target ] || [ "$mode" = restore ]; then
  [[ "$target" =~ ^lolly_rehearsal_[A-Za-z0-9_]+$ ]] || die "Use an explicit lolly_rehearsal_<suffix> target."
fi

for tool in psql pg_dump pg_restore; do
  command -v "$tool" >/dev/null || die "Install the PostgreSQL 18 client tools."
  version=$("$tool" --version)
  [[ "$version" =~ \(PostgreSQL\)\ 18\. ]] || die "All client tools must be PostgreSQL 18; an older dump client cannot export PostgreSQL 18."
done
[[ "${PGSERVICE:-}" =~ ^[A-Za-z0-9_-]+$ ]] || die "Set an explicit libpq PGSERVICE name."
for key in PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGPASSWORD; do
  [ -z "${!key:-}" ] || die "Remove $key; use private service and password files."
done
private_file() {
  local file=$1 permissions owner
  case "$file" in /*) ;; *) die "Connection files must use absolute paths." ;; esac
  [ -f "$file" ] && [ ! -L "$file" ] || die "Connection files must be regular private files."
  if permissions=$(stat -c '%a' "$file" 2>/dev/null); then
    owner=$(stat -c '%u' "$file")
  else
    permissions=$(stat -f '%Lp' "$file")
    owner=$(stat -f '%u' "$file")
  fi
  [ "$owner" = "$(id -u)" ] || die "Connection files must belong to the current operator."
  [[ "$permissions" =~ ^[46]00$ ]] || die "Connection files must have mode 0400 or 0600."
}
private_file "${PGSERVICEFILE:-}"
private_file "${PGPASSFILE:-}"
export PGCONNECT_TIMEOUT=10
# Do not inherit options that could disable read-only source access or timeouts.
export PGOPTIONS='-c statement_timeout=60000 -c lock_timeout=1000'
work=$(mktemp -d "${TMPDIR:-/tmp}/lolly-pg-rehearsal.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
query() {
  if ! psql --no-password -X -qAt --set=ON_ERROR_STOP=1 "$@" 2>"$work/psql.stderr"; then
    die "Database preflight failed; no connection details are logged."
  fi
}
metadata() {
  query <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '500ms';
SELECT current_setting('server_version_num') || '|' || pg_encoding_to_char(encoding) || '|' || datlocprovider::text || '|' || coalesce(datlocale, '') || '|' || current_database()
FROM pg_database WHERE datname = current_database();
ROLLBACK;
SQL
}
check_major() {
  [[ "$server_version" =~ ^18[0-9]{4}$ ]] || die "Source and destination must both be PostgreSQL 18; no downgrade is supported."
}
check_locale() {
  [ "$encoding" = UTF8 ] && [ "$provider" = b ] && [ "$locale" = C.UTF-8 ] ||
    die "Database must use UTF8 with the builtin C.UTF-8 locale."
}
read_metadata() {
  local row
  row=$(metadata)
  IFS='|' read -r server_version encoding provider locale database <<< "$row"
  check_major
}

backup_helper="$(cd "$(dirname "$0")/../vm" && pwd)/postgres-backup.sh"
if [ "$mode" = restore ]; then
  # Verify the archive before opening a destination connection.
  bash "$backup_helper" verify "$2" >"$work/archive.stdout" 2>"$work/archive.stderr" || die "Archive checksum or format verification failed."
  pg_restore --list "$2" >"$work/archive.list" 2>"$work/archive.stderr" || die "Archive format verification failed."
  archive_major18=false
  archive_version_pattern='^;[[:space:]]*Dumped from database version: 18\.'
  while IFS= read -r line; do
    if [[ "$line" =~ $archive_version_pattern ]]; then archive_major18=true; break; fi
  done < "$work/archive.list"
  [ "$archive_major18" = true ] || die "Archive must come from PostgreSQL 18."
fi
read_metadata
if [ "$mode" = init-target ]; then
  [ "$database" = postgres ] || die "Initialize through the rehearsal cluster's postgres maintenance database."
  # psql quotes the checked name as an identifier; no password appears in argv.
  query --set=rehearsal_database="$target" <<'SQL' >/dev/null
CREATE DATABASE :"rehearsal_database" OWNER lollywork TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';
SQL
  echo "Dedicated PostgreSQL 18 rehearsal database created with the source locale."
else
  check_locale
  case "$mode" in
    inspect) echo "PostgreSQL 18; UTF8; builtin C.UTF-8. Read-only compatibility preflight passed." ;;
    backup)
      export PGOPTIONS="$PGOPTIONS -c default_transaction_read_only=on"
      bash "$backup_helper" backup "$2" >"$work/backup.stdout" 2>"$work/backup.stderr" || die "Backup failed; no connection details are logged."
      echo "Private PostgreSQL 18 archive and checksum saved. This is not a final cutover snapshot."
      ;;
    restore)
      [ "$database" = "$target" ] || die "Connected database does not match the confirmed rehearsal target."
      bash "$backup_helper" restore "$2" --confirm-database "$target" >"$work/restore.stdout" 2>"$work/restore.stderr" || die "Restore failed or target is occupied; no existing objects were dropped."
      echo "Rehearsal restore completed. Validate migrations, assets, collaboration and recovery before cutover."
      ;;
  esac
fi
