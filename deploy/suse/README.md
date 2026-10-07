# SUSE deployment profiles

Run Lolly Work and the public Lolly services on the same qualified cluster when
that fits your isolation and recovery requirements. Use separate namespaces,
service accounts, credentials and private/public ingress rules. Existing Compose
and external PostgreSQL deployments remain available; selecting these profiles
does not migrate an instance or change DNS.

## Choose the cluster and storage

The [platform-team workflow](PLATFORM-TEAMS.md) connects the provider-neutral
host readiness gate, Ansible/Salt adapters, existing guarded K3s installation,
Work Helm release and recovery acceptance. It also documents BCI/Podman image
builds and the remaining RKE2/Quadlet qualification boundaries.

The [K3s operator workflow](K3S-OPERATOR.md) provides pinned candidate bootstrap,
restricted host/provider preflight and credential-safe cluster checks for both
UpCloud and Evroc. It stages only a fresh dedicated host, keeps Compose available
and requires actual recovery/application acceptance before cutover.

| Profile | Intended starting point | Acceptance required |
|---|---|---|
| K3s on openSUSE or SLES | A small team; one application owner and optional bounded render worker | Host image, supported versions, sign-in, shared editing, render load and restore |
| RKE2 with Rancher | Teams needing its operational and hardening controls | Supported OS/runtime matrix, host hardening, network policies and the same application checks |
| Provider CSI | Persistent block storage on UpCloud or Evroc | Actual driver permissions, attachment, disk performance and independent recovery |
| Longhorn | Multi-node deployments needing replicated volumes | Separate storage capacity, replica placement, failure and backup restore tests |

For a new small K3s candidate, 4 vCPU, 8 GiB memory and 80 GB disk are a starting
benchmark budget, not measured application capacity or an approved cloud plan.
Kubernetes system services, ingress, image caches, PostgreSQL, browser processes
and rollback releases need headroom beyond the chart requests. Containers share
node resources; a cloud Kubernetes worker can still be a billable VM. Keep the
existing production host running during rehearsal. Installing a second ingress
on its occupied ports is not a cutover procedure.

