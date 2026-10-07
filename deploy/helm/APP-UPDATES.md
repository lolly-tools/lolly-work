# Update applications without redeploying infrastructure

Change application code, qualify a new image, then update the owned Deployment's
container image. The database, persistent assets, secrets, ingress, TLS, DNS and
cluster stay in place. This works with K3s or RKE2 on UpCloud, evroc or another
Kubernetes provider; there is no provider API or paid provisioning operation.

`scripts/app-update.py` plans by default. It uses Python 3.10 or newer and kubectl,
with no Python packages to install. Applying needs the exact reviewed plan and
its hash. It never invokes Helm, Terraform/OpenTofu, database migrations or a
rollout restart. An already deployed image produces `NO_CHANGE` without a patch
or rollout. A changed image replaces Pods using the existing Deployment strategy
and drain settings. A single-owner collaboration deployment using `Recreate`
therefore has a brief reconnect window; this helper does not establish zero
downtime or a multi-replica collaboration topology.

## Set up an explicit target once

Copy [examples/app-update-target.json](examples/app-update-target.json) to a
protected operator directory outside the repository. Give it the real kubeconfig
path, context, cluster UID (the `kube-system` namespace UID), node UID, namespace
UID, Deployment UID and exact application container name. Obtain these from the
reviewed cluster with explicit `--kubeconfig` and `--context`, not from a default
context. No credentials go in the target JSON; the kubeconfig itself is secret
and should have mode 600. Refresh identities only after a separately reviewed
cluster or resource replacement. A stale identity fails closed.

The allowed component names are `work`, `public-web`, `public-mcp`, `public-ca`,
`public-penpot`, `public-demo`, `render-worker` and `live-relay`. Map only the
Deployments this operator owns. Each Deployment may appear once; the helper
changes one named container in it. Edge and database components and Deployment
names are excluded. Optional `requiredLabels` further bind ownership. Optional
`healthURLs` are credential-free HTTPS endpoints expected to return 200 with
normal certificate verification and no redirects. They are checked after an
actual rollout, in addition to Deployment readiness. Choose an application
health endpoint, not a sign-in URL that redirects.
Kubernetes system namespaces and resources carrying an edge, database or storage
component label are also refused, even if a target mistakenly aliases them as
an application component.

### Operating through SSH

For a bastion-accessed K3s host, replace the `transport` object with this explicit
route. There are no hardcoded production addresses in the helper:

```json
{
  "type": "ssh",
  "host": "operator@production-host",
  "jump": "operator@bastion",
  "knownHostsFile": "/absolute/path/to/reviewed-known-hosts",
  "sudo": true,
  "kubectl": ["/usr/local/bin/k3s", "kubectl"],
  "kubeconfig": "/root/protected/production.kubeconfig",
  "context": "reviewed-production-context"
}
```

`jump` is optional. SSH uses batch authentication and strict host-key checking;
`sudo` uses `-n`, so no password prompt is hidden inside an update. The configured
kubectl argv, kubeconfig and context are shell quoted on the remote host. The
SSH identity uses the operator's existing SSH configuration. For local kubectl,
`kubeconfig` is a local absolute path; for SSH it is an absolute path on the host.

Follow your site's production preflight and resource ownership rules immediately
before any apply. This generic helper checks the configured Kubernetes identities
and resources; it does not know your provider UUID, DNS authority or retained-host
fences. Agents with document-scoped MCP invitations cannot deploy infrastructure.

## Edit, qualify and publish an image

Use an isolated checkout so an unrelated dirty source tree cannot enter a release.
Run the checks appropriate to the changed code. Work's normal release checks are
the engine pin, tests, typecheck, dependency audit and image packaging; a release
that changes the consumed engine also needs its normal release qualification.
Then build and publish to a registry the existing cluster can read, for example:

```sh
docker buildx build --platform linux/amd64 \
  --file deploy/compose/Dockerfile \
  --tag registry.example/lolly-work:reviewed-release --push .
docker buildx imagetools inspect registry.example/lolly-work:reviewed-release
```

Use the published `sha256` digest, not the mutable tag. Retain the previous
qualified image. For multi-architecture nodes, publish the supported platforms
and choose the qualified index or matching platform digest. Image signing, SBOM
and provenance verification remain part of release qualification. This helper
requires digest references but does not verify registry signatures for you.

For air-gapped or `imagePullPolicy: Never` deployments, import or mirror the new
qualified image into the existing node's container runtime before the update.
The helper preserves pull policy and pull secrets; it will not change them or
silently download new tools. K3s can import a reviewed OCI archive with
`sudo k3s ctr images import /protected/reviewed-image.tar`. Verify the imported
digest against the release record, then delete the recreatable transport archive.

## Produce and review an application-only plan

Create a release file with one or more explicitly owned components:

```json
{
  "version": 1,
  "updates": [
    {
      "component": "work",
      "expectedImage": "registry.example/lolly-work@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "image": "registry.example/lolly-work@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  ]
}
```

Both images must be digest pinned. `expectedImage` is the existing qualified
image, so a concurrent release cannot be silently overwritten. If the desired
image is already running, the component is recorded as unchanged. Planning
performs Kubernetes reads and a server-side dry run; it makes no cluster writes:

```sh
python3 scripts/app-update.py \
  --target /protected/production-target.json \
  --release /protected/reviewed-release.json \
  --plan-out /protected/app-update-plan.json
```

Review the component, namespace, Deployment UID, container, before/after digest,
resource version and the displayed JSON Patch. Only a named container's image
may be replaced. The helper binds the rest of the Deployment spec to a protected
hash, including secrets, volumes, PVC references, other containers, resources,
security, selectors, replicas and strategy. It rejects a server-side admission
change to those fields. Raw Kubernetes resources, Secret contents and stderr
responses are not printed or written into the plan.

The displayed `reviewedPlanSha256` hashes canonical JSON, rather than the file's
whitespace. Copy that value after reviewing the plan. The helper refuses to
overwrite an existing plan or receipt file. Applying requires an explicit flag:

```sh
python3 scripts/app-update.py \
  --target /protected/production-target.json \
  --apply /protected/app-update-plan.json \
  --reviewed-plan-sha256 COPY_REVIEWED_PLAN_SHA256 \
  --receipt-out /protected/app-update-receipt.json
```

Apply validates all selected resources and server-side dry runs before the first
write, then rechecks identity immediately before each patch. Each patch includes
Kubernetes JSON `test` operations for Deployment UID, resource version, container
name and current image. If a controller or another operator changes the resource
version after review, make and review a new plan. The helper waits for every
changed Deployment, verifies its image and full replica readiness, then checks
its configured HTTPS health URLs. Extend `--rollout-timeout` from the default
180 seconds up to 1800 seconds for an intentionally slower deployment.
Python uses its standard trusted CA configuration. If an operator machine's
Python installation lacks system trust, point `SSL_CERT_FILE` or `SSL_CERT_DIR`
at the existing trusted system CA bundle, for example
`SSL_CERT_FILE=/etc/ssl/cert.pem` on macOS. Certificate and hostname verification
remain enabled; there is no insecure TLS option.

## Release ownership, rollback and limits

Coordinate concurrent operators. A set of multiple application patches is not an
atomic transaction. If a later patch, rollout or health check fails, earlier
successful patches remain applied; the helper reports failure and performs no
automatic rollback. Its phase output identifies each successfully patched
component. Structured failure output includes confirmed updates, every patch
attempt and the failed phase. A transport failure can happen after the API
committed its last patch, so inspect all patch attempts, not only confirmed
responses. Inspect those named resources, preserve any new data and decide the
next reviewed release. Do not respond by replaying a full infrastructure install.

For an application-only rollback, create a new release with `expectedImage` set
to the current digest and `image` set to the retained previous digest, then
produce and review a new plan. Do not use `rollout undo` against unknown revision
history, and do not roll back a database automatically. Database migrations,
engine/shell/catalog compatibility changes and data-bearing changes need their
own backup, migration and rollback review before releasing the application.

This narrow helper does not update Helm's stored release values or a GitOps
controller's desired image. Record the same reviewed digest in your maintained
environment values/release record, and coordinate any reconciler before applying
an image patch. Otherwise a later Helm upgrade or reconciliation could restore
the old image. Keep infrastructure upgrades as a separate reviewed operation.

## Publish mounted shell and tool content separately

An image update changes files baked into that image. A volume mounted over those
files keeps its existing contents. Inspect the Deployment's `volumeMounts`,
`volumes` and configured `instance.shellDir` / `instance.pack` before choosing the
release path. Work's `/admin` console is baked into its server image. A mounted
Lolly web shell or private tool pack is a separate release input. The public
Lolly `deploy/docker/web.Dockerfile` bakes the signed shell/tools/catalog into its
image, but model data mounted over `/models` remains separate.

