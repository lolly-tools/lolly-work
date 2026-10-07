# Encrypted off-host PostgreSQL backups

`postgres-backup-cronjob.py` renders an optional, suspended CronJob. It takes a
PostgreSQL 18 snapshot in an init container, then encrypts, uploads and verifies
it using the standalone bundle of `scripts/backup-object.ts` in Node 24. It does
not install a monitoring stack or enable a schedule automatically.

The database container sees only its TLS CA and read-only libpq credentials. The
uploader sees only the shared archive and separate object-storage/encryption
credentials. Both run as UID 1000, drop capabilities, use runtime seccomp and a
read-only root filesystem, and mount no Kubernetes API token. Their scratch
volumes are separate. The shared archive volume is bounded at 256 MiB; the
upload helper accepts at most 128 MiB and fails visibly above that bound. Review
larger-instance budgets before raising limits or replacing the helper.

## Prepare operator inputs

Create a dedicated database backup login through a protected operator session.
Use a new random password supplied through private stdin, never CLI arguments
or public logs. Grant `CONNECT` on the target database and the `pg_read_all_data`
role; set `default_transaction_read_only=on`. Give it no superuser, role creation,
database creation or replication privilege. Review row-level security: the
built-in read role does not bypass RLS, so a successful full dump must be tested.
Do not alter the production database during a candidate rehearsal.

Create namespace Secret `lolly-postgres-backup-connection` with these file keys:

- `pg_service.conf`: service `[backup]`, exact database/host/user, port 5432,
  `sslmode=verify-full`, `sslrootcert=/etc/lolly/postgres/ca.crt` and
  `connect_timeout=10`.
- `pgpass`: the matching libpq password entry for that database only.

The server hostname must match its certificate. ConfigMap `lolly-postgres-ca`
contains the public `ca.crt`. The init container copies its connection files to
mode 0600 private scratch and verifies that its actual connection uses TLS.
Protected files are not passed to the uploader.

Create separate Secret `lolly-backup-upload` with `storage.json` and
`encryption-key.txt`. The JSON uses the upload helper's reviewed HTTPS endpoint,
region, dedicated private bucket, object prefix and scoped access credentials.
The encryption key is 64 lowercase hexadecimal characters. Keep an independent,
protected recovery copy of the key. Do not put credentials in values files,
command arguments, generated artifacts in Git or public registries.

Create ConfigMap `lolly-backup-operator` with portable
`deploy/vm/postgres-backup.sh` as `postgres-backup.sh` and a reviewed standalone
bundle of `scripts/backup-object.ts` as `backup-object.mjs`. The container images
must be immutable digest references. The renderer defaults to the locked AppCo
PostgreSQL 18 image; `--pg-image` permits another separately qualified PostgreSQL
18 client image. Registry credentials stay in the namespace pull Secret.

## Render and rehearse

```sh
python3 deploy/suse/postgres-backup-cronjob.py \
  --node-image "$LW_BACKUP_NODE_IMAGE" > /path/to/private/backup-cronjob.json
```

Inspect the manifest and validate it against the intended Kubernetes version.
Keep its default `suspend: true`. Under namespace default deny, permit the
backup-labelled pod to reach only the intended PostgreSQL service, scoped
cluster DNS and public HTTPS for its object-storage endpoint. The pod has no
inbound service. Add these rules explicitly; do not undo the namespace deny with
unrestricted egress. Apply the reviewed object only to the intended namespace.

Run a manual Job from the suspended CronJob. Require snapshot/checksum success
and the uploader's `VERIFIED` result, which includes a complete object GET,
ciphertext check, authenticated decryption and plaintext integrity comparison.
Then independently recover the object to a new private file, verify its checksum
and restore it into an explicitly empty disposable PostgreSQL 18 database. Run
the migration, asset and application acceptance checks before enabling daily
scheduling. Record failures and restore evidence; Kubernetes Job success alone
does not prove a usable restore.

The schedule is daily at 02:00 UTC, forbids overlapping runs and has a ten-minute
deadline. It retains one successful and two failed Jobs, with a one-day finished
Job TTL. These are small-instance starting limits. Monitor missed/failed Jobs
using the deployment's existing observability and test recovery periodically.
Object retention and immutability must be reviewed separately for the selected
storage provider; the CronJob does not delete old backups.

A database backup covers stored sessions, memberships and database-backed blobs.
Complete recovery also requires the instance configuration, signing/credential
keys, private pack, release identity and independent encryption-key escrow.
Preserve and protect those separately before claiming disaster recovery.
