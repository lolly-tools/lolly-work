# Chromium namespace profile

`chromium.json` is derived from Playwright 1.64.0's Docker seccomp profile at
commit `606ecd8b34bac100db32561b6278ffd76e5eb3cd`, originally SHA-256
`cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`.
The upstream Apache 2.0 license is included here.

The upstream profile permits `clone`, `setns` and `unshare` for Chromium's user
namespaces. This version also permits `chroot`: Chromium uses that operation
inside its new namespace, while dropping every container capability otherwise
blocks the syscall through the profile's capability condition. Kernel capability
checks still apply. No container capabilities, privilege escalation or
unconfined seccomp mode are enabled.

Use the runtime default when the target platform already supports the required
browser sandbox. Otherwise have the cluster security operator review and install
this profile at `lolly/chromium.json` under each worker node's kubelet seccomp
directory. Configure `renderWorker.seccompProfile` with `type: Localhost` and
`localhostProfile: lolly/chromium.json`. The chart cannot install node policies.
Qualify the policy on the actual cluster kernel, AppArmor policy and runtime.
SELinux hosts need nothing more. On AppArmor hosts (Debian, Ubuntu), a runtime
default profile can still refuse Chromium's user namespace; the opt-in
companion in [`../apparmor/`](../apparmor/README.md) adds that one permission.

## When no node profile can be installed

On shared or managed clusters the platform team may not install node files at
all. There, set `renderWorker.userNamespace.enabled: true` and keep
`seccompProfile: { type: RuntimeDefault }`. The worker pod then gets its own
Kubernetes user namespace (`hostUsers: false`) with `CAP_SYS_ADMIN` and
`CAP_SYS_CHROOT`. The runtime's default profile permits `unshare(CLONE_NEWUSER)`
only with the first and `chroot` (which Chromium calls inside its new namespace,
as `chromium.json` above also has to allow) only with the second. Inside the
pod's user namespace both reach only the pod's own namespaces: container root
maps to an unprivileged host UID range, and the non-root worker process still
has an empty effective capability set, so the renderer evidence checks are
unchanged.

Measured on RKE2 1.35, containerd 2.2.6, SLES 15 SP7 kernel 6.4 with the worker
image built from this chart's source, UID 1000, no new privileges and a read-only
root, launching Chromium with `workerBrowserOptions()`:

| Pod | Chromium |
| --- | --- |
| `RuntimeDefault` | no user namespace (`unshare` denied) |
| `Localhost` profile not installed on the node | container creation fails |
| `hostUsers: false` + `RuntimeDefault` | no user namespace |
| `hostUsers: false` + `RuntimeDefault` + `SYS_ADMIN` | zygote aborts: `Check failed: sys_chroot(...)` |
| `hostUsers: false` + `RuntimeDefault` + `SYS_CHROOT` | `No usable sandbox` |
| `hostUsers: false` + `RuntimeDefault` + `SYS_ADMIN` + `SYS_CHROOT` | launches; `linuxSandboxEvidence` passes |

It needs Kubernetes 1.33 or newer, containerd 2.0 or newer and kernel 6.3 or
newer; the chart refuses older Kubernetes versions. An API server without
user-namespace support drops `hostUsers` rather than rejecting it, so the chart
also sets `LW_RENDER_REQUIRE_USER_NAMESPACE=1` and the worker refuses to start
when its `uid_map` reaches host UID 0. Security review should accept the
residual risk explicitly: the worker can mount, unshare and chroot inside its
own namespaces, so kernel defects in those paths remain reachable, as they are with
the Localhost profile.

Local image qualification selects `--sandbox-profile chromium` explicitly.
It keeps non-root execution, all capabilities dropped, no new privileges, a
read-only root filesystem, bounded scratch, and no external network. The test
examines the running renderer's user and PID namespaces and confirms an
additional seccomp filter beyond the container's filter. Startup flag presence
alone does not establish that the sandbox is active.
