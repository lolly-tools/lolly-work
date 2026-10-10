# Publish private UI changes without rebuilding images

The shell update lane builds the changed web application and switches the existing
Work Deployment to a new verified shell claim. It retains the qualified Work
image, native engine, tool pack and immutable engine pin. No Helm upgrade, cloud
provisioning, database migration or registry upload is involved.

This path is for an instance whose web shell already uses a dedicated persistent
claim mounted read-only by Work. The chart's generic deployment choices remain
available for other layouts. The existing Deployment strategy still applies:
a single-owner `Recreate` workspace has a brief reconnect window.

For the usual build and one-command publication flow, start with
[PRIVATE-SHELL-QUICKSTART.md](PRIVATE-SHELL-QUICKSTART.md). The detailed phase
interfaces below remain available for separately reviewed staging and publication.
For the public Nginx shell, use [PUBLIC-SHELL-QUICKSTART.md](PUBLIC-SHELL-QUICKSTART.md).

## Choose a release

| Code change | Release path |
| --- | --- |
| Web application TypeScript, CSS, layouts, presenter controls or service worker | Shell update, after source and compatibility checks |
| Backend TypeScript or the current baked admin console | Application image |
| Engine/core/schema, dependencies, build configuration, profile, brand or tools | Matched release with broader qualification |
| Host, storage topology, database, secrets, DNS or cluster | Separate infrastructure or data operation |

The classifier is conservative. It compares immutable committed trees, including
added, deleted and mode-changed files. Unknown changes require the broader path.
An allowed filename alone does not authorize reuse or promotion.

## Developer: prepare a clean main revision

Keep normal source CI and the explicit web release gate. Use an isolated clean
checkout of the exact main commit; the live instance never follows a moving
working directory. Keep installed dependencies and generated prerequisites
consistent with the accepted release. The build command installs nothing and
does not modify the source checkout.

The usual setup must supply the ignored `public/ort` and `public/ort-hf` runtime
caches: the maintained Vite plugins check these paths, including worker builds.
Reuse the accepted files when dependencies are unchanged. The producer checks
present cache bytes and retains the accepted static runtime files in its output.

From the maintained Work checkout, with Node 24 or newer:

```sh
pnpm update:shell:build \
  --source /absolute/clean/lolly-checkout \
  --base ACCEPTED_SHELL_COMMIT \
  --candidate NEW_MAIN_COMMIT \
  --previous-shell /protected/accepted-shell-snapshot \
  --public-key /protected/existing-public-jwk.json \
  --custody /protected/shell-build-custody.json \
  --custody-sha256 REVIEWED_CUSTODY_SHA256 \
  --out /protected/new-shell-build
```

The protected custody file binds the accepted engine/Work/brand commits, immutable
engine-pin digest, profile, exact build settings, complete previous-shell manifest,
previous acceptance, candidate CI record and existing public JWK digest. CI origin
and previous acceptance are reviewed independently; supplying a JSON file does
not authenticate its origin. See `tests/prepare-shell-update.test.ts` for the
complete v1 contract.

The producer uses the exact checkout's Vite plugins and worker configuration,
compiles fresh workspace source, verifies the existing signed catalog before and
after building, and emits complete candidate/prepared/delta inventories plus
original build and gate reports. No private signing key is needed when the signed
content is unchanged. Old `_app` assets remain available for already-open tabs;
same-path changes to an existing immutable chunk refuse. The service worker and
`portable/player.js` are explicitly bounded generated shell outputs. Protected
PDF, model, font and other static resources must remain identical.

Cloning is an optional storage optimization with separate file inodes. APFS clones
or Linux reflinks avoid copying unchanged large assets; unsupported filesystems
fall back to a capacity-checked ordinary copy. The accepted snapshot is never
hardlinked for writes. Output directories are new and exclusive; a refusal leaves
original reports available for diagnosis.

## IT operator: qualify the compatible cohort

Python 3.10 or newer is sufficient for the local preparation and captured planner;
live publication also needs your existing kubectl/SSH access and Node runtime in
the qualified Work image. Use a protected directory outside the repository for
site-specific targets and evidence. Do not put private packs or secrets into a
public CI artifact.

```sh
pnpm update:shell:prepare \
  --evidence /protected/shell-evidence.json \
  --reviewed-evidence-sha256 REVIEWED_EVIDENCE_SHA256 \
  --existing-public-pin-sha256 REVIEWED_CANONICAL_PUBLIC_JWK_SHA256 \
  --node /absolute/path/to/node \
  --out-dir /protected/new-shell-cohort
```

The preparer binds genuine original previous runtime/TLS acceptance, current
normal CI, producer outputs and unchanged engine/pack/pin custody. It compares the
new shell source separately from the accepted engine source. Its result is
`SHELL_ONLY_PREPARED_NOT_RUNTIME_QUALIFIED_NOT_APPLIED`; it makes no cluster calls.

