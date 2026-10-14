// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';

/**
 * Startup check for renderWorker.userNamespace (deploy/helm/templates/render-worker.yaml).
 *
 * On a cluster that cannot install a Localhost seccomp profile, Chromium's namespace
 * sandbox runs when the pod has its own Kubernetes user namespace (hostUsers: false)
 * and CAP_SYS_ADMIN plus CAP_SYS_CHROOT: the runtime's default seccomp profile only
 * permits unshare(CLONE_NEWUSER) with the first and chroot with the second. Inside a user
 * namespace the capabilities are scoped to the pod's own namespaces. Outside one they are
 * real host capabilities.
 *
 * An API server without user-namespace support drops `hostUsers` from the pod spec
 * instead of rejecting it, so the same manifest can land in the node's namespace. The
 * chart sets LW_RENDER_REQUIRE_USER_NAMESPACE=1 whenever it adds the capabilities, and
 * this check stops the worker before Chromium starts if any uid_map range reaches host
 * UID 0 - the identity map `0 0 4294967295` of a pod without its own namespace included.
 */
export function assertUserNamespace(required: string | undefined,
  uidMap: () => string = () => readFileSync('/proc/self/uid_map', 'utf8')): void {
  if (required === undefined || required === '') return;
  if (required !== '1') throw new Error('LW_RENDER_REQUIRE_USER_NAMESPACE must be 1 or unset');
  let map: string;
  try { map = uidMap(); } catch { throw new Error('A user namespace is required but /proc/self/uid_map is unreadable'); }
  const ranges = map.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  if (!ranges.length || ranges.some(range => range.length !== 3 || range.some(n => !Number.isSafeInteger(n) || n < 0))) {
    throw new Error('A user namespace is required but /proc/self/uid_map is malformed');
  }
  if (ranges.some(([, outside, count]) => outside === 0 && count! > 0)) {
    throw new Error('A user namespace is required (renderWorker.userNamespace) but this pod shares the node\'s user namespace; check that the cluster supports hostUsers: false');
  }
}
