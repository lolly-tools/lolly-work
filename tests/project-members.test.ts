// SPDX-License-Identifier: MPL-2.0
/**
 * People on a project (plans/74 "Invite from inside Lolly", "Policy in Lolly
 * Work", "Collaborate tonight") over real HTTP:
 *   - one access level per (person, project) drives EVERY project and session
 *     route: owner, manager, editor, viewer member, group member, admin, an
 *     admin denied project.manage, a viewer-role account, an outsider;
 *   - invites: an existing account becomes a member at once with an inbox
 *     message, an unknown address gets an invitation carrying the project,
 *     within policy.invites (tiers, domains, project roles, expiry);
 *   - acceptance at sign-in applies the memberships, for a new account and an
 *     existing one;
 *   - org-config carries can['user.invite'], can['session.edit'] and the
 *     invite limits, and can['link.create-guest'] follows policy.guestLinks;
 *   - list rows carry myRole, updatedAt and updatedByName from one name read.
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
import { assembleOrgConfig, maySetPasswordFromLink } from '../server/src/policy/org-config.ts';
import { readInviteToken } from '../server/src/access/invite-token.ts';
import type { Grant } from '../server/src/rbac/evaluate.ts';
import { startupChecks } from '../server/src/setup/checks.ts';
import { effectiveProjectAccess, projectAccess } from '../server/src/rbac/project-access.ts';
import { eligibleInvitees, mayJoinSession } from '../server/src/collab/invites.ts';
import { mergeInvitationProject } from '../server/src/projects/sharing.ts';
import type { AccessRequestRecord, ProjectRecord, Store, UserRecord } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const PEOPLE = [
  { email: 'owner@test', name: 'Olive Owner', groups: ['owner'] },
  { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
  { email: 'alice@test', name: 'Alice', groups: [] },
  { email: 'mona@test', name: 'Mona', groups: [] },
  { email: 'eddie@test', name: 'Eddie', groups: [] },
  { email: 'vic@test', name: 'Vic', groups: [] },
  { email: 'gina@test', name: 'Gina', groups: ['team'] },
  { email: 'vera@test', name: 'Vera', groups: ['readers'] },
  { email: 'olly@test', name: 'Olly', groups: [] },
  { email: 'dee@test', name: 'Dee', groups: [] },
];

async function boot(over: Record<string, unknown> = {}, secrets: Record<string, string> = {}, store: Store = createMemoryStore()) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-members-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const { idp, ...rest } = over as { idp?: Record<string, unknown> };
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Team Hub', baseUrl: 'https://team.example', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: PEOPLE },
    idp: { roleGroups: { viewer: ['readers'] }, ...(idp ?? {}) },
    ...rest,
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sMem', link: 'lMem', ...secrets } });
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
  return { base, store, login, as, userId };
}

type Env = Awaited<ReturnType<typeof boot>>;

/** Invite result rows without the invitation id, invite link and end date
 *  a row backed by a pending invitation carries (pinned on their own below). */
const brief = (rows: Array<Record<string, unknown>>) =>
  rows.map(({ invitationId: _id, link: _link, expiresAt: _ends, ...rest }) => rest);

/** alice owns a team-visible project; mona manages, eddie and vera edit, vic views. */
async function seedProject(env: Env, visibility: unknown = { groups: ['team'] }) {
  // Everyone signs in once, so each has an account (a dev user has none
  // until then, and an invite to an address with no account is an invitation).
  for (const p of PEOPLE) await env.login(p.email);
  const made = await env.as('alice@test', 'POST', '/api/v1/projects', { name: 'Launch', visibility });
  assert.equal(made.status, 201);
  assert.equal(made.json.myRole, 'owner');
  const projectId = made.json.id as string;
  const at = new Date().toISOString();
  const add = async (email: string, role: 'viewer' | 'editor' | 'manager') =>
    env.store.putProjectMember({ projectId, userId: await env.userId(email), role, addedBy: 'user:seed', addedAt: at });
  await add('mona@test', 'manager');
  await add('eddie@test', 'editor');
  await add('vic@test', 'viewer');
  await add('vera@test', 'editor');
  return projectId;
}

const newSession = async (env: Env, projectId: string, by = 'alice@test') => {
  const r = await env.as(by, 'POST', `/api/v1/projects/${projectId}/sessions`, { toolId: 'poster', inputs: { t: 1 }, meta: { label: 'x' } });
  assert.equal(r.status, 201, `session create by ${by}`);
  return r.json.id as string;
};

// ── the access matrix ──────────────────────────────────────────────────────