Use Lolly's signed `pnpm run build:web:release` / `deploy/docker/web.Dockerfile`
workflow from an isolated checkout with the intended profile and existing
catalog signing-key/public-pin pair. The signing key is a BuildKit secret, never
an image argument or copied file. Follow
[Lolly's signed web-image guide](https://github.com/lolly-tools/lolly/blob/main/deploy/docker/README.md).
For a Work instance pack, materialize and inspect its matching profile:

```sh
node scripts/build-instance-pack.ts \
  --lolly /isolated/qualified-lolly-checkout --profile suse \
  --out /protected/new-instance-pack
node scripts/inspect-pack.ts /protected/new-instance-pack
```

`build-instance-pack.ts` records the source commit and initialized submodule
commits, refuses dirty source by default and validates the resulting real files
against the vendored engine. Server per-caller signing remains responsible for
the served tool index. Preserve the configured signing key, verification pin,
engine contract, brand state and source-reference compatibility. A changed
engine pin or Work configuration needs its own reviewed release.

For new installations, the existing chart supports immutable `shell.image`
and `pack.image` references with per-Pod `emptyDir` copies. Build the shell image
with `/shell/index.html` and the pack image with the tree under `/pack`; set
`shell.enabled: true`, `shell.type: emptyDir`, `shell.image`, `pack.type: emptyDir`
and `pack.image`, matching the configured mount paths. Pin both images by digest.
See [SMALL-SUSE.md](SMALL-SUSE.md) and the copy-init-container contracts in
`values.yaml`. Updating those init images is a separately reviewed application
Deployment change; the image-only helper does not alter init containers or volume
configuration. Never use a copy init container to overwrite an active shared PVC.

### Existing PVC installations: a reviewed single-volume promotion

This maintained manual workflow changes only the owned application's shell or
pack claim. It does not provision cloud infrastructure. There is currently no
generic automated PVC-content promoter. Site-specific historical migration
scripts are not a reusable release command.

1. Build and qualify the signed shell/pack outside production. Create a distinct
   candidate PVC in the application's namespace and populate it with a bounded
   candidate-only staging Pod. Never mount the active PVC in that Pod: SELinux
   may relabel it even read-only. If previous content is needed, stream a read-only
   snapshot through the existing owning application Pod into the separate claim.
2. Verify the candidate's exact source/content hashes, signatures, pin and engine
   compatibility. For a shell release, retain and verify previously published
   hashed JavaScript chunks so existing tabs can still fetch them. Record the
   candidate PVC UID and release evidence. Stop the staging Pod before promotion;
   leave the qualified candidate Bound and the previous claim retained.
3. Run the site's production preflight. Using the same explicit kubeconfig and
   context as the application target, verify cluster/node/namespace and Deployment
   UIDs. Capture the current Deployment resource version, owned volume index and
   current claim name/UID. Verify the owned application container mounts this
   volume read-only. Keep any resource snapshots in a mode-600 operator directory;
   they can contain configuration and must not be printed or committed.
4. Verify that the new PVC still has the reviewed UID, is Bound, is a filesystem
   volume and is in that namespace. Query active Pods server-side with
   `--field-selector=status.phase!=Succeeded,status.phase!=Failed`; refuse if any
   references the candidate claim. Include deleting Pods until they terminate.
   Review controllers/jobs for future candidate mounts, and coordinate exclusive
   ownership. Do not force-detach a claim or relax SELinux/security settings.
5. Prepare the exact JSON Patch below with the reviewed values. Server-side dry
   run it, then compare the before/after Deployment specs with only this claim
   name normalized. Every other field must match, including other claims, images,
   secrets, security, replicas, resources, selectors and strategy. Reject admission
   changes outside that one claim. Review the patch and content evidence together.
6. Immediately before apply, repeat the identities, candidate UID/Bound status and
   active-mount checks. Apply this same reviewed JSON Patch, then wait for the
   existing Deployment's rollout and verify the new claim and Ready replica.
   Do not run a full-chart apply or restart unrelated components. Kubernetes can
   guard the Deployment atomically, but a PVC check and Deployment patch are not
   one transaction; keep candidate-PVC writers and deletion controllers fenced.
7. Validate normal HTTPS UI, signature loading, exports and a previously open tab's
   lazy chunks. Test collaboration/reconnect and durable project/asset visibility.
   Retain the previous claim and release evidence. A failure leaves any successful
   patch applied; choose a fresh reviewed forward fix or rollback.

The patch is deliberately one `replace`; all preceding operations are tests:

```json
[
  {"op":"test","path":"/metadata/uid","value":"REVIEWED_DEPLOYMENT_UID"},
  {"op":"test","path":"/metadata/namespace","value":"REVIEWED_NAMESPACE"},
  {"op":"test","path":"/metadata/resourceVersion","value":"FRESH_RESOURCE_VERSION"},
  {"op":"test","path":"/spec/template/spec/volumes/2/name","value":"pack"},
  {"op":"test","path":"/spec/template/spec/volumes/2/persistentVolumeClaim/claimName","value":"previous-qualified-pack"},
  {"op":"replace","path":"/spec/template/spec/volumes/2/persistentVolumeClaim/claimName","value":"new-qualified-pack"}
]
```

The example index `2` and volume name `pack` are placeholders, not discovery rules.
Use the actual unique named volume; shell promotion uses its own index/name. A
stale resource version refuses; regenerate and review the patch. Through the
authorized kubectl route, the bounded mutation is:

```sh
kubectl --kubeconfig /protected/production.kubeconfig \
  --context reviewed-production-context --namespace reviewed-namespace \
  patch deployment reviewed-application --type=json \
  --patch-file /protected/reviewed-asset-patch.json --dry-run=server
# After the checks and review above, repeat with only --dry-run=server removed.
```

For rollback, verify the retained previous PVC's UID and contents, recapture the
Deployment resource version and prepare a new one-claim patch whose tested current
claim is the promoted claim. Preserve new project/database writes. Never copy
old files over the current live claim or undo a database to roll back a shell.

Test the updater locally without a cluster:

```sh
python3 tests/test_app_update.py
python3 -O tests/test_app_update.py
node --test tests/app-update.test.ts
```

The Node test is part of the normal `pnpm test` suite. It requires `python3` on
the test runner. The negative cases cover wrong identities, unowned components,
unpinned images, protected changes, server admission changes, stale versions and
applying without an exact reviewed plan. Tests do not deploy any resources.
