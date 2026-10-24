# Restore rehearsal

`restore-rehearsal.py` proves three things on a throwaway copy of a database before a deploy changes the live one:

1. the backup restores;
2. the pending migrations apply with the **new** image's own runner, and no file holds its locks longer than the lock
   budget (30 s by default);
3. the **previous** image still boots on the migrated schema and can save a document, so rolling the application back
   would work.

Then it deletes everything it created. The lolly.ing path of the preview deploy command (Phase 2) is to call it
whenever migrations are pending, and once a month when nothing is. Any operator can run it by hand against their own
cluster.

Python 3.9 or newer, standard library only. It drives a kubectl-like executable (`k3s kubectl`, `kubectl`, or a test
fake), so it runs on the node or anywhere with cluster access. It lives here, in the pinned preview tool tree, and not
in `scripts/`, which is copied into every Work image.

## What one run does

One Pod, in a dedicated namespace. Its containers run in this order:

| Step | Image | Does |
|---|---|---|
| `fetch` | previous Work image | Recovers exactly the named backup object with the image's own `scripts/backup-object.ts` (authenticated decryption, plaintext digest) and checks its sha256, size and key id against the backup record. The only container that mounts the backup credential. |
| `postgres` | pinned PostgreSQL 18 | A native sidecar: a fresh cluster on `emptyDir` that listens on a Unix socket only. No TCP listener, no password, no statements in its log. |
| `restore` | pinned PostgreSQL 18 | Checks the archive bytes and that it is a PostgreSQL 18 dump, creates a non-superuser application role and a database with the source's `builtin` `C.UTF-8` locale, restores as that role in one transaction, records which migrations it holds, and sets `transaction_timeout` to the lock budget. |
| `migrate` | **new** Work image | Runs `scripts/migrate.ts` with only `DATABASE_URL`, `LW_MIGRATE_EXPECT` and `NODE_ENV`, the environment the live migrate Job gets. It first checks the image's runner knows `LW_MIGRATE_EXPECT` and that its migration files have the expected sha256. |
| `verify` | pinned PostgreSQL 18 | Lifts the budget, checks `schema_migrations` is exactly the restored set plus the pending files, and times each file. |
| `previous` | **previous** Work image | Boots that image's server with `LW_AUTO_MIGRATE=false` against the migrated copy (it refuses to start if the schema lacks a file it expects), signs in with a throwaway development account, creates a project and a document, saves it, and reads it back. |

The driver reads each step's own report from its log and checks it again: the archive identity, the files the runner
applied, `schema_migrations` afterwards, every file's time against the budget, and that each container ran the image
digest it was given and did not restart.

### The lock budget

The `migrate` step runs with `transaction_timeout` set to the budget, so a file that runs longer is cut off and the
rehearsal fails with `LOCK_BUDGET_EXCEEDED` (the driver confirms it from the PostgreSQL log). When every file finishes,
the `verify` step measures each one: the runner records a file in `schema_migrations` inside the file's own
transaction, and `now()` there is the transaction start, so a file lasted until the next file started, and the last
one until the runner returned. A file over the budget fails the rehearsal. On the live database such a file would hold
its locks, and block writers, for about as long.

## Isolation

- **Namespace.** Its own namespace, labelled `app.kubernetes.io/managed-by=lolly-restore-rehearsal` and enforcing the
  `restricted` Pod Security level. The driver refuses the live namespaces (`lolly-private`, `lolly-public`,
  `lolly-edge`, ...) and any `kube-` namespace, and refuses a namespace without the label.
- **Network.** A deny-all NetworkPolicy and one egress rule: TCP 443 to the backup store's addresses. The Pod has no
  DNS (`dnsPolicy: None`); the store's name resolves from a fixed `hostAliases` entry. Before each run the driver
  checks that the namespace holds exactly these two policies, that the egress rule is still TCP 443 to IP blocks only,
  and that the store's address is inside it.
- **Data.** Everything lives on `emptyDir` and goes with the Pod. A ResourceQuota allows one Pod and no
  PersistentVolumeClaims.
- **Credentials.** Only the read-only backup credential, mounted into the `fetch` container alone, from the previous
  (live, accepted) image. The driver never reads a Secret, never creates one, and never names the live database
  Secret, a live claim or a live workload. The `migrate` container's environment is the three variables above; the
  `previous` server gets random throwaway secrets and an evaluation config.
- **Teardown.** The driver deletes the Pod and then the ConfigMap by UID (`delete --raw` with `preconditions.uid`) and
  waits until each is gone, whatever the result. `cleanup` removes what a crashed run left, only objects carrying this
  tool's labels, and never while a rehearsal Pod is running.

The namespace itself is not deleted per run. A per-run namespace would need the backup credential copied into it each
time, which means the tool would hold and write a Secret. Here the operator installs the credential once, and the
driver only references it by name.

## One-time setup (by the operator)