test('one access level per person drives every project and session route', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const denyAdmin = { principal: `user:${await env.userId('admin@test')}`, action: 'project.manage', resource: '*', effect: 'deny' as const };

  // Who sees the project, and as what.
  const expectRole: Record<string, string | null> = {
    'alice@test': 'owner', 'mona@test': 'manager', 'eddie@test': 'editor', 'vic@test': 'viewer',
    'gina@test': 'editor', 'vera@test': 'editor', 'admin@test': 'manager', 'owner@test': 'manager', 'olly@test': null,
  };
  for (const [email, role] of Object.entries(expectRole)) {
    const list = await env.as(email, 'GET', '/api/v1/projects');
    const row = (list.json.projects as Array<{ id: string; myRole: string }>).find((p) => p.id === projectId);
    assert.equal(row?.myRole ?? null, role, `${email} lists the project as ${role}`);
  }

  // Reads: viewer and up; the outsider gets the one "cannot see" 403.
  const sessionId = await newSession(env, projectId);
  for (const email of ['alice@test', 'mona@test', 'eddie@test', 'vic@test', 'gina@test', 'vera@test', 'admin@test']) {
    assert.equal((await env.as(email, 'GET', `/api/v1/projects/${projectId}/sessions`)).status, 200, `${email} lists sessions`);
    const full = await env.as(email, 'GET', `/api/v1/sessions/${sessionId}`);
    assert.equal(full.status, 200, `${email} reads a session`);
    assert.equal(full.json.myRole, expectRole[email], `${email} receives the effective project role`);
    assert.equal((await env.as(email, 'GET', `/api/v1/sessions/${sessionId}/revisions`)).status, 200, `${email} reads revisions`);
    assert.equal((await env.as(email, 'GET', `/api/v1/projects/${projectId}/members`)).status, 200, `${email} lists people`);
  }
  for (const path of [`/api/v1/projects/${projectId}/sessions`, `/api/v1/sessions/${sessionId}`, `/api/v1/sessions/${sessionId}/revisions`, `/api/v1/projects/${projectId}/members`]) {
    const r = await env.as('olly@test', 'GET', path);
    assert.equal(r.status, 403, `outsider refused ${path}`);
    assert.equal(r.json.error.code, 'FORBIDDEN');
  }

  // Writes: editor and up. A viewer member gets READ_ONLY; a viewer-ROLE
  // account in an editor membership is still refused by the global action.
  for (const email of ['alice@test', 'mona@test', 'eddie@test', 'gina@test', 'admin@test']) {
    await newSession(env, projectId, email);
    const cur = (await env.as(email, 'GET', `/api/v1/sessions/${sessionId}`)).json as { rev: number };
    assert.equal((await env.as(email, 'PUT', `/api/v1/sessions/${sessionId}`, { rev: cur.rev, inputs: { by: email } })).status, 200, `${email} saves`);
  }
  const vicPost = await env.as('vic@test', 'POST', `/api/v1/projects/${projectId}/sessions`, { toolId: 'poster', inputs: {} });
  assert.equal(vicPost.status, 403);
  assert.equal(vicPost.json.error.code, 'READ_ONLY');
  const rev = (await env.as('vic@test', 'GET', `/api/v1/sessions/${sessionId}`)).json.rev as number;
  const vicPut = await env.as('vic@test', 'PUT', `/api/v1/sessions/${sessionId}`, { rev, inputs: { by: 'vic' } });
  assert.equal(vicPut.status, 403);
  assert.equal(vicPut.json.error.code, 'READ_ONLY');
  assert.equal((await env.as('vic@test', 'DELETE', `/api/v1/sessions/${sessionId}`)).json.error.code, 'READ_ONLY');
  assert.equal((await env.as('vera@test', 'POST', `/api/v1/projects/${projectId}/sessions`, { toolId: 'poster', inputs: {} })).status, 403, 'viewer role: no session.create');
  assert.equal((await env.as('vera@test', 'PUT', `/api/v1/sessions/${sessionId}`, { rev, inputs: {} })).status, 403, 'viewer role: no session.edit');
  assert.equal((await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/sessions`, { toolId: 'poster', inputs: {} })).status, 403);
  assert.equal((await env.as('olly@test', 'PUT', `/api/v1/sessions/${sessionId}`, { rev, inputs: {} })).status, 403);

  // Delete: your own as an editor; anyone's as a manager.
  const alices = await newSession(env, projectId);
  assert.equal((await env.as('eddie@test', 'DELETE', `/api/v1/sessions/${alices}`)).status, 403, 'an editor cannot delete a colleague\'s session');
  assert.equal((await env.as('gina@test', 'DELETE', `/api/v1/sessions/${alices}`)).status, 403, 'nor can a group member');
  const eddies = await newSession(env, projectId, 'eddie@test');
  assert.equal((await env.as('eddie@test', 'DELETE', `/api/v1/sessions/${eddies}`)).status, 200, 'an editor deletes their own');
  assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/sessions/${alices}`)).status, 200, 'a manager deletes anyone\'s');

  // Manage: rename, people and invites need manager.
  for (const email of ['eddie@test', 'vic@test', 'gina@test', 'olly@test']) {
    assert.equal((await env.as(email, 'PATCH', `/api/v1/projects/${projectId}`, { name: 'Nope' })).status, 403, `${email} cannot rename`);
    assert.equal((await env.as(email, 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['dee@test'], role: 'viewer' })).status, 403, `${email} cannot invite`);
    assert.equal((await env.as(email, 'PATCH', `/api/v1/projects/${projectId}/members/${await env.userId('vic@test')}`, { role: 'editor' })).status, 403, `${email} cannot change a role`);
  }
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}`, { name: 'Launch 2' })).status, 200, 'a manager renames');
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}`, { ownerId: await env.userId('mona@test') })).status, 403,
    'but a manager member cannot take ownership');
  assert.equal((await env.as('admin@test', 'PATCH', `/api/v1/projects/${projectId}`, { name: 'Launch' })).status, 200, 'project.manage renames');

  // An admin denied project.manage acts as an editor: reads and writes, no managing.
  await env.store.putGrant(denyAdmin);
  try {
    const row = ((await env.as('admin@test', 'GET', '/api/v1/projects')).json.projects as Array<{ id: string; myRole: string }>).find((p) => p.id === projectId);
    assert.equal(row?.myRole, 'editor');
    assert.equal((await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['dee@test'], role: 'viewer' })).status, 403);
    assert.equal((await env.as('admin@test', 'GET', `/api/v1/projects/${projectId}/sessions`)).status, 200);
  } finally {
    await env.store.deleteGrant(denyAdmin);
  }

  // People: emails and invitations only for managers.
  const asManager = await env.as('mona@test', 'GET', `/api/v1/projects/${projectId}/members`);
  assert.equal(asManager.json.myRole, 'manager');
  assert.ok(Array.isArray(asManager.json.invitations));
  const owner = asManager.json.members[0];
  assert.deepEqual([owner.role, owner.name, owner.email], ['owner', 'Alice', 'alice@test']);
  assert.deepEqual(new Set((asManager.json.members as Array<{ role: string }>).map((m) => m.role)), new Set(['owner', 'manager', 'editor', 'viewer']));
  const asViewer = await env.as('vic@test', 'GET', `/api/v1/projects/${projectId}/members`);
  assert.equal(asViewer.json.myRole, 'viewer');
  assert.equal(asViewer.json.invitations, undefined, 'no invitations for a viewer');
  assert.ok((asViewer.json.members as Array<Record<string, unknown>>).every((m) => !('email' in m)), 'no emails for a viewer');

  // Role changes and removal.
  const vicId = await env.userId('vic@test');
  const promoted = await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}/members/${vicId}`, { role: 'editor' });
  assert.equal(promoted.status, 200);
  assert.deepEqual([promoted.json.userId, promoted.json.role, promoted.json.name], [vicId, 'editor', 'Vic']);
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}/members/${await env.userId('alice@test')}`, { role: 'viewer' })).status, 409, 'the owner has no member role');
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}/members/${await env.userId('olly@test')}`, { role: 'viewer' })).status, 404);
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}/members/${vicId}`, { role: 'admin' })).status, 400);
  assert.equal((await env.as('eddie@test', 'DELETE', `/api/v1/projects/${projectId}/members/${vicId}`)).status, 403, 'an editor cannot remove someone else');
  assert.equal((await env.as('vic@test', 'DELETE', `/api/v1/projects/${projectId}/members/${vicId}`)).status, 204, 'anyone may leave');
  assert.equal((await env.as('vic@test', 'GET', `/api/v1/projects/${projectId}/sessions`)).status, 403, 'and then cannot see it');
  const eddieId = await env.userId('eddie@test');
  assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/projects/${projectId}/members/${eddieId}`)).status, 204);
  assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/projects/${projectId}/members/${eddieId}`)).status, 404);
  assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/projects/${projectId}/members/${await env.userId('alice@test')}`)).status, 409, 'the owner cannot be removed');
  const kinds = (await env.store.listAudit()).map((e) => e.action);
  for (const k of ['project.member.role', 'project.member.remove']) assert.ok(kinds.includes(k), `${k} audited`);
});

test('a private project is invisible to everyone but its owner, members and admins', async () => {
  const env = await boot();
  const projectId = await seedProject(env, 'private');
  const sees = async (email: string) =>
    ((await env.as(email, 'GET', '/api/v1/projects')).json.projects as Array<{ id: string }>).some((p) => p.id === projectId);
  assert.equal(await sees('gina@test'), false, 'group membership does not reach a private project');
  assert.equal(await sees('vic@test'), true, 'an explicit viewer does');
  assert.equal(await sees('admin@test'), true);
  assert.equal(await sees('olly@test'), false);
});

// ── invites ────────────────────────────────────────────────────────────────

test('invite: an existing account joins now with an inbox message; a role is raised, never lowered', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const r = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['OLLY@test', 'olly@test'], role: 'editor' });
  assert.equal(r.status, 200);
  assert.deepEqual(brief(r.json.results), [{ email: 'olly@test', status: 'added' }], 'deduplicated, lowercased');
  assert.equal(r.json.link, `https://team.example/#/team/project/${projectId}`);
  const row = ((await env.as('olly@test', 'GET', '/api/v1/projects')).json.projects as Array<{ id: string; myRole: string }>).find((p) => p.id === projectId);
  assert.equal(row?.myRole, 'editor');

  const inbox = (await env.as('olly@test', 'GET', '/api/v1/inbox')).json.messages as Array<{ id: string; kind: string; title: string; cta: { url: string }; data: Record<string, string> }>;
  const share = inbox.find((m) => m.kind === 'share');
  assert.ok(share, 'an inbox message');
  assert.equal(share.title, 'Mona shared Launch with you');
  assert.equal(share.cta.url, `/#/team/project/${projectId}`);
  assert.equal(share.data.projectId, projectId);

  const lower = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'viewer' });
  assert.deepEqual(brief(lower.json.results), [{ email: 'olly@test', status: 'already' }]);
  assert.equal((await env.store.getProjectMember(projectId, await env.userId('olly@test')))?.role, 'editor', 'never lowered silently');
  // A dismissed message stays dismissed: a raise posts nothing, and neither
  // does removing and re-adding the person (finding: inbox re-delivery).
  await env.as('olly@test', 'POST', `/api/v1/inbox/${share.id}/ack`);
  const raise = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'manager' });
  assert.deepEqual(brief(raise.json.results), [{ email: 'olly@test', status: 'added' }]);
  const inboxIds = async () => ((await env.as('olly@test', 'GET', '/api/v1/inbox')).json.messages as Array<{ id: string }>).map((m) => m.id);
  assert.ok(!(await inboxIds()).includes(share.id), 'a raise does not re-deliver');
  const ollyIdNow = await env.userId('olly@test');
  for (let i = 0; i < 3; i++) {
    assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/projects/${projectId}/members/${ollyIdNow}`)).status, 204);
    assert.deepEqual(brief((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'manager' })).json.results),
      [{ email: 'olly@test', status: 'added' }]);
  }
  assert.ok(!(await inboxIds()).includes(share.id), 'removing and re-adding never puts a dismissed message back');

  // Owner and current members are 'already'; a disabled account is refused.
  const again = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['alice@test', 'eddie@test'], role: 'viewer' });
  assert.deepEqual(again.json.results.map((x: { status: string }) => x.status), ['already', 'already']);
  await env.store.setUserDisabled(await env.userId('dee@test'), new Date().toISOString());
  // Whether an account is disabled is directory knowledge: an admin (who
  // holds user.invite) is told, a plain member manager gets exactly what an
  // unknown address gets.
  const disabled = await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['dee@test', 'not-an-email'], role: 'viewer' });
  assert.deepEqual(brief(disabled.json.results), [
    { email: 'dee@test', status: 'refused', reason: 'account-disabled' },
    { email: 'not-an-email', status: 'refused', reason: 'invalid-email' },
  ]);
  const blind = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['dee@test', 'nobody@test'], role: 'viewer' });
  assert.deepEqual(brief(blind.json.results), [
    { email: 'dee@test', status: 'refused', reason: 'invites-not-allowed' },
    { email: 'nobody@test', status: 'refused', reason: 'invites-not-allowed' },
  ], 'a disabled account and an unknown address read the same to a member');
  const audit = (await env.store.listAudit()).filter((e) => e.action === 'project.member.add');
  const ollyId = await env.userId('olly@test');
  assert.ok(audit.some((e) => e.payload?.userId === ollyId && e.payload?.role === 'manager' && e.payload?.from === 'editor' && e.payload?.via === 'invite'),
    'the raise is audited with the role it replaced');

  // Bad input and archived projects.
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['x@test'], role: 'owner' })).status, 400);
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: [], role: 'viewer' })).status, 400);
  assert.equal((await env.as('alice@test', 'PATCH', `/api/v1/projects/${projectId}`, { archived: true })).status, 200);
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'viewer' })).status, 409);
});

test('invite: an unknown address gets an invitation carrying the project, within the default policy (admins)', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const second = (await env.as('admin@test', 'POST', '/api/v1/projects', { name: 'Second' })).json.id as string;

  // A plain member manager may share with existing people but not invite new ones.
  const byMember = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['new@else.example'], role: 'editor' });
  assert.deepEqual(brief(byMember.json.results), [{ email: 'new@else.example', status: 'refused', reason: 'invites-not-allowed' }]);
  assert.equal(await env.store.findActiveInvitation('new@else.example'), null);

  const before = Date.now();
  const byAdmin = await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['new@else.example'], role: 'editor' });
  assert.deepEqual(brief(byAdmin.json.results), [{ email: 'new@else.example', status: 'invited' }]);
  const inv = (await env.store.findActiveInvitation('new@else.example'))!;
  const adminId = await env.userId('admin@test');
  assert.deepEqual(inv.projects, [{ projectId, role: 'editor', invitedBy: `user:${adminId}` }]);
  assert.equal(inv.createdVia, 'project');
  assert.deepEqual(inv.groups, []);
  const ttl = Date.parse(inv.expiresAt!) - before;
  assert.ok(ttl > 719 * 3_600_000 && ttl <= 720 * 3_600_000 + 60_000, 'expires after the default 720 hours');

  // Extending: another project merges in; the same project at a higher role upgrades; lower is 'already'.
  assert.deepEqual(brief((await env.as('admin@test', 'POST', `/api/v1/projects/${second}/invite`, { emails: ['new@else.example'], role: 'viewer' })).json.results),
    [{ email: 'new@else.example', status: 'invited' }]);
  assert.deepEqual(brief((await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['new@else.example'], role: 'viewer' })).json.results),
    [{ email: 'new@else.example', status: 'already' }]);
  assert.deepEqual(brief((await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['new@else.example'], role: 'manager' })).json.results),
    [{ email: 'new@else.example', status: 'invited' }]);
  const merged = (await env.store.findActiveInvitation('new@else.example'))!;
  assert.equal(merged.id, inv.id, 'one invitation per address');
  assert.equal(merged.expiresAt, inv.expiresAt, 'extending never prolongs');
  assert.deepEqual(merged.projects, [
    { projectId, role: 'manager', invitedBy: `user:${adminId}` }, { projectId: second, role: 'viewer', invitedBy: `user:${adminId}` },
  ]);

  // Managers see it on the project; taking the project off keeps the invitation for the other one.
  const people = await env.as('mona@test', 'GET', `/api/v1/projects/${projectId}/members`);
  assert.deepEqual(people.json.invitations.map((i: { email: string; role: string }) => [i.email, i.role]), [['new@else.example', 'manager']]);
  assert.equal((await env.as('eddie@test', 'DELETE', `/api/v1/projects/${projectId}/invitations/${inv.id}`)).status, 403);
  assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/projects/${projectId}/invitations/${inv.id}`)).status, 204);
  assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/projects/${projectId}/invitations/${inv.id}`)).status, 404);
  assert.deepEqual((await env.store.getInvitation(inv.id))?.projects, [{ projectId: second, role: 'viewer', invitedBy: `user:${adminId}` }]);
  // ...and taking the last project off a group-less invitation withdraws it.
  assert.equal((await env.as('admin@test', 'DELETE', `/api/v1/projects/${second}/invitations/${inv.id}`)).status, 204);
  assert.ok((await env.store.getInvitation(inv.id))?.revokedAt, 'revoked');
});

test('invite policy: allow tiers, domains, project roles and the expiry are enforced', async () => {
  // members tier with a domain list and two project roles.
  const env = await boot({ policy: { invites: { allow: 'members', domains: ['@Example.com'], projectRoles: ['viewer', 'editor'], maxTtlHours: 48 } } });
  const projectId = await seedProject(env);
  const res = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['a@example.com', 'b@other.org'], role: 'viewer' });
  assert.deepEqual(brief(res.json.results), [
    { email: 'a@example.com', status: 'invited' },
    { email: 'b@other.org', status: 'refused', reason: 'domain-not-allowed' },
  ]);
  const ttl = Date.parse((await env.store.findActiveInvitation('a@example.com'))!.expiresAt!) - Date.now();
  assert.ok(ttl > 47 * 3_600_000 && ttl <= 48 * 3_600_000, 'maxTtlHours sets the expiry');
  const manager = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'manager' });
  assert.equal(manager.status, 403);
  assert.equal(manager.json.error.code, 'ROLE_NOT_ALLOWED');
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}/members/${await env.userId('vic@test')}`, { role: 'manager' })).json.error.code, 'ROLE_NOT_ALLOWED');
  // The domain list is for new people: an existing account from anywhere can be shared with.
  assert.deepEqual(brief((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'viewer' })).json.results),
    [{ email: 'olly@test', status: 'added' }]);
  // An editor is not a manager, whatever the tier.
  assert.equal((await env.as('eddie@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['c@example.com'], role: 'viewer' })).status, 403);
  // A deny of user.invite wins over the members tier.
  const deny = { principal: `user:${await env.userId('mona@test')}`, action: 'user.invite', resource: '*', effect: 'deny' as const };
  await env.store.putGrant(deny);
  assert.deepEqual(brief((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['d@example.com'], role: 'viewer' })).json.results),
    [{ email: 'd@example.com', status: 'refused', reason: 'invites-not-allowed' }]);
  await env.store.deleteGrant(deny);

  // owners tier: an admin manages the project but cannot invite new people.
  const strict = await boot({ policy: { invites: { allow: 'owners' } } });
  const p2 = await seedProject(strict);
  assert.deepEqual(brief((await strict.as('admin@test', 'POST', `/api/v1/projects/${p2}/invite`, { emails: ['n@x.example'], role: 'viewer' })).json.results),
    [{ email: 'n@x.example', status: 'refused', reason: 'invites-not-allowed' }]);
  assert.deepEqual(brief((await strict.as('owner@test', 'POST', `/api/v1/projects/${p2}/invite`, { emails: ['n@x.example'], role: 'viewer' })).json.results),
    [{ email: 'n@x.example', status: 'invited' }]);

  // The config is validated.
  const bad = (invites: unknown) => () => parseConfig(JSON.stringify({ instance: { name: 'x', baseUrl: 'https://x.example', pack: '/tmp' }, policy: { invites } }));
  assert.throws(bad({ allow: 'everyone' }), /policy\.invites\.allow/);
  assert.throws(bad({ domains: ['not a domain'] }), /policy\.invites\.domains/);
  assert.throws(bad({ maxTtlHours: 0 }), /policy\.invites\.maxTtlHours/);
  assert.throws(bad({ projectRoles: [] }), /policy\.invites\.projectRoles/);
  assert.throws(bad({ projectRoles: ['owner'] }), /policy\.invites\.projectRoles/);
  assert.throws(bad({ ttl: 3 }), /policy\.invites\.ttl is not a known key/);
});

