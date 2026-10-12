# Complete public static root and application updates

This source proposal is not active in the five-path facade. The existing
delivery-map hold stays in place until the producer, new-claim staging,
native qualifier and publisher bind this protocol. These helpers perform
local assembly and pure resource/patch derivation; they do not contact a cluster.

The first matched release needs its actual `lolly-start` public artifact,
ordinary source CI, image custody, pinned catalog verification and complete
public static inventory. An instance's SUSE static tree cannot stand in for
that public artifact. Keep all original artifacts and source receipts.

`scripts/assemble-public-delivery.py` audits both complete local roots, copies
the candidate into a new exclusive `site/` root, and retains old immutable
identity and coding files. Any collision fails. On macOS copies use independent
APFS clones; hard links are forbidden. Signed indexes and tool/asset bytes are
copied exactly. Old mutable aliases never replace the current catalog.

The adjacent `public-delivery-map.mjs` streams every gzip and Brotli sibling,
checks decoded size and full SHA256 against its identity, and compiles the
seven Nginx maps from the actual identity/wire metadata at epoch zero. It also
validates complete addressed model-directory recipes. The actual model bytes
remain on a separately reviewed model claim; metadata does not qualify them.

The closed assembly input has these fields:

```text
version: 2
mode: matched | frontend
candidate: {root, manifest: {path, sha256}, originalCustody: {path, sha256}}
previous:  {root, manifest: {path, sha256}, originalCustody: {path, sha256}}
models:   {path, sha256}  # JSON {version:1, files:[{url,size,sha256}]}
compiler: {path, sha256}  # adjacent public-delivery-map.mjs
boundary: {path, sha256}  # adjacent public-delivery-overlay.py
node:     {path, sha256}  # actual reviewed executable
outputDirectory: /exclusive/new/local/output
```

The candidate descriptor must be the original maintained
`public-shell-update.prepared.json`, with its exact source, public profile,
candidate root/manifest, successful Vite command/input and complete builder
source references. The assembler holds and revalidates those originals and
retains them in `assembly.actual.json` as `candidateBuild`. The lifecycle binder
then requires the build source/profile to match qualified CI and independently
reconstructs the assembled candidate/retained byte union. A passing unrelated
commit cannot relabel old bytes. Other descriptor formats require an explicit
reviewed producer adapter. Build custody is not CI or runtime acceptance.
The original model union array may be wrapped in a new reviewed
`{version:1,files}` record while preserving its original reference and hash.
Do not rewrite the original union or its source receipts.

Invoke the assembler only after every input is real and hashed:

```sh
python3 -B scripts/assemble-public-delivery.py \
  --input /reviewed/assembly.input.json --input-sha256 INPUT_SHA256 \
  --operator-sha256 ASSEMBLER_SHA256
```

Its output includes a full lexical manifest, original coding-command output
and `assembly.actual.json`. That receipt explicitly says runtime qualification
and publication are false. A failed assembly output is retained; use a new
exclusive output for any corrected attempt.

For `frontend` mode the whole resulting tree must also satisfy the v2 delta
boundary: every protected catalog/font/doc/tool file and old app chunk is
identical. Only the four mutable shell identities, their freshly checked
codings, new `_app` chunks and the map may change. Stale compressed siblings
are explicitly absent from the full-root overlay and cannot fall through to
an older image.

`scripts/plan-public-delivery-root.py` renders one new claim and deny-all,
credential-free Noop writer. The maintained stager must prove new names absent,
unique empty backing, exact allocated UIDs/specs, actual root permissions,
global Pod/PV/host mount exclusion and fresh all13 owner specifications. Target
preflight is the last operation before each real mutation. Stream snapshots
through their owning Pods; never mount an active or rollback claim in staging.
Verify every physical hash, decode and epoch after copying, then retire the
writer and prove host/global mount release before qualifying.

The serving mounts use one whole-volume read-only anchor, followed by its
`site` root and `.delivery-etags.conf` subPath. The independent whole-model
anchor and exact model subPath come afterwards. This makes the root and map a
single selected claim. Config, models and the accepted Nginx image stay fixed
for a later application-only update.

First-release memory limits are an explicit matched-cohort decision. Measure
the real new map's owner-bound cgroup current/peak/events and Nginx RSS; do not
borrow a prior smaller map's qualification or assume 256 MiB is sufficient.
`qualified_patch()` refuses a peak at/above the selected limit, any OOM,
wrong image/root/map tuple, incomplete external8080 HTTP proofs or missing
qualifier retirement. The normalized record must come from actual original
commands bound by the maintained publisher, not operator-written success flags.
New model CORS, including416, must pass strictly on that actual new image.

`frontend_spec()` changes only the accepted complete-root claim and its three
owning annotations. It preserves image, security, memory, config, models,
catalog and unrelated provenance. `guarded_patch()` uses the actual UID,
latest resourceVersion and complete before-spec. `rollback()` requires the
actual after-spec and owning UID; it never invents a future resourceVersion.
The maintained publisher retains all source, CI, image, pin, protected claims,
retirement, all13-owner and normal-TLS gates.

Local validation:

```sh
LOLLY_TEST_NODE=/reviewed/node python3 -B tests/test_public_delivery_assembly.py
LOLLY_TEST_NODE=/reviewed/node python3 -O -B tests/test_public_delivery_assembly.py
/reviewed/node tests/public-delivery-map-native.mjs \
  /qualified/lolly/scripts/build-delivery.ts /reviewed/nginx
```

The native fixture compares exact generated map bytes with the maintained
generator and checks real retained200/304, If-Range206, stale/cross-coding misses
and404. It is a local fixture, not public candidate or production acceptance.
