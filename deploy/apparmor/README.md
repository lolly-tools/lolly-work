# Chromium AppArmor companion profile

**Use an SELinux host if you can.** openSUSE Leap 16, SUSE Linux Enterprise
Server 16 and the Lolly appliance ship SELinux, and the render worker needs
nothing from this directory there: the seccomp profile in
[`../seccomp/`](../seccomp/README.md) is the whole policy. AppArmor is the
older of the two policy systems, and Lolly treats it as a compatibility case.

`lolly-chromium` is for hosts that still run AppArmor, such as Debian and
Ubuntu, where the container runtime's default AppArmor profile stops Chromium
from creating its sandbox. It is opt-in everywhere: the chart leaves it out
unless `renderWorker.appArmorProfile` is set, and the image qualification uses
it only with `--apparmor-profile lolly-chromium`.

## What it is

The rules are Docker's `docker-default` profile from
[moby/profiles](https://github.com/moby/profiles) (`apparmor/template.go`,
Apache 2.0) with the names filled in, plus two lines:

- `userns,` lets processes in the container create a user namespace. Chromium
  puts each renderer in a new user namespace, with new PID and network
  namespaces, before it applies its own seccomp filter. AppArmor 4 checks user
  namespace creation, and a profile without this rule refuses it.
- `unix,` states access to Unix sockets outright. Under ABI 4.0 the `network`
  rule already includes them; the line keeps Chromium's IPC working if a later
  ABI separates them.

Everything else, including `deny mount` and the `/proc` and `/sys` write
denials, is unchanged. The profile declares `abi <abi/4.0>`, so it needs
AppArmor 4 user space (Debian 13, Ubuntu 24.04 and newer).

## When a host needs it

Whether the runtime's default profile refuses Chromium depends on how that
profile was built, not only on the distribution. Docker 26.1.5's template has
no `abi` line, so Debian's parser compiles it against Debian's AppArmor 4
feature set, which checks user namespaces. The current moby/profiles template
and containerd 2.3.4 (the version in K3s 1.37) pin `abi <abi/3.0>`, which
predates that check, and Docker 29.1.3 allowed the user namespace. Measure the
host rather than assume: run the image qualification without the profile
first, and add it when Chromium stops at `credentials.cc` with an
`apparmor="DENIED" operation="userns_create"` line in the kernel log.

Measured on 27 October 2026 with the `lolly-work-render-worker:1.1.2` image
(arm64), launching Chromium with `workerBrowserOptions()` and checking
`linuxSandboxEvidence()`, with the qualification's container settings: UID
1000, all capabilities dropped, no new privileges, read-only root, no network.

Docker 26.1.5 (Debian's `docker.io` package), Debian 13, kernel
6.12.111+deb13-cloud-arm64, AppArmor 4.1.0:

| Seccomp | AppArmor | Chromium |
| --- | --- | --- |
| Docker default | `docker-default` | `No usable sandbox` |
| `chromium.json` | `docker-default` | `credentials.cc:131` permission denied; kernel logs `userns_create` denied for `docker-default` |
| `chromium.json` | `lolly-chromium` | launches; `linuxSandboxEvidence` passes |
| Docker default | `lolly-chromium` | `No usable sandbox` (the seccomp profile is still required) |

Docker 29.1.3, Ubuntu 26.04.1, kernel 7.0.0-34-generic, AppArmor 5.0.2,
`kernel.apparmor_restrict_unprivileged_userns=1`:

| Seccomp | AppArmor | Chromium |
| --- | --- | --- |
| Docker default | `docker-default` | `No usable sandbox` |
| `chromium.json` | `docker-default` | launches; `linuxSandboxEvidence` passes |
| `chromium.json` | `lolly-chromium` | launches; `linuxSandboxEvidence` passes |
| `chromium.json` | unconfined | `No usable sandbox`: Ubuntu moves unconfined processes that create a user namespace to its `unprivileged_userns` profile, which denies the capabilities Chromium needs |

K3s 1.37.1 (containerd 2.3.4) on the same Debian 13 host, with the security
context the chart renders:

| Chart values | AppArmor in effect | Chromium |
| --- | --- | --- |
| defaults | `cri-containerd.apparmor.d` | `No usable sandbox` |
| `seccompProfile` Localhost `lolly/chromium.json` | `cri-containerd.apparmor.d` | launches; `linuxSandboxEvidence` passes |
| the above plus `appArmorProfile` Localhost `lolly-chromium` | `lolly-chromium` | launches; `linuxSandboxEvidence` passes |

The same refusal was first seen on a Debian 13 amd64 cloud server (kernel
6.12.107+deb13-cloud-amd64, Docker 26.1.5) during the Mulga Spinifex
qualification run. The passing rows were measured on arm64 only.

Never use `apparmor=unconfined` instead. It removes the `/proc`, `/sys` and
mount denials as well, and on Ubuntu it does not even start Chromium.

## Install

The profile has to be loaded on every host or node that runs the worker, by
someone allowed to change host security policy. The chart cannot install it.

```sh
sudo install -m 644 deploy/apparmor/lolly-chromium /etc/apparmor.d/lolly-chromium
sudo apparmor_parser -r /etc/apparmor.d/lolly-chromium
```

Files in `/etc/apparmor.d` are loaded again at boot. Check that a container
gets it in enforce mode, not complain mode:

```sh
docker run --rm --security-opt apparmor=lolly-chromium --entrypoint cat \
  ghcr.io/lolly-tools/lolly-work-render-worker:<version> /proc/self/attr/current
# lolly-chromium (enforce)
```

With Docker or Compose, pass both profiles:

```sh
--security-opt seccomp=deploy/seccomp/chromium.json --security-opt apparmor=lolly-chromium
```

With the Helm chart (Kubernetes 1.30 or newer, AppArmor nodes only), install
`chromium.json` as described in [`../seccomp/README.md`](../seccomp/README.md)
and set:

```yaml
renderWorker:
  seccompProfile: { type: Localhost, localhostProfile: lolly/chromium.json }
  appArmorProfile: { type: Localhost, localhostProfile: lolly-chromium }
```

A kubelet on a node without AppArmor refuses a pod that names an AppArmor
profile, so leave `appArmorProfile` empty on SELinux nodes, and keep worker
pods off mixed node pools with `renderWorker.nodeSelector`.

To qualify an image on an AppArmor host:

```sh
node scripts/qualify-render-worker-image.ts --lolly-root <checkout> --image <image> \
  --sandbox-profile chromium --apparmor-profile lolly-chromium
```

The script refuses to start unless the profile is loaded in enforce mode.

## Residual risk

`userns,` lets any process in the worker container create a user namespace,
not only Chromium. Inside it the process holds capabilities over that
namespace, so kernel code that checks namespaced capabilities becomes
reachable. The seccomp profile still limits which system calls get there, the
worker runs as UID 1000 with no capabilities in the host namespace and no new
privileges, and the profile still denies mounts. This is the same exposure the
seccomp profile and the chart's `userNamespace` option already accept, and
security review should accept it explicitly. Keep the host kernel patched.