Requirements: Kubernetes 1.29 or newer (native sidecar containers), a NetworkPolicy controller that enforces policies
(K3s's built-in one does unless disabled), and the three images on the node by digest or a pull Secret in the
namespace.

1. Render the namespace objects, review them and apply them:

   ```sh
   python3 deploy/preview/restore-rehearsal.py setup --egress-cidr <backup store address>/32 > rehearsal-setup.json
   k3s kubectl apply -f rehearsal-setup.json
   ```

   Name every address the store's host resolves to. `0.0.0.0/0`, `::/0`, loopback and link-local ranges are refused.

2. Create the read-only backup credential by hand, in that namespace only. Use a storage key that can **read** the
   backup prefix and nothing else, and the backup encryption key:

   ```sh
   k3s kubectl -n lolly-restore-rehearsal create secret generic restore-rehearsal-backup-read \
     --from-file=storage.json=/path/to/read-only-storage.json \
     --from-file=encryption-key.txt=/path/to/encryption-key.txt
   ```

   `storage.json` has the same fields as the backup uploader's (`deploy/suse/POSTGRESQL-BACKUPS.md`). Its `endpoint`
   host must be the `--storage-host` the rehearsal is given.

## Running it

```sh
python3 deploy/preview/restore-rehearsal.py plan  <run options>      # print the ConfigMap and Pod; contacts nothing
python3 deploy/preview/restore-rehearsal.py run   <run options> --kubectl '["/usr/local/bin/k3s", "kubectl"]'
python3 deploy/preview/restore-rehearsal.py cleanup --kubectl '["/usr/local/bin/k3s", "kubectl"]'
```

Run options:

| Option | Value |
|---|---|
| `--backup FILE` | The backup uploader's result line, exactly `{"status": "VERIFIED", "object", "sha256", "size", "keyId"}`, from the fresh backup Job's log. |
| `--pending FILE` or `none` | The pending migration files as `[{"name", "sha256"}]`, for example the `migrations` of `node scripts/classify-migrations.ts --json --only <pending>`. `none` for a rehearsal without migrations. |
| `--new-image`, `--previous-image` | The Work images, `repository@sha256:...`. |
| `--postgres-image` | The PostgreSQL 18 image the live database runs, by digest (`deploy/suse/appco-postgresql.lock.json` for the AppCo image). |
| `--storage-host`, `--storage-address` | The backup store's host name and the address the Pod reaches it at. |
| `--lock-budget` | Seconds per file, 1 to 120 (default 30). |
| `--deadline` | Seconds for the whole Pod, 120 to 3600 (default 900). |
| `--namespace`, `--secret`, `--pull-secret`, `--run-id`, `--pgdata-size` | Defaults: `lolly-restore-rehearsal`, `restore-rehearsal-backup-read`, none, a timestamp, `4Gi`. |

The deploy command calls the same code as a library: `preview_rehearsal.Rehearsal(Kubectl(argv), Inputs(...)).run()`.

## Results

`run` prints one JSON object: the inputs, `result`, `code`, `reason`, each step's report, each file's seconds, the UIDs
it created and the teardown. Exit status: `0` passed, `1` failed, `2` refused before creating anything (or bad
input), `3` something it created is still present.

| Code | Meaning |
|---|---|
| `KUBERNETES_TOO_OLD`, `NAMESPACE_UNSAFE`, `POLICY_DRIFT`, `STORAGE_OUTSIDE_POLICY`, `REHEARSAL_BUSY` | Refused in the read-only preflight. Nothing was created. |
| `ADMISSION_CHANGED` | The API server's dry run changed the Pod (for example an injected container). Refused. |
| `POD_NOT_STARTED` | The Pod never started: usually a missing credential Secret or an image not on the node. |
| `ARCHIVE_UNVERIFIED` | The backup object could not be recovered, or is not the named backup. |
| `RESTORE_FAILED` | The archive is not a PostgreSQL 18 dump of the expected bytes, or did not restore. |
| `MIGRATE_REFUSED` | The runner's pending set on the copy differs from `LW_MIGRATE_EXPECT`. |
| `MIGRATE_EXPECT_UNSUPPORTED`, `IMAGE_FILE_MISMATCH` | The new image's runner predates `LW_MIGRATE_EXPECT`, or its migration files differ from the reviewed ones. |
| `MIGRATE_FAILED` | A migration failed on the copy. |
| `LOCK_BUDGET_EXCEEDED` | A file ran past the lock budget. |
| `RECORD_MISMATCH` | `schema_migrations` is not the restored set plus exactly the pending files. |
| `PREVIOUS_IMAGE_FAILED` | The previous image did not boot on the migrated schema, or its save round trip failed. Rolling back to it would not work. |
| `EVIDENCE_MISMATCH` | A report disagrees with the inputs, a container ran another image, or a container restarted. |
| `TIMEOUT` | The Pod ran past its deadline. |

## What it does not prove

- The live database's timing under load. The copy runs on the same node without other writers, so a file that locks a
  large, busy table can take longer live.
- The live configuration. The previous image boots with an evaluation config and a development sign-in; identity
  providers, the shell, catalog signing, collaboration and the render worker are not exercised.
- Blobs kept outside the database (an S3 blob store), which a database backup does not hold.
- A rollback across a change to stored document formats outside SQL.

## Checking the programs locally

The in-Pod programs in `rehearsal/` read their paths from `REHEARSAL_*` variables when set (`REHEARSAL_PROGRAMS`,
`REHEARSAL_APP`, `REHEARSAL_ARCHIVE`, `REHEARSAL_SOCKET`, `REHEARSAL_EVIDENCE`, `REHEARSAL_PGDATA`,
`REHEARSAL_BACKUP_SECRET`), so they can be run against a local PostgreSQL and checkouts. The Pod never sets them.
