// SPDX-License-Identifier: MPL-2.0
/**
 * The sharing ladder (lolly plan 299 M1, lolly-work plan 79):
 *   - the commenter role sits between viewer and editor everywhere;
 *   - memberships and group grants end on their date;
 *   - general access shares a project with everyone signed in, capped by
 *     `policy.sharing.instance.maxRole`, never with a service token;
 *   - directory groups carry their own role while they stay in visibility;
 *   - members make their own groups, share with them, and those groups never
 *     reach `users.groups` (so they can never satisfy an RBAC grant);
 *   - people suggestions carry names, never addresses.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import {
  accessAtLeast, configureSharingLimits, isProjectMember, mayCommentOn, mayShareProject, projectAccess, projectAccessRank,
} from '../server/src/rbac/project-access.ts';
import { resolveSharingPolicy, validateSharingPolicy } from '../server/src/policy/sharing.ts';
import type { ProjectRecord, Store, UserRecord } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); configureSharingLimits(undefined); });

const NOW = Date.parse('2026-10-07T12:00:00Z');
const user = (over: Partial<UserRecord> = {}): UserRecord => ({
  id: 'u1', sub: 's1', email: 'u1@test', idpGroups: [], localGroups: [], groups: [], role: 'member',
  sessionEpoch: 0, createdAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z', ...over,
});
const project = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: 'p1', name: 'Launch', visibility: 'private', ownerId: 'owner', createdAt: '2026-01-01T00:00:00Z', ...over,
});

// ── the access rule as data ────────────────────────────────────────────────

test('commenter ranks between viewer and editor and never reaches artwork', () => {
  assert.ok(projectAccessRank('commenter') > projectAccessRank('viewer'));
  assert.ok(projectAccessRank('commenter') < projectAccessRank('editor'));
  assert.ok(accessAtLeast('commenter', 'viewer'));
  assert.ok(!accessAtLeast('commenter', 'editor'));
  const p = project();
  const m = { projectId: 'p1', userId: 'u1', role: 'commenter' as const };
  assert.equal(projectAccess(user(), p, m, NOW), 'commenter');
});

test('a membership past its end date gives nothing, and isProjectMember agrees', () => {
  const p = project();
  const ended = { projectId: 'p1', userId: 'u1', role: 'editor' as const, expiresAt: '2026-10-07T11:59:59Z' };
  const live = { ...ended, expiresAt: '2026-10-08T00:00:00Z' };
  assert.equal(projectAccess(user(), p, ended, NOW), 'none');
  assert.equal(projectAccess(user(), p, live, NOW), 'editor');
  assert.equal(isProjectMember(user(), p, ended, NOW), false);
  assert.equal(isProjectMember(user(), p, live, NOW), true);
});

test('directory groups carry their own role while they stay in visibility', () => {
  const gina = user({ groups: ['team'] });
  const legacy = project({ visibility: { groups: ['team'] } });
  assert.equal(projectAccess(gina, legacy, null, NOW), 'editor', 'a visibility group with no grant still edits');
  const asViewers = project({ visibility: { groups: ['team'] }, sharing: { groups: [{ kind: 'directory', name: 'team', role: 'viewer' }] } });
  assert.equal(projectAccess(gina, asViewers, null, NOW), 'viewer');
  const dropped = project({ visibility: 'private', sharing: { groups: [{ kind: 'directory', name: 'team', role: 'manager' }] } });
  assert.equal(projectAccess(gina, dropped, null, NOW), 'none', 'leaving visibility removes the group, grant or not');
  const ended = project({ visibility: { groups: ['team'] }, sharing: { groups: [{ kind: 'directory', name: 'team', role: 'editor', expiresAt: '2026-10-01T00:00:00Z' }] } });
  assert.equal(projectAccess(gina, ended, null, NOW), 'none');
  assert.equal(isProjectMember(gina, ended, null, NOW), false);
});

test('user-made groups grant through shareGroups only, and switch off with policy', () => {
  const p = project({ sharing: { groups: [{ kind: 'custom', id: 'sg_a', role: 'commenter' }] } });
  assert.equal(projectAccess(user({ shareGroups: ['sg_a'] }), p, null, NOW), 'commenter');
  assert.equal(projectAccess(user({ groups: ['sg_a'] }), p, null, NOW), 'none', 'a directory group of the same name is not the user-made group');
  configureSharingLimits({ customGroups: false });
  try {
    assert.equal(projectAccess(user({ shareGroups: ['sg_a'] }), p, null, NOW), 'none');
  } finally { configureSharingLimits(undefined); }
});

test('general access reaches every signed-in member, capped by the instance ceiling', () => {
  const p = project({ sharing: { general: { audience: 'instance', role: 'editor' } } });
  assert.equal(projectAccess(user(), p, null, NOW), 'commenter', 'the default ceiling is commenter');
  assert.equal(projectAccess(user({ id: 'svc_robot' }), p, null, NOW), 'none', 'never a service token');
  assert.equal(projectAccess(user({ disabledAt: '2026-01-02T00:00:00Z' }), p, null, NOW), 'none');
  assert.equal(projectAccess(user({ role: 'guest' }), p, null, NOW), 'none');
  configureSharingLimits({ instanceMaxRole: 'editor' });
  try {
    assert.equal(projectAccess(user(), p, null, NOW), 'editor');
    configureSharingLimits({ instanceAudience: false });
    assert.equal(projectAccess(user(), p, null, NOW), 'none', 'switching the audience off lowers shares made before');
  } finally { configureSharingLimits(undefined); }
  assert.equal(isProjectMember(user(), p, null, NOW), false, 'the whole instance is not a relationship');
});

test('commenting and sharing follow the project settings', () => {
  const open = project();
  const quiet = project({ sharing: { settings: { viewersCanComment: false, editorsCanShare: true } } });
  assert.equal(mayCommentOn(open, 'viewer'), true);
  assert.equal(mayCommentOn(quiet, 'viewer'), false);
  assert.equal(mayCommentOn(quiet, 'commenter'), true);
  assert.equal(mayCommentOn(open, 'none'), false);
  assert.equal(mayShareProject(open, 'editor'), false);
  assert.equal(mayShareProject(quiet, 'editor'), true);
  assert.equal(mayShareProject(open, 'manager'), true);
  assert.equal(mayShareProject(quiet, 'commenter'), false);
});

test('policy.sharing validates and resolves defaults', () => {
  assert.deepEqual(resolveSharingPolicy(undefined), { instanceAudience: true, instanceMaxRole: 'commenter', customGroups: true, maxGrantDays: null });
  assert.deepEqual(resolveSharingPolicy({ instance: { enabled: false, maxRole: 'viewer' }, customGroups: false, maxGrantDays: 30 }),
    { instanceAudience: false, instanceMaxRole: 'viewer', customGroups: false, maxGrantDays: 30 });
  validateSharingPolicy(undefined);
  assert.throws(() => validateSharingPolicy({ instance: { maxRole: 'manager' } }), /maxRole/);
  assert.throws(() => validateSharingPolicy({ maxGrantDays: 0 }), /maxGrantDays/);
  assert.throws(() => validateSharingPolicy({ public: true }), /not a known setting/);
});

// ── over HTTP ──────────────────────────────────────────────────────────────

const PEOPLE = [
  { email: 'alice@test', name: 'Alice', groups: [] },
  { email: 'mona@test', name: 'Mona', groups: [] },
  { email: 'eddie@test', name: 'Eddie', groups: [] },
  { email: 'gina@test', name: 'Gina', groups: ['team'] },
  { email: 'dee@test', name: 'Dee', groups: [] },
  { email: 'olly@test', name: 'Olly', groups: [] },
  { email: 'admin@test', name: 'Ada', groups: ['admin'] },
];

async function boot(over: Record<string, unknown> = {}, store: Store = createMemoryStore()) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-share-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Team Hub', baseUrl: 'https://team.example', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: PEOPLE },
    idp: { roleGroups: { admin: ['admin'] } },
    ...over,
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sMem', link: 'lMem' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const cookies = new Map<string, string>();
  const login = async (email: string): Promise<string> => {
    const hit = cookies.get(email);
    if (hit) return hit;
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    assert.equal(res.status, 302, `dev login ${email}`);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
    cookies.set(email, cookie);
    return cookie;
  };
  const as = async (email: string, method: string, path: string, body?: unknown) => {
    const cookie = await login(email);
    const res = await fetch(`${base}${path}`, {
      method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json: json as any };
  };
  const userId = async (email: string): Promise<string> => {
    await login(email);
    return (await store.findUsersByEmail(email))[0]!.id;
  };
  for (const p of PEOPLE) await login(p.email);
  const made = await as('alice@test', 'POST', '/api/v1/projects', { name: 'Launch', visibility: { groups: ['team'] } });
  assert.equal(made.status, 201);
  const projectId = made.json.id as string;
  await store.putProjectMember({ projectId, userId: await userId('mona@test'), role: 'manager', addedBy: 'user:seed', addedAt: '2026-10-01T00:00:00Z' });
  await store.putProjectMember({ projectId, userId: await userId('eddie@test'), role: 'editor', addedBy: 'user:seed', addedAt: '2026-10-01T00:00:00Z' });
  return { base, store, as, userId, projectId };
}

const roleIn = async (env: Awaited<ReturnType<typeof boot>>, email: string): Promise<string | null> => {
  const list = await env.as(email, 'GET', '/api/v1/projects');
  return (list.json.projects as Array<{ id: string; myRole: string }>).find((p) => p.id === env.projectId)?.myRole ?? null;
};

test('GET sharing: managers see limits and end dates; others see the share without them', async () => {
  const env = await boot();
  const owner = await env.as('alice@test', 'GET', `/api/v1/projects/${env.projectId}/sharing`);
  assert.equal(owner.status, 200);
  assert.deepEqual(owner.json.general, { audience: 'restricted', role: 'viewer' });
  assert.deepEqual(owner.json.grants, [{ principal: { kind: 'group', name: 'team' }, role: 'editor' }]);
  assert.deepEqual(owner.json.settings, { viewersCanComment: true, viewersCanExport: true, editorsCanShare: false });
  assert.deepEqual(owner.json.policy, { audiences: ['restricted', 'instance'], instanceMaxRole: 'commenter', roles: ['viewer', 'commenter', 'editor', 'manager'], customGroups: true });
  assert.equal(owner.json.canManage, true);
  const editor = await env.as('eddie@test', 'GET', `/api/v1/projects/${env.projectId}/sharing`);
  assert.equal(editor.json.canManage, false);
  assert.deepEqual(editor.json.expiries, {});
  assert.equal((await env.as('dee@test', 'GET', `/api/v1/projects/${env.projectId}/sharing`)).status, 404);
  assert.equal((await env.as('eddie@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { general: { audience: 'instance', role: 'viewer' } })).status, 403);
});

test('sharing with everyone: listed for every member, at the role and no higher', async () => {
  const env = await boot();
  assert.equal(await roleIn(env, 'dee@test'), null);
  const tooHigh = await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { general: { audience: 'instance', role: 'editor' } });
  assert.equal(tooHigh.status, 403);
  assert.equal(tooHigh.json.error.code, 'ROLE_NOT_ALLOWED');
  const put = await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { general: { audience: 'instance', role: 'commenter' } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.general, { audience: 'instance', role: 'commenter' });
  assert.equal(await roleIn(env, 'dee@test'), 'commenter');
  const write = await env.as('dee@test', 'POST', `/api/v1/projects/${env.projectId}/sessions`, { toolId: 'poster', inputs: {}, meta: {} });
  assert.equal(write.status, 403, 'a commenter cannot create documents');
  assert.equal((await env.as('dee@test', 'GET', `/api/v1/projects/${env.projectId}/sessions`)).status, 200);
  // Back to restricted.
  await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { general: { audience: 'restricted' } });
  assert.equal(await roleIn(env, 'dee@test'), null);
});

test('policy limits: the audience can be off, and the ceiling can rise to editor', async () => {
  const off = await boot({ policy: { sharing: { instance: { enabled: false } } } });
  const refused = await off.as('alice@test', 'PUT', `/api/v1/projects/${off.projectId}/sharing`, { general: { audience: 'instance', role: 'viewer' } });
  assert.equal(refused.json.error.code, 'AUDIENCE_NOT_ALLOWED');
  const wide = await boot({ policy: { sharing: { instance: { maxRole: 'editor' } } } });
  const ok = await wide.as('alice@test', 'PUT', `/api/v1/projects/${wide.projectId}/sharing`, { general: { audience: 'instance', role: 'editor' } });
  assert.equal(ok.status, 200);
  assert.equal(await roleIn(wide, 'dee@test'), 'editor');
});

test('group grants: a directory group gets its own role, and removing it takes access away', async () => {
  const env = await boot();
  assert.equal(await roleIn(env, 'gina@test'), 'editor');
  const put = await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { grants: [{ principal: { kind: 'group', name: 'team' }, role: 'viewer' }] });
  assert.equal(put.status, 200);
  assert.equal(await roleIn(env, 'gina@test'), 'viewer');
  await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { grants: [] });
  assert.equal(await roleIn(env, 'gina@test'), null);
  const p = await env.store.getProject(env.projectId);
  assert.equal(p!.visibility, 'private');
  const past = await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { grants: [{ principal: { kind: 'group', name: 'team' }, role: 'viewer', expiresAt: '2020-01-01T00:00:00Z' }] });
  assert.equal(past.status, 400);
  const dup = await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { grants: [{ principal: { kind: 'group', name: 'team' }, role: 'viewer' }, { principal: { kind: 'group', name: 'team' }, role: 'editor' }] });
  assert.equal(dup.status, 400);
});

test('editors share only when the project allows it, and never manager access', async () => {
  const env = await boot();
  assert.equal((await env.as('eddie@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { settings: { editorsCanShare: true } })).status, 403);
  assert.equal((await env.as('mona@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { settings: { editorsCanShare: true } })).status, 200);
  const share = await env.as('eddie@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { general: { audience: 'instance', role: 'viewer' } });
  assert.equal(share.status, 200);
  const manager = await env.as('eddie@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { grants: [{ principal: { kind: 'group', name: 'team' }, role: 'manager' }] });
  assert.equal(manager.status, 403);
  const flip = await env.as('eddie@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { settings: { editorsCanShare: false } });
  assert.equal(flip.status, 403, 'only a manager changes who may share');
});

test('member end dates: set, cleared and enforced', async () => {
  const env = await boot();
  const eddie = await env.userId('eddie@test');
  const path = `/api/v1/projects/${env.projectId}/members/${eddie}/expiry`;
  assert.equal((await env.as('alice@test', 'PUT', path, { expiresAt: '2020-01-01T00:00:00Z' })).status, 400);
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const set = await env.as('alice@test', 'PUT', path, { expiresAt: future });
  assert.equal(set.status, 200);
  assert.equal(set.json.expiresAt, future);
  const state = await env.as('alice@test', 'GET', `/api/v1/projects/${env.projectId}/sharing`);
  assert.deepEqual(state.json.expiries, { [eddie]: future });
  assert.equal(await roleIn(env, 'eddie@test'), 'editor');
  await env.store.setProjectMemberExpiry(env.projectId, eddie, new Date(Date.now() - 1000).toISOString());
  assert.equal(await roleIn(env, 'eddie@test'), null, 'an ended membership gives nothing');
  const cleared = await env.as('alice@test', 'PUT', path, { expiresAt: null });
  assert.equal(cleared.json.expiresAt, undefined);
  assert.equal(await roleIn(env, 'eddie@test'), 'editor');
  assert.equal((await env.as('eddie@test', 'PUT', path, { expiresAt: null })).status, 403);
  const owner = await env.userId('alice@test');
  assert.equal((await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/members/${owner}/expiry`, { expiresAt: null })).status, 409);
  const limited = await boot({ policy: { sharing: { maxGrantDays: 3 } } });
  const eddie2 = await limited.userId('eddie@test');
  const tooLong = await limited.as('alice@test', 'PUT', `/api/v1/projects/${limited.projectId}/members/${eddie2}/expiry`, { expiresAt: future });
  assert.equal(tooLong.status, 400);
});

test('user-made groups: make one, share with it, and it never reaches users.groups', async () => {
  const env = await boot();
  const mona = await env.userId('mona@test');
  const made = await env.as('alice@test', 'POST', '/api/v1/share-groups', { name: '  Agency reviewers ', add: [mona, 'dee@test'] });
  assert.equal(made.status, 201);
  assert.equal(made.json.name, 'Agency reviewers');
  assert.equal(made.json.memberCount, 3);
  assert.equal(made.json.myRole, 'owner');
  const groupId = made.json.id as string;
  const dee = (await env.store.findUsersByEmail('dee@test'))[0]!;
  assert.deepEqual(dee.shareGroups, [groupId]);
  assert.ok(!dee.groups.includes(groupId), 'never an RBAC group');

  const share = await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, {
    grants: [{ principal: { kind: 'group', name: 'team' }, role: 'editor' }, { principal: { kind: 'custom-group', id: groupId }, role: 'commenter' }],
  });
  assert.equal(share.status, 200);
  assert.deepEqual(share.json.grants[1], { principal: { kind: 'custom-group', id: groupId, name: 'Agency reviewers', memberCount: 3 }, role: 'commenter' });
  assert.equal(await roleIn(env, 'dee@test'), 'commenter');

  // Only members can share with a group they are not on yet.
  const olly = await env.as('olly@test', 'POST', '/api/v1/projects', { name: 'Olly’s' });
  const theirs = await env.as('olly@test', 'PUT', `/api/v1/projects/${olly.json.id}/sharing`, { grants: [{ principal: { kind: 'custom-group', id: groupId }, role: 'viewer' }] });
  assert.equal(theirs.status, 404);
  assert.equal((await env.as('olly@test', 'GET', `/api/v1/share-groups/${groupId}`)).status, 404);

  // Detail: names only, owner first.
  const detail = await env.as('dee@test', 'GET', `/api/v1/share-groups/${groupId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.members[0].role, 'owner');
  assert.ok(!JSON.stringify(detail.json).includes('@test'), 'no addresses');
  assert.equal((await env.as('dee@test', 'PATCH', `/api/v1/share-groups/${groupId}`, { name: 'Mine now' })).status, 403);

  // Managers manage; members can leave.
  const promote = await env.as('alice@test', 'PATCH', `/api/v1/share-groups/${groupId}`, { managers: [mona] });
  assert.equal(promote.status, 200);
  assert.equal(promote.json.members.find((m: { id: string }) => m.id === mona).role, 'manager');
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/share-groups/${groupId}`, { name: 'Reviewers' })).status, 200);
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/share-groups/${groupId}`, { managers: [] })).status, 403, 'only the owner picks managers');
  const leave = await env.as('dee@test', 'PATCH', `/api/v1/share-groups/${groupId}`, { remove: [dee.id] });
  assert.equal(leave.status, 204);
  assert.equal(await roleIn(env, 'dee@test'), null);
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/share-groups/${groupId}`, { remove: [await env.userId('alice@test')] })).status, 409);

  // Lists and deletion.
  const mine = await env.as('mona@test', 'GET', '/api/v1/share-groups');
  assert.deepEqual(mine.json.groups.map((g: { id: string; myRole: string }) => [g.id, g.myRole]), [[groupId, 'manager']]);
  assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/share-groups/${groupId}`)).status, 403);
  assert.equal((await env.as('alice@test', 'DELETE', `/api/v1/share-groups/${groupId}`)).status, 204);
  assert.equal(await roleIn(env, 'mona@test'), 'manager', 'membership rows are untouched');
  const after = await env.as('alice@test', 'GET', `/api/v1/projects/${env.projectId}/sharing`);
  assert.equal(after.json.grants.length, 1, 'a deleted group drops out of the share');
});

test('people suggestions: co-members by name, an exact address, never an address back', async () => {
  const env = await boot();
  const all = await env.as('alice@test', 'GET', '/api/v1/share-groups/people');
  assert.deepEqual(all.json.people.map((p: { name: string }) => p.name), ['Eddie', 'Mona']);
  assert.ok(!JSON.stringify(all.json).includes('@'));
  const q = await env.as('alice@test', 'GET', '/api/v1/share-groups/people?q=mo');
  assert.deepEqual(q.json.people.map((p: { name: string }) => p.name), ['Mona']);
  const stranger = await env.as('alice@test', 'GET', '/api/v1/share-groups/people?q=dee');
  assert.deepEqual(stranger.json.people, [], 'someone you share nothing with is not suggested');
  const exact = await env.as('alice@test', 'GET', `/api/v1/share-groups/people?q=${encodeURIComponent('dee@test')}`);
  assert.equal(exact.json.people.length, 1);
  const unknown = await env.as('alice@test', 'POST', '/api/v1/share-groups', { name: 'x', add: [await env.userId('olly@test')] });
  assert.equal(unknown.status, 404, 'an id the caller does not know is refused');
});

test('making groups follows policy and grants', async () => {
  const off = await boot({ policy: { sharing: { customGroups: false } } });
  assert.equal((await off.as('alice@test', 'POST', '/api/v1/share-groups', { name: 'x' })).json.error.code, 'GROUPS_OFF');
  assert.equal((await off.as('alice@test', 'GET', '/api/v1/org-config')).json.can['group.create'], false);
  const env = await boot();
  const oc = await env.as('alice@test', 'GET', '/api/v1/org-config');
  assert.equal(oc.json.can['group.create'], true);
  assert.deepEqual(oc.json.sharing.instance, { enabled: true, maxRole: 'commenter' });
  const denied = createMemoryStore({ grants: [{ principal: '*', action: 'group.create', resource: '*', effect: 'deny' }] });
  const blocked = await boot({}, denied);
  assert.equal((await blocked.as('alice@test', 'POST', '/api/v1/share-groups', { name: 'x' })).status, 403);
});

test('invite links and access requests accept the commenter role', async () => {
  const env = await boot();
  const link = await env.as('alice@test', 'POST', `/api/v1/projects/${env.projectId}/invite-links`, { role: 'commenter' });
  assert.equal(link.status, 201);
  assert.equal(link.json.role, 'commenter');
});

test('postgres keeps parity for the sharing ladder', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async (store) => {
    await store.upsertUserBySub({ sub: 'a', email: 'a@test', groups: [], role: 'member' });
    await store.upsertUserBySub({ sub: 'b', email: 'b@test', groups: [], role: 'member' });
    const a = (await store.getUserBySub('a'))!;
    const b = (await store.getUserBySub('b'))!;
    const p = { id: 'prj_1', name: 'P', visibility: 'private' as const, ownerId: a.id, createdAt: '2026-10-07T00:00:00.000Z',
      sharing: { general: { audience: 'instance' as const, role: 'commenter' as const }, groups: [{ kind: 'custom' as const, id: 'sg_1', role: 'viewer' as const }] } };
    await store.putProject(p);
    assert.deepEqual((await store.getProject('prj_1'))!.sharing, p.sharing);
    await store.putProjectMember({ projectId: 'prj_1', userId: b.id, role: 'commenter', addedBy: 'user:a', addedAt: '2026-10-07T00:00:00.000Z', expiresAt: '2026-11-01T00:00:00.000Z' });
    assert.equal((await store.getProjectMember('prj_1', b.id))!.expiresAt, '2026-11-01T00:00:00.000Z');
    assert.equal((await store.setProjectMemberExpiry('prj_1', b.id, null))!.expiresAt, undefined);
    await store.putShareGroup({ id: 'sg_1', name: 'G', ownerId: a.id, managers: [b.id, 'gone'], createdBy: a.id, createdAt: '2026-10-07T00:00:00.000Z' });
    assert.deepEqual((await store.getShareGroup('sg_1'))!.managers, [b.id], 'managers whose accounts are gone drop out');
    assert.deepEqual((await store.setUserShareGroups(b.id, ['sg_1', 'sg_1']))!.shareGroups, ['sg_1']);
    assert.deepEqual((await store.listShareGroupMembers('sg_1')).map((u) => u.id), [b.id]);
    assert.equal((await store.listShareGroups()).length, 1);
    await store.deleteShareGroup('sg_1');
    assert.equal(await store.getShareGroup('sg_1'), null);
    assert.equal((await store.getUser(b.id))!.shareGroups, undefined);
  });
});

// ── each person's own Projects list (lolly plan 299 section 6) ───────────────

test('projectRelation names the strongest relationship, never the instance audience as yours', async () => {
  const { projectRelation } = await import('../server/src/rbac/project-access.ts');
  const p = project({ visibility: { groups: ['team'] }, sharing: { general: { audience: 'instance', role: 'viewer' }, groups: [{ kind: 'custom', id: 'sg_a', role: 'viewer' }] } });
  assert.equal(projectRelation(user({ id: 'owner' }), p, null, NOW), 'owner');
  assert.equal(projectRelation(user(), p, { projectId: 'p1', userId: 'u1', role: 'viewer' }, NOW), 'member');
  assert.equal(projectRelation(user({ groups: ['team'] }), p, null, NOW), 'group');
  assert.equal(projectRelation(user({ shareGroups: ['sg_a'] }), p, null, NOW), 'custom-group');
  assert.equal(projectRelation(user(), p, null, NOW), 'everyone');
  assert.equal(projectRelation(user({ role: 'admin' }), project(), null, NOW), 'admin');
  assert.equal(projectRelation(user(), project(), null, NOW), 'none');
  const ended = { projectId: 'p1', userId: 'u1', role: 'editor' as const, expiresAt: '2026-10-01T00:00:00Z' };
  assert.equal(projectRelation(user(), p, ended, NOW), 'everyone', 'an ended membership is not a relationship');
});

test('the project list says why and carries each person’s own pin, hide and last open', async () => {
  const env = await boot();
  await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { general: { audience: 'instance', role: 'viewer' } });
  const row = async (email: string) => (await env.as(email, 'GET', '/api/v1/projects')).json.projects.find((p: { id: string }) => p.id === env.projectId);
  assert.equal((await row('alice@test')).via, 'owner');
  assert.equal((await row('eddie@test')).via, 'member');
  assert.equal((await row('gina@test')).via, 'group');
  const dee = await row('dee@test');
  assert.equal(dee.via, 'everyone');
  assert.equal(dee.audience, 'instance');
  assert.equal(dee.listed, undefined);
  assert.equal(dee.lastOpenedAt, undefined);

  const opened = await env.as('dee@test', 'POST', `/api/v1/projects/${env.projectId}/opened`);
  assert.equal(opened.status, 200);
  assert.ok(Date.parse((await row('dee@test')).lastOpenedAt) > 0);
  assert.equal((await row('eddie@test')).lastOpenedAt, undefined, 'one person’s open is theirs alone');

  assert.equal((await env.as('dee@test', 'PUT', `/api/v1/projects/${env.projectId}/listing`, { listed: 'pinned' })).status, 200);
  assert.equal((await row('dee@test')).listed, 'pinned');
  assert.equal((await env.as('dee@test', 'PUT', `/api/v1/projects/${env.projectId}/listing`, { listed: 'hidden' })).status, 200);
  assert.equal((await row('dee@test')).listed, 'hidden');
  await env.as('dee@test', 'POST', `/api/v1/projects/${env.projectId}/opened`);
  assert.equal((await row('dee@test')).listed, 'hidden', 'opening again does not undo a hide');
  assert.equal((await env.as('dee@test', 'PUT', `/api/v1/projects/${env.projectId}/listing`, { listed: null })).status, 200);
  assert.equal((await row('dee@test')).listed, undefined);
  assert.equal((await env.as('dee@test', 'PUT', `/api/v1/projects/${env.projectId}/listing`, { listed: 'starred' })).status, 400);
  assert.equal((await env.as('olly@test', 'POST', '/api/v1/projects/prj_nope/opened')).status, 404);
  await env.as('alice@test', 'PUT', `/api/v1/projects/${env.projectId}/sharing`, { general: { audience: 'restricted' } });
  assert.equal((await env.as('dee@test', 'POST', `/api/v1/projects/${env.projectId}/opened`)).status, 404, 'no access, no record');
});

test('postgres keeps per-person project state', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async (store) => {
    const a = await store.upsertUserBySub({ sub: 'a', email: 'a@test', groups: [], role: 'member' });
    await store.putProject({ id: 'prj_1', name: 'P', visibility: 'private', ownerId: a.id, createdAt: '2026-10-07T00:00:00.000Z' });
    const first = await store.putProjectUserState(a.id, 'prj_1', { lastOpenedAt: '2026-10-07T10:00:00.000Z' });
    assert.deepEqual(first, { userId: a.id, projectId: 'prj_1', lastOpenedAt: '2026-10-07T10:00:00.000Z' });
    await store.putProjectUserState(a.id, 'prj_1', { listed: 'pinned' });
    const both = await store.putProjectUserState(a.id, 'prj_1', { lastOpenedAt: '2026-10-07T11:00:00.000Z' });
    assert.deepEqual(both, { userId: a.id, projectId: 'prj_1', listed: 'pinned', lastOpenedAt: '2026-10-07T11:00:00.000Z' });
    await store.putProjectUserState(a.id, 'prj_1', { listed: null });
    assert.deepEqual(await store.listProjectUserState(a.id), [{ userId: a.id, projectId: 'prj_1', lastOpenedAt: '2026-10-07T11:00:00.000Z' }]);
  });
});
