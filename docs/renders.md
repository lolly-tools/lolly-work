# Recoverable renders

Submit a render or a batch, keep its status and output, and recover interrupted work
after restarting the server. The request uses the existing Lolly tool inputs and
renderer. Each resource belongs to the user or service token that submitted it.

## Submit and retrieve

Save a request as `render.json`, using a tool from your instance:

```json
{
  "toolId": "qr-code",
  "format": "svg",
  "inputs": { "url": "https://example.com" },
  "priority": 0,
  "maxAttempts": 3
}
```

```bash
lw renders submit render.json --idempotency-key campaign-qr-v1 --json
lw renders list --json
lw renders show <renderId> --json
lw renders output <renderId> --out qr.svg
lw renders evidence <renderId> --out evidence.json
lw renders cancel <renderId>
lw renders retry <renderId> --idempotency-key campaign-qr-retry --json
```

`submit` returns the resource id immediately. `show` reports `queued`, `running`,
`succeeded`, `failed` or `cancelled`, the number of attempts, and a structured
failure when one occurs. Output is available after success. Download verifies
the retained bytes against the resource's SHA-256 receipt.

The same principal and idempotency key return the original resource for an
equivalent request, including objects whose keys were written in a different
order. Reusing the key with different input values returns `409
IDEMPOTENCY_KEY_REUSED`. Keep the original key if an HTTP response is lost.

`priority` is an integer from 0 to 9 (higher runs first); `maxAttempts` is 1 to 5
and defaults to 3. Transient failures retry with bounded backoff. Invalid input
and policy refusals stop without consuming the remaining retry budget. A manual
retry creates a new resource with `retryOf` naming its predecessor; the original
history stays intact. Cancellation retains the resource and prevents an active
attempt from publishing its result.

## HTTP

| Method and path | Result |
|---|---|
| `POST /api/v1/renders` | Typed request above; `202` for a new resource, `200` for an idempotent replay |
| `GET /api/v1/renders?limit=50&offset=0` | Caller-owned, currently permitted resources; `nextOffset` for pagination; limit 1–100 |
| `GET /api/v1/renders/:id` | Request, state, attempts and output receipt |
| `GET /api/v1/renders/:id/output/default` | Retained bytes; `409` before success or on integrity failure, `410` if missing |
| `GET /api/v1/renders/:id/evidence` | Retained execution receipt; `409` before success or on receipt integrity failure, `404 EVIDENCE_UNAVAILABLE` for older outputs without evidence |
| `DELETE /api/v1/renders/:id` | Cancel queued/running work; completed history is retained and returns `409` |
| `POST /api/v1/renders/:id/retry` | New resource from a failed/cancelled predecessor; accepts `Idempotency-Key` |

Authentication is required even on an open instance. Create, execute and read
check current tool visibility, `tool.use` and `export.server`. Each attempt
resolves the current member or service token; disabling the member, revoking the
token or removing the grant prevents queued work from executing. Cancellation
remains available to the authenticated owner after losing a tool grant. These
routes share `rateLimit.automation`.

## Batches with durable rows

Use `/api/v1/render-batches` when each row needs its own retained result and
recovery history. Save this as `batch.json`:

```json
{
  "toolId": "qr-code",
  "format": "svg",
  "inputs": {},
  "rows": [
    { "key": "home", "inputs": { "url": "https://example.com" } },
    { "key": "support", "inputs": { "url": "https://example.com/support" } }
  ]
}
```

Each row shallowly overrides the shared `inputs`. Nested objects and arrays are
replaced as whole values. Row keys are unique, case-sensitive identifiers:
1–80 letters, digits, underscores or hyphens, starting with a letter or digit.
Their order is preserved. A batch accepts 1–200 rows, uses the same `priority`
and `maxAttempts` for every row, and limits the expanded requests to 2 MB.
The HTTP JSON body limit is 512 KiB. Unknown fields and invalid tool inputs
reject the entire submission before any child is allocated.

```bash
lw render-batches submit batch.json --idempotency-key campaign-qr-v1 --json
lw render-batches list --json
lw render-batches show <batchId> --json
lw render-batches manifest <batchId> --out manifest.json
lw render-batches cancel <batchId>
lw render-batches retry <batchId> --idempotency-key campaign-qr-v1-retry --json
lw renders output <childRenderId> --out qr.svg
```

The parent and new child renders commit in one transaction. The existing
render runner claims the children individually, using the same concurrency,
lease, policy and output checks as a single render. Recovery runs unfinished
children; completed children retain their ids, attempts and output receipts.

`show` and `manifest` read a consistent snapshot of the parent and its children.
They report per-state counts and ordered rows containing the row key, render id,
request, attempt, failure and, after success, the output URL and SHA-256 receipt.
The downloadable JSON adds `manifestVersion: 1`. It is a status snapshot, not
an approved release or a ZIP archive. Retrieve each output through its child
render URL. Successful rows remain downloadable even if another row fails.

A batch starts `queued` and becomes `running` when any row starts or finishes.
Once every row is terminal, its state is `failed` if any row failed, otherwise
`cancelled` if any row was cancelled, otherwise `succeeded`. `progress.done`
counts all terminal rows, including failures and cancellations. Counts are
derived from child records, so they cannot drift from a separately saved counter.

Cancellation atomically stops all unfinished children and retains successful
and failed rows. A retry requires a terminal batch with at least one failed or
cancelled row. It creates a new parent with `retryOf`, reuses successful child
resources, and creates new linked renders only for unsuccessful rows. The old
manifest remains unchanged. Retried rows use current policy and content;
reused rows keep their original bytes. This can produce a batch containing
outputs from different content versions until dependency locking is available.
A direct `lw renders retry` creates an independent render; use the batch retry
to obtain a new parent manifest with replacements.

