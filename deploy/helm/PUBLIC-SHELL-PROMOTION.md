# Stage and promote a public shell overlay

This guide completes the operator path described in
[PUBLIC-SHELL-UPDATES.md](PUBLIC-SHELL-UPDATES.md). It updates the five public UI
paths on an accepted Nginx image. It does not rebuild that image, engine, tools,
models or infrastructure. The source includes offline adversarial tests; those
fixtures are not live deployment, Nginx, browser or authenticated CI acceptance.

For `lolly.tools`, read the private production handoff before selecting a target.
The historical `candidate` host and context are production. These commands use
the explicit `app-update.py` target JSON and have no hardcoded host, namespace,
Deployment name or UID. Serialize overlapping operators. Keep the old image and
overlay for a separately reviewed rollback; never replay a prior patch.

## Reviewed inputs

First run the maintained producer and `prepare-public-shell.py` as described in
the preparation guide. Its original `cohort.prepared.json` and evidence envelope
are inputs, together with their exact SHA-256 values. The stager independently
recomputes that contract, including original public647 or accepted overlay proof,
normal main CI, non-shell source equality, catalog and complete physical trees.

Every reference is `{path,sha256}`. Use canonical absolute paths, mode 0600 for
evidence and a new output directory outside all artifact trees. Node 24+, Python
3 and already installed dependencies are required; the operators install nothing.

The stage input has exactly:

| Field | Required value |
| --- | --- |
| `version` | `1` |
| `target` | Reviewed `app-update.py` target, including all nine application components |
| `prepared` | Original maintained public `cohort.prepared.json` reference |
| `planningEvidence` | Its original hash-reviewed evidence envelope reference |
| `baseline` | Complete fresh capture described below |
| `publicKey` | Existing public-only P-256 JWK reference; never a private signing key |
| `preflight` | Hash-pinned Python target preflight, called last before every mutation |
| `hostProbe` | Hash-pinned Python capacity/mount probe implementing the existing private-stage protocol |
| `names` | `{writer,qualifier,policy}` with new, distinct resource names |
| `storage` | `{storageClassName,bytes}` allocating only a new overlay PVC |
| `minimumFreeBytes` | Remote free-space floor, at least 8 GiB |
| `maximumWriteBytes` | Reviewed complete-overlay write bound, at most 1 GiB |
| `outputDirectory` | New canonical stage evidence directory |
| `node` | Explicit Node 24 executable |
| `sourceFiles` | Exact source closure listed by `SOURCE_NAMES` in the stager |

The baseline is `{version,deployments,claims,pvs,pods,owner,replicaSet,storageClass}`.
`deployments` contains every protected component's original full Deployment.
`claims` is a complete **global** PVC collection and `pvs` a complete global PV
collection. `pods` is the complete public namespace collection. `owner` and
`replicaSet` are the actual accepted public owner chain; their image, UID and full
spec are bound to the original acceptance. `storageClass` is its complete original
resource. Ordinary `v1/List` output is accepted without inventing collection RVs;
each item still needs its actual API, kind, scope, UID and nonempty RV. Paginated,
duplicate, deleting or partial captures refuse.

The host probe uses `capacity --target PATH` and returns the actual node name/UID
and `freeBytes`. It uses `mounts --target PATH --pod-uid UID` and returns that exact
`podUid`, `nodeUID`, `unmounted:true` and `mountsReleased:true` only after checking
the host. A success label alone is not a host implementation. Review and pin the
probe with the source/target evidence.

## Stage isolated content

```sh
python3 scripts/stage-public-shell.py check \
  --inputs /review/stage.json --sha256 REVIEWED_INPUT_SHA256 \
  --operator-sha256 REVIEWED_STAGER_SOURCE_SHA256

python3 scripts/stage-public-shell.py run \
  --inputs /review/stage.json --sha256 REVIEWED_INPUT_SHA256 \
  --operator-sha256 REVIEWED_STAGER_SOURCE_SHA256
```

`check` is offline and emits `PUBLIC_STAGE_INPUTS_BOUND_NOT_EXECUTED`. `run`
executes the six single-use phases below. Individual phase commands are also
available for a supervised release; they require accepted prior phase records.

