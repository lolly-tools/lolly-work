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

Local image qualification selects `--sandbox-profile chromium` explicitly.
It keeps non-root execution, all capabilities dropped, no new privileges, a
read-only root filesystem, bounded scratch, and no external network. The test
examines the running renderer's user and PID namespaces and confirms an
additional seccomp filter beyond the container's filter. Startup flag presence
alone does not establish that the sandbox is active.
