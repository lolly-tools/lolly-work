# PostgreSQL 18 restore rehearsal

The live lolly.ing database was inspected on 7 October 2026 using a read-only
transaction. It runs PostgreSQL 18.6 with UTF8, the builtin `C.UTF-8` locale
provider, and only the standard `plpgsql` extension. Its measured size was
50,413,568 bytes, with 62 user tables and 49 applied migrations. These are
planning measurements, not a final cutover snapshot.

The Application Collection candidate now uses PostgreSQL `18.6-16.3`, pinned
by multi-architecture digest in `appco-postgresql.lock.json`. PostgreSQL 17
must not be used to restore this source. The installed local client tools were
17.11, so the rehearsal needs PostgreSQL 18 clients from the verified image or
another separately qualified source. PostgreSQL documents the
[dump client and destination version limits](https://www.postgresql.org/docs/18/app-pgdump.html).

The chart remains a separate optional release. Work's normal Helm chart still
accepts an external database and requires no Application Collection account.
Do not run this rehearsal on the existing production VM: its available disk
and memory do not provide room for an additional database and restore.

## Candidate and resource budget

Use the locked chart 0.8.0 archive and check its SHA-256 before rendering. The
18.6 image index, both architecture manifests, chart, SPDX SBOMs and SLSA v1
provenance must pass the
[official signature and transparency checks](https://docs.apps.rancher.io/developer-toolkit/verify-signatures-with-cosign).
Signature verification establishes origin and integrity; vulnerability and
license policy acceptance is a separate release gate.

A disposable database-only rehearsal can start with one CPU, a 512 MiB memory
limit, at least 2 GiB free memory for the container runtime and its client, and
several GiB of free disk for the image, archive, data, WAL and temporary files.
The maintained Kubernetes candidate requests a 16 GiB RWO volume and permits
1 GiB database memory. These are starting budgets, not a benchmark for the
whole Lolly deployment. A successful native arm64 container rehearsal does not
qualify amd64, CSI volume permissions, a Kubernetes rollout or a production
storage failure. Qualify those on the intended candidate node before cutover.

Keep database ports private. Use a separate namespace or rootless container,
separate generated credentials, and clearly named rehearsal volumes. Preserve
the production database, user containers and global registry login. Registry
credentials belong in a temporary owner-readable auth file; remove only that
file when finished. Never pass passwords or connection URLs as CLI arguments.

## Preserve the source locale

Chart 0.8.0 calls `initdb` without locale flags and creates `auth.database` from
its cluster template. The image's default locale is `en_US.utf8`; this does not
match the source's builtin `C.UTF-8`. The maintained profile therefore leaves
`auth.database` empty while creating the `lollywork` role. Create the database
explicitly after boot using a separate rehearsal administrator connection:

```sql
CREATE DATABASE lolly_rehearsal_20261007
  OWNER lollywork TEMPLATE template0 ENCODING 'UTF8'
  LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8';
```

This matches PostgreSQL's
[database locale creation contract](https://www.postgresql.org/docs/18/sql-createdatabase.html).
The helper below performs this creation only for an explicitly confirmed
`lolly_rehearsal_<suffix>` name, connected to the candidate's `postgres`
maintenance database. It never drops or recreates an existing database.

The chart runs PostgreSQL as UID 1000 and overrides the image entrypoint and
`PGDATA` with `/mnt/postgresql/data/pgdata`. Test its actual mounted scripts,
data ownership, TLS key ownership and certificate SANs. The profile gives the
pod group 1000 and mounts a bounded 8 MiB socket directory at `/run/postgresql`
so UID 1000 can create its Unix socket. It also drops Linux capabilities, uses
the runtime seccomp profile and disables service-account token mounting. Test
actual restricted namespace admission before promotion. A direct Docker
entrypoint boot with `/var/lib/postgresql/18/docker` does not test that chart
contract. The profile references existing auth, registry and TLS Secrets;
changing a Secret after initialization does not automatically rotate existing
database passwords. Create rehearsal passwords from random hex bytes so the
chart's initial SQL interpolation cannot receive quote characters.

## Private connections and guarded commands

Create owner-readable regular files with mode 0600 or 0400, using absolute
paths. The service file names connections; the password file supplies their
passwords. Source and destination identities must remain separate. Use the
source's direct connection, not a transaction pooler. For a public CA chain,
PostgreSQL 18 accepts `sslrootcert=system` with `sslmode=verify-full`; for the
candidate use the dedicated CA file and a hostname covered by its certificate.

An example service file contains no password:

```ini
[source]
host=direct-source-host
port=5432
dbname=source-database
user=source-reader
sslmode=verify-full
sslrootcert=system

[rehearsal-admin]
host=candidate-database-host
port=5432
dbname=postgres
user=postgres
sslmode=verify-full
sslrootcert=/private/rehearsal-ca.crt

[rehearsal-target]
host=candidate-database-host
port=5432
dbname=lolly_rehearsal_20261007
user=lollywork
sslmode=verify-full
sslrootcert=/private/rehearsal-ca.crt
```

Write the corresponding entries into the private `PGPASSFILE` without logging
its contents. Remove ambient `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGUSER`,
`PGDATABASE` and `PGPASSWORD` overrides before using the helper. It requires
PostgreSQL 18 clients, bounds connections and statements, validates the major
version and source locale, and suppresses connection details from failure
output. Source metadata uses `BEGIN READ ONLY`; the dump also requests a
read-only transaction. The archive helper retains its existing no-overwrite,
checksum and single-transaction empty-target checks. Checksum extraction and
archive version inspection use Bash builtins; the minimal Collection image
does not need an additional `awk` or `grep` package.

```sh
export PGSERVICEFILE=/private/rehearsal/pg_service.conf
export PGPASSFILE=/private/rehearsal/pgpass

PGSERVICE=source bash deploy/suse/postgres-rehearsal.sh inspect
PGSERVICE=source bash deploy/suse/postgres-rehearsal.sh backup /private/rehearsal/source.dump

PGSERVICE=rehearsal-admin bash deploy/suse/postgres-rehearsal.sh \
  init-target --confirm-database lolly_rehearsal_20261007
PGSERVICE=rehearsal-target bash deploy/suse/postgres-rehearsal.sh inspect
PGSERVICE=rehearsal-target bash deploy/suse/postgres-rehearsal.sh \
  restore /private/rehearsal/source.dump --confirm-database lolly_rehearsal_20261007
```

Restore refuses a PostgreSQL 17 archive, a different database, a wrong locale,
a nonempty destination, or a production-style database name. A second restore
must fail. It does not use `--clean` or `--create`. Its one-minute per-statement
budget is suitable for the measured small database; a larger estate needs a
reviewed budget rather than silently disabling timeouts.

## Acceptance and final cutover

While production writers continue during rehearsal, `pg_dump` takes a
consistent snapshot. Compare records against that snapshot, not a later live
query. For stronger evidence, a bounded read-only source session can export a
snapshot, calculate only counts and aggregate digests, and keep it open while
PostgreSQL 18 `pg_dump --snapshot` copies the database. Close it with `ROLLBACK`
as soon as the dump finishes. Do not log customer records, credentials or blob
contents. Store the archive and checksum under `lolly-private`, not in Git.

Verify all pending migration names against the candidate's migration files,
project memberships, sessions, collaboration checkpoints and journals,
comments, invitation state, passkey and agent grants. For uploaded images,
compare blob counts, lengths and content digests; database records alone are
insufficient when the instance uses an S3 blob provider. Copy and validate the
object store separately when applicable. Boot Work against the disposable
restore and exercise login, shared asset fetch, collaboration, agents, render
and export before declaring application acceptance.

Record dump and restore time, resource use, TLS validation and an attempted
second restore. Keep a tested independent backup before a production writer
pause. A rehearsal copy is not the final snapshot: the final cutover must
drain collaboration, stop all database writers and workers, take a fresh
consistent copy, restore and validate it, and then change the Work connection.
Neon remains the rollback source until the new deployment is accepted. After
writes resume on the new database, rolling back needs an explicit data
reconciliation plan; a DNS change does not copy those writes back to Neon.

## Recorded native rehearsal

On 7 October 2026 the locked native arm64 image passed a rootless Podman boot
using chart 0.8.0's mounted entrypoint scripts, UID 1000, the bounded socket
mount and TLS with hostname and CA verification. A real read-only exported
source snapshot produced a 22,383,284-byte archive. Production writers remained
running; no production database or registry configuration was changed.

Restore into the empty source-matching PostgreSQL 18 database completed in
1.041 seconds with a 512 MiB memory limit and one CPU. The measured memory
sample after validation was 73.18 MB; it is not a peak-memory measurement. All
12 selected critical table counts and aggregate record digests matched the
snapshot, including uploaded blob contents and collaboration persistence.
The 20 blobs held 18,677,908 bytes with no declared-size mismatches. All 49
migration filenames matched the source records, and a second restore was
refused. The archive and checksum remain in owner-readable private storage;
owned containers, volumes, secrets, temporary auth and verifier files were
removed.

This qualifies the native database restore path for that sample. It does not
qualify the intended amd64 node, Kubernetes CSI/TLS mounts, vulnerability or
license policy, Work application acceptance or production cutover. The dump
coordinator initially delayed process exit after closing its read-only
transaction, so dump duration was not recorded. The valid complete archive was
reused; do not treat the restore timing as an end-to-end recovery objective.