| Method and path | Result |
|---|---|
| `POST /api/v1/render-batches` | Request above; `202` on creation, `200` on idempotent replay |
| `GET /api/v1/render-batches?limit=10&offset=0` | Caller-owned summaries and `nextOffset`; limit 1–20 |
| `GET /api/v1/render-batches/:id` | Parent and ordered child status |
| `GET /api/v1/render-batches/:id/manifest` | Download the current JSON manifest |
| `DELETE /api/v1/render-batches/:id` | Cancel unfinished rows; `409` if already terminal with no cancelled rows |
| `POST /api/v1/render-batches/:id/retry` | New parent retaining successes; accepts `Idempotency-Key` |

Batch idempotency keys are scoped to the submitting principal and separate from
single-render keys. Creation, retrieval and retry check current tool grants;
cancellation remains available to the owner after a grant is removed. These
routes also share `rateLimit.automation`. The existing `/api/v1/batch` job/ZIP
contract remains separate; it does not create these child resources.

## Execution evidence

New durable renders, including batch children, retain an execution receipt with
their output. The output descriptor links to `/api/v1/renders/:id/evidence` and
reports the receipt id and `coverage: "partial"`. Download it with
`lw renders evidence <renderId> --out evidence.json`.

The receipt records:

- The control plane's engine/document API versions, loaded tool version, file
  digests and combined source hash. A source edit is visible even if the tool's
  declared version stays the same.
- Hashes of prepared input values, profile and groups; policy/catalog versions;
  format, pixel dimensions, watermark, renderer/rasterizer choice and configured
  signing-certificate digest. Profile values and provider credentials are not
  copied into the receipt.
- For the local runtime, hashes of the engine's initialized input values and
  hydrated markup, plus initialization hook-error and dropped-asset counts.
- Catalog/provider asset reads observed through Work's bridges: logical id,
  format, declared version when available, actual byte digest and size. These
  digests come from read bytes rather than trusting a catalog checksum. Asset
  bytes and internal storage references are not included.
- The output SHA-256 and a digest of the complete receipt. Output and evidence
  settle under the same worker lease; a stale attempt cannot replace either.

Durable attempts bypass the output cache so observations come from the attempt
that produced the retained bytes. Idempotent replay still returns the original
resource and its original receipt. Existing ordinary render-cache keys now
distinguish nested input values, profiles, export dimensions, watermark settings
and loaded source content; hooks execute afresh because they can read mutable
state outside the host.

Coverage is always partial in this release. The pinned engine does not emit its
planned canonical dependency graph yet. Template/global resource reads, fonts,
composition and historical replay are not fully attested. A worker receipt
identifies the tool loaded for control-plane validation and the prepared
context; the worker's actual engine, inputs/profile, tool, asset and font
environment are not attested. It has no local-runtime observation section.
Every receipt carries explicit `limitations` for these boundaries.

Observation storage is bounded to 256 distinct asset receipts and 128 KiB of
asset metadata. Extra observations set `asset-observation-limit`; a provider
result whose bytes cannot be observed sets `asset-bytes-unobserved`. An empty
asset list means no bridge reads were recorded, not that the output is proven
dependency-free. Receipts are diagnostic evidence, not signed attestations,
complete lockfiles, cache-reuse authority or automatic stale/current decisions.

Evidence is stored in the existing output JSON record and needs no additional
migration. Earlier successful outputs remain downloadable but have no invented
receipt; their evidence endpoint reports `404 EVIDENCE_UNAVAILABLE`. Evidence
can be inspected even if retained output bytes later become unavailable; the
output download endpoint separately checks availability and byte integrity.
Reads use the same ownership and current-grant checks as the render itself.

## Hosting and recovery

The standalone server starts the runner automatically. Apply
`0032_render_resources.sql` and `0033_render_batches.sql` through the normal migrations runner. Use Postgres
and a persistent BlobStore for recovery across process restarts; memory mode is
for evaluation and loses its data when the process exits. Every replica must
use the same database, byte store and compatible mounted content.

The runner polls once per second and executes up to two requests per process.
Claims last 30 seconds and renew every 10 seconds. An attempt has a 120-second
budget and retains at most 32 MiB. A crashed worker's expired claim can be taken
by another replica, consuming another attempt. Exhausted requests become failed.
These are initial runner defaults, not new `instance.json` settings.

Only the current unexpired lease can settle a result. Each attempt writes a
distinct blob path, so a worker finishing late cannot overwrite the winning
output. Physical execution is at least once. Cancellation and timeout fence
results; an underlying renderer that ignores cancellation can continue running.

Function-only deployments refuse submission with `503
RENDER_RUNNER_UNAVAILABLE`. A background promise in a serverless request does
not provide reliable recovery. The existing `/render` and `/jobs` interfaces
remain available under their own contracts.

## Scope of this release

The fingerprint identifies the typed request. It is not a lockfile for every
font, asset, token, engine and policy version. Attempts and manual retries use
the current mounted content, current profile and current policy. The output
receipt includes its byte digest, the renderer's cache key and, for new durable
outputs, the partial execution evidence above. None is a complete dependency
trace or proof of historical reconstruction.

This first slice retains terminal requests and outputs without an automatic
expiry/deletion policy. Include them in storage sizing and backups. Losing
attempts normally delete their unreferenced blobs; an ambiguous database commit
or failed cleanup may leave an orphan for future collection. Resource mutation
requests are audited; a transactional lifecycle event/outbox is still planned.

Dependency snapshots, campaign reconciliation and
collection-wide approval/promotion follow this foundation. Organization delivery
currently accepts legacy `/jobs` outputs; delivery by the new render-resource
reference is a subsequent integration. A successful render alone does not
publish anything to a destination.
