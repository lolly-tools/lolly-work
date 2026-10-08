# Lolly admission store

This optional HTTPS service replaces the Redis REST store used by Lolly's public
MCP and certificate services. It uses the official minimal
[`@redis/client`](https://github.com/redis/node-redis) package against an operator
managed Redis server. It does not join a workspace or store documents, sessions,
assets, certificates or identity records.

The deployed consumers already use HTTPS REST. Keeping that contract makes the
initial migration a store/configuration release; native Redis support in both
consumers would require two application changes and releases. Native clients
remain a sensible later simplification. This adapter accepts only their exact
fixed-window Lua script, the MCP daily-budget Lua script and the matching two-key
budget `MGET`. It is not a general Redis API. CA and MCP use distinct bearer
credentials; CA cannot read or write daily MCP budgets. Rate keys retain their
existing SHA-256 format and namespace-derived identity so old counters can be
imported without renaming or resetting them.

Both HTTP and Redis connections require verified TLS. The runtime reads secrets
from mounted files, disables Redis's offline command queue, bounds outstanding
commands and returns 503 when the store is unavailable. A timed-out increment
may have committed: it is never automatically retried. Redis errors, credentials,
commands and counter values are excluded from service logs. The service exposes
only HTTPS: `POST /`, process `GET /livez`, and connection `GET /readyz`.
Readiness reports the authenticated Redis connection state, not disk durability.

## Build and run

From this directory, install the separate frozen lockfile and run the tests:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm audit --prod --audit-level high
docker build -t registry.example.com/team/lolly-admission:reviewed .
```

The container uses the pinned SUSE BCI Node 24 base and a non-root UID 1000.
Publish and resolve an immutable digest before deploying. The main Work image
does not include this service or its dependencies. No engine build is needed.

The admission qualification workflow builds an amd64 OCI archive on pull
requests with only `contents: read`. It boots the exact exported runtime config
as UID 1000 on a read-only filesystem, checks verified HTTPS/Redis TLS, role
refusals, outage 503 responses and synthetic AOF counters across restart. The
isolated CI fixture uses the runner's upstream Redis package; AppCo amd64 and
Kubernetes storage/ACL/network acceptance still require separate qualification.
The seven-day `admission-amd64-<workflow-sha>` artifact includes archive SHA-256,
OCI manifest/config digests and source/run identities. Review that evidence
before importing the archive, then remove the recreatable transport copy.

After merge, an explicit `workflow_dispatch` with `publish=true` and the exact
reviewed main `source_sha` may publish `ghcr.io/<owner>/lolly-admission`. Only
that main-only job receives `packages: write` and signing `id-token: write`;
pull request jobs receive neither and no production credentials. Publication
uses `GITHUB_TOKEN` without a wider PAT fallback, boots the published digest,
then signs that digest using the workflow's OIDC identity. It never deploys.
Verify the digest/signature/provenance and site qualifications before use.

Subsequent adapter image changes use the narrow `admission-rest` application
component in [the app update guide](../../deploy/helm/APP-UPDATES.md). The Redis
store, counters, ACLs and volumes remain a separate owned operation.

Required configuration consists of `ADMISSION_TLS_KEY_FILE`,
`ADMISSION_TLS_CERT_FILE`, `ADMISSION_MCP_TOKEN_FILE`, `ADMISSION_CA_TOKEN_FILE`
and `ADMISSION_REDIS_URL_FILE`. The two tokens must be different and contain at
least 32 characters; generate random values. The Redis URL file contains a
`rediss://` connection string, including its Redis credentials. Optional
`ADMISSION_REDIS_CA_FILE` supplies the private Redis CA; certificates and DNS
names are still verified. `ADMISSION_PORT` defaults to 8443. Never put these
secret bytes in source, image layers, command arguments or release reports.

The 16 protocol/HTTP/snapshot tests also run through the root test suite without
installing Redis dependencies into Work. Three integration tests additionally
require `ADMISSION_TEST_FIXTURE` and `ADMISSION_TEST_HTTPS_PORT`. They expect a
fresh isolated local Redis with verified TLS, authentication, and empty
DB 0/1/3/4 test databases;
they write synthetic counters. Do not point them at a shared or production store.
The fixture contains protected `redis-url.txt`, `tls.crt`, `tls.key`,
`mcp-token.txt` and `ca-token.txt`. Integration checks cover concurrent Lua
increments, deadlines, the budget pair, an empty-destination import and the
actual HTTPS process and protected operator CLI/hash guards. AppCo amd64, Kubernetes storage/security/network and
restart/recovery acceptance remain deployment qualifications.

## Counter transfer

`src/transfer.mjs` is an operator tool, not an HTTP endpoint. It exports only
the existing rate counters and MCP daily totals. It preserves integer strings
and exact stored expiry deadlines obtained by an atomic Redis `GET`/`PEXPIRETIME`
Lua snapshot with bracketing `TIME` reads after bounded `SCAN` discovery.
Redis 7 or newer is required. Import uses `SET ... PXAT` with those original
absolute deadlines; elapsed time never becomes a renewed relative TTL.
Discovery and transfer between stores are **not** one atomic transaction.
All admission writers must be
quiesced through the final export, import and consumer switch, including old
Vercel functions and requests arriving through cached DNS. Drain and finish
in-flight usage records before taking the snapshot. A live mirror alone cannot
provide exactly-once counters with the currently deployed single-store clients.

The protected quiescence JSON is an operator attestation, not automatic proof
that the gate is closed. It includes `version: 1`, `sourceHost`, a recent
`recordedAtMs`, `admissionWritersQuiesced: true`, and `consumers: ["mcp", "ca"]`.
Record the independently verified gates and workload identities in the site's
release evidence before writing that attestation. Never attest a live writer as
stopped just to satisfy the tool. A daily budget reset is not a migration.

Export uses the existing store's protected HTTPS URL and token files:

```sh
node src/transfer.mjs export \
  --source-url-file /protected/old-rest-url.txt \
  --source-token-file /protected/old-rest-token.txt \
  --quiescence-file /protected/verified-quiescence.json \
  --out /protected/new-counter-snapshot.json
node src/transfer.mjs plan-import \
  --snapshot /protected/new-counter-snapshot.json \
  --target-url-file /protected/new-redis-url.txt \
  --target-ca-file /protected/new-redis-ca.pem \
  --out /protected/new-import-plan.json
```

Files must be owner-readable only. Output files use mode 0600 and refuse
overwriting existing evidence. Plans pin the snapshot SHA-256 and Redis process
`run_id`, endpoint and database. Imports reject nonempty destinations, stale
snapshots, clock skew over one second, unknown keys, duplicate counters, missing
TTLs or freshened expiry deadlines. The source snapshot is limited to 20,004
counters and five minutes of age; check source provider request limits before
using that maximum. Larger/different key spaces need separate reviewed support.

After reviewing the plan and its printed hash, run the site's production target
preflight immediately before any production candidate mutation, then:

```sh
node src/transfer.mjs apply-import \
  --snapshot /protected/new-counter-snapshot.json \
  --target-url-file /protected/new-redis-url.txt \
  --target-ca-file /protected/new-redis-ca.pem \
  --plan /protected/new-import-plan.json \
  --reviewed-plan-sha256 COPY_THE_REVIEWED_FILE_HASH \
  --out /protected/new-import-receipt.json
```

One bounded Lua operation checks the empty destination before importing. Redis
scripts prevent interleaving; a Redis OOM/storage error can still leave partial
writes because Lua is not a rollback transaction. A timeout or lost connection
can also follow a committed import. Keep the candidate inactive and writers
drained on any failure, inspect the exact isolated target, and do not blindly
retry or flush a shared store. Successful receipts additionally reread counters
and verify original absolute deadlines. Expired counters stay expired.

Rollback before opening the gate can restore the old consumer configuration
because no post-snapshot writes exist. After reopening, the stores diverge:
keep admission fail-closed and transfer the new high-water totals/deadlines under
another verified drain before moving backwards. Never restore an older daily
budget or overwrite a store that has accepted new writes.

See [the SUSE deployment and cutover guide](../../deploy/suse/ADMISSION-STORE.md).
