# Public frontend updates with Plan300 delivery

This is a source-only protocol proposal. The maintained five-path facade still
refuses a baseline containing `.delivery-etags.conf`. Its hold is necessary:
mounting a new `index.html` can leave the old image's `index.html.gz` visible,
and a baked map can validate old or unrelated bytes. The new pure
`scripts/public-delivery-overlay.py` does not remove that hold or publish a
release. Local metadata controls do not qualify Kubernetes, Nginx or browsers.

The smallest safe next protocol retains the accepted image, Nginx policy,
P256 pin, public signed catalog and model claim. It replaces application bytes
and their full validator map together, using one new static claim. It does not
build an OCI image, recreate infrastructure, modify private Work generation or
enable a rendering/native experiment.

## Exact assembly

Use a version 2 public artifact class distinct from the legacy five-path class.
Preserve its original baseline, full Git/classifier/ordinary-main CI checks,
observed main and worker module graph, public profile and catalog proof. New
fields bind the complete effective static manifest, the exact generated map,
explicit removed mutable coding siblings, reviewed immutable model metadata,
the pinned generator source and original generator/decoder reports. Do not
accept an opaque map merely because a caller says its hash is trusted.

Build the changed TypeScript with the existing native Vite API. Copy accepted
protected assets; retain every old `_app` identity and coding byte. Only the
four existing mutable identities (`index.html`, `precache.json`, `sw.js`,
`portable/player.js`), their gzip/Brotli siblings and new app chunks may change.
The catalog, all tool/asset hash directories, docs, fonts, ORT and other static
content remain exact. Source changes to the engine, dependencies, policy,
templates, tools, brands or rendering route continue to require the matched
release. Ordinary main CI is mandatory; an image job alone is insufficient.

Apply the maintained final delivery generator to the complete effective root,
using the accepted full model hash/size inventory. Verify every identity and
wire SHA256, independently decode all `.gz`/`.br` to its exact identity within
the existing byte/deadline bounds, and prove every serving file's mtime is
epoch 0. Remove only listed old mutable sidecars whose identity changed; absent
sidecars must remain absent in the served filesystem. The map itself is hidden
operator metadata and remains a real 404 on HTTP. Native Nginx must parse the
actual candidate map within the explicitly approved container memory limit;
the earlier 30 MB map's memory proof does not qualify a new 50 MB map.

## Mount and transport

Layout the new claim as `site/` containing the complete effective static root.
Mount the whole claim read-only at `/run/lolly-public-overlay` first, then
`site/` at `/usr/share/nginx/html`, and its `.delivery-etags.conf` at
`/etc/nginx/delivery-etags.conf`. The existing model volume remains its separate
read-only child mount, with exact accepted claim/PV/UID/subPath/metadata. The
parent-root mount prevents stale image sidecar fallback without changing
Nginx routing. Parent/child mount order and actual model identity must be
qualified; do not infer them from the helper's list.

Snapshot through the owning Pod into an exclusive new writer/claim. Never
mount the active static, model or rollback claim in staging. For speed, a
bounded owning-Pod stdout stream may feed the new writer on the same host,
avoiding a large round trip and duplicate archive on the operator's laptop.
Keep both exact source/target transport programs, hashes, gzip byte accounting,
backpressure/timeout outcomes and final full-tree comparison. Then transfer
only changed identities/codings/map plus explicit removed sidecar paths.
The complete destination and retained source must both match full manifests.
No hard-link or SELinux-label borrowing from an active claim is permitted.

## Integration boundaries and release gates

1. `prepare-public-shell-update.ts`: add the closed version2 producer and exact
   complete-root delivery/decoder custody after unchanged Vite/classification.
2. `prepare-public-shell.py`: admit original accepted full-cohort baselines as
   a separate closed schema; retain the legacy schema and its hold. Bind full
   catalog hash directories, sidecars, generator/model metadata, deployment
   and actual map mount. Rederive the entire permitted delta.
3. `stage-public-shell.py`: support the new whole-root layout, exact removal
   instructions and fresh UID/global backing guards. Reuse isolated allocation,
   literal preflight-last rules, full byte checks, UID101/setgid/MCS handoff,
   deny policies, writer retirement and new qualifier retirement. The qualifier
   never mounts active model storage: use the accepted physical model proof and
   check the unchanged model owner before/after separately.
4. Native qualifier: test actual identity/gzip SHA ETags, retained lazy chunks,
   root/mutable304 and changed old-tag200, `If-Range`206 and mismatch200,
   cross-coding refusal, gzip;q=0, HEAD, wildcard/weak/list validators, hidden
   map404 and missing404/private no-store. Preserve signed decoded bytes,
   normal browser startup, service worker/reconnect and actual memory evidence.
5. `publish-public-shell.py` and `update-public-shell.py`: require every stage,
   native/browser and retirement receipt before a fresh full-spec guarded
   application patch. Bootstrap changes only the reviewed static/map mounts
   and provenance; subsequent releases change their selected claim and paired
   manifests. Require complete all 13 owner UID/spec evidence, unchanged models,
   config, pin and private generation before/after. Derive an exact rollback
   to the retained old claim/map without changing data or replaying a phase.

Post-promotion normal TLS independently proves all static identity/coding bytes,
new map hash, owner UID/image/config/mounts, current and retained validator
semantics, models Range/CORS and fresh browser lazy loading. The accepted
baseline records original full-cohort custody and the separate delta acceptance.
No current production tuple is described as having this protocol installed.