// ── acceptance at sign-in ──────────────────────────────────────────────────

test('acceptance at sign-in applies project memberships, for a new account and an existing one', async () => {
  const SECRET = 'proxy-shared-secret-0123456789';
  const env = await boot({ proxyAuth: { enabled: true, displayName: 'Proxy' }, idp: { admission: { emails: ['owner@test'] } } }, { proxyAuth: SECRET });
  const projectId = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Brand refresh' })).json.id as string;
  const invited = await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['bo@partner.example'], role: 'editor' });
  assert.deepEqual(brief(invited.json.results), [{ email: 'bo@partner.example', status: 'invited' }]);

  const headers = { 'x-lw-proxy-auth': SECRET, ynh_user: 'bo', ynh_user_email: 'bo@partner.example' };
  const signIn = await fetch(`${env.base}/api/auth/proxy`, { headers, redirect: 'manual' });
  assert.equal(signIn.status, 302, 'the invitation admits');
  const bo = (await env.store.getUserBySub('proxy:bo'))!;
  assert.equal((await env.store.getProjectMember(projectId, bo.id))?.role, 'editor');
  const cookie = signIn.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const list = await (await fetch(`${env.base}/api/v1/projects`, { headers: { cookie } })).json() as { projects: Array<{ id: string; myRole: string }> };
  assert.equal(list.projects.find((p) => p.id === projectId)?.myRole, 'editor');
  const inbox = await (await fetch(`${env.base}/api/v1/inbox`, { headers: { cookie } })).json() as { messages: Array<{ kind: string; title: string }> };
  assert.ok(inbox.messages.some((m) => m.kind === 'notice' && m.title === 'Welcome to Team Hub'));
  assert.ok(!inbox.messages.some((m) => m.kind === 'share'), 'the welcome replaces the share message');
  const accept = (await env.store.listAudit()).find((e) => e.action === 'invite.accept');
  assert.deepEqual(accept?.payload?.projects, [{ projectId, role: 'editor', invitedBy: `user:${await env.userId('owner@test')}` }]);

  // An existing account whose invitation was written later (for example by
  // an operator through the store) gets the projects at its next sign-in.
  const second = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Second' })).json.id as string;
  await env.store.revokeInvitation((await env.store.findActiveInvitation('bo@partner.example'))!.id, new Date().toISOString());
  await env.store.createInvitation({
    id: 'inv_later', email: 'bo@partner.example', groups: [], invitedBy: `user:${await env.userId('owner@test')}`,
    createdAt: new Date().toISOString(), projects: [{ projectId: second, role: 'viewer' }],
  });
  assert.equal((await fetch(`${env.base}/api/auth/proxy`, { headers, redirect: 'manual' })).status, 302);
  assert.equal((await env.store.getProjectMember(second, bo.id))?.role, 'viewer');
});

// ── org-config ─────────────────────────────────────────────────────────────

test('org-config: can[user.invite] follows the tier, can[session.edit], invite limits, guest links', async () => {
  const env = await boot();
  const oc = async (email: string) => (await env.as(email, 'GET', '/api/v1/org-config')).json as {
    can: Record<string, boolean>; invites: { domains: string[]; maxTtlHours: number; projectRoles: string[] };
  };
  const admin = await oc('admin@test');
  assert.equal(admin.can['user.invite'], true);
  assert.equal(admin.can['session.edit'], true);
  assert.equal(admin.can['link.create-guest'], true);
  assert.deepEqual(admin.invites, { domains: [], maxTtlHours: 720, projectRoles: ['viewer', 'editor', 'manager'], passwordSetup: false, passwordDomains: [] });
  const member = await oc('alice@test');
  assert.equal(member.can['user.invite'], false, 'admins tier by default');
  assert.equal(member.can['session.edit'], true);
  assert.equal((await oc('vera@test')).can['session.edit'], false, 'a viewer role cannot edit');

  const open = await boot({ policy: { invites: { allow: 'members', domains: ['example.com'], maxTtlHours: 24, projectRoles: ['viewer'] }, guestLinks: { enabled: false } } });
  const m2 = (await open.as('alice@test', 'GET', '/api/v1/org-config')).json as typeof admin & { policyVersion: string };
  assert.equal(m2.can['user.invite'], true, 'members tier');
  assert.deepEqual(m2.invites, { domains: ['example.com'], maxTtlHours: 24, projectRoles: ['viewer'], passwordSetup: false, passwordDomains: [] });
  const a2 = (await open.as('admin@test', 'GET', '/api/v1/org-config')).json as typeof admin;
  assert.equal(a2.can['link.create-guest'], false, 'guest links are off');

  // The invite policy and the guest-link switch move the version, so a
  // redeploy that changes them is not a stale 304.
  const config = (invites: unknown, guest: boolean) => parseConfig(JSON.stringify({
    instance: { name: 'x', baseUrl: 'https://x.example', pack: '/tmp' }, dev: { enabled: true },
    policy: { invites, guestLinks: { enabled: guest } },
  }));
  const user = { id: 'u1', sub: 's', email: 'e@x', groups: [], idpGroups: [], localGroups: [], role: 'member', sessionEpoch: 0, createdAt: '', lastSeenAt: '' } as unknown as UserRecord;
  const v = (c: ReturnType<typeof config>) => assembleOrgConfig({ config: c, user, overlays: new Map(), inboxUnread: 0 }).policyVersion;
  assert.notEqual(v(config({}, true)), v(config({ allow: 'members' }, true)));
  assert.notEqual(v(config({}, true)), v(config({}, false)));
  assert.equal(v(config({}, true)), v(config({}, true)));
});

// ── activity on list rows ──────────────────────────────────────────────────

