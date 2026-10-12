# Frontend root lifecycle adapter

After the first complete-root release is accepted, a compatible frontend update
can reuse its native image, immutable configuration, resource limits and model
recipe. The new writer and qualifier mount only a fresh complete site claim.
The root and its validator map share that claim. Active models are checked
through the current serving Pod and normal HTTP; they are never mounted in a
temporary Pod. This also applies to active and retained rollback site claims.

The local `scripts/public-delivery-lifecycle.py` binder renders resource requests
and derives a guarded patch. It makes no target calls, creates no cluster
resources and publishes nothing. A separately reviewed runtime adapter must
perform the stage, native checks, retirement and publication for the chosen
cluster. The [concrete adapter](PUBLIC-DELIVERY-RUNTIME.md) provides those
commands for the declared managed K3s layout. Registration and its first real
native acceptance remain release requirements; the existing five-path hold
stays in place.

Use the [shared update guide](../../docs/frontend-updates.md) to choose between
a frontend update and a new matched image/catalog release. Read
[complete-root assembly](PLAN300-PUBLIC-FULL-ROOT.md) for the physical producer.
Changes to signed tools, asset metadata, served docs, native dependencies or
configuration use that matched release route instead.

## Prepare a target request

All references are exact existing canonical `{path,sha256}` files. Inputs are
closed schemas; unresolved future references are not executable inputs.

The preparation input has these keys:

```text
version:1
status:REVIEWED_PUBLIC_FRONTEND_LIFECYCLE_NOT_EXECUTED
refs:{deployment,baseline,assembly,previousManifest,models,configs,
      qualifiedSource,acceptedRelease,adapterReview}
names:{claim,writer,qualifier,policy}
node,storageClass,minimumFreeBytes,outputDirectory
```

The Deployment name and namespace are taken from the actual selected owner.
They are not fixed to a hosted Lolly domain. Its accepted placement must already
use the whole-volume anchor, complete `/usr/share/nginx/html` site and paired
`/etc/nginx/delivery-etags.conf` map. The native UID/GID101 and
`OnRootMismatch` handoff remain fixed. Existing selectors, configuration,
catalog provenance, models, image and memory limits remain exact.

`baseline` contains `version:1`, the complete `deployments` array and original
unpaginated collection objects named `pods,pvcs,pvs,services,policies`. Its full
Deployment set is protected, including unrelated application namespaces. For
the hosted cluster this includes all13 current Deployments. Generic instances
must include their own full reviewed protection scope; a subset is not inferred
from the selected application alone. Temporary labels cannot match an existing
Service or an additive policy that grants ingress or egress.

`assembly` is the actual frontend-mode physical assembler receipt. The binder
rehashes its complete site and rederives the frontend boundary. Catalog, fonts,
tools, docs and retained immutable chunks stay byte-identical. The new claim
cannot be the active site/model claim or adopt any existing resource name.
Scheduling uses a hostname `nodeSelector`, so a local-path
`WaitForFirstConsumer` allocator can observe the selected node.

`acceptedRelease` has exact keys:

```text
version:1,status:ACTUAL_PUBLIC_FULL_ROOT_SERVING_ACCEPTED,
deploymentUID,deploymentSpecSha256,ownerPodUID,image,
manifestSha256,mapSha256,models,configs,publicPin
```

The owner, configuration, model recipe and original manifest references must
match the actual baseline. `configs` is the unchanged selected immutable native
ConfigMap array. `models` has `{version:1,files:[{url,size,sha256}]}` and remains
the exact accepted recipe. `publicPin` holds only the original public verifier
authority; private signing keys do not belong in any of these requests.

`qualifiedSource` is a source-custody descriptor, not a replacement for CI. It
has exact keys `version:1,status:ACTUAL_SOURCE_CI_QUALIFIED,source,profile,main,
run,jobs,requiredJobs`. `profile` is `lolly-start`; source is the actual full
commit. `main`, `run` and `jobs` bind the original provider responses. Every
nonempty reviewed mandatory job name must actually pass on that completed
successful main run. The mandatory set is chosen in the instance's release
review, not by a user-facing deployment control.

```sh
python3 -B scripts/public-delivery-lifecycle.py prepare \
  --input "$REVIEWED_INPUT" --input-sha256 "$INPUT_SHA256" \
  --operator-sha256 "$LIFECYCLE_SOURCE_SHA256"
```

