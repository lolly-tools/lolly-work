#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Restore rehearsal, verify step. After the new image's runner: lifts the lock
# budget, checks schema_migrations is exactly the restored set plus the pending
# files, and measures how long each pending file's transaction ran. Each file's
# transaction starts when the runner records it (schema_migrations.at is the
# transaction start), so a file lasted until the next file's start, and the
# last one until the runner returned.
set -euo pipefail
umask 077

programs=${REHEARSAL_PROGRAMS:-/programs}
socket=${REHEARSAL_SOCKET:-/socket}
evidence=${REHEARSAL_EVIDENCE:-/evidence}
port=$(<"$programs/postgres-port")
database=$(<"$programs/database")
role=$(<"$programs/app-role")
budget=$(<"$programs/lock-budget-seconds")

die() { printf '{"step":"verify","status":"FAILED","reason":"%s"}\n' "$1"; exit 1; }
for name in PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGPASSWORD PGSERVICE PGSERVICEFILE PGPASSFILE PGOPTIONS; do unset "$name"; done
export HOME=${TMPDIR:-/tmp} PGHOST=$socket PGPORT=$port PGUSER=rehearsal PGCONNECT_TIMEOUT=10

[[ "$port" =~ ^[0-9]{4,5}$ && "$budget" =~ ^[0-9]{1,3}$ ]] || die "bad settings"
[[ "$database" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$role" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "bad names"
ended=$(<"$evidence/migrate-ended-at")
[[ "$ended" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$ ]] || die "no migrate end time"
q() { psql -X -qAt -v ON_ERROR_STOP=1 "$@"; }

# The previous image boots next, with no per-transaction limit.
q -d postgres -v db="$database" >/dev/null <<'SQL' || die "could not lift the lock budget"
ALTER DATABASE :"db" RESET transaction_timeout;
SQL

join_names() {
  local file=$1 out='' name
  [ -s "$file" ] || { printf ''; return; }
  while IFS= read -r name; do
    [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$ ]] || return 1
    out+="$name,"
  done <"$file"
  printf '%s' "${out%,}"
}
pending=$(join_names "$programs/pending.txt") || die "bad pending migration name"
before=$(join_names "$evidence/applied-before.txt") || die "bad restored migration name"

result=$(q -d "$database" -U "$role" -v pending="$pending" -v before="$before" -v ended="$ended" -v budget="$budget" <<'SQL'
with pending as (select unnest(string_to_array(nullif(:'pending', ''), ',')) as name),
before as (select unnest(string_to_array(nullif(:'before', ''), ',')) as name),
after as (select name, at from schema_migrations),
expected as (select name from before union select name from pending),
missing as (select name from expected except select name from after),
unexpected as (select name from after except select name from expected),
applied as (
  select a.name, a.at, lead(a.at) over (order by a.at, a.name) as next_at
  from after a join pending p using (name)
),
files as (
  select name, round(extract(epoch from coalesce(next_at, :'ended'::timestamptz) - at)::numeric, 3) as seconds
  from applied
),
verdict as (
  select case
    when exists (select 1 from missing) or exists (select 1 from unexpected) then 'RECORD_MISMATCH'
    when exists (select 1 from files where seconds > :budget) then 'LOCK_BUDGET_EXCEEDED'
    else 'RECORD_OK' end as status
)
select status || E'\t' || json_build_object(
  'step', 'verify',
  'status', status,
  'lockBudgetSeconds', :budget,
  'files', (select coalesce(json_agg(json_build_object('name', name, 'seconds', seconds) order by name), '[]'::json) from files),
  'missing', (select coalesce(json_agg(name order by name), '[]'::json) from missing),
  'unexpected', (select coalesce(json_agg(name order by name), '[]'::json) from unexpected),
  'appliedAfterCount', (select count(*) from after)
)::text
from verdict;
SQL
) || die "verify query failed"
status=${result%%$'\t'*}
printf '%s\n' "${result#*$'\t'}"
[ "$status" = RECORD_OK ] || exit 1
