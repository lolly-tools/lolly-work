# Publish a frontend without restarting Work

The optional release-pointer mode keeps Work on one persistent shell volume.
An operator stages an immutable directory and atomically replaces a small
`current.json` pointer. The next shell request uses the new directory. Work's
process, sessions, collaboration connections, engine, pack and authenticated
catalog routes stay in place. This mode does not publish backend or pack changes.

Activation on an existing instance needs a fully qualified new Work image and a
one-time reviewed volume/configuration rollout. This feature is off by default.
It is not a replacement for source qualification, target identity checks,
authenticated export/agent canaries, or release compatibility checks.

## Layout and configuration

Use a physical, absolute release-store directory owned by the publishing
operator. Work gets a read-only mount. No file or directory inside a release may
be a symlink. Releases contain a complete bounded manifest and a `files/` tree;
their names are the SHA-256 of their canonical manifest. Publication seals
directories to mode 0555 and files to 0444. Releases are never overwritten.

```text
shell-store/
  current.json
  releases/<manifest-sha256>/manifest.json
  releases/<manifest-sha256>/files/index.html
  releases/<manifest-sha256>/files/_app/...
```

For a standalone server, configure:

```json
{"instance":{"shellDir":"/app/shell","shellReleasePointer":true}}
```

For Helm, also set the explicit chart switch:

```yaml
shell:
  enabled: true
  releasePointer: true
  type: existingClaim
  existingClaim: stable-shell-store
  mountPath: /app/shell
  readOnly: true
  image: ""
config:
  instance:
    shellDir: /app/shell
    shellReleasePointer: true
```

The chart refuses mismatched paths, writable Work mounts, image init copies or
ephemeral volumes in pointer mode. The pointer is not stored in the instance
ConfigMap or Pod annotations, so a frontend publication does not alter the
Deployment template. All serving replicas must see the same atomic filesystem;
the supported combined Work chart still requires one replica.

## Prepare and switch

Use a complete qualified current-build candidate and its original version-1
`{version, files, totalBytes}` inventory. Each file row has `path`, `size` and
`sha256`. Include required runtime files, governed boot, service worker and public
verification metadata. The existing producer also emits a prepared tree with
all prior `_app` history merged into it. Do not use that merged tree when the
goal is bounded release history; select its complete current candidate and
qualify that exact manifest instead. This publisher does not synthesize CI or
runtime acceptance and does not silently remove files from either input.

Run the local filesystem publisher from the reviewed Work checkout. The store
must exist before staging. Keep the emitted JSON with the original source and
qualification receipts.

```sh
node scripts/publish-shell-release.ts --action stage \
  --root /srv/lolly/shell-store --source /protected/current-candidate \
  --manifest /protected/current-candidate.manifest.json \
  --manifest-sha256 ORIGINAL_MANIFEST_SHA256

node scripts/publish-shell-release.ts --action activate \
  --root /srv/lolly/shell-store --release STAGED_RELEASE_SHA256 \
  --expected-pointer CURRENT_JSON_SHA256 --grace-seconds 600
```

Use `--expected-pointer absent` only for the first activation. Later commands
require the exact reviewed hash of `current.json`. Staging compares complete
source and destination inventories, preserves a 2 GiB free-space reserve, and
never changes the pointer. Activation revalidates the complete selected release,
checks immutable-URL compatibility, then uses an exclusive publication lock,
fsynced temporary file and atomic rename. A stale pointer or lock refuses the
operation. No lock is forcibly removed or operation automatically replayed.
Failed staging directories remain separate from published releases for review.

On **lolly.ing**, never mount the active production shell PVC in a new writer or
staging Pod. SELinux relabeling of an active volume can interrupt its owning
Work process. The activation runbook must first establish a separately reviewed
host backing path with exact PVC/PV, node, mount, ownership and process guards,
then run the publisher through that authorized host path. Run the normal
production target preflight immediately before mutation. This standalone tool
does not discover Kubernetes targets, create Pods, relabel a volume, or grant
permission to write to a host path. No live migration is performed by this PR.

## Rollback and bounded asset retention

```sh
node scripts/publish-shell-release.ts --action rollback \
  --root /srv/lolly/shell-store --expected-pointer CURRENT_JSON_SHA256

node scripts/publish-shell-release.ts --action retire \
  --root /srv/lolly/shell-store --release EXPIRED_UNUSED_RELEASE_SHA256 \
  --expected-pointer CURRENT_JSON_SHA256
```

The pointer always retains the current release and immediate rollback release.
Immutable URLs missing from current may be read from rollback, then from
explicitly unexpired grace releases. HTML, service workers and other mutable
paths only use current. An overlapping immutable URL must have the same bytes
across all retained releases. Catalog routes retain their existing caller
visibility and signature checks, including proofs for retained public media.

`--grace-seconds` defaults to zero and accepts at most 86400. A positive value
retains the former rollback release for that period when publishing another
release. There are at most six grace releases, two current/rollback releases,
and ten stored release directories including staged candidates. Publication
refuses when a bound would be exceeded; it never evicts promised assets early.
Retirement is explicit and refuses current, rollback and unexpired grace
releases. Once grace expires, much older tabs may need to reload to fetch new
lazy chunks. Choose grace from the instance's expected feedback/session cadence
and available disk capacity. This first mode copies full release trees; shared
content storage or filesystem reflinks are separate optimizations.

The focused test starts one HTTP server, keeps an authenticated session through
switch and rollback, verifies private route gates and older immutable requests,
and exercises pointer races, corruption, symlink/traversal refusals, retention
bounds, and Helm mount restrictions. It does not claim production activation.