test('list rows: myRole, updatedAt and updatedByName, with one name read per listing', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const fresh = ((await env.as('eddie@test', 'GET', '/api/v1/projects')).json.projects as Array<Record<string, unknown>>).find((p) => p.id === projectId)!;
  assert.equal(fresh.updatedByName, null, 'nobody has changed it yet');
  assert.equal(fresh.updatedAt, fresh.createdAt);

  const s1 = await newSession(env, projectId, 'eddie@test');
  await new Promise((r) => setTimeout(r, 5));
  const s2 = await newSession(env, projectId, 'gina@test');
  let row = ((await env.as('vic@test', 'GET', '/api/v1/projects')).json.projects as Array<Record<string, unknown>>).find((p) => p.id === projectId)!;
  assert.equal(row.updatedByName, 'Gina', 'the newest session save');
  assert.equal(row.myRole, 'viewer');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}`, { name: 'Launch v2' })).status, 200);
  row = ((await env.as('vic@test', 'GET', '/api/v1/projects')).json.projects as Array<Record<string, unknown>>).find((p) => p.id === projectId)!;
  assert.equal(row.updatedByName, 'Mona', 'a rename is the newest change');
  assert.ok((row.updatedAt as string) > (row.createdAt as string));

  // Session rows name their last editor; names come from ONE batched read.
  const realBatch = env.store.getUsersByIds;
  const realOne = env.store.getUser;
  let batches = 0;
  let singles = 0;
  env.store.getUsersByIds = async (ids) => { batches++; return realBatch.call(env.store, ids); };
  env.store.getUser = async (id) => { singles++; return realOne.call(env.store, id); };
  try {
    const sessions = (await env.as('vic@test', 'GET', `/api/v1/projects/${projectId}/sessions`)).json.sessions as Array<{ id: string; updatedByName: string | null }>;
    assert.equal(sessions.find((s) => s.id === s1)?.updatedByName, 'Eddie');
    assert.equal(sessions.find((s) => s.id === s2)?.updatedByName, 'Gina');
    assert.equal(batches, 1, 'one batched name read');
    batches = 0;
    await env.as('vic@test', 'GET', '/api/v1/projects');
    assert.equal(batches, 1, 'one batched name read for the project list too');
    assert.equal(singles, 0, 'never one read per row');
  } finally {
    env.store.getUsersByIds = realBatch;
    env.store.getUser = realOne;
  }
});

// ── the pure rules ─────────────────────────────────────────────────────────

test('pure rules: access levels, collab eligibility, invitation merging and the role-groups setup check', () => {
  const u = (id: string, role: string, groups: string[] = []) => ({ id, role, groups, disabledAt: undefined } as unknown as UserRecord);
  const project: ProjectRecord = { id: 'p1', name: 'P', visibility: { groups: ['team'] }, ownerId: 'own', createdAt: '' };
  const row = (userId: string, role: 'viewer' | 'editor' | 'manager') => ({ projectId: 'p1', userId, role });
  assert.equal(projectAccess(u('own', 'member'), project), 'owner');
  assert.equal(projectAccess(u('x', 'member'), project), 'none');
  assert.equal(projectAccess(u('x', 'member', ['team']), project), 'editor');
  assert.equal(projectAccess(u('x', 'member', ['team']), project, row('x', 'manager')), 'manager', 'the higher level wins');
  assert.equal(projectAccess(u('x', 'member', ['team']), project, row('x', 'viewer')), 'editor', 'the group never lowers');
  assert.equal(projectAccess(u('x', 'member'), project, row('y', 'manager')), 'none', 'someone else\'s row gives nothing');
  assert.equal(projectAccess(u('x', 'member'), project, { ...row('x', 'manager'), projectId: 'p2' }), 'none', 'nor does another project\'s');
  assert.equal(projectAccess(u('a', 'admin'), project), 'editor');
  assert.equal(effectiveProjectAccess(u('a', 'admin'), project, null, []), 'manager');
  assert.equal(effectiveProjectAccess(u('x', 'member'), project, null, [{ principal: 'user:x', action: 'project.manage', resource: '*', effect: 'allow' }]), 'none',
    'project.manage never makes a project visible');

  // Collab: an explicit member is offered and may join; the admin bypass is still not a relationship.
  const users = [u('v', 'member'), u('a', 'admin'), u('o', 'member')];
  const { invitees } = eligibleInvitees({ users, grants: [], project, memberships: [{ ...row('v', 'viewer'), addedBy: 'x', addedAt: '' }], callerId: 'own' });
  assert.deepEqual(invitees.map((i) => i.id), ['v']);
  assert.equal(mayJoinSession(u('v', 'member'), project, [], row('v', 'viewer')), true);
  assert.equal(mayJoinSession(u('v', 'member'), project, []), false);

  assert.deepEqual(mergeInvitationProject([{ projectId: 'p1', role: 'editor' }], { projectId: 'p1', role: 'viewer' }), { projects: [{ projectId: 'p1', role: 'editor' }], changed: false });
  assert.deepEqual(mergeInvitationProject([{ projectId: 'p1', role: 'editor' }], { projectId: 'p1', role: 'manager' }), { projects: [{ projectId: 'p1', role: 'manager' }], changed: true });
  assert.deepEqual(mergeInvitationProject([], { projectId: 'p2', role: 'viewer' }), { projects: [{ projectId: 'p2', role: 'viewer' }], changed: true });

  const secrets = { session: 'x'.repeat(40), link: 'y'.repeat(40) };
  const prod = (roleGroups: Record<string, string[]>) => parseConfig(JSON.stringify({
    deployment: { mode: 'production' }, instance: { name: 'x', baseUrl: 'https://x.example', pack: '/tmp' },
    idp: { issuer: 'https://idp.example', clientId: 'c', roleGroups },
  }));
  const check = (roleGroups: Record<string, string[]>) => startupChecks(prod(roleGroups), secrets, true).find((c) => c.id === 'role-groups');
  const unmapped = check({ owner: ['lw-owners'] });
  assert.equal(unmapped?.status, 'warning');
  assert.match(unmapped!.message, /admin, approver, author/);
  assert.equal(check({ owner: ['o'], admin: ['a'], approver: [], author: [] })?.status, 'pass', 'an empty list counts as mapped');
});

// ── review fixes (plans/74 invite-server review) ───────────────────────────

test('taking a project off a console invitation never withdraws the invitation itself', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const made = await env.as('admin@test', 'POST', '/api/v1/invitations', { emails: ['newhire@x.example'] });
  assert.equal(made.status, 201);
  const inv = made.json.invitations[0] as { id: string; createdVia: string };
  assert.equal(inv.createdVia, 'console');
  // An admin shares the project with the address: the console invitation gains it.
  assert.deepEqual(brief((await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['newhire@x.example'], role: 'viewer' })).json.results),
    [{ email: 'newhire@x.example', status: 'invited' }]);
  // mona manages the project but holds no user.invite: she can take the
  // project off, and the invitation that admits the person stays.
  assert.equal((await env.as('mona@test', 'DELETE', `/api/v1/projects/${projectId}/invitations/${inv.id}`)).status, 204);
  const after = (await env.store.getInvitation(inv.id))!;
  assert.equal(after.revokedAt, undefined, 'the console invitation still admits the address');
  assert.deepEqual(after.projects, []);
  const audit = (await env.store.listAudit()).filter((e) => e.subject === `invitation:${inv.id}`).map((e) => e.action);
  assert.ok(audit.includes('invite.project.remove') && !audit.includes('invite.revoke'));
});

test('acceptance applies a project entry only while its inviter still manages that project', async () => {
  const SECRET = 'proxy-shared-secret-0123456789';
  const env = await boot({
    proxyAuth: { enabled: true, displayName: 'Proxy' }, idp: { admission: { emails: ['owner@test'] } },
    policy: { invites: { allow: 'members' } },
  }, { proxyAuth: SECRET });
  for (const p of PEOPLE) await env.login(p.email);
  const kept = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Kept' })).json.id as string;
  const lost = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Lost' })).json.id as string;
  const monaId = await env.userId('mona@test');
  const at = new Date().toISOString();
  for (const projectId of [kept, lost]) await env.store.putProjectMember({ projectId, userId: monaId, role: 'manager', addedBy: 'user:seed', addedAt: at });
  // mona invites a second mailbox of her own as manager on both projects.
  for (const projectId of [kept, lost]) {
    assert.deepEqual(brief((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['m.alt@partner.example'], role: 'manager' })).json.results),
      [{ email: 'm.alt@partner.example', status: 'invited' }]);
  }
  // The owner then removes her from one project.
  assert.equal((await env.as('owner@test', 'DELETE', `/api/v1/projects/${lost}/members/${monaId}`)).status, 204);

  const signIn = await fetch(`${env.base}/api/auth/proxy`, {
    headers: { 'x-lw-proxy-auth': SECRET, ynh_user: 'malt', ynh_user_email: 'm.alt@partner.example' }, redirect: 'manual',
  });
  assert.equal(signIn.status, 302, 'the invitation still admits');
  const alt = (await env.store.getUserBySub('proxy:malt'))!;
  assert.equal((await env.store.getProjectMember(kept, alt.id))?.role, 'manager', 'an entry whose inviter still manages the project applies');
  assert.equal(await env.store.getProjectMember(lost, alt.id), null, 'a removed manager cannot come back through a pending invitation');
  const skip = (await env.store.listAudit()).find((e) => e.action === 'invite.project.skip');
  assert.deepEqual(skip?.payload?.skipped, [{ projectId: lost, reason: 'inviter-not-manager' }]);
});

test('sharing goes only to an account that has shown it holds the address', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const at = new Date().toISOString();
  // Someone signed in through an IdP that did not verify the address and
  // claimed a new hire's mailbox.
  const squatter = await env.store.upsertUserBySub({ sub: 'selfreg:sq', email: 'newhire@corp.example', groups: [], role: 'member' });
  await env.store.linkIdentity({ identitySub: 'selfreg:sq', userId: squatter.id, idp: 'selfreg', email: 'newhire@corp.example', emailVerified: false, linkedAt: at });
  // ...and a person whose sign-in did verify theirs.
  const real = await env.store.upsertUserBySub({ sub: 'selfreg:re', email: 'real@corp.example', groups: [], role: 'member' });
  await env.store.linkIdentity({ identitySub: 'selfreg:re', userId: real.id, idp: 'selfreg', email: 'real@corp.example', emailVerified: true, linkedAt: at });

  const res = await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['newhire@corp.example', 'real@corp.example'], role: 'editor' });
  assert.deepEqual(brief(res.json.results), [
    { email: 'newhire@corp.example', status: 'invited' },
    { email: 'real@corp.example', status: 'added' },
  ]);
  assert.equal(await env.store.getProjectMember(projectId, squatter.id), null, 'the unverified claim gets nothing');
  assert.equal((await env.store.getProjectMember(projectId, real.id))?.role, 'editor');

  // The console's groups-now branch follows the same rule.
  const console = await env.as('owner@test', 'POST', '/api/v1/invitations', { emails: ['newhire@corp.example'], groups: ['admin'] });
  assert.equal(console.json.invitations[0].status, 'pending', 'an invitation, which a verified sign-in has to accept');
  assert.deepEqual((await env.store.getUser(squatter.id))?.localGroups, [], 'no admin group for the claim');
});

test('a member without user.invite cannot run the invite route over a list', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const batch = (n: number) => Array.from({ length: 50 }, (_, i) => `guess${n}-${i}@else.example`);
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: batch(1), role: 'viewer' })).status, 200);
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: batch(2), role: 'viewer' })).status, 200);
  const third = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: batch(3), role: 'viewer' });
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, 'RATE_LIMITED');
  // An admin, who may list people anyway, is not held to it.
  for (const n of [4, 5, 6]) assert.equal((await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: batch(n), role: 'viewer' })).status, 200);
});

test('a name never falls back to an email for someone who may not see emails', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const nameless = await env.store.upsertUserBySub({ sub: 'proxy:nn', email: 'nameless@corp.example', groups: [], role: 'member' });
  await env.store.putProjectMember({ projectId, userId: nameless.id, role: 'editor', addedBy: 'user:seed', addedAt: new Date().toISOString() });
  await env.store.putSession({
    id: 'ses_nameless', projectId, toolId: 'poster', toolVersion: '1.0.0', inputs: {}, meta: {},
    createdBy: nameless.id, updatedBy: nameless.id, rev: 1, updatedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const row = (body: { members: Array<{ userId: string; name: string; email?: string }> }) => body.members.find((m) => m.userId === nameless.id)!;
  const asViewer = await env.as('vic@test', 'GET', `/api/v1/projects/${projectId}/members`);
  assert.equal(row(asViewer.json).name, 'nameless', 'the part before the @, not the address');
  assert.ok(!('email' in row(asViewer.json)));
  const asManager = await env.as('mona@test', 'GET', `/api/v1/projects/${projectId}/members`);
  assert.equal(row(asManager.json).email, 'nameless@corp.example', 'a manager still sees the address');
  const projects = (await env.as('vic@test', 'GET', '/api/v1/projects')).json.projects as Array<{ id: string; updatedByName: string }>;
  assert.equal(projects.find((p) => p.id === projectId)?.updatedByName, 'nameless');
  const sessions = (await env.as('vic@test', 'GET', `/api/v1/projects/${projectId}/sessions`)).json.sessions as Array<{ id: string; updatedByName: string }>;
  assert.equal(sessions.find((x) => x.id === 'ses_nameless')?.updatedByName, 'nameless');
});

test('the console invitation route honours policy.invites for new addresses', async () => {
  const env = await boot({ policy: { invites: { allow: 'owners', domains: ['example.com'] } } });
  for (const p of PEOPLE) await env.login(p.email);
  const byAdmin = await env.as('admin@test', 'POST', '/api/v1/invitations', { emails: ['someone@evil.org'] });
  assert.equal(byAdmin.status, 200);
  assert.deepEqual([byAdmin.json.invitations[0].status, byAdmin.json.invitations[0].reason], ['refused', 'invites-not-allowed']);
  assert.equal(await env.store.findActiveInvitation('someone@evil.org'), null);
  const byOwner = await env.as('owner@test', 'POST', '/api/v1/invitations', { emails: ['someone@evil.org', 'ok@example.com'] });
  assert.equal(byOwner.status, 201);
  assert.deepEqual(byOwner.json.invitations.map((i: { status: string; reason?: string }) => [i.status, i.reason ?? null]),
    [['refused', 'domain-not-allowed'], ['pending', null]]);
  assert.equal(await env.store.findActiveInvitation('someone@evil.org'), null);
});

test('with invitations off, a project invite refuses new addresses instead of writing a dead invitation', async () => {
  const env = await boot({ idp: { admission: { emails: ['owner@test'], domains: ['partner.example'], invitations: false } } });
  for (const p of PEOPLE) await env.login(p.email);
  const projectId = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Off' })).json.id as string;
  assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['bo@partner.example'], role: 'editor' })).json.results),
    [{ email: 'bo@partner.example', status: 'refused', reason: 'invitations-off' }]);
  assert.equal(await env.store.findActiveInvitation('bo@partner.example'), null);
});

test('sharing helpers: a name without an email, and the window quota', async () => {
  const { nameWithoutEmail, createWindowQuota } = await import('../server/src/projects/sharing.ts');
  assert.equal(nameWithoutEmail({ firstname: 'Ada', lastname: 'Lovelace', email: 'ada@x.example' }), 'Ada Lovelace');
  assert.equal(nameWithoutEmail({ email: 'bob.smith@x.example' }), 'bob.smith');
  assert.equal(nameWithoutEmail({ firstname: 'carol@x.example', email: 'carol@x.example' }), 'carol');
  assert.equal(nameWithoutEmail({ email: '' }), 'Member');
  let t = 0;
  const q = createWindowQuota(3, 1000, () => t);
  assert.equal(q.take('a', 2), true);
  assert.equal(q.take('a', 2), false, 'past the limit, nothing is spent');
  assert.equal(q.take('a', 1), true);
  assert.equal(q.take('b', 3), true, 'per key');
  t = 1000;
  assert.equal(q.take('a', 3), true, 'a new window');
});

// ── a member is never also "waiting to accept" ─────────────────────────────
// Becoming a member of a project by any route closes that project's entry on
// a pending invitation for an address the person holds, and revokes a
// project-made invitation left with nothing on it. Each path runs on the
// memory store and, with LW_TEST_DATABASE_URL, on Postgres.

const pgUrl = process.env.LW_TEST_DATABASE_URL;
function onBothStores(name: string, body: (store: Store) => Promise<void>): void {
  test(`${name} (memory)`, () => body(createMemoryStore()));
  test(`${name} (postgres)`, { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, () => withFreshPostgres(pgUrl as string, body));
}
const invitationRows = async (env: Env, projectId: string, as = 'owner@test') =>
  ((await env.as(as, 'GET', `/api/v1/projects/${projectId}/members`)).json.invitations as Array<{ email: string }>).map((i) => i.email);
const auditFor = async (env: Env, invitationId: string) =>
  (await env.store.listAudit()).filter((e) => e.subject === `invitation:${invitationId}`);

onBothStores('inviting someone who signed up since their invitation closes it', async (store) => {
  const env = await boot({}, {}, store);
  const first = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'First' })).json.id as string;
  const second = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Second' })).json.id as string;
  // dee has no account yet, so both invites write one invitation.
  for (const projectId of [first, second]) {
    assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['dee@test'], role: 'editor' })).json.results),
      [{ email: 'dee@test', status: 'invited' }]);
  }
  const inv = (await env.store.findActiveInvitation('dee@test'))!;
  assert.deepEqual(await invitationRows(env, first), ['dee@test']);
  // She signs in (the dev provider accepts no invitation), then is invited again.
  const deeId = await env.userId('dee@test');
  assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${first}/invite`, { emails: ['dee@test'], role: 'editor' })).json.results),
    [{ email: 'dee@test', status: 'added' }]);
  const people = (await env.as('owner@test', 'GET', `/api/v1/projects/${first}/members`)).json;
  assert.ok(people.members.some((m: { userId: string }) => m.userId === deeId), 'a member');
  assert.deepEqual(people.invitations, [], 'and not waiting to accept');
  const afterFirst = (await env.store.getInvitation(inv.id))!;
  assert.equal(afterFirst.revokedAt, undefined, 'the second project still rides on it');
  assert.deepEqual(afterFirst.projects?.map((p) => p.projectId), [second]);
  const ownerPrincipal = `user:${await env.userId('owner@test')}`;
  const removed = (await auditFor(env, inv.id)).find((e) => e.action === 'invite.project.remove');
  assert.equal(removed?.actor, ownerPrincipal);
  assert.deepEqual(removed?.payload, { email: 'dee@test', projectId: first, userId: deeId, via: 'membership' });
  // The last project goes the same way, and the invitation is withdrawn.
  assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${second}/invite`, { emails: ['dee@test'], role: 'viewer' })).json.results),
    [{ email: 'dee@test', status: 'added' }]);
  assert.deepEqual(await invitationRows(env, second), []);
  assert.ok((await env.store.getInvitation(inv.id))?.revokedAt, 'revoked');
  assert.equal(await env.store.findActiveInvitation('dee@test'), null);
  const revoked = (await auditFor(env, inv.id)).find((e) => e.action === 'invite.revoke');
  assert.deepEqual(revoked?.payload, { email: 'dee@test', projectId: second, userId: deeId, via: 'membership', was: 'pending' });
});

onBothStores('accepting one invitation at sign-in closes the project on the invitation for another address the person holds', async (store) => {
  const SECRET = 'proxy-shared-secret-0123456789';
  const env = await boot({ proxyAuth: { enabled: true, displayName: 'Proxy' }, idp: { admission: { emails: ['owner@test'] } } }, { proxyAuth: SECRET }, store);
  const projectId = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Brand refresh' })).json.id as string;
  const ownerPrincipal = `user:${await env.userId('owner@test')}`;
  // bo's account exists and holds a second, verified address.
  const bo = await env.store.upsertUserBySub({ sub: 'proxy:bo', email: 'bo@partner.example', groups: [], role: 'member' });
  const at = new Date().toISOString();
  await env.store.linkIdentity({ identitySub: 'proxy:bo', userId: bo.id, idp: 'proxy', email: 'bo@partner.example', emailVerified: true, linkedAt: at });
  await env.store.linkIdentity({ identitySub: 'work:bo', userId: bo.id, idp: 'work', email: 'bo.work@partner.example', emailVerified: true, linkedAt: at });
  // Each address has a pending invitation to the project, written before bo held them.
  const entry = { projectId, role: 'editor' as const, invitedBy: ownerPrincipal };
  for (const [id, email] of [['inv_main', 'bo@partner.example'], ['inv_work', 'bo.work@partner.example']]) {
    await env.store.createInvitation({ id: id!, email: email!, groups: [], invitedBy: ownerPrincipal, createdAt: at, projects: [entry], createdVia: 'project' });
  }
  const signIn = await fetch(`${env.base}/api/auth/proxy`, {
    headers: { 'x-lw-proxy-auth': SECRET, ynh_user: 'bo', ynh_user_email: 'bo@partner.example' }, redirect: 'manual',
  });
  assert.equal(signIn.status, 302);
  assert.equal((await env.store.getProjectMember(projectId, bo.id))?.role, 'editor', 'the accepted invitation applied');
  assert.ok((await env.store.getInvitation('inv_main'))?.acceptedAt, 'accepted, and kept as it was');
  assert.deepEqual((await env.store.getInvitation('inv_main'))?.projects, [entry]);
  const other = (await env.store.getInvitation('inv_work'))!;
  assert.ok(other.revokedAt, 'the other address needs no invitation to this project now');
  assert.deepEqual(other.projects, []);
  assert.equal((await auditFor(env, 'inv_work')).find((e) => e.action === 'invite.revoke')?.actor, ownerPrincipal);
  assert.deepEqual(await invitationRows(env, projectId), []);
});

onBothStores('transferring a project to someone closes their invitation to it', async (store) => {
  const env = await boot({}, {}, store);
  const projectId = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Handover' })).json.id as string;
  for (const email of ['dee@test', 'newhire@corp.example']) {
    assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: [email], role: 'viewer' })).json.results),
      [{ email, status: 'invited' }]);
  }
  // Someone who only claims newhire@ (an IdP that did not verify it) takes
  // the project over: the invitation is for whoever holds that mailbox.
  const squatter = await env.store.upsertUserBySub({ sub: 'selfreg:sq', email: 'newhire@corp.example', groups: [], role: 'member' });
  await env.store.linkIdentity({ identitySub: 'selfreg:sq', userId: squatter.id, idp: 'selfreg', email: 'newhire@corp.example', emailVerified: false, linkedAt: new Date().toISOString() });
  assert.equal((await env.as('owner@test', 'PATCH', `/api/v1/projects/${projectId}`, { ownerId: squatter.id })).status, 200);
  assert.deepEqual((await env.store.findActiveInvitation('newhire@corp.example'))?.projects?.map((p) => p.projectId), [projectId], 'a claim closes nothing');
  // dee signs in and the project is handed to her.
  const deeId = await env.userId('dee@test');
  const deeInv = (await env.store.findActiveInvitation('dee@test'))!;
  await env.store.putProject({ ...(await env.store.getProject(projectId))!, ownerId: await env.userId('owner@test') });
  assert.equal((await env.as('owner@test', 'PATCH', `/api/v1/projects/${projectId}`, { ownerId: deeId })).status, 200);
  assert.ok((await env.store.getInvitation(deeInv.id))?.revokedAt, 'the new owner is no longer invited');
  assert.deepEqual(await invitationRows(env, projectId, 'dee@test'), ['newhire@corp.example']);
});

onBothStores('an account with no sign-in yet keeps its invitation open, without the project', async (store) => {
  const env = await boot({}, {}, store);
  const projectId = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Provisioned' })).json.id as string;
  assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['prov@corp.example'], role: 'viewer' })).json.results),
    [{ email: 'prov@corp.example', status: 'invited' }]);
  const inv = (await env.store.findActiveInvitation('prov@corp.example'))!;
  // The operator provisions the account (SCIM, a seed): no sign-in yet, so
  // the invitation may be what admits this person the first time.
  const prov = await env.store.upsertUserBySub({ sub: 'scim:prov', email: 'prov@corp.example', groups: [], role: 'member' });
  assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['prov@corp.example'], role: 'viewer' })).json.results),
    [{ email: 'prov@corp.example', status: 'added' }]);
  assert.equal((await env.store.getProjectMember(projectId, prov.id))?.role, 'viewer');
  const after = (await env.store.getInvitation(inv.id))!;
  assert.equal(after.revokedAt, undefined, 'still admits');
  assert.deepEqual(after.projects, []);
  assert.deepEqual(await invitationRows(env, projectId), []);
});

onBothStores('the people list never shows an invitation for someone already on the project', async (store) => {
  const env = await boot({}, {}, store);
  const projectId = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Stale' })).json.id as string;
  for (const email of ['dee@test', 'owner@test', 'stranger@else.example']) {
    await env.store.createInvitation({
      id: `inv_${email.split('@')[0]}`, email, groups: [], invitedBy: 'user:seed', createdAt: new Date().toISOString(),
      projects: [{ projectId, role: 'viewer' }], createdVia: 'project',
    });
  }
  // A row written before the closing rule existed: dee is a member AND invited.
  await env.store.putProjectMember({ projectId, userId: await env.userId('dee@test'), role: 'editor', addedBy: 'user:seed', addedAt: new Date().toISOString() });
  assert.deepEqual(await invitationRows(env, projectId), ['stranger@else.example'], 'neither a member nor the owner is listed as invited');
  assert.ok(!(await env.store.getInvitation('inv_dee'))?.revokedAt, 'reading the list changes nothing');
  // Sharing with her again tidies the row: 'already', and the invitation is closed.
  assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['dee@test'], role: 'viewer' })).json.results),
    [{ email: 'dee@test', status: 'already' }]);
  assert.ok((await env.store.getInvitation('inv_dee'))?.revokedAt);
});

onBothStores('an invitation that would still raise a member stays listed until it is accepted or withdrawn', async (store) => {
  const SECRET = 'proxy-shared-secret-0123456789';
  const env = await boot({ proxyAuth: { enabled: true, displayName: 'Proxy' }, idp: { admission: { emails: ['owner@test', 'bo@partner.example'] } } }, { proxyAuth: SECRET }, store);
  const projectId = (await env.as('owner@test', 'POST', '/api/v1/projects', { name: 'Raise' })).json.id as string;
  const signIn = (user: string, email: string) => fetch(`${env.base}/api/auth/proxy`, {
    headers: { 'x-lw-proxy-auth': SECRET, ynh_user: user, ynh_user_email: email }, redirect: 'manual',
  });
  assert.equal((await signIn('bo', 'bo@partner.example')).status, 302);
  const bo = (await env.store.findUsersByEmail('bo@partner.example'))[0]!;
  // Nobody holds these addresses yet, so each invite writes an invitation.
  for (const [email, role] of [['bo.home@else.example', 'manager'], ['bo.alt@else.example', 'viewer'], ['bo.ed@else.example', 'editor']] as const) {
    assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: [email], role })).json.results),
      [{ email, status: 'invited' }]);
  }
  assert.deepEqual(brief((await env.as('owner@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['bo@partner.example'], role: 'viewer' })).json.results),
    [{ email: 'bo@partner.example', status: 'added' }]);
  // Bo then links sign-ins carrying the three addresses. A link accepts nothing.
  const at = new Date().toISOString();
  for (const [sub, email] of [['proxy:bohome', 'bo.home@else.example'], ['proxy:boalt', 'bo.alt@else.example'], ['proxy:boed', 'bo.ed@else.example']]) {
    await env.store.linkIdentity({ identitySub: sub!, userId: bo.id, idp: 'proxy', email: email!, emailVerified: true, linkedAt: at });
  }
  // A viewer invitation changes nothing for a viewer, so it is not listed;
  // the manager and editor ones would raise Bo at sign-in, so they are.
  assert.deepEqual((await invitationRows(env, projectId)).sort(), ['bo.ed@else.example', 'bo.home@else.example']);
  // The owner can see the editor grant, so the owner can withdraw it.
  const ed = (await env.store.findActiveInvitation('bo.ed@else.example'))!;
  assert.equal((await env.as('owner@test', 'DELETE', `/api/v1/projects/${projectId}/invitations/${ed.id}`)).status, 204);
  assert.deepEqual(await invitationRows(env, projectId), ['bo.home@else.example']);
  // Signing in with the manager address applies the grant the owner could see.
  assert.equal((await signIn('bohome', 'bo.home@else.example')).status, 302);
  assert.equal((await env.store.getProjectMember(projectId, bo.id))?.role, 'manager');
  assert.deepEqual(await invitationRows(env, projectId), [], 'accepted, and the viewer one now changes nothing');
});

// ── invite links, requests and Invite again on the people panel ────────────
// (plans/74 invite spec R17 to R20): what the panel lists, the link a pending
// invitation carries for this project, New link and Invite again, the
// password tick, and the access requests a share supersedes.

const PASSWORD_IDP = { additional: [{ id: 'email', kind: 'password', displayName: 'Email and password' }] };
const DAY = 86_400_000;
const isoAgo = (ms: number): string => new Date(Date.now() - ms).toISOString();
const openRequest = (over: Partial<AccessRequestRecord> & Pick<AccessRequestRecord, 'id' | 'email'>): AccessRequestRecord => ({
  kind: 'project', status: 'open', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * DAY).toISOString(), ...over,
});

onBothStores('the people panel lists pending invitations with this project\'s link, expired ones for 30 days, and the requests a manager may answer', async (store) => {
  const env = await boot({}, {}, store);
  const projectId = await seedProject(env);
  const invited = await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['new@else.example'], role: 'editor' });
  const row = invited.json.results[0] as { invitationId: string; link: string; expiresAt: string };
  assert.deepEqual(readInviteToken(row.link.slice(row.link.lastIndexOf('/') + 1), ['lMem']),
    { invitationId: row.invitationId, projectId, version: 1 }, 'the link is for this project\'s entry');
  assert.equal(await env.store.markInvitationOpened(row.invitationId, new Date().toISOString()), true);
  // Ended within the window: listed as expired, without a link. Longer ago: gone.
  await env.store.createInvitation({
    id: 'inv_late', email: 'late@else.example', groups: [], invitedBy: `user:${await env.userId('mona@test')}`,
    createdAt: isoAgo(10 * DAY), expiresAt: isoAgo(2 * DAY), projects: [{ projectId, role: 'viewer' }], createdVia: 'project',
  });
  await env.store.createInvitation({
    id: 'inv_gone', email: 'gone@else.example', groups: [], invitedBy: 'user:x',
    createdAt: isoAgo(60 * DAY), expiresAt: isoAgo(40 * DAY), projects: [{ projectId, role: 'viewer' }], createdVia: 'project',
  });

  const panel = (await env.as('mona@test', 'GET', `/api/v1/projects/${projectId}/members`)).json;
  const byEmail = new Map((panel.invitations as Array<Record<string, unknown>>).map((i) => [i.email, i]));
  assert.deepEqual([...byEmail.keys()].sort(), ['late@else.example', 'new@else.example']);
  const pending = byEmail.get('new@else.example')!;
  assert.deepEqual(
    [pending.status, pending.link, pending.expiresAt, typeof pending.openedAt, pending.invitedByName, pending.passwordSetup],
    ['pending', row.link, row.expiresAt, 'string', 'Ada Admin', false],
  );
  const late = byEmail.get('late@else.example')!;
  assert.deepEqual([late.status, late.link, late.invitedByName, late.role], ['expired', undefined, 'Mona', 'viewer']);

  // Requests: managers who may answer see them, with the session link they came through.
  const sessionId = await newSession(env, projectId);
  const vicId = await env.userId('vic@test');
  await env.store.createAccessRequest(openRequest({
    id: 'req_vic', email: 'vic@test', userId: vicId, projectId, role: 'editor', currentRole: 'viewer', note: '<b>may I</b>', viaSessionId: sessionId,
  }), new Date().toISOString());
  const asked = (await env.as('mona@test', 'GET', `/api/v1/projects/${projectId}/members`)).json;
  assert.deepEqual(asked.requests, [{
    id: 'req_vic', userId: vicId, name: 'Vic', email: 'vic@test', role: 'editor', currentRole: 'viewer', note: '<b>may I</b>',
    createdAt: (await env.store.getAccessRequest('req_vic'))!.createdAt, viaSession: { id: sessionId, name: 'x' },
  }]);
  assert.deepEqual((await env.as('alice@test', 'GET', `/api/v1/projects/${projectId}/members`)).json.requests.map((r: { id: string }) => r.id), ['req_vic']);
  // An admin manages the project through project.manage, but its owner and
  // managers answer while they can, so the admin is listed nothing to answer.
  assert.deepEqual((await env.as('admin@test', 'GET', `/api/v1/projects/${projectId}/members`)).json.requests, []);
  const asEditor = (await env.as('eddie@test', 'GET', `/api/v1/projects/${projectId}/members`)).json;
  assert.deepEqual([asEditor.invitations, asEditor.requests], [undefined, undefined], 'neither for anyone below manager');
});

onBothStores('a share, an invite or a role change supersedes the person\'s open requests for no more than they now have', async (store) => {
  const env = await boot({}, {}, store);
  const projectId = await seedProject(env);
  const vicId = await env.userId('vic@test');
  const ollyId = await env.userId('olly@test');
  const monaId = await env.userId('mona@test');
  const now = new Date().toISOString();
  await env.store.createAccessRequest(openRequest({ id: 'req_edit', email: 'vic@test', userId: vicId, projectId, role: 'editor', currentRole: 'viewer' }), now);
  await env.store.createAccessRequest(openRequest({ id: 'req_view', email: 'olly@test', userId: ollyId, projectId, role: 'viewer', currentRole: 'none' }), now);
  // The approvers' notice for a request ends with it.
  await env.store.putMessage({
    id: 'msg_req_req_edit', kind: 'request', severity: 'action', audience: { users: [monaId] }, title: 'Vic asks to edit Launch',
    endsAt: new Date(Date.now() + 14 * DAY).toISOString(), dismissible: true,
  });
  const inboxIds = async () => ((await env.as('mona@test', 'GET', '/api/v1/inbox')).json.messages as Array<{ id: string }>).map((m) => m.id);
  assert.ok((await inboxIds()).includes('msg_req_req_edit'));

  // olly is given viewer: their viewer request is moot.
  assert.deepEqual(brief((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'viewer' })).json.results),
    [{ email: 'olly@test', status: 'added' }]);
  assert.equal((await env.store.getAccessRequest('req_view'))?.status, 'superseded');
  // vic asked to edit; a share at viewer ('already') leaves the ask open, a role change to editor ends it.
  assert.deepEqual(brief((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['vic@test'], role: 'viewer' })).json.results),
    [{ email: 'vic@test', status: 'already' }]);
  assert.equal((await env.store.getAccessRequest('req_edit'))?.status, 'open');
  assert.equal((await env.as('mona@test', 'PATCH', `/api/v1/projects/${projectId}/members/${vicId}`, { role: 'editor' })).status, 200);
  const closed = (await env.store.getAccessRequest('req_edit'))!;
  assert.deepEqual([closed.status, closed.answeredBy], ['superseded', `user:${monaId}`]);
  assert.ok(!(await inboxIds()).includes('msg_req_req_edit'), 'the approvers\' notice is retired');
  const rows = (await env.store.listAudit()).filter((e) => e.action === 'access.supersede').map((e) => [e.subject, e.payload?.by]);
  assert.deepEqual(rows.sort(), [['request:req_edit', 'membership'], ['request:req_view', 'membership']]);
});

test('project invite answers carry each invitation\'s link and the message context; the password tick counts only for admins', async () => {
  const env = await boot({
    idp: PASSWORD_IDP,
    instance: { name: 'lolly.ing', baseUrl: 'https://team.example', inviteNote: 'Use GitHub or email and password.' },
    policy: { invites: { allow: 'members', passwordDomains: ['suse.com'] } },
  });
  const projectId = await seedProject(env);
  const r = await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['sam@suse.com'], role: 'editor', passwordSetup: true });
  assert.equal(r.status, 200);
  const [sam] = r.json.results as Array<{ email: string; status: string; invitationId: string; link: string; expiresAt: string }>;
  const inv = (await env.store.findActiveInvitation('sam@suse.com'))!;
  assert.deepEqual([sam!.status, sam!.invitationId, sam!.expiresAt, inv.passwordSetup], ['invited', inv.id, inv.expiresAt, true]);
  assert.deepEqual(r.json.message, { workspace: 'lolly.ing', inviter: 'Ada Admin', providers: ['Email and password'], note: 'Use GitHub or email and password.' });
  assert.equal((await env.store.listAudit()).find((e) => e.action === 'invite.create')?.payload?.passwordSetup, true);
  assert.equal((await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['x@suse.com'], role: 'editor', passwordSetup: 1 })).status, 400);

  // Inviting the same address again at the same role: already invited, with the link to copy again.
  const again = (await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['sam@suse.com'], role: 'viewer' })).json.results[0];
  assert.deepEqual([again.status, again.link], ['already', sam!.link]);

  // A member manager may invite under the members tier, but never with a password link.
  const byMona = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['kim@suse.com'], role: 'viewer', passwordSetup: true });
  assert.deepEqual(brief(byMona.json.results), [{ email: 'kim@suse.com', status: 'invited' }]);
  assert.equal((await env.store.findActiveInvitation('kim@suse.com'))?.passwordSetup, undefined, 'passwordSetup ignored for a non-admin manager');
  // An admin's tick on an existing invitation turns it on, once.
  await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['kim@suse.com'], role: 'viewer', passwordSetup: true });
  assert.equal((await env.store.findActiveInvitation('kim@suse.com'))?.passwordSetup, true);

  // Without password sign-in the tick means nothing.
  const plain = await boot();
  const p2 = await seedProject(plain);
  await plain.as('admin@test', 'POST', `/api/v1/projects/${p2}/invite`, { emails: ['sam@suse.com'], role: 'viewer', passwordSetup: true });
  assert.equal((await plain.store.findActiveInvitation('sam@suse.com'))?.passwordSetup, undefined);
});

onBothStores('New link and Invite again from the people panel', async (store) => {
  const env = await boot({}, {}, store);
  const projectId = await seedProject(env);
  const other = (await env.as('admin@test', 'POST', '/api/v1/projects', { name: 'Other' })).json.id as string;
  const first = (await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['new@else.example'], role: 'editor' })).json.results[0];

  // New link (R19): a manager of a project the invitation carries.
  const rotated = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invitations/${first.invitationId}/link`, {});
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.json.link, first.link);
  assert.equal(rotated.json.expiresAt, first.expiresAt);
  assert.equal(readInviteToken(rotated.json.link.slice(rotated.json.link.lastIndexOf('/') + 1), ['lMem'])?.version, 2);
  const linkRow = (await env.store.listAudit()).find((e) => e.action === 'invite.link');
  assert.deepEqual([linkRow?.actor, linkRow?.payload], [`user:${await env.userId('mona@test')}`, { email: 'new@else.example', version: 2 }]);
  assert.equal((await env.as('eddie@test', 'POST', `/api/v1/projects/${projectId}/invitations/${first.invitationId}/link`, {})).status, 403);
  assert.equal((await env.as('admin@test', 'POST', `/api/v1/projects/${other}/invitations/${first.invitationId}/link`, {})).status, 404,
    'only from a project the invitation carries');
  // Invite again is for an expired invitation only.
  assert.equal((await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invitations/${first.invitationId}/reinvite`, {})).json.error.code, 'NOT_ENDED');

  // An expired one: New link is refused, Invite again needs someone who may invite new people.
  const monaId = await env.userId('mona@test');
  await env.store.createInvitation({
    id: 'inv_late', email: 'late@else.example', groups: ['kept-out'], invitedBy: `user:${monaId}`,
    createdAt: isoAgo(31 * DAY), expiresAt: isoAgo(DAY),
    projects: [{ projectId, role: 'viewer', invitedBy: `user:${monaId}` }, { projectId: other, role: 'editor' }], createdVia: 'project',
  });
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invitations/inv_late/link`, {})).json.error.code, 'NOT_PENDING');
  const refused = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/invitations/inv_late/reinvite`, {});
  assert.deepEqual([refused.status, refused.json.error.code], [403, 'FORBIDDEN'], 'admins invite new people by default (plans/75 C12)');
  const again = await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invitations/inv_late/reinvite`, {});
  assert.equal(again.status, 200);
  const [result] = again.json.results as Array<{ email: string; status: string; invitationId: string; link: string }>;
  assert.deepEqual([result!.email, result!.status], ['late@else.example', 'invited']);
  assert.equal(readInviteToken(result!.link.slice(result!.link.lastIndexOf('/') + 1), ['lMem'])?.projectId, projectId);
  assert.equal(again.json.link, `https://team.example/#/team/project/${projectId}`);
  assert.equal(again.json.message.inviter, 'Ada Admin');
  assert.ok((await env.store.getInvitation('inv_late'))?.revokedAt, 'the expired invitation ends');
  const fresh = (await env.store.getInvitation(result!.invitationId))!;
  const adminId = await env.userId('admin@test');
  assert.deepEqual([fresh.groups, fresh.projects], [[], [{ projectId, role: 'viewer', invitedBy: `user:${adminId}` }]],
    'only this project, at the role it had, now in the name of whoever invited again');
  const create = (await env.store.listAudit()).find((e) => e.action === 'invite.create' && e.subject === `invitation:${fresh.id}`);
  assert.deepEqual([create?.payload?.via, create?.payload?.from], ['reinvite', 'inv_late']);
  const panel = (await env.as('mona@test', 'GET', `/api/v1/projects/${projectId}/members`)).json.invitations as Array<{ id: string; status: string }>;
  assert.deepEqual(panel.filter((i) => i.id !== first.invitationId).map((i) => [i.id, i.status]), [[fresh.id, 'pending']]);
});

