# SUSE deployment handoff for platform teams

Use the same Lolly application and recovery contracts on your selected cloud or
on-premises cluster. SUSE Linux Enterprise Server or openSUSE Leap, K3s or RKE2,
Rancher, SUSE BCI and Application Collection are preferred building blocks.
Lolly's ordinary Helm chart still accepts another conformant Kubernetes cluster,
an external PostgreSQL service and operator-built application images. It does
not require a cloud vendor API, a new Rancher installation or a Collection
subscription.

## Readers: choose a starting point

| Your starting point | Next action |
|---|---|
| Existing Rancher-managed K3s/RKE2 or other Kubernetes | Use the [Work installation guide](../../docs/install.md#7b-production), existing Secrets and your reviewed ingress/storage policies |
| Fresh SLES/Leap VM on UpCloud or evroc | Run the host gate, then the [pinned K3s operator workflow](K3S-OPERATOR.md) and the Work Helm installation |
| Fresh SLES/Leap on another cloud or on-premises | Run the host gate, use your platform team's qualified cluster installation, then the same Helm release |
| Build images with Podman | Use the rootless image-build workflow below; deploy those images through your selected Kubernetes runtime |

OVHcloud, Hetzner, other sovereign/neocloud providers, hyperscaler public clouds
and on-premises hardware can supply a VM or a conformant cluster. Only UpCloud
and evroc have repository-owned infrastructure modules today. Those modules
have schema/mock tests; the production UpCloud deployment also has a real boot
and application recovery record. The other named providers are interface-based
deployment targets, not individually qualified products.

## IT operations: host gate to application acceptance

Select the host's exact hostname and one profile. The Python 3 gate is read-only
and provider-neutral; it emits a JSON receipt and exits nonzero when blocked.
Run it from the reviewed checkout using an OS administrator account for cluster
profiles. It reads only host metadata and does not inspect application secrets.

```sh
umask 077
sudo python3 -I deploy/suse/host-readiness.py \
  --profile k3s --expect-host lolly-rehearsal > /private/host-readiness.json
```

The initial cluster budget is four CPUs, seven usable GiB RAM and 40 GiB free in
`/var`. It checks versioned SLES/Leap, amd64, cgroup v2, no active swap, tooling,
firewalld, SELinux posture and absence of existing application/cluster owners or
occupied standard ports. These are rehearsal bounds, not measured capacity or a
runtime support matrix. A SUSE SELinux policy's existing scaffold is conservatively
blocked here; the pinned K3s installer has its own narrow package-owned scaffold
exception. Review that exact policy rather than deleting it to pass this gate.

Use [Ansible](../ansible/README.md) or [Salt](../salt/README.md) to run the same
gate through your existing fleet tooling. They do not introduce a second
installer. Keep the receipt with the private release record. A successful receipt
does not qualify provider firewall rules, the selected OS/runtime version,
storage, a cluster or Lolly itself. The handoff continues:

1. Review the selected runtime's current OS/architecture requirements and your
   image subscription/repositories. Preserve the host's existing security policy.
2. Provision only a new selected host using the
   [UpCloud](../upcloud/README.md) or [evroc](../evroc/README.md) OpenTofu/Terraform
   module, or your existing provider/on-premises automation. Keep API credentials,
   encrypted state and saved plans in operator custody. Do not apply cloud resources
   from the readiness playbook.
3. For the repository's locked K3s path, complete its current provider/network
   review, run `k3s-bootstrap.sh preflight`, then its guarded `install`. It stages
   the pinned runtime stopped and disabled. Follow its operator runbook to review,
   start and qualify that exact host. This installer presently accepts only
   UpCloud/evroc; the provider-neutral gate does not widen that install contract.
4. For RKE2, use your existing Rancher lifecycle or the official
   [RKE2 installation](https://docs.rke2.io/install/quickstart) and
   [requirements](https://docs.rke2.io/install/requirements). There is no repository
   RKE2 host installer or reviewed runtime lock. Inspect host policy, supported
   versions, cluster state, CNI and API boundaries separately. An existing cluster
   should skip the fresh-host gate and use its normal upgrade/change process.
5. Choose the provider CSI or qualified Longhorn design, independently managed
   PostgreSQL, private Secrets, signing keys and backups. The
   [SUSE profiles](README.md) cover the locked Application Collection PostgreSQL
   release and independent recovery. Public Redis admission belongs to the public
   service deployment; Work's job store needs PostgreSQL, not Redis.
6. Render and review the Work Helm chart with `values-small-suse.yaml` before
   installation. Use [SMALL-SUSE.md](../helm/SMALL-SUSE.md) and
   [install section 7b](../../docs/install.md#7b-production) for the application
   owner, immutable images, migrations and ingress. Work's writable collaboration
   owner remains one replica; this does not provide application HA.
7. Verify owner sign-in, invited viewers/editors, shared upload bytes on a second
   device, live editing, agent permissions/activity, provider queries, real exports
   and an independent byte-exact restore. Then use the
   [application update workflow](../helm/APP-UPDATES.md) for subsequent releases,
   with collaboration drain, target identity and rollback evidence.

Do not run a fresh-host installer over an existing instance. Lolly's current
production domains use UpCloud/K3s; historical Compose, Neon or Vercel deployment
commands are not their production route. The generic options remain available
for separately selected instances.

## Developers: build and release with SUSE images

The Work BCI variant already pins `registry.suse.com/bci/nodejs` to a reviewed
multi-architecture digest. Build the application inside BCI's glibc userspace;
do not transfer Alpine native dependencies. Under a rootless Podman build owner
with reviewed `/etc/subuid` and `/etc/subgid` ranges, check the build host first:

```sh
python3 -I deploy/suse/host-readiness.py \
  --profile podman-build --expect-host lolly-build
podman build --file deploy/compose/Dockerfile.suse \
  --tag registry.example.com/team/lolly-work-server:suse-candidate .
```

The gate does not initialize Podman storage, pull images or run a container.
The build does use the owner's image store; choose its storage capacity and
cleanup policy before building. Podman supplies the OCI build route; it is not
required on K3s/RKE2 nodes, which use their managed containerd runtime. Preserve
the owner's registry configuration. Use a separate `--authfile` and stdin token
for a registry login when needed; never check it into the checkout.

Qualify the built image's native dependencies, boot, migrations and real renders
on each selected architecture. Publish immutable application, shell, pack and
worker image references; pin their digests in the reviewed Helm values. The BCI
Work image already has separate container qualification in CI. That does not
qualify an arm64 Kubernetes release or a new Chromium worker base.

Use `dp.apps.rancher.io` for Collection OCI images/charts and
`registry.suse.com` for BCI bases. Preserve upstream source identity and verify
signatures/digests before mirroring into a disconnected registry. Review the
dependency's license/entitlement and each release's resources, TLS and recovery.
The ordinary Work release remains usable with external PostgreSQL and no
Collection account.

Podman/Quadlet as the full Work runtime is a planned qualification phase.
SUSE recommends Podman for its container ecosystem, but replacing this kit's
Docker Compose orchestration requires tested units, owned volume labels,
secrets, proxy routes, migrations, startup/reboot and independent restore.
Do not substitute `podman compose` into the historical VM production scripts.

## Support and remaining qualification

| Surface | Available now | Still required |
|---|---|---|
| Host readiness | CLI, Ansible and Salt; fixture/refusal tests | Real adapter execution on each selected SLES/Leap image |
| New K3s host | Locked amd64 installer, provider/network guards | Actual candidate capacity and full application/storage acceptance |
| Existing K3s/RKE2 | Work Helm profiles, immutable releases and guarded app-only updates | Platform's OS/runtime matrix and cluster lifecycle; RKE2 host installation is reference-only |
| SUSE BCI Work image | Pinned base, CI boot/native checks | Selected target architecture and render acceptance |
| AppCo PostgreSQL | Locked separate chart, TLS, rehearsal and backup tools | Every new database/storage target and measured independent restore |
| Rootless Podman build | OCI build instructions and owner/host gate | Actual build and native image acceptance on the selected host |
| Podman/Quadlet runtime | Design and acceptance requirements | Runnable units and fresh/reboot/restore qualification |
| Other cloud/on-premises foundations | Shared VM/Kubernetes release contracts | Provider-specific image, network, CSI, quota, billing and recovery checks |

Follow [SUSE's support matrix](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/),
[K3s requirements](https://docs.k3s.io/installation/requirements),
[SUSE's Container Guide](https://documentation.suse.com/en-us/container/all/html/Container-guide/index.html)
and [Podman Quadlet documentation](https://docs.podman.io/en/stable/markdown/podman-systemd.unit.5.html).