Use [K3s requirements](https://docs.k3s.io/installation/requirements),
[RKE2 requirements](https://docs.rke2.io/install/requirements) and the
[SUSE support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/)
to choose versions and host preparation. RKE2's CIS profile also needs the
[documented host and policy steps](https://docs.rke2.io/security/hardening_guide).
Choosing a distribution does not apply those steps automatically.

UpCloud's [CSI driver](https://upcloud.com/docs/products/managed-kubernetes/container-storage-interface/)
provides provider block volumes and snapshot features. Evroc's
[CSI driver](https://docs.evroc.com/integrations/csi-driver.html) has different
capabilities: its published guide currently lists no CSI snapshots, cloning or
volume expansion. Qualify the selected version and use logical PostgreSQL and
object-store backups on both targets. An attachment or snapshot alone does not
prove database recovery.

Do not add replicated storage merely to copy a signed shell or immutable pack.
The Work chart can populate bounded `emptyDir` volumes from their OCI images.
Use persistent volumes for durable database storage, and independent backups.
Longhorn belongs in a measured multi-node design; follow its
[resource and placement guidance](https://longhorn.io/docs/1.13.0/best-practices/)
and account for each storage replica. Leave storage-engine selection to a
qualified configuration rather than enabling additional engines by default.

## Render the small Work profile

Merge the resource profile before your instance values. The latter supply the
actual base URL, existing application/database Secrets, complete release image
references, ingress and pack/shell choices.

```sh
helm lint deploy/helm -f deploy/helm/values-small-suse.yaml -f instance-values.yaml
helm template lolly-work deploy/helm \
  -f deploy/helm/values-small-suse.yaml -f instance-values.yaml > /private/lolly-work.yaml
```

Inspect the generated manifests, then use the production installation procedure
in [install.md](../../docs/install.md#7b-production). Keep the rendered file
private: chart-managed Secrets appear in the output. Prefer existing Secret
references for production. The profile keeps the render worker disabled until
you enable it and supply its shell origin and matching render credential.

The app and migration Job use `image.digest`; the worker uses
`renderWorker.image.digest`. Digests are SHA-256 references to your complete
published Lolly images. They override tags; the default empty digest preserves
existing tag behavior. Registry credentials in top-level `imagePullSecrets`
reach the application, migration Job and worker. Worker-specific credentials
can override the inherited list. OCI pack/shell images use complete image
references, so pin their digests directly in `pack.image` and `shell.image`.

The profile limits CPU, memory, temporary storage and artifact-copy volumes.
Increase the shell/pack bounds when your expanded release needs more space.
Keep PostgreSQL and S3 records out of ephemeral volumes. A single application
owner uses `Recreate` with a collaboration drain. Multiple writable Work
replicas remain refused; worker autoscaling does not establish application HA
or provision additional nodes.

The public repository has a separate `deploy/helm/profiles/lean.yaml` for its
static web shell and optional MCP/CA. It does not install Work, a database,
collaboration relay, Penpot or model hosting. Preserve public route parity and
private-data boundaries before moving lolly.tools. See the
[cloud cutover guide](../../docs/cloud-deployment.md#public-shell-cutover).

## Preferred SUSE image sources

Use `registry.suse.com` for SUSE BCI bases and `dp.apps.rancher.io` for
Application Collection containers and Helm charts. The Collection website is
[apps.rancher.io](https://apps.rancher.io); it is not the OCI pull endpoint.
Build the Lolly application into the chosen base, resolve immutable digests,
and test each target architecture before publishing. A base image by itself
cannot serve Lolly. Pin the application image digest in the deployment as well
as the base digest in its Dockerfile.

The optional `deploy/compose/Dockerfile.suse` builds the Work server on SUSE BCI
Node 24. It installs the frozen production dependencies inside the glibc image;
Alpine's native binaries are not copied across. Build from the repository root:

```sh
docker build -f deploy/compose/Dockerfile.suse \
  -t registry.example.com/team/lolly-work-server:suse-candidate .
```

The separate CI qualification builds and boots this candidate and checks native
render dependencies. It does not publish an image or switch production. The
Chromium worker retains its existing image; changing browser packages and its
sandbox/runtime requires separate render qualification. The public shell/CA/MCP
images also retain their existing bases unless a separately qualified variant
is chosen.

## Application Collection dependencies

Application Collection's [Penpot chart](https://docs.apps.rancher.io/reference-guides/penpot)
uses optional PostgreSQL and Redis dependencies. Lolly follows the useful part
of that model: manage a needed dependency explicitly, with its own version,
credentials, resource budget and recovery lifecycle. Work needs PostgreSQL for
durable records and jobs; adding Redis is unnecessary for that path. Public
MCP/CA currently use a REST admission-store adapter, so a Redis TCP endpoint is
not a compatible replacement without an adapter and qualification.

Application Collection requires a username plus token, or an organization
service-account username plus secret. An organization service account inherits
that organization's subscriptions. Use the existing account's entitlements;
see [authentication](https://docs.apps.rancher.io/get-started/authentication)
and [subscriptions](https://docs.apps.rancher.io/get-started/subscriptions).
Keep token bytes in an owner-readable file. Log in through stdin with a separate
Helm configuration when inspecting candidates, preserving your existing login:

```sh
(
  umask 077
  APPCO_CONFIG_DIR=$(mktemp -d)
  trap 'rm -rf "$APPCO_CONFIG_DIR"' EXIT
  export HELM_REGISTRY_CONFIG="$APPCO_CONFIG_DIR/registry.json"
helm registry login dp.apps.rancher.io --username "$APPCO_USERNAME" \
  --password-stdin < /private/appco-access-token.txt
helm show values oci://dp.apps.rancher.io/charts/postgresql \
  --version "$APPCO_POSTGRES_CHART_VERSION" > /private/postgresql-values.reference.yaml
helm show readme oci://dp.apps.rancher.io/charts/postgresql \
  --version "$APPCO_POSTGRES_CHART_VERSION" > /private/postgresql-readme.reference.md
) # The subshell removes only its temporary login and preserves caller settings.
```

Select an explicit chart version and retain its package checksum, image digests
and configuration review with the release record. Use the chart's actual values
and README for authentication, TLS, resources and persistence; do not assume
another PostgreSQL chart has the same keys. Provision the Collection pull Secret
in its namespace and set `global.imagePullSecrets` to that Secret's name. Keep
the database on a separate Helm release so an application removal does not also
remove its database. Keep the ordinary Work chart independent of Collection
registry access; external PostgreSQL remains its default.

The checked-in `appco-postgresql.yaml` pins chart 0.8.0 and PostgreSQL 18.6.
A read-only inventory found the existing migration source already runs
PostgreSQL 18.6; the earlier PG17 candidate cannot receive that source dump.
`appco-postgresql.lock.json` records the chart OCI/archive checksums, the image
index and both architecture digests. Official Cosign verification, strict Helm
lint and Kubernetes 1.34 schemas passed. A native arm64 rehearsal booted as
UID1000 with TLS and restored a consistent source snapshot; all twelve critical
table data checks and all 49 migration names matched. This does not qualify
amd64, Kubernetes storage, application behavior or production migration.
Follow [the guarded PostgreSQL rehearsal](POSTGRESQL-REHEARSAL.md) for those checks.

Pull that exact chart using your isolated registry login, then compare the
archive SHA-256 to the lock file before rendering. This example assumes the
archive was downloaded to your private staging directory:

```sh
node --input-type=module - /private/postgresql-0.8.0.tgz <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const lock = JSON.parse(readFileSync('deploy/suse/appco-postgresql.lock.json', 'utf8'));
const actual = createHash('sha256').update(readFileSync(process.argv[2])).digest('hex');
assert.equal(actual, lock.chart.archiveSha256, 'Chart package differs from the reviewed candidate');
JS
helm template lolly-postgres /private/postgresql-0.8.0.tgz \
  -f deploy/suse/appco-postgresql.yaml -f postgres-instance-values.yaml
```

Provide `application-collection` as the registry pull Secret,
`lolly-postgres-auth` with `password`, `postgresPassword` and
`replicationPassword` keys, and `lolly-postgres-tls` with `server.crt`,
`server.key` and `ca.crt`. Change those names in your instance values when needed.
The app user is `lollywork`, separate from the PostgreSQL superuser. The
profile enables TLS, uses existing Secrets, requests 16 GiB persistent storage
and sets database resource budgets. `auth.database` stays empty: create the
candidate database explicitly from `template0` with the source-compatible
UTF8, built-in locale provider and `C.UTF-8` locale before restoring. A bounded
socket volume and `fsGroup: 1000` let the non-root entrypoint write its socket
and persistent data. It creates no password-bearing Secret,
exporter or privileged volume-permission helper. Review the StorageClass,
certificate names/permissions, access policy and recovery before installation.
Use a `verify-full` Work connection with the correct trust chain and database
hostname. Render success cannot establish that trust chain or a working mount.

Use [the Collection PostgreSQL guide](https://docs.apps.rancher.io/reference-guides/postgresql)
for its deployment and TLS contract. After reviewing the pinned chart, install
it into a rehearsal namespace, create the Work connection-URL Secret and point
`database.existingSecret`/`database.existingSecretKey` at that value. Test
migrations, uploaded asset bytes, shared editing and the
[backup/restore procedure](../../docs/cloud-deployment.md#database-migration)
before migrating existing records. PostgreSQL major-version changes need their
own compatibility and restore checks. Record measured recovery time before
choosing the production outage window.

For mirrored or disconnected releases, retain verified artifacts and their
source identities. Collection publishes
[signature and attestation verification instructions](https://docs.apps.rancher.io/developer-toolkit/verify-signatures-with-cosign).
Mirror only the chosen application and dependency versions; no new registry
service is required for a connected small deployment.

## Optional WebAssembly tracks

See [WebAssembly and Kubewarden choices](../../docs/wasm-deployment.md) for
Rancher-managed admission policies and a separate WIT/WASI component evaluation.
Current profiles keep their qualified OCI workloads and containerd default
handler. A controller, RuntimeClass or component canary needs its own isolated
qualification before any production rollout.