test('org-config: invites.passwordSetup follows password sign-in, the role and user.invite; passwordDomains and requests ride along', async () => {
  const config = (over: Record<string, unknown> = {}) => parseConfig(JSON.stringify({
    instance: { name: 'x', baseUrl: 'https://x.example', pack: '/tmp' }, dev: { enabled: true }, ...over,
  }));
  const person = (role: string, id = 'u1') => ({ id, sub: 's', email: 'e@x', groups: [role], idpGroups: [], localGroups: [], role, sessionEpoch: 0, createdAt: '', lastSeenAt: '' }) as unknown as UserRecord;
  const withPassword = config({ idp: PASSWORD_IDP, policy: { invites: { passwordDomains: ['SUSE.com'] }, requests: { project: false, join: true, ttlDays: 14, joinOpenMax: 50 } } });
  const oc = (c: ReturnType<typeof config>, user: UserRecord, grants: Grant[] = []) => assembleOrgConfig({ config: c, user, overlays: new Map(), grants, inboxUnread: 0 });

  assert.equal(oc(withPassword, person('admin')).invites.passwordSetup, true);
  assert.equal(oc(withPassword, person('owner')).invites.passwordSetup, true);
  assert.equal(oc(withPassword, person('member')).invites.passwordSetup, false);
  const deny: Grant = { principal: 'user:u1', action: 'user.invite', resource: '*', effect: 'deny' };
  assert.equal(oc(withPassword, person('admin'), [deny]).invites.passwordSetup, false, 'a deny of user.invite wins');
  assert.equal(oc(config(), person('admin')).invites.passwordSetup, false, 'no password sign-in, no tick');
  assert.equal(maySetPasswordFromLink(withPassword, person('admin'), []), true);
  assert.equal(maySetPasswordFromLink(withPassword, person('admin', 'svc_ci'), []), false, 'a service token is not a person');
  assert.deepEqual(oc(withPassword, person('member')).invites.passwordDomains, ['suse.com']);
  assert.deepEqual(oc(withPassword, person('member')).requests, { project: false });
  assert.deepEqual(oc(config(), person('member')).requests, { project: true });

  // Both settings move the version, so a redeploy that changes them is not a stale 304.
  const v = (c: ReturnType<typeof config>) => oc(c, person('member')).policyVersion;
  assert.notEqual(v(config()), v(config({ idp: PASSWORD_IDP })));
  assert.notEqual(v(config()), v(config({ policy: { requests: { project: false, join: false, ttlDays: 14, joinOpenMax: 50 } } })));
  assert.equal(v(config()), v(config({ policy: { requests: { project: true, join: true, ttlDays: 7, joinOpenMax: 10 } } })),
    'what the shell does not read leaves it alone');
});

