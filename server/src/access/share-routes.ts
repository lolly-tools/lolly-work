// SPDX-License-Identifier: MPL-2.0
/**
 * The sharing ladder's routes (lolly plan 299 M1, lolly-work plan 79).
 *
 *   GET  /api/v1/projects/:id/sharing            general access, group grants, settings, limits
 *   PUT  /api/v1/projects/:id/sharing            change any of those (managers, or editors when allowed)
 *   PUT  /api/v1/projects/:id/members/:userId/expiry   set or clear a member's end date
 *   GET  /api/v1/share-groups                    the caller's own groups
 *   POST /api/v1/share-groups                    make a group (`group.create`)
 *   GET  /api/v1/share-groups/people?q=          people the caller may add
 *   GET  /api/v1/share-groups/:id                one group and its members
 *   PATCH /api/v1/share-groups/:id               rename, add or remove people, set managers
 *   DELETE /api/v1/share-groups/:id              delete a group (its owner or an admin)
 *
 * People rows stay on the members routes; this module adds what those do not
 * carry. Every decision about who may see a project still comes from
 * `rbac/project-access.ts`, which reads what these routes write.
 *
 * Privacy: people suggestions come only from the projects and groups the
 * caller already shares with, plus an exact address the caller typed, and a
 * suggestion carries a name and an id, never an address.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { randomId } from '../lib/crypto.ts';
import { resolveInvitePolicy } from '../policy/invites.ts';
import { resolveSharingPolicy, type SharingPolicy } from '../policy/sharing.ts';
import { createWindowQuota, nameWithoutEmail } from '../projects/sharing.ts';
import {
  accessAtLeast, grantLive, isInstanceMember, mayShareProject, projectAccessRank, projectRelation, type ProjectAccess,
  type ProjectMembership,
} from '../rbac/project-access.ts';
import {
  PROJECT_MEMBER_ROLES, type ProjectGroupGrant, type ProjectMemberRole, type ProjectRecord, type ProjectSharing,
  type ProjectUserStateRecord, type ShareGroupRecord, type Store, type UserRecord,
} from '../store/types.ts';

/** The fields a project list row adds so a shell can keep its Projects view to
 *  the person's own work: why they can open the project, its general access, and
 *  their own choice to pin or hide it, with when they last opened it. */
export function projectListing(user: UserRecord, project: ProjectRecord, membership: ProjectMembership, state: ProjectUserStateRecord | undefined) {
  return {
    via: projectRelation(user, project, membership),
    audience: project.sharing?.general?.audience ?? 'restricted',
    ...(state?.listed ? { listed: state.listed } : {}),
    ...(state?.lastOpenedAt ? { lastOpenedAt: state.lastOpenedAt } : {}),
  };
}

interface Dependencies {
  config: InstanceConfig;
  store: Store;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  projectAccessOf(user: UserRecord, project: ProjectRecord): Promise<ProjectAccess>;
  audit(actor: string, action: string, subject: string, payload: Record<string, unknown>): Promise<unknown>;
}

export const SHARE_GRANT_LIMIT = 50;
export const SHARE_GROUP_NAME_MAX = 80;
export const SHARE_GROUP_DESCRIPTION_MAX = 280;
export const SHARE_GROUP_MEMBER_LIMIT = 500;
export const SHARE_GROUPS_PER_OWNER = 100;
const PEOPLE_LIMIT = 20;
const PEOPLE_PROJECT_SCAN = 50;
/** People lookups one person may make a minute (as `comment-people`). An exact
 *  address answers whether that address has an account here, so the lookup is
 *  metered like the other people searches. */
export const SHARE_PEOPLE_PER_MINUTE = 60;
const DAY_MS = 86_400_000;
const GROUP_NAME = /^[^\u0000-\u001f]{1,128}$/;
const NO_STORE = { 'cache-control': 'private, no-store' };

/** A label with control characters removed, trimmed, or null when empty or too long. */
function label(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return t && t.length <= max ? t : null;
}

const isRole = (v: unknown): v is ProjectMemberRole => typeof v === 'string' && (PROJECT_MEMBER_ROLES as readonly string[]).includes(v);
const rank = (r: ProjectMemberRole | ProjectAccess): number => projectAccessRank(r as ProjectAccess);