| Phase | Result |
| --- | --- |
| `create` | New PVC, deny-ingress/egress policy and writer; allocation and global backing alias checks finish before a Pod mounts the claim |
| `copy` | Read-only owning-Pod snapshot of the five old paths, exact archive validation, bounded UI delta, complete new overlay hashes |
| `retire-writer` | UID/RV-backed deletion followed by actual Pod absence and host mount release |
| `create-qualifier` | Same accepted image, five read-only mounts, exact accepted Nginx config, no model mount, no Service or production credentials |
| `qualify` | Complete effective static inventory, actual catalog bytes/P-256 signature and signed-map checks, actual UID/GID and loopback Nginx entry response |
| `retire` | Qualifier and owned policy deletion; both original Pod UIDs are absent and unmounted; new claim is retained |

The image/qualifier must supply its existing `sh`, `find`, `stat`, `sha256sum`,
`tar`, `id`, `wget` and Nginx, running as UID/GID 101 with its accepted port 8080
configuration. No package is installed in staging. The immutable image supplies
unchanged catalog, tools, fonts, docs and other static content. Models are pruned
from the inventory and remain excluded from shell manifests.

Never mount an active models or shell PVC into another Pod. Only the genuine
owning Pod reads those bytes. The snapshot contains the five overlay paths,
not the 1.35 GB static image tree. It is checked before extraction; links, special
files, escapes, duplicate files, missing files and incorrect hashes refuse.
The local snapshot transport preserves a 2 GiB disk floor. Full static validation
transfers checksum text and actual catalog bytes rather than the complete tree.

Every phase creates an exclusive `*.started.json` before execution and retains
original command stdout/stderr, API responses and failures. A partial/uncertain
phase cannot be rerun. Read-only asynchronous mount observations may be repeated
within their original bounded wait; deletion and other mutations may not.
Retained failed mount observations remain explicitly identified in the receipts.

## Promote once, observe separately

The publication input is exactly
`{version,status,stageInput,stage,preflight,staticProbes,outputDirectory,sourceFiles}`.
Set `version:1`, `status:"REVIEWED_PUBLIC_SHELL_PUBLICATION_INPUT"`; reference the
original stage input and its actual `stage.accepted-and-retired.actual.json`.
Use the same reviewed preflight and a separate new output directory. The publisher
source closure includes its own file plus the stager's exact imports.

`staticProbes` is a reviewed list of `{url,path,size,sha256}` from the full qualified
manifest. Include `index.html`, both catalog files and at least one `_app` chunk.
URLs must use normal HTTPS, an explicit target public health origin, exact encoded
paths, no credentials/query/fragment and no redirects. Verification uses the
system CA and hostname checks; expected 200 and exact size/hash are mandatory.

```sh
python3 scripts/publish-public-shell.py check \
  --inputs /review/publication.json --sha256 REVIEWED_INPUT_SHA256 \
  --operator-sha256 REVIEWED_PUBLISHER_SOURCE_SHA256
```

Run the same reviewed command with `dryrun`, then `apply`, then `observe`.
Each phase is exclusive. `apply` binds the freshly read Deployment UID/RV/full
spec and replaces only the exact desired spec independently prepared by the
public contract. Bootstrap adds exactly five read-only subPath mounts; later
updates change only the claim and public provenance. Nginx image/config, models
claim/PV/subPath, all other mounts/resources/security/probes/services/policies and
the other eight application specifications remain unchanged.

Before promotion, the expected full owning Pod spec is derived from the original
accepted owner and the exact prepared overlay change. All admitted defaults,
including `enableServiceLinks:true` when absent from its Deployment template,
remain exact. The isolated stage still explicitly disables service links. A new
or changed default in the promoted owner refuses observation; it is not guessed
from that new owner's response.

`observe` mutates no Kubernetes resources. It verifies the rollout, genuine new
Pod/ReplicaSet chain and image/readiness, all nine application ready specs, exact
protected resources, retired Pod absence/mount release, full fresh owning static
hashes, actual P-256 catalog and normal verified-TLS probes. It then emits
`observe.acceptance.original.json` with
`PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED` and `accepted.previous.json`, consumed
directly by the maintained public baseline parser. Original image preparation is
retained; new static/overlay manifests, source, current owner and exact checksum
conversion provenance are explicit. Browser, physical clicker and native/device
qualification remain separately recorded.

If observation refuses after a successful patch, preserve that applied state
and its originals. Do not repeat `apply` or clear its intent. Prepare a read-only
reconciliation against fresh captures. `rollback-intent` produces a fresh review
record only; it cannot apply an inverse or restore stale data.
