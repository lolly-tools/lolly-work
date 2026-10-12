# Run a compatible frontend update

This adapter uploads and qualifies a complete static site on one fresh claim,
then changes the site's root claim and three release annotations. It reuses
the accepted native image, configuration, models, storage class and resource
limits. It does not reprovision the cluster or rebuild unchanged native
dependencies. The [shared update guide](../../docs/frontend-updates.md) keeps
the existing private three-command route and explains when a new image or
signed catalog release is required.

This source has local fixture controls, not cluster qualification. Register the
actual source closure, target policy and original native acceptance before
using it. Its first real mounted acceptance is still required. The existing
five-path hold stays closed. The earlier binder guide describes that source
boundary; this document supplies the concrete adapter commands.

For an ordinary TypeScript or frontend asset update, the operator journey is:

1. Choose an exact `main` commit whose required CI has passed, then build and
   prepare its compatible complete frontend root against the accepted release.
2. Review the new claim, resource request and exact target inputs, then stage
   the root and qualify it with the accepted image and unchanged infrastructure.
3. Review the actual retirement and server dryrun, switch the root atomically,
   and check the serving owner and browser journey.

The private instance keeps its existing three-command frontend update route.
Neither route follows a moving branch automatically. An unqualified native
target stays held; a frontend receipt does not override that hold.

## Supported first adapter

The maintained target transport supports explicit local or SSH kubectl,
kubeconfig, context, cluster/node and namespace/Deployment UIDs. The adapter
currently qualifies the managed `rancher.io/local-path` plugin on K3s with native
UID/GID101, a serial `Recreate` web owner and the accepted complete-root/map
layout. Its CRI/native-network probes use the standard K3s runtime paths.
CSI, a different runtime path, another UID/security policy or a different
storage plugin needs a separately qualified adapter. Those cases do not
silently enter this lane.

No active model, site or rollback PVC is mounted in staging. Retained bytes are
already in the independently assembled local root. Only the new claim, tmp
and unchanged read-only native ConfigMap enter the temporary qualifier. A gzip
TAR is streamed directly into the writer; no second whole TAR or local site
copy is created by this adapter. The complete new backing is verified for full
hashes, epoch zero, no shared static hardlinks, coding identity and paired map.

The complete owning Pod specification must match the reviewed template, with
only the maintained ordinary API defaults and exact scheduler node placement.
Extra host networking, host PID/IPC, credentials, token mounting, sidecars or
security fields refuse. Temporary Pods cannot inherit an explicit MCS level
from either the Pod or container security context.

Root and trailing-slash hostPath ancestors are normalized before overlap
checks. Disjoint text alone cannot disprove a physical symlink or bind alias.
This first adapter therefore refuses unresolved direct hostPath volumes on the
selected node, including unscheduled Pods; they need a separately reviewed
filesystem identity protocol. It never treats an unproved path as safe.
Every global PV backing must also be a resolved managed local path on the
reviewed node. A bounded read-only host pass records actual directory roots,
ancestry device/inode identities and kernel mountinfo mappings to underlying
filesystem-relative paths. Equal roots, physical ancestor aliases, bind-mounted
subtrees, symlinks and unproved storage backends refuse before staging or
publication. Host-native device pairs remain in the proof, so a remote Linux
device number is never decoded using the operator's platform conventions.

Model reads run through the active serving owner and normal authenticated
server TLS, without client credentials, cookies or redirects. Every full model
hash, unique body/inode group, link membership and before/after fingerprint is
checked. Equal model bodies must share exactly their owned in-root inode group;
foreign links refuse. The source model UID/GID101 is distinct from private
Work staging's UID1000. Staging leaves active metadata unchanged. At publication
only the model label's SELinux level may follow the actual verified new owner's
level; filesystem identity, label type, DAC and all bytes remain guarded.

## Bind real inputs

Create the physical frontend assembly and reviewed lifecycle preparation from
[the binder guide](PUBLIC-DELIVERY-LIFECYCLE.md). The adapter review binds
`scripts/stage-public-delivery.py` and every imported helper. This includes
the binder, assembler, boundary/map compiler, maintained private/public target
and storage helpers, native/HTTP programs and publisher. The complete local
signature verifier's import closure must also be recorded. Use the maintained
Lolly `scripts/verify-release-catalog.ts`; its explicit `--public-key` is the
accepted public pin. No deployment private key is needed.

Assembly must retain the original maintained public build descriptor, exact
candidate root and complete manifest. The binder revalidates the original
producer helpers, Vite command/input and source-bound workspace graph, then
requires that original source and profile to match the successful CI source.
The exact original CI reference must match the qualified run. The original
source checkout must be canonical, clean and at that immutable commit; every
compiled workspace row is checked against its committed Git bytes using the
hardened reader without replacement objects, hooks, grafts or lazy fetching.
It independently reconstructs candidate plus retained immutable bytes and the
new map against the complete assembled inventory. It refuses an unrelated
passing commit or an operator-written replacement source label. Other artifact
descriptor formats need their own reviewed producer adapter.

The stage input has exact keys:

```text
version:1,status:REVIEWED_PUBLIC_FRONTEND_RUNTIME_NOT_EXECUTED,
prepared,target,context,programs,sources,outputDirectory
```