/** An end date from the wire: absent or null means none; otherwise a future
 *  ISO time inside the policy's limit. Returns an error message instead. */
function endDate(v: unknown, policy: SharingPolicy, now: number): { ok: true; at?: string } | { ok: false; message: string } {
  if (v === undefined || v === null) return { ok: true };
  if (typeof v !== 'string' || v.length > 40 || !Number.isFinite(Date.parse(v))) return { ok: false, message: 'expiresAt must be a date and time' };
  const at = Date.parse(v);
  if (at <= now) return { ok: false, message: 'expiresAt must be in the future' };
  if (policy.maxGrantDays !== null && at - now > policy.maxGrantDays * DAY_MS) {
    return { ok: false, message: `access may last at most ${policy.maxGrantDays} days on this instance` };
  }
  return { ok: true, at: new Date(at).toISOString() };
}

function groupRoleOf(group: ShareGroupRecord, user: UserRecord): 'owner' | 'manager' | 'member' | null {
  if (group.ownerId === user.id) return 'owner';
  if (group.managers.includes(user.id)) return 'manager';
  return user.shareGroups?.includes(group.id) ? 'member' : null;
}

const isAdmin = (user: UserRecord): boolean => user.role === 'admin' || user.role === 'owner';

export function registerShareRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  const policy = (): SharingPolicy => resolveSharingPolicy(d.config.policy.sharing);
  const allowedRoles = (): ProjectMemberRole[] => resolveInvitePolicy(d.config.policy.invites).projectRoles;
  const peopleQuota = createWindowQuota(SHARE_PEOPLE_PER_MINUTE, 60_000);

  async function projectFor(req: IncomingMessage, res: ServerResponse, id: string) {
    const user = await d.memberOf(req);
    if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    const project = await d.store.getProject(id);
    const access = project ? await d.projectAccessOf(user, project) : 'none';
    if (!project || access === 'none') { sendError(res, 404, 'NOT_FOUND', 'no such project'); return null; }
    return { user, project, access };
  }

  /** The share answer for one project, as `@lolly-tools/core/sharing-v1`
   *  `readShareState` reads it. */
  async function shareState(project: ProjectRecord, access: ProjectAccess) {
    const limits = policy();
    const sharing = project.sharing ?? {};
    const general = sharing.general && sharing.general.audience === 'instance' && limits.instanceAudience
      ? sharing.general : { audience: 'restricted' as const, role: 'viewer' as const };
    const grants: unknown[] = [];
    const visible = project.visibility === 'private' ? [] : project.visibility.groups;
    for (const name of visible) {
      const grant = sharing.groups?.find((g) => g.kind === 'directory' && g.name === name);
      grants.push({ principal: { kind: 'group', name }, role: grant?.role ?? 'editor', ...(grant?.expiresAt ? { expiresAt: grant.expiresAt } : {}) });
    }
    if (limits.customGroups) {
      for (const grant of sharing.groups ?? []) {
        if (grant.kind !== 'custom') continue;
        const group = await d.store.getShareGroup(grant.id);
        if (!group) continue;
        const memberCount = (await d.store.listShareGroupMembers(group.id)).length;
        grants.push({ principal: { kind: 'custom-group', id: group.id, name: group.name, memberCount }, role: grant.role, ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}) });
      }
    }
    const canManage = mayShareProject(project, access);
    const expiries: Record<string, string> = {};
    if (canManage) {
      for (const m of await d.store.listProjectMembers(project.id)) if (m.expiresAt) expiries[m.userId] = m.expiresAt;
    }
    return {
      general: { audience: general.audience, role: general.role },
      grants,
      expiries,
      settings: {
        viewersCanComment: sharing.settings?.viewersCanComment !== false,
        viewersCanExport: sharing.settings?.viewersCanExport !== false,
        editorsCanShare: sharing.settings?.editorsCanShare === true,
      },
      policy: {
        audiences: limits.instanceAudience ? ['restricted', 'instance'] : ['restricted'],
        instanceMaxRole: limits.instanceMaxRole,
        roles: allowedRoles(),
        customGroups: limits.customGroups,
        ...(limits.maxGrantDays !== null ? { maxGrantDays: limits.maxGrantDays } : {}),
      },
      canManage,
    };
  }

  router.add('GET', '/api/v1/projects/:id/sharing', async (req, res, ctx) => {
    const admitted = await projectFor(req, res, ctx.params.id as string);
    if (!admitted) return;
    sendJson(res, 200, await shareState(admitted.project, admitted.access), NO_STORE);
  });

  router.add('PUT', '/api/v1/projects/:id/sharing', async (req, res, ctx) => {
    const admitted = await projectFor(req, res, ctx.params.id as string);
    if (!admitted) return;
    const { user, project, access } = admitted;
    if (!mayShareProject(project, access)) return sendError(res, 403, 'FORBIDDEN', 'you cannot change who has access to this project');
    if (project.archivedAt) return sendError(res, 409, 'PROJECT_ARCHIVED', 'restore the project first');
    const body = (await readJson(req, 64 * 1024)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'INVALID_INPUT', 'body must be a JSON object');
    const limits = policy();
    const roles = allowedRoles();
    const isManager = accessAtLeast(access, 'manager');
    const now = Date.now();
    const sharing: ProjectSharing = structuredClone(project.sharing ?? {});
    let visibility = project.visibility;

    if (body.general !== undefined) {
      const g = body.general as { audience?: unknown; role?: unknown } | null;
      if (!g || typeof g !== 'object') return sendError(res, 400, 'INVALID_INPUT', 'general must be an object', { field: 'general' });
      if (g.audience === 'restricted') delete sharing.general;
      else if (g.audience === 'instance') {
        if (!limits.instanceAudience) return sendError(res, 403, 'AUDIENCE_NOT_ALLOWED', 'this instance does not allow sharing with everyone', { field: 'general' });
        if (!isRole(g.role) || g.role === 'manager') return sendError(res, 400, 'INVALID_INPUT', 'general.role must be viewer, commenter or editor', { field: 'general' });
        if (rank(g.role) > rank(limits.instanceMaxRole)) {
          return sendError(res, 403, 'ROLE_NOT_ALLOWED', `everyone on this instance can be at most ${limits.instanceMaxRole}`, { field: 'general' });
        }
        sharing.general = { audience: 'instance', role: g.role };
      } else return sendError(res, 400, 'INVALID_INPUT', 'general.audience must be restricted or instance', { field: 'general' });
    }

    if (body.grants !== undefined) {
      if (!Array.isArray(body.grants) || body.grants.length > SHARE_GRANT_LIMIT) {
        return sendError(res, 400, 'INVALID_INPUT', `grants must be a list of at most ${SHARE_GRANT_LIMIT}`, { field: 'grants' });
      }
      const before = new Map((sharing.groups ?? []).map((g) => [g.kind === 'directory' ? `group:${g.name}` : `custom-group:${g.id}`, g]));
      const beforeVisible = project.visibility === 'private' ? [] : project.visibility.groups;
      const next: ProjectGroupGrant[] = [];
      const seen = new Set<string>();
      for (const raw of body.grants as unknown[]) {
        const entry = raw as { principal?: { kind?: unknown; name?: unknown; id?: unknown }; role?: unknown; expiresAt?: unknown } | null;
        if (!entry || typeof entry !== 'object' || !entry.principal || typeof entry.principal !== 'object') {
          return sendError(res, 400, 'INVALID_INPUT', 'each grant needs a principal and a role', { field: 'grants' });
        }
        if (!isRole(entry.role)) return sendError(res, 400, 'INVALID_INPUT', 'role must be viewer, commenter, editor or manager', { field: 'grants' });
        const role = entry.role;
        const ends = endDate(entry.expiresAt, limits, now);
        if (!ends.ok) return sendError(res, 400, 'INVALID_INPUT', ends.message, { field: 'grants' });
        let grant: ProjectGroupGrant;
        let key: string;
        if (entry.principal.kind === 'group') {
          const name = typeof entry.principal.name === 'string' ? entry.principal.name.trim() : '';
          if (!GROUP_NAME.test(name)) return sendError(res, 400, 'INVALID_INPUT', 'a group needs a name', { field: 'grants' });
          key = `group:${name}`;
          grant = { kind: 'directory', name, role, ...(ends.at ? { expiresAt: ends.at } : {}) };
        } else if (entry.principal.kind === 'custom-group') {
          if (!limits.customGroups) return sendError(res, 403, 'GROUPS_OFF', 'this instance does not allow user-made groups', { field: 'grants' });
          const id = typeof entry.principal.id === 'string' ? entry.principal.id : '';
          key = `custom-group:${id}`;
          const group = id ? await d.store.getShareGroup(id) : null;
          // Share only with a group you belong to, unless it is already on the project.
          if (!group || (!before.has(key) && !groupRoleOf(group, user) && !isAdmin(user))) {
            return sendError(res, 404, 'NOT_FOUND', 'no such group', { field: 'grants' });
          }
          grant = { kind: 'custom', id, role, ...(ends.at ? { expiresAt: ends.at } : {}) };
        } else return sendError(res, 400, 'INVALID_INPUT', 'principal.kind must be group or custom-group', { field: 'grants' });
        if (seen.has(key)) return sendError(res, 400, 'INVALID_INPUT', 'each group may appear once', { field: 'grants' });
        seen.add(key);
        const previousRole: ProjectMemberRole | undefined = before.get(key)?.role
          ?? (grant.kind === 'directory' && beforeVisible.includes(grant.name) ? 'editor' : undefined);
        if (previousRole !== role && !roles.includes(role)) {
          return sendError(res, 403, 'ROLE_NOT_ALLOWED', `this instance does not allow giving the ${role} role`, { field: 'grants' });
        }
        // Only a manager gives or takes away manager access.
        if (!isManager && (role === 'manager' || previousRole === 'manager') && previousRole !== role) {
          return sendError(res, 403, 'FORBIDDEN', 'only a project manager can change manager access', { field: 'grants' });
        }
        next.push(grant);
      }
      if (!isManager) {
        for (const [key, g] of before) if (g.role === 'manager' && !seen.has(key)) return sendError(res, 403, 'FORBIDDEN', 'only a project manager can change manager access', { field: 'grants' });
      }
      sharing.groups = next;
      if (!next.length) delete sharing.groups;
      const directory = next.filter((g): g is Extract<ProjectGroupGrant, { kind: 'directory' }> => g.kind === 'directory').map((g) => g.name);
      visibility = directory.length ? { groups: directory } : 'private';
    }

    if (body.settings !== undefined) {
      const s = body.settings as Record<string, unknown> | null;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return sendError(res, 400, 'INVALID_INPUT', 'settings must be an object', { field: 'settings' });
      const settings = { ...(sharing.settings ?? {}) };
      for (const key of ['viewersCanComment', 'viewersCanExport', 'editorsCanShare'] as const) {
        if (s[key] === undefined) continue;
        if (typeof s[key] !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', `settings.${key} must be true or false`, { field: 'settings' });
        if (key === 'editorsCanShare' && !isManager && s[key] !== settings[key]) {
          return sendError(res, 403, 'FORBIDDEN', 'only a project manager can change who may share', { field: 'settings' });
        }
        settings[key] = s[key] as boolean;
      }
      sharing.settings = settings;
    }

    const next: ProjectRecord = { ...project, visibility, updatedAt: new Date(now).toISOString(), updatedBy: user.id };
    if (Object.keys(sharing).length) next.sharing = sharing; else delete next.sharing;
    await d.store.putProject(next);
    await d.audit(`user:${user.id}`, 'project.sharing', `project:${project.id}`, {
      general: next.sharing?.general ?? { audience: 'restricted' },
      groups: (next.sharing?.groups ?? []).map((g) => ({ ...(g.kind === 'directory' ? { group: g.name } : { shareGroup: g.id }), role: g.role, ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}) })),
      settings: next.sharing?.settings ?? {},
    });
    sendJson(res, 200, await shareState(next, await d.projectAccessOf(user, next)), NO_STORE);
  });

  // The person's own Projects list: record an open, or pin or hide a project.
  router.add('POST', '/api/v1/projects/:id/opened', async (req, res, ctx) => {
    const admitted = await projectFor(req, res, ctx.params.id as string);
    if (!admitted) return;
    const state = await d.store.putProjectUserState(admitted.user.id, admitted.project.id, { lastOpenedAt: new Date().toISOString() });
    sendJson(res, 200, { lastOpenedAt: state.lastOpenedAt, ...(state.listed ? { listed: state.listed } : {}) }, NO_STORE);
  });

  router.add('PUT', '/api/v1/projects/:id/listing', async (req, res, ctx) => {
    const admitted = await projectFor(req, res, ctx.params.id as string);
    if (!admitted) return;
    const body = (await readJson(req)) as { listed?: unknown } | null;
    const listed = body?.listed;
    if (listed !== null && listed !== 'pinned' && listed !== 'hidden') {
      return sendError(res, 400, 'INVALID_INPUT', 'listed must be pinned, hidden or null', { field: 'listed' });
    }
    const state = await d.store.putProjectUserState(admitted.user.id, admitted.project.id, { listed });
    sendJson(res, 200, { ...(state.listed ? { listed: state.listed } : {}), ...(state.lastOpenedAt ? { lastOpenedAt: state.lastOpenedAt } : {}) }, NO_STORE);
  });

  router.add('PUT', '/api/v1/projects/:id/members/:userId/expiry', async (req, res, ctx) => {
    const admitted = await projectFor(req, res, ctx.params.id as string);
    if (!admitted) return;
    const { user, project, access } = admitted;
    // An end date in a minute is a removal, and removing someone is a
    // manager's call (DELETE .../members/:userId), so editors who may share
    // still cannot set one.
    if (!accessAtLeast(access, 'manager')) return sendError(res, 403, 'FORBIDDEN', 'only a project manager can change when someone\'s access ends');
    const targetId = ctx.params.userId as string;
    if (targetId === project.ownerId) return sendError(res, 409, 'PROJECT_OWNER', 'the owner has no end date');
    const body = (await readJson(req)) as { expiresAt?: unknown } | null;
    if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'expiresAt')) {
      return sendError(res, 400, 'INVALID_INPUT', 'expiresAt is required (null clears it)', { field: 'expiresAt' });
    }
    const ends = endDate(body.expiresAt, policy(), Date.now());
    if (!ends.ok) return sendError(res, 400, 'INVALID_INPUT', ends.message, { field: 'expiresAt' });
    const existing = await d.store.getProjectMember(project.id, targetId);
    if (!existing) return sendError(res, 404, 'NOT_FOUND', 'no such member on this project');
    const updated = await d.store.setProjectMemberExpiry(project.id, targetId, ends.at ?? null);
    if (!updated) return sendError(res, 404, 'NOT_FOUND', 'no such member on this project');
    await d.audit(`user:${user.id}`, 'project.member.expiry', `project:${project.id}`, { userId: targetId, expiresAt: ends.at ?? null });
    sendJson(res, 200, { userId: targetId, role: updated.role, ...(updated.expiresAt ? { expiresAt: updated.expiresAt } : {}) }, NO_STORE);
  });

  // ── user-made groups ─────────────────────────────────────────────────────

  const summary = async (group: ShareGroupRecord, role: 'owner' | 'manager' | 'member') => ({
    id: group.id, name: group.name, ...(group.description ? { description: group.description } : {}),
    memberCount: (await d.store.listShareGroupMembers(group.id)).length, myRole: role,
  });

  /** People the caller may add to a group: those they already share a project
   *  or a group with. Ids only; callers resolve and filter. */
  async function knownPeople(user: UserRecord): Promise<Set<string>> {
    const known = new Set<string>();
    const memberships = await d.store.listUserProjectMemberships(user.id);
    const projectIds = new Set(memberships.filter((m) => grantLive(m.expiresAt, Date.now())).map((m) => m.projectId));
    for (const p of await d.store.listProjects()) if (p.ownerId === user.id) projectIds.add(p.id);
    for (const id of [...projectIds].slice(0, PEOPLE_PROJECT_SCAN)) {
      const project = await d.store.getProject(id);
      if (!project || project.archivedAt) continue;
      known.add(project.ownerId);
      for (const m of await d.store.listProjectMembers(id)) known.add(m.userId);
    }
    for (const groupId of user.shareGroups ?? []) {
      for (const m of await d.store.listShareGroupMembers(groupId)) known.add(m.id);
    }
    known.delete(user.id);
    return known;
  }

  async function groupFor(req: IncomingMessage, res: ServerResponse, id: string) {
    const user = await d.memberOf(req);
    if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    if (!policy().customGroups) { sendError(res, 404, 'NOT_FOUND', 'no such group'); return null; }
    const group = await d.store.getShareGroup(id);
    const role = group ? groupRoleOf(group, user) : null;
    if (!group || (!role && !isAdmin(user))) { sendError(res, 404, 'NOT_FOUND', 'no such group'); return null; }
    return { user, group, role };
  }

  /** Resolve people for a group change: each entry is a user id the caller
   *  already knows, or an exact address of an enabled member account. */
  async function resolvePeople(user: UserRecord, entries: unknown[], res: ServerResponse): Promise<UserRecord[] | null> {
    const known = await knownPeople(user);
    const out = new Map<string, UserRecord>();
    for (const entry of entries) {
      if (typeof entry !== 'string' || !entry.trim() || entry.length > 320) { sendError(res, 400, 'INVALID_INPUT', 'people must be ids or addresses', { field: 'add' }); return null; }
      let match: UserRecord | null = null;
      if (entry.includes('@')) {
        match = (await d.store.findUsersByEmail(entry)).find((u) => isInstanceMember(u)) ?? null;
      } else if (known.has(entry) || entry === user.id) {
        const found = await d.store.getUser(entry);
        match = found && isInstanceMember(found) ? found : null;
      }
      if (!match) { sendError(res, 404, 'PERSON_NOT_FOUND', `no member of this instance matches ${entry.includes('@') ? 'that address' : 'that person'}`, { field: 'add' }); return null; }
      out.set(match.id, match);
    }
    return [...out.values()];
  }

  router.add('GET', '/api/v1/share-groups', async (req, res) => {
    const user = await d.memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    if (!policy().customGroups) return sendJson(res, 200, { groups: [], enabled: false }, NO_STORE);
    const groups = [];
    for (const group of await d.store.listShareGroups()) {
      const role = groupRoleOf(group, user);
      if (role) groups.push(await summary(group, role));
    }
    sendJson(res, 200, { groups, enabled: true }, NO_STORE);
  });

  router.add('GET', '/api/v1/share-groups/people', async (req, res, ctx) => {
    const user = await d.memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    // Suggestions exist to fill a user-made group, so they follow the same
    // gates: a member of this instance (never a guest or a service token),
    // while the instance allows those groups.
    if (!isInstanceMember(user)) return sendError(res, 403, 'FORBIDDEN', 'people suggestions are for members of this instance');
    if (!policy().customGroups) return sendError(res, 403, 'GROUPS_OFF', 'this instance does not allow user-made groups');
    if (!peopleQuota.take(user.id)) {
      res.setHeader('retry-after', '60');
      return sendError(res, 429, 'RATE_LIMITED', 'too many people lookups; try again in a minute');
    }
    const q = (ctx.url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 120);
    const people: { id: string; name: string }[] = [];
    if (q.includes('@')) {
      for (const u of await d.store.findUsersByEmail(q)) if (isInstanceMember(u) && u.id !== user.id) people.push({ id: u.id, name: nameWithoutEmail(u) });
    } else {
      const ids = [...await knownPeople(user)];
      for (const u of await d.store.getUsersByIds(ids)) {
        if (!isInstanceMember(u)) continue;
        const name = nameWithoutEmail(u);
        if (!q || name.toLowerCase().includes(q) || u.email.toLowerCase().startsWith(q)) people.push({ id: u.id, name });
      }
      people.sort((a, b) => a.name.localeCompare(b.name));
    }
    sendJson(res, 200, { people: people.slice(0, PEOPLE_LIMIT), truncated: people.length > PEOPLE_LIMIT }, NO_STORE);
  });

  router.add('POST', '/api/v1/share-groups', async (req, res) => {
    const user = await d.requireAction(req, res, 'group.create');
    if (!user) return;
    if (!policy().customGroups) return sendError(res, 403, 'GROUPS_OFF', 'this instance does not allow user-made groups');
    const body = (await readJson(req, 64 * 1024)) as { name?: unknown; description?: unknown; add?: unknown } | null;
    const name = label(body?.name, SHARE_GROUP_NAME_MAX);
    if (!name) return sendError(res, 400, 'INVALID_INPUT', `a group needs a name of at most ${SHARE_GROUP_NAME_MAX} characters`, { field: 'name' });
    const description = body?.description === undefined || body.description === null || body.description === '' ? null : label(body.description, SHARE_GROUP_DESCRIPTION_MAX);
    if (description === null && body?.description) return sendError(res, 400, 'INVALID_INPUT', `a description has at most ${SHARE_GROUP_DESCRIPTION_MAX} characters`, { field: 'description' });
    const add = body?.add === undefined ? [] : body.add;
    if (!Array.isArray(add) || add.length >= SHARE_GROUP_MEMBER_LIMIT) return sendError(res, 400, 'INVALID_INPUT', `add at most ${SHARE_GROUP_MEMBER_LIMIT - 1} people`, { field: 'add' });
    const owned = (await d.store.listShareGroups()).filter((g) => g.ownerId === user.id).length;
    if (owned >= SHARE_GROUPS_PER_OWNER) return sendError(res, 409, 'GROUP_LIMIT', `you can own at most ${SHARE_GROUPS_PER_OWNER} groups`);
    const people = await resolvePeople(user, add, res);
    if (!people) return;
    const group: ShareGroupRecord = {
      id: `sg_${randomId(10)}`, name, ...(description ? { description } : {}), ownerId: user.id, managers: [],
      createdBy: user.id, createdAt: new Date().toISOString(),
    };
    await d.store.putShareGroup(group);
    for (const person of [user, ...people]) await d.store.addUserShareGroup(person.id, group.id);
    await d.audit(`user:${user.id}`, 'share-group.create', `share-group:${group.id}`, { name, members: people.length + 1 });
    sendJson(res, 201, await summary(group, 'owner'));
  });

  router.add('GET', '/api/v1/share-groups/:id', async (req, res, ctx) => {
    const admitted = await groupFor(req, res, ctx.params.id as string);
    if (!admitted) return;
    const { group, role } = admitted;
    const members = (await d.store.listShareGroupMembers(group.id))
      .map((u) => ({ id: u.id, name: nameWithoutEmail(u), role: groupRoleOf(group, u) ?? 'member' }))
      .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.name.localeCompare(b.name)));
    sendJson(res, 200, { ...(await summary(group, role ?? 'member')), members }, NO_STORE);
  });

  router.add('PATCH', '/api/v1/share-groups/:id', async (req, res, ctx) => {
    const admitted = await groupFor(req, res, ctx.params.id as string);
    if (!admitted) return;
    const { user, group, role } = admitted;
    const body = (await readJson(req, 64 * 1024)) as { name?: unknown; description?: unknown; add?: unknown; remove?: unknown; managers?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'INVALID_INPUT', 'body must be a JSON object');
    const manages = role === 'owner' || role === 'manager' || isAdmin(user);
    const onlyLeaving = body.name === undefined && body.description === undefined && body.add === undefined && body.managers === undefined
      && Array.isArray(body.remove) && body.remove.length === 1 && body.remove[0] === user.id;
    if (!manages && !onlyLeaving) return sendError(res, 403, 'FORBIDDEN', 'only the group owner or a group manager can change it');
    const next: ShareGroupRecord = { ...group, managers: [...group.managers], updatedAt: new Date().toISOString() };
    if (body.name !== undefined) {
      const name = label(body.name, SHARE_GROUP_NAME_MAX);
      if (!name) return sendError(res, 400, 'INVALID_INPUT', `a group needs a name of at most ${SHARE_GROUP_NAME_MAX} characters`, { field: 'name' });
      next.name = name;
    }
    if (body.description !== undefined) {
      if (body.description === null || body.description === '') delete next.description;
      else {
        const description = label(body.description, SHARE_GROUP_DESCRIPTION_MAX);
        if (!description) return sendError(res, 400, 'INVALID_INPUT', `a description has at most ${SHARE_GROUP_DESCRIPTION_MAX} characters`, { field: 'description' });
        next.description = description;
      }
    }
    const members = await d.store.listShareGroupMembers(group.id);
    const memberIds = new Set(members.map((m) => m.id));
    const add = body.add === undefined ? [] : body.add;
    const remove = body.remove === undefined ? [] : body.remove;
    if (!Array.isArray(add) || !Array.isArray(remove) || add.length > SHARE_GROUP_MEMBER_LIMIT || remove.length > SHARE_GROUP_MEMBER_LIMIT) {
      return sendError(res, 400, 'INVALID_INPUT', 'add and remove must be lists of people');
    }
    const adding = await resolvePeople(user, add, res);
    if (!adding) return;
    const fresh = adding.filter((p) => !memberIds.has(p.id));
    if (memberIds.size + fresh.length > SHARE_GROUP_MEMBER_LIMIT) return sendError(res, 409, 'GROUP_FULL', `a group holds at most ${SHARE_GROUP_MEMBER_LIMIT} people`);
    for (const id of remove) {
      if (typeof id !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'remove takes person ids', { field: 'remove' });
      if (id === group.ownerId) return sendError(res, 409, 'GROUP_OWNER', 'the owner stays in the group; delete the group instead', { field: 'remove' });
    }
    if (body.managers !== undefined) {
      if (role !== 'owner' && !isAdmin(user)) return sendError(res, 403, 'FORBIDDEN', 'only the group owner chooses its managers', { field: 'managers' });
      if (!Array.isArray(body.managers) || body.managers.some((m) => typeof m !== 'string' || (!memberIds.has(m) && !fresh.some((p) => p.id === m)))) {
        return sendError(res, 400, 'INVALID_INPUT', 'managers must be members of the group', { field: 'managers' });
      }
      next.managers = [...new Set(body.managers as string[])].filter((m) => m !== group.ownerId);
    }
    // One id added or removed in place: writing back a list read earlier
    // could undo a change made to another group in the meantime.
    for (const person of fresh) await d.store.addUserShareGroup(person.id, group.id);
    for (const id of remove as string[]) {
      if (members.some((m) => m.id === id)) await d.store.removeUserShareGroup(id, group.id);
    }
    next.managers = next.managers.filter((m) => !(remove as string[]).includes(m));
    await d.store.putShareGroup(next);
    await d.audit(`user:${user.id}`, onlyLeaving ? 'share-group.leave' : 'share-group.update', `share-group:${group.id}`, {
      ...(body.name !== undefined ? { name: next.name } : {}), added: fresh.map((p) => p.id), removed: remove, ...(body.managers !== undefined ? { managers: next.managers } : {}),
    });
    const after = groupRoleOf(next, { ...user, shareGroups: onlyLeaving ? [] : user.shareGroups });
    if (!after && !isAdmin(user)) { res.writeHead(204); res.end(); return; }
    const list = (await d.store.listShareGroupMembers(group.id))
      .map((u) => ({ id: u.id, name: nameWithoutEmail(u), role: groupRoleOf(next, u) ?? 'member' }))
      .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : a.name.localeCompare(b.name)));
    sendJson(res, 200, { ...(await summary(next, after ?? 'member')), members: list }, NO_STORE);
  });

  router.add('DELETE', '/api/v1/share-groups/:id', async (req, res, ctx) => {
    const admitted = await groupFor(req, res, ctx.params.id as string);
    if (!admitted) return;
    const { user, group, role } = admitted;
    if (role !== 'owner' && !isAdmin(user)) return sendError(res, 403, 'FORBIDDEN', 'only the group owner can delete it');
    await d.store.deleteShareGroup(group.id);
    await d.audit(`user:${user.id}`, 'share-group.delete', `share-group:${group.id}`, { name: group.name });
    res.writeHead(204); res.end();
  });
}