The exclusive output contains `lifecycle.prepared.json`. It holds the exact
writer/qualifier/PVC/deny-policy resources and the proposed spec. Its status is
`PUBLIC_FRONTEND_LIFECYCLE_PREPARED_NOT_STAGED`. Preparation is not runtime,
browser, model or publication acceptance.

## Register and qualify the runtime adapter

The adapter's source and every imported helper must be registered in an
independent root review. `adapterReview` has exact keys
`version:1,status:ROOT_REVIEWED_FULL_ROOT_RUNTIME_ADAPTER,source,sources,
capabilities,stages,review`. Its `review` reference binds the same source,
complete source closure, capabilities and stage list, with status
`ROOT_REVIEWED_RUNTIME_ADAPTER_SOURCE` and `productionMutation:false`.

The ordered stages are `create,copy,retire-writer,create-qualifier,qualify,retire`.
Their review must verify these capabilities, not merely copy their names into
a request:

```text
completeProtectedDeployments,globalPodsPVCsPVs,uniqueBackingAndMountRelease,
sourceRootIdentityDACMCS,newRootOnly,modelsThroughOwnerOnly,
nativePhysicalCodingAndSignature,nativeHTTPAndMemory,exclusiveNoReplay,
preflightImmediatelyBeforeEveryMutation
```

The adapter preserves complete resource UID/RV/spec fences, global claim/PV/Pod
and host backing checks, active/rollback filesystem identity/DAC/MCS, host
reserve, actual imported native image availability and no replay journals.
Allocation, writes, deletes and publication each require the maintained target
check as the last operation before mutation. It must retain original command
stdout/stderr with full hashes and leave a failed phase failed.

The writer uploads only the independent local complete site into the new claim.
It verifies every full physical hash and epoch-zero metadata before retiring.
No active claim is mounted to retain old bytes. The qualifier mounts only the
new root/map, unchanged immutable native ConfigMap and temporary scratch space.
It uses the accepted image/security/resource limits with no credentials, no
service account token, no model mount and no egress.

Native qualification must actually verify the complete physical inventory,
all gzip/Brotli decoded identities, recompiled full map and original P256 signed
file closure. Real native HTTP must check strong identity/gzip ETags,304,
If-Range206, cross-coding misses, private errors and the service worker's exact
no-store boundary. Actual owning cgroup current/peak/RSS must be below the
unchanged selected limit with zero OOM and zero oom_kill. A historical smaller
map or different memory limit is insufficient.

Model proof is separate: the accepted active owner/PVC/PV remains exact before
and after, full physical model hashes match its unchanged recipe, and normal
serving HTTP checks all models, validators, Range/If-Range, strict416, CORS and
private errors. There is no exception that remounts active models for this
check. The first matched release's inactive-model qualifier is a separate
protocol and cannot be relabeled a frontend adapter.

Retirement verifies actual writer/qualifier and deny-policy absence, original
UIDs, complete global consumer absence and CRI/kubelet/host mount release.
The new root claim is retained. Stage/native/retirement records bind the exact
prepared hash and source, resource tuple, complete command originals and all
protected Deployment specifications.

## Admit the actual retired root

The runtime receipt uses exact keys:

```text
version:1,status:ACTUAL_FRONTEND_ROOT_QUALIFIED_AND_RETIRED,
prepared,adapter,phases,native,models,retirement,globalBefore,globalAfter
```

Every proof is a reference to its original adapter output. The binder verifies
the complete source/input binding and rederives the prepared artifacts again.
It refuses omitted stages, failed original commands, wrong public pin/map,
changed model owner/backing, incomplete global scope, OOM, model mounts or
missing retirement. The exact leaf schemas are in `admit` and covered by
synthetic negative controls. Those controls do not qualify a native runtime.

An admission input has `{version:1,prepared,runtimeReceipt,outputFile}`:

```sh
python3 -B scripts/public-delivery-lifecycle.py admit \
  --input "$ACTUAL_ADMISSION_INPUT" --input-sha256 "$ADMISSION_SHA256" \
  --operator-sha256 "$LIFECYCLE_SOURCE_SHA256"
```

The result is a patch proposal, still `published:false`. It tests the exact
Deployment UID, resourceVersion and full spec, then changes only the site claim
and three root/map annotations. The adapter must run fresh complete target,
resource, backing and owner guards immediately before its atomic mutation.
It must then verify the actual selected native owner, full root/map/model
bytes, memory and normal TLS. Rollback likewise needs the actual current
UID/RV/full spec and retained previous root; it is not an unconditional replay
of an old patch. No helper result grants automatic permission to bypass those
last target checks.