Stage a **new** shell claim using the unchanged qualified image and pin. Stream
the accepted shell and pack read-only through their existing owning Pod. Copy
the pack into a temporary staging-only claim; do not attach the active pack or
shell PVC to another Pod, even read-only. SELinux may relabel an active claim.
Apply the small frontend delta to the new shell claim, retire the writer and
verify its mounts are released. A separate qualifier then mounts both new claims
read-only, verifies every file and signed catalog, and boots Work with ephemeral
in-memory storage and no production configuration, accounts, credentials or
database. Retire the exact qualifier and owned policies, then verify host mounts
are released before production uses the new shell claim. The temporary copied
pack never replaces the production pack.

The maintained stager binds an explicit target, complete original deployment and
storage captures, prepared shell trees, existing image source map and reviewed
guard programs. Its protected input chooses new resource names and capacity
limits; it never adopts an existing attempt. Use `check` to inspect the prepared
resources without cluster calls, then `run` for the serialized staging phases:

```sh
pnpm update:shell:stage check \
  --inputs /protected/shell-stage-input.json \
  --sha256 REVIEWED_STAGE_INPUT_SHA256 \
  --operator-sha256 REVIEWED_STAGER_SOURCE_SHA256

pnpm update:shell:stage run \
  --inputs /protected/shell-stage-input.json \
  --sha256 REVIEWED_STAGE_INPUT_SHA256 \
  --operator-sha256 REVIEWED_STAGER_SOURCE_SHA256
```

New backing volumes must be bound and checked for isolation before a writer can
mount them. For a supported `WaitForFirstConsumer` class, allocation selects the
reviewed node on the new claims without creating a mount-capable Pod. A class
that cannot complete this allocation stops the attempt. The server admission dry
run must also preserve the reviewed Pod volumes and security settings.

Each phase preserves its original responses and has a single-use intent. On a
refusal, inspect the original resources and receipts read-only before choosing a
recovery action. Keep both new claims until live acceptance; retire the temporary
pack claim only with fresh identity and ownership checks afterwards.

```sh
pnpm update:shell:plan \
  --evidence /protected/shell-plan-evidence.json \
  --reviewed-evidence-sha256 REVIEWED_PLAN_EVIDENCE_SHA256 \
  --out-dir /protected/new-shell-plan
```

The captured planner consumes `shell.prepared.json`, complete namespace Pod and
PVC/PV captures, the existing immutable pin and original isolated-stage runtime,
content and retirement proofs. It refuses storage aliases and a new claim still
mounted elsewhere. Its result is
`PLANNED_FROM_CAPTURES_NOT_DRY_RUN_NOT_APPLIED`.

## Publish and verify

Use the maintained publisher's `--help` for the exact protected execution envelope
and its separate check, dry-run, apply, observe and rollback-intent phases. The
execution envelope binds the explicit site target, original plan/evidence and
mandatory site preflight. A local capture or build never counts as live acceptance.

```sh
pnpm update:shell:publish check \
  --input /protected/shell-publication-input.json \
  --reviewed-input-sha256 REVIEWED_PUBLICATION_INPUT_SHA256 \
  --reviewed-operator-sha256 REVIEWED_PUBLISHER_SOURCE_SHA256 \
  --out-dir /protected/new-shell-publication
```

Use the same reviewed arguments for `dryrun`, inspect its original server
response, then run `apply` once and `observe`. `rollback-intent` prepares a fresh
reference for review; it does not restore data or execute a rollback.

Only the shell volume's claim and its existing shell-source/release annotations
can change. The image, engine-source annotation, raw pack and engine pin stay
exact. Before mutation, reread target identities and storage ownership, run the
site preflight, then use UID, resource-version and complete-spec tests. Inspect
the server's admission dry run. Serialize publishers that share a Deployment.

Apply has a single-use intent record. Preserve its original response even if a
later observation fails; reconcile read-only instead of retrying the patch.
Observe the genuine new owning Pod, image digest, complete shell/pack bytes,
immutable pin, normal verified-TLS routes and unchanged application components.
Also test authenticated exports, document agents and an existing collaborator's
reconnection. Keep old claims until this acceptance passes.

The publisher emits `accepted.previous.json` with original runtime and TLS
evidence, complete manifest hashes and separate shell/engine commits. Use this
accepted record for the next update. Backend or native engine changes still use
the appropriate application-image or matched-release path.

Rollback is a fresh plan against the **current** Deployment, reusing the retained
qualified shell and checking its UID, hashes and exclusive ownership. It changes
application references while keeping new user writes, assets and database data.
Do not replay an inverse patch or restore a database for a UI rollback.

Production promotion remains a separate serialized operator operation from CI
candidate preparation. Native/device qualification holds remain in force even
when a site has explicitly qualified a web-only release.