// ── effective access and handing a project on (plans/75 G15) ───────────────

type EffectiveRow = { userId: string; name: string; role: string; via: string; group?: string; isMe?: boolean; email?: string };
const effectiveOf = async (env: Env, as: string, projectId: string) => {
  const r = await env.as(as, 'GET', `/api/v1/projects/${projectId}/members`);
  assert.equal(r.status, 200, `${as} lists people`);
  return r.json as { members: Array<{ userId: string; role: string; via?: string }>; effective?: EffectiveRow[]; effectiveTruncated?: boolean; adminAccess?: string };
};

test('people: group and admin access appear as their own rows, for managers only, without an address', async () => {
  const env = await boot();
  const projectId = await seedProject(env);
  const [gina, admin, owner, alice] = await Promise.all(['gina@test', 'admin@test', 'owner@test', 'alice@test'].map((e) => env.userId(e)));
  // A group member whose name would fall back to an address, one who is
  // disabled, and one who is also an admin.
  const nameless = await env.store.upsertUserBySub({ sub: 'proxy:grp', email: 'grp@corp.example', groups: ['team'], role: 'member' });
  const parked = await env.store.upsertUserBySub({ sub: 'proxy:parked', email: 'parked@corp.example', groups: ['team'], role: 'member', firstname: 'Parked' });
  await env.store.setUserDisabled(parked.id, new Date().toISOString());
  const boss = await env.store.upsertUserBySub({ sub: 'proxy:boss', email: 'boss@corp.example', groups: ['team', 'admin'], role: 'admin', firstname: 'Bea', lastname: 'Boss' });

  // Members carry where their access comes from.
  const asOwner = await effectiveOf(env, 'alice@test', projectId);
  assert.deepEqual([asOwner.members[0]!.role, asOwner.members[0]!.via], ['owner', 'owner']);
  assert.deepEqual(new Set(asOwner.members.slice(1).map((m) => m.via)), new Set(['member']));

  // A manager who is no admin and not in the group learns nothing about who
  // is in it: a visibility group can name any group, and the people list
  // must not read the directory out for whoever made the project. They get
  // only a note that admins can open the project too.
  for (const as of ['alice@test', 'mona@test']) {
    const body = await effectiveOf(env, as, projectId);
    assert.equal(body.adminAccess, 'note');
    assert.deepEqual(body.effective, [], `${as}: no rows for a group they are not in, and no admin rows`);
  }
  // A guessed group shows nothing either, however it was named.
  const guessed = (await env.as('alice@test', 'POST', '/api/v1/projects', { name: 'Probe', visibility: { groups: ['team', 'admin'] } })).json.id as string;
  assert.deepEqual((await effectiveOf(env, 'alice@test', guessed)).effective, [], 'making a project visible to a group does not list its people');

  // An admin may list everyone anyway, so the admins are listed by name, at
  // the level they have; their own row is marked.
  const asAdmin = await effectiveOf(env, 'admin@test', projectId);
  assert.equal(asAdmin.adminAccess, 'listed');
  assert.deepEqual(asAdmin.effective!.map((r) => [r.userId, r.role, r.via, r.isMe ?? false]), [
    [admin, 'manager', 'admin', true], [boss.id, 'manager', 'group', false], [gina, 'editor', 'group', false],
    [nameless.id, 'editor', 'group', false], [owner, 'manager', 'admin', false],
  ]);

  // Editors and viewers see neither.
  for (const as of ['eddie@test', 'vic@test', 'gina@test']) {
    const body = await effectiveOf(env, as, projectId);
    assert.deepEqual([body.effective, body.adminAccess], [undefined, undefined], `${as} sees no effective rows`);
  }

  // A manager who is in the group sees its people, whose names they can see
  // anyway, at the level the group gives: never a Manager level an admin role
  // adds, which would point the admins out.
  await env.store.putProjectMember({ projectId, userId: gina!, role: 'manager', addedBy: 'user:seed', addedAt: new Date().toISOString() });
  const asGroupManager = await effectiveOf(env, 'gina@test', projectId);
  assert.equal(asGroupManager.adminAccess, 'note');
  assert.deepEqual(asGroupManager.effective!.map((r) => [r.name, r.role, r.via, r.group]), [
    ['Bea Boss', 'editor', 'group', 'team'], ['grp', 'editor', 'group', 'team'],
  ], 'group rows by name; no admin rows; no Manager level an admin role adds');
  assert.deepEqual(asGroupManager.effective!.map((r) => r.userId), [boss.id, nameless.id]);
  assert.ok(asGroupManager.effective!.every((r) => !('email' in r) && !r.name.includes('@')), 'no addresses');
  assert.ok(!asGroupManager.effective!.some((r) => r.userId === parked.id || r.userId === alice || r.userId === gina), 'disabled people and members are not repeated');
  assert.equal(asGroupManager.effectiveTruncated, undefined);

  // An admin denied project.manage acts as an editor on the project: no rows for them, and
  // the owner sees them at that level.
  const denyAdmin: Grant = { principal: `user:${admin}`, action: 'project.manage', resource: '*', effect: 'deny' };
  await env.store.putGrant(denyAdmin);
  try {
    assert.equal((await effectiveOf(env, 'admin@test', projectId)).effective, undefined);
    const asWorkspaceOwner = await effectiveOf(env, 'owner@test', projectId);
    assert.deepEqual(asWorkspaceOwner.effective!.find((r) => r.userId === admin), { userId: admin, name: 'Ada Admin', role: 'editor', via: 'admin' });
  } finally {
    await env.store.deleteGrant(denyAdmin);
  }

  // A private project has no group rows, and a long group list is capped.
  const lone = (await env.as('alice@test', 'POST', '/api/v1/projects', { name: 'Solo' })).json.id as string;
  assert.deepEqual((await effectiveOf(env, 'alice@test', lone)).effective, []);
  for (let i = 0; i < 205; i++) {
    await env.store.upsertUserBySub({ sub: `proxy:crowd${i}`, email: `crowd${i}@corp.example`, groups: ['team'], role: 'member', firstname: `Crowd ${String(i).padStart(3, '0')}` });
  }
  const crowded = await effectiveOf(env, 'gina@test', projectId);
  assert.equal(crowded.effective!.length, 200);
  assert.equal(crowded.effectiveTruncated, true);
});

