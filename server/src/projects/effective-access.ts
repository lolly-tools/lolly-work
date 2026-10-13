// SPDX-License-Identifier: MPL-2.0
/** Manager-only inherited access. Never turn a project's grants into a directory. */
import type { ProjectRecord, Store, UserRecord } from '../store/types.ts';
import type { Grant } from '../rbac/evaluate.ts';
import { effectiveProjectAccess, grantLive, projectAccess, projectAccessRank, sharingLimits, type ProjectAccess } from '../rbac/project-access.ts';
import { nameWithoutEmail } from './sharing.ts';

const ROWS_MAX = 200;
type EffectiveRow = { userId: string; name: string; role: ProjectAccess; via: 'group' | 'custom-group' | 'admin'; group?: string; isMe?: true };

export async function effectiveAccessFor(
  store: Pick<Store, 'listUsers' | 'getShareGroup'>, caller: UserRecord, project: ProjectRecord,
  listed: ReadonlySet<string>, grants: Grant[], now = Date.now(),
) {
  const directory = caller.role === 'admin' || caller.role === 'owner';
  const policy = sharingLimits();
  const allGrants = project.sharing?.groups ?? [];
  const visible = project.visibility === 'private' ? [] : project.visibility.groups;
  const groups = visible.filter((name) => {
    const grant = allGrants.find((g) => g.kind === 'directory' && g.name === name);
    return (directory || caller.groups.includes(name)) && (!grant || grantLive(grant.expiresAt, now));
  });
  const custom = policy.customGroups ? allGrants.filter((g) => g.kind === 'custom'
    && grantLive(g.expiresAt, now) && (directory || caller.shareGroups?.includes(g.id))) : [];
  const names = new Map<string, string>();
  for (const grant of custom) if (grant.kind === 'custom') {
    const group = await store.getShareGroup(grant.id);
    if (group) names.set(grant.id, group.name);
  }
  // Hidden grants and the instance audience must not reveal a stronger role to a
  // group peer. Administrators may see the actual combined access instead.
  const peerProject: ProjectRecord = {
    ...project, visibility: { groups },
    sharing: { groups: allGrants.filter((g) => g.kind === 'directory' ? groups.includes(g.name) : names.has(g.id)) },
  };
  const rows: EffectiveRow[] = [];
  for (const user of await store.listUsers()) {
    if (listed.has(user.id) || user.disabledAt) continue;
    const group = groups.find((g) => user.groups.includes(g));
    const customId = [...names.keys()].find((id) => user.shareGroups?.includes(id));
    const admin = user.role === 'admin' || user.role === 'owner';
    if (!group && !customId && !(directory && admin)) continue;
    const role = directory ? effectiveProjectAccess(user, project, null, grants)
      : projectAccess({ ...user, role: 'member' }, peerProject, null, now);
    if (role === 'none') continue;
    rows.push({ userId: user.id, name: nameWithoutEmail(user), role,
      ...(group ? { via: 'group' as const, group } : customId
        ? { via: 'custom-group' as const, group: names.get(customId)! } : { via: 'admin' as const }),
      ...(user.id === caller.id ? { isMe: true as const } : {}),
    });
  }
  rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.userId.localeCompare(b.userId));
  const general = project.sharing?.general;
  const audienceRole = general?.audience === 'instance' && policy.instanceAudience
    ? [general.role, policy.instanceMaxRole, 'editor' as const].sort((a, b) => projectAccessRank(a) - projectAccessRank(b))[0]! : undefined;
  return {
    effective: rows.slice(0, ROWS_MAX), ...(rows.length > ROWS_MAX ? { effectiveTruncated: true } : {}),
    adminAccess: directory ? 'listed' as const : 'note' as const,
    ...(audienceRole ? { instanceAudience: { role: audienceRole } } : {}),
  };
}
