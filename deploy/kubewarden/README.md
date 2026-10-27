# Kubewarden policy set for Lolly Work

For platform teams that run [Kubewarden](https://www.kubewarden.io/) and want admission
policy for Work's pods. Nothing here is installed by the Helm chart; a cluster without
Kubewarden is unchanged. The full guide is
[admission policy with Kubewarden](../../docs/admission-policy.md).

| File | What it holds |
|---|---|
| [`lolly-work-requirements.json`](lolly-work-requirements.json) | What Work's pods need, as data: user and group IDs, capabilities, seccomp and AppArmor profiles, volume types, host access, images and their signing identity, and the render worker's network rules. Generated from the chart, never edited by hand |
| [`policies.yaml`](policies.yaml) | 13 `ClusterAdmissionPolicy` objects that admit those pods and refuse everything else |
| [`options/render-worker-user-namespace.yaml`](options/render-worker-user-namespace.yaml) | Only for `renderWorker.userNamespace.enabled=true` |

## What Work's pods need

Every pod (control plane, migration Job, render worker, and the optional pack and web
app copy steps) runs as UID and GID 1000 with `fsGroup` 1000, drops every capability,
refuses privilege escalation, keeps a read-only root filesystem, uses the runtime's
default seccomp profile and uses no host network, PID, IPC, ports or user namespace.
Volumes are `configMap`, `emptyDir`, `secret` and `persistentVolumeClaim`.

Chart options change that list:

| Chart value | What changes |
|---|---|
| `renderWorker.seccompProfile: { type: Localhost, localhostProfile: lolly/chromium.json }` | The worker uses the reviewed profile in [`../seccomp`](../seccomp/README.md) |
| `renderWorker.appArmorProfile: { type: Localhost, localhostProfile: lolly-chromium }` | The worker uses the reviewed profile in [`../apparmor`](../apparmor/README.md) |
| `renderWorker.userNamespace.enabled: true` | The worker gets its own user namespace (`hostUsers: false`) and adds `SYS_ADMIN` and `SYS_CHROOT` there |
| `pack.type` or `shell.type` `hostPath` | A `hostPath` volume, for a single node only. The policy set refuses it |
| `serviceAccount.automountServiceAccountToken: true` | A `projected` token volume. The policy set refuses it; Work needs no Kubernetes API access |
| `pack.image`, `shell.image` | An init container running your image. Add its repository to `lolly-work-image-sources` |

Both images, `ghcr.io/lolly-tools/lolly-work-server` and `...-render-worker`, are
signed keyless by `.github/workflows/release.yml` at a release tag: issuer
`https://token.actions.githubusercontent.com`, subject
`https://github.com/lolly-tools/lolly-work/.github/workflows/release.yml@refs/tags/v<version>`.
The signatures are Sigstore bundles stored as OCI referrers (cosign 3), with no
`.sig` tag.

The render worker accepts connections from the control plane only, on port 8791. It
reaches cluster DNS and public addresses on ports 80 and 443; private, shared, loopback,
link-local (including cloud metadata) and documentation ranges are refused by its
NetworkPolicy and again by its own code.

## Apply

```sh
kubectl label namespace lolly-work lolly.tools/policy-set=lolly-work
kubectl apply -f deploy/kubewarden/policies.yaml
kubectl wait --for=condition=PolicyActive clusteradmissionpolicy \
  -l app.kubernetes.io/part-of=lolly-work-policy-set --timeout=5m
```

The policies apply to Pods in namespaces with that label, so keep PostgreSQL and other
workloads in another namespace, and let only cluster administrators change namespace
labels. Check your values before installing:

```sh
helm template lolly-work deploy/helm -n lolly-work -f my-values.yaml \
  | node scripts/kubewarden-preflight.ts --namespace lolly-work --probes
```

The preflight sends each pod the chart would create as a server-side dry run, then nine
copies of the control-plane pod that each break one rule (privileged, an added
capability, root, a writable root filesystem, the host network, a `hostPath` volume,
an unconfined seccomp profile, an unsigned image and an unlisted image). It exits 1
when a Work pod is refused or a probe is admitted.

## The policies

| Policy | Published policy | What it enforces |
|---|---|---|
| `lolly-work-privileged` | `pod-privileged` v1.0.14 | No privileged container |
| `lolly-work-privilege-escalation` | `allow-privilege-escalation-psp` v1.0.15 | `allowPrivilegeEscalation: false` |
| `lolly-work-capabilities` | `capabilities-psp` v1.0.15 | Drop `ALL`, add nothing (every pod except the render worker) |
| `lolly-work-capabilities-render-worker` | `capabilities-psp` v1.0.15 | The same for the render worker; the user-namespace option widens this one |
| `lolly-work-user-group` | `user-group-psp` v1.1.5 | UID and GID 1000, supplemental groups within 1000 |
| `lolly-work-fsgroup` | `allowed-fsgroups-psp` v1.0.14 | `fsGroup` 1000 |
| `lolly-work-host-namespaces` | `host-namespaces-psp` v1.1.13 | No host network, PID, IPC or ports |
| `lolly-work-volumes` | `volumes-psp` v1.1.12 | `configMap`, `emptyDir`, `persistentVolumeClaim`, `secret` |
| `lolly-work-readonly-root` | `readonly-root-filesystem-psp` v1.0.15 | A read-only root filesystem in every container |
| `lolly-work-seccomp` | `seccomp-psp` v1.0.16 | `RuntimeDefault`, or `Localhost` `lolly/chromium.json` |
| `lolly-work-apparmor` | `cel-policy` v1.6.5 | Unset, `RuntimeDefault`, or `Localhost` `lolly-chromium`, in the field and the annotation |
| `lolly-work-image-sources` | `trusted-repos` v2.1.6 | Only Work's two images (add your pack, web app and mirror repositories) |
| `lolly-work-image-signatures` | `verify-image-signatures` v1.0.13 | Work's images carry a signature from the release workflow; each pod is pinned to the verified digest |

Each module is pinned by tag and digest. `lolly-work-user-group` and
`lolly-work-image-signatures` mutate pods: the first fills an unset container UID or GID
with 1000, the second replaces a tag with the digest it verified.

## Four things found while qualifying

- `verify-image-signatures` reads the prefix setting as `url_prefix`, although its
  README shows `urlPrefix`, and appends `/` to the prefix. A prefix ending in
  `refs/tags/v` therefore matches nothing; the set uses `refs/tags/`.
- `apparmor-psp` reads only the `container.apparmor.security.beta.kubernetes.io/`
  annotation. Kubernetes 1.30 and later, and this chart, use
  `securityContext.appArmorProfile`, which it admitted unchecked, so the set uses a CEL
  rule instead.
- `user-group-psp` v1.1.5 with `validate_only: true` refuses `MustRunAs` even when the
  ID is present and within range, and checks each container without the pod's value.
  The set runs it as a mutating policy.
- A first signature verification fetches Sigstore's trust material and can take longer
  than the Policy Server's 2 second evaluation limit, so that policy sets
  `timeoutEvalSeconds: 10`. The Policy Server restarts whenever a policy changes; give
  it a minute before testing.

## Mirrored images

A mirror changes the image names. Add the mirrored repositories to
`lolly-work-image-sources` and as `image` patterns in `lolly-work-image-signatures`,
and copy the signatures with the images (`cosign copy`, or a registry that serves OCI
referrers). The signing identity stays the same.

## Qualification record (2026-10-27)

Kubewarden 1.38.2 (`admission-controller` chart 6.1.0) on K3s v1.35.5+k3s1 in k3d 5.9.0,
arm64. Work 1.1.2 and its render worker, pinned by digest, with PostgreSQL 17 in a
separate namespace and the worker on the `Localhost` seccomp profile:

- the migration Job, the control plane and the render worker were admitted, and both
  Deployments became ready (the worker's readiness requires a launched, sandboxed
  Chromium);
- a privileged pod and Work's own pod spec with the unsigned `lolly-work-server:0.2.0`
  image were refused on a real create, by `lolly-work-privileged` and
  `lolly-work-image-signatures`;
- all nine preflight probes were refused, each by the policy for its rule, and a
  the release signature was refused by a policy that asked for a different workflow;
- an unreviewed AppArmor profile was refused, the user-namespace worker was refused
  without the option file and admitted with it, and a pod that borrowed the worker's
  label without its own user namespace was refused by the CEL rule.

## When the chart changes

Run `node scripts/kubewarden-requirements.ts --write` and review the diff of
`lolly-work-requirements.json`. `tests/kubewarden-policies.test.ts` fails until the
requirements match the chart and the policies agree with the requirements.