Every reference is a canonical existing `{path,sha256}` record. `sources` is
the exact reviewed adapter/import/program closure. `programs` has
`preflight,hostProbe,node,signatureVerifier`. The Node binary is pinned too.
The maintained host probe supplies actual capacity and CRI/kubelet mount-release
proofs. The preflight is the instance's maintained target identity check.
For the hosted domains it is Build's `lolly-private/production/check-target.py`.

`context` contains exact keys:

```text
version:1,owner,replicaSet,storageClass,namespaces,sourceRoots,configPaths,origin
```

These are actual current captures, not desired resources. `namespaces` binds
every namespace in the complete protected Deployment baseline. Each
`sourceRoots` row has `{claim,pv,metadata}`; metadata is the maintained read-only
root observation for the actual local backing. Include the active static/model
roots and retained rollback roots. `configPaths` maps every accepted immutable
Nginx ConfigMap data key to its actual read-only mounted file path. `origin` is
the current normal HTTPS origin, without credentials, query or fragment.

For source/runtime receipts, controller-owned resourceVersion/status changes
are separate from ownership. The complete Deployment key set, UID, full spec,
guarded labels/annotations/generation and availability fences stay exact.
Readiness degradation refuses. Every actual full GET is retained in the new
command journal. Nothing converts a failed phase into acceptance.

Run the local-only constructor before root reviews the exact resource request:

```sh
python3 -B scripts/stage-public-delivery.py check \
  --input "$STAGE_INPUT" --reviewed-input-sha256 "$STAGE_INPUT_SHA" \
  --reviewed-operator-sha256 "$STAGE_SOURCE_SHA"
```

The same arguments run one fresh ordered lifecycle:

```sh
python3 -B scripts/stage-public-delivery.py run \
  --input "$STAGE_INPUT" --reviewed-input-sha256 "$STAGE_INPUT_SHA" \
  --reviewed-operator-sha256 "$STAGE_SOURCE_SHA"
```

The explicit phases are `create,copy,retire-writer,create-qualifier,qualify,retire`.
`run` stops on the first failure and never adopts an old attempt. Each stage
retains original commands and an exclusive intent before target mutation.
Allocation and Pods use the selected scheduling node; server admission may not
add exposure labels, sidecars, credentials, unknown mounts or privileges. Every
mutation's final operation is the maintained target preflight, after complete
Deployment, global storage/Pod/backing, current owner, source root, exposure,
capacity and present native-image guards.

Native checks use the actual container network namespace with CID/PID/start/
UID membership guards. They prove full physical/coding/signature/map closure,
real HEAD/304/Range/If-Range/cross-coding/error/service-worker responses, exact
mounted configuration and actual cgroup current/peak/limit/RSS/zero OOM. The
qualifier then retires, with UID/RV deletes, actual Pod/policy/global consumer
absence and CRI/kubelet/host mount release. A successful final receipt is
`runtime.qualified-and-retired.actual.json`. No image/model waiver is inferred
from that filename or from these source tests.

## Inspect without replay

When a phase fails, preserve its intent, originals and uncertain result. Do not
run it again. GET-only inspection uses a fresh separate observation directory:

```sh
python3 -B scripts/stage-public-delivery.py inspect \
  --input "$STAGE_INPUT" --reviewed-input-sha256 "$STAGE_INPUT_SHA" \
  --reviewed-operator-sha256 "$STAGE_SOURCE_SHA" \
  --observation-directory "$NEW_OBSERVATION_DIRECTORY"
```

Inspection can repeat into new journals without changing the target. It never
adopts resources, grants native acceptance, clears a failed intent or authorizes
the next phase. An uncertain mutation still needs separately reviewed factual
reconciliation or exact owned cleanup.

## Publish the actual retired root

The publication input has exact keys:

```text
version:1,status:REVIEWED_ACTUAL_FRONTEND_ROOT_PUBLICATION_NOT_EXECUTED,
stageInput,stageSource,retirement,outputDirectory
```

`retirement` references the actual stage receipt. `stageSource` is the exact
adjacent source-bound adapter. The exclusive publication journal is separate
from stage originals. Use the same final SHA arguments for `check,dryrun,
publish,observe,rollback`:

```sh
python3 -B scripts/publish-public-delivery.py check \
  --input "$PUBLICATION_INPUT" --reviewed-input-sha256 "$PUBLICATION_INPUT_SHA" \
  --reviewed-operator-sha256 "$PUBLICATION_SOURCE_SHA"
```

Run `dryrun`, review its actual server response, then `publish`. The atomic
patch tests the fresh UID, resourceVersion and whole spec before selecting
only the new claim and three root/map annotations. `observe` verifies the new
native owner, full site/model hashes, memory and normal TLS. Its accepted
runtime receipt still makes no signed-in browser claim. Run the instance's
browser/export/agent acceptance separately. Rollback requires the actual
published tuple and healthy owning state, retains both roots and records
runtime acceptance pending; it is not unconditional replay of an old patch.

Use a trusted system CA bundle when the operator's Python distribution does
not provide one, for example `SSL_CERT_FILE=/etc/ssl/cert.pem` after reviewing
that actual bundle. TLS verification and hostname checks remain enabled.

The complete-source input constructors rehash physical bytes, decode codings
and recompute the map/P256 closure. Model checks stream full bodies. Performance
on a real target has not been measured by these local controls; no seconds-to-
deploy claim is made. Rebuilding infrastructure is outside every command above.