onBothStores('handing a project on keeps the previous owner as a Manager', async (store) => {
  const env = await boot({}, {}, store);
  const [alice, dee] = [await env.userId('alice@test'), await env.userId('dee@test')];
  const projectId = (await env.as('alice@test', 'POST', '/api/v1/projects', { name: 'Handover' })).json.id as string;
  assert.equal((await env.as('alice@test', 'PATCH', `/api/v1/projects/${projectId}`, { ownerId: dee })).status, 200);
  assert.equal((await env.store.getProject(projectId))?.ownerId, dee);
  assert.equal((await env.store.getProjectMember(projectId, alice))?.role, 'manager');
  const people = await effectiveOf(env, 'alice@test', projectId);
  assert.deepEqual(people.members.map((m) => [m.userId, m.role, m.via]), [[dee, 'owner', 'owner'], [alice, 'manager', 'member']]);
  const added = (await env.store.listAudit()).find((e) => e.action === 'project.member.add' && e.subject === `project:${projectId}`);
  assert.deepEqual(added?.payload, { userId: alice, role: 'manager', via: 'transfer' });
  // Still a manager: alice can manage people, but handing it on again is the new owner's call.
  assert.equal((await env.as('alice@test', 'PATCH', `/api/v1/projects/${projectId}`, { ownerId: alice })).status, 403);
  // Who may hand it on is said in the list, by the test the transfer itself
  // applies: the owner, or a holder of project.manage, never a member manager.
  const transfers = async (email: string) => (await effectiveOf(env, email, projectId) as { canTransfer?: boolean }).canTransfer;
  assert.equal(await transfers('dee@test'), true, 'the owner');
  assert.equal(await transfers('alice@test'), false, 'a member manager');
  assert.equal(await transfers('owner@test'), true, 'a holder of project.manage');
  // An admin denied project.manage who is a Manager on the project may not hand
  // it on, and is not offered to: the list and the transfer agree.
  const admin = await env.userId('admin@test');
  await env.store.putProjectMember({ projectId, userId: admin, role: 'manager', addedBy: 'user:seed', addedAt: new Date().toISOString() });
  const denyAdmin: Grant = { principal: `user:${admin}`, action: 'project.manage', resource: '*', effect: 'deny' };
  await env.store.putGrant(denyAdmin);
  try {
    assert.equal(await transfers('admin@test'), false, 'project.manage denied');
    assert.equal((await env.as('admin@test', 'PATCH', `/api/v1/projects/${projectId}`, { ownerId: admin })).status, 403);
  } finally {
    await env.store.deleteGrant(denyAdmin);
  }
  // A member granted project.manage is offered it, and the transfer is accepted.
  const grantAlice: Grant = { principal: `user:${alice}`, action: 'project.manage', resource: '*', effect: 'allow' };
  await env.store.putGrant(grantAlice);
  try {
    assert.equal(await transfers('alice@test'), true, 'project.manage granted');
  } finally {
    await env.store.deleteGrant(grantAlice);
  }
  // She can leave like any member.
  assert.equal((await env.as('alice@test', 'DELETE', `/api/v1/projects/${projectId}/members/${alice}`)).status, 204);

  // A disabled previous owner is not kept: offboarding leaves no row to come back.
  const parked = await env.store.upsertUserBySub({ sub: 'proxy:gone', email: 'gone@corp.example', groups: [], role: 'member' });
  const theirs = 'prj_offboard';
  await env.store.putProject({ id: theirs, name: 'Offboard', visibility: 'private', ownerId: parked.id, createdAt: new Date().toISOString() });
  await env.store.setUserDisabled(parked.id, new Date().toISOString());
  assert.equal((await env.as('owner@test', 'PATCH', `/api/v1/projects/${theirs}`, { ownerId: dee })).status, 200);
  assert.equal(await env.store.getProjectMember(theirs, parked.id), null);
});
