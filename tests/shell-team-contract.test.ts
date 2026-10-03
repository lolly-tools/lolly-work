// SPDX-License-Identifier: MPL-2.0
/**
 * The wire shapes the Lolly web shell reads for team projects, people and
 * linked sign-ins (plans/74 scope change), pinned over real HTTP. The shell
 * side lives in the Lolly repository (shells/web/src/org/project-members.ts,
 * identities.ts, session-source.ts, team-access.ts); a rename here that the
 * shell does not follow would leave its People panel or Linked sign-ins card
 * silently empty, so each field it reads is asserted by name:
 *   - project and session list rows: myRole, updatedAt, updatedByName;
 *   - the members list: myRole, member rows with `isMe` on the caller's own,
 *     and invitations only for managers;
 *   - invite: results plus `link`, and the share inbox message whose cta.url
 *     is the same address (relative when appUrl is unset, `<appUrl>/...` when
 *     it is set);
 *   - error bodies `{ error: { code } }` for the codes the shell words
 *     (ROLE_NOT_ALLOWED, PROJECT_ARCHIVED, ACCOUNT_SIGN_IN);
 *   - identity rows carry the subjectHash the remove route takes;
 *   - org-config carries can['user.invite'], can['session.edit'] and invites.
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

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const PEOPLE = [
  { email: 'alice@test', name: 'Alice', groups: [] },
  { email: 'mona@test', name: 'Mona', groups: [] },
  { email: 'vic@test', name: 'Vic', groups: [] },
  { email: 'olly@test', name: 'Olly', groups: [] },
];

async function boot(instance: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-shell-contract-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Team Hub', baseUrl: 'https://team.example', pack, ...instance },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: PEOPLE },
    ...rest,
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sShell', link: 'lShell' } });
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
    return { status: res.status, json: json as any, headers: res.headers };
  };
  const userId = async (email: string): Promise<string> => {
    await login(email);
    return (await store.findUsersByEmail(email))[0]!.id;
  };
  return { base, store, login, as, userId };
}

type Env = Awaited<ReturnType<typeof boot>>;

/** alice owns a private project; mona manages it and vic views it. */
async function seed(env: Env): Promise<string> {
  for (const p of PEOPLE) await env.login(p.email);
  const made = await env.as('alice@test', 'POST', '/api/v1/projects', { name: 'Launch', visibility: 'private' });
  assert.equal(made.status, 201);
  const projectId = made.json.id as string;
  const at = new Date().toISOString();
  await env.store.putProjectMember({ projectId, userId: await env.userId('mona@test'), role: 'manager', addedBy: 'user:seed', addedAt: at });
  await env.store.putProjectMember({ projectId, userId: await env.userId('vic@test'), role: 'viewer', addedBy: 'user:seed', addedAt: at });
  return projectId;
}

test('list rows carry the fields the shell reads: myRole, updatedAt, updatedByName', async () => {
  const env = await boot();
  const projectId = await seed(env);
  const saved = await env.as('mona@test', 'POST', `/api/v1/projects/${projectId}/sessions`, { toolId: 'poster', inputs: { t: 1 }, meta: { label: 'Cover' } });
  assert.equal(saved.status, 201);
  assert.equal(typeof saved.json.id, 'string');
  assert.equal(typeof saved.json.rev, 'number');

  const row = (await env.as('vic@test', 'GET', '/api/v1/projects')).json.projects.find((p: { id: string }) => p.id === projectId);
  assert.equal(row.myRole, 'viewer');
  assert.equal(row.name, 'Launch');
  assert.equal(row.sessionCount, 1);
  assert.equal(typeof row.updatedAt, 'string');
  assert.equal(row.updatedByName, 'Mona');

  const sessions = (await env.as('vic@test', 'GET', `/api/v1/projects/${projectId}/sessions`)).json.sessions;
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['id', 'label', 'meta', 'rev', 'toolId', 'toolVersion', 'updatedAt', 'updatedBy', 'updatedByName']);
  assert.equal(sessions[0].label, 'Cover');
  assert.equal(sessions[0].updatedByName, 'Mona');

  // The #/team/project/<id> route tells these apart by status.
  assert.equal((await env.as('olly@test', 'GET', `/api/v1/projects/${projectId}/sessions`)).status, 403);
  assert.equal((await env.as('olly@test', 'GET', '/api/v1/projects/prj_missing/sessions')).status, 404);
});

test('members: isMe marks the caller, emails and invitations only for managers', async () => {
  const env = await boot();
  const projectId = await seed(env);
  const vicId = await env.userId('vic@test');
  const monaId = await env.userId('mona@test');

  const asViewer = await env.as('vic@test', 'GET', `/api/v1/projects/${projectId}/members`);
  assert.equal(asViewer.status, 200);
  assert.equal(asViewer.json.myRole, 'viewer');
  assert.equal(asViewer.json.invitations, undefined);
  const mine = (asViewer.json.members as Array<Record<string, unknown>>).filter((m) => m.isMe === true);
  assert.deepEqual(mine.map((m) => m.userId), [vicId], 'exactly one row is the caller');
  assert.ok((asViewer.json.members as Array<Record<string, unknown>>).every((m) => m.userId === vicId || !('isMe' in m)), 'no isMe: false noise');

  const asManager = await env.as('mona@test', 'GET', `/api/v1/projects/${projectId}/members`);
  assert.equal(asManager.json.myRole, 'manager');
  assert.ok(Array.isArray(asManager.json.invitations));
  const me = (asManager.json.members as Array<Record<string, unknown>>).find((m) => m.isMe === true)!;
  assert.deepEqual([me.userId, me.role, me.email], [monaId, 'manager', 'mona@test']);
  const owner = asManager.json.members[0];
  assert.deepEqual([owner.role, typeof owner.addedAt], ['owner', 'string']);
});

test('invite: link and the share message open the same address, relative without appUrl', async () => {
  const env = await boot({}, { policy: { invites: { allow: 'members' } } });
  const projectId = await seed(env);
  const r = await env.as('alice@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test', 'new@else.example'], role: 'editor' });
  assert.equal(r.status, 200);
  const [added, invited] = r.json.results as Array<Record<string, string>>;
  assert.deepEqual(added, { email: 'olly@test', status: 'added' });
  // An invited row carries what Lolly needs for its invite message: the
  // invitation, this project's invite link and when the invitation ends.
  assert.deepEqual([invited!.email, invited!.status, typeof invited!.invitationId, typeof invited!.expiresAt],
    ['new@else.example', 'invited', 'string', 'string']);
  assert.match(invited!.link!, /^https:\/\/team\.example\/l\/invite\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(r.json.link, `https://team.example/#/team/project/${projectId}`);
  assert.deepEqual(r.json.message, { workspace: 'Team Hub', inviter: 'Alice', providers: [] });

  const inbox = (await env.as('olly@test', 'GET', '/api/v1/inbox')).json.messages as Array<Record<string, any>>;
  const share = inbox.find((m) => m.kind === 'share')!;
  assert.equal(share.title, 'Alice shared Launch with you');
  assert.equal(share.cta.url, `/#/team/project/${projectId}`);
  assert.equal(share.data.projectId, projectId);

  const people = (await env.as('alice@test', 'GET', `/api/v1/projects/${projectId}/members`)).json;
  const inv = people.invitations.find((i: { email: string }) => i.email === 'new@else.example');
  assert.equal(inv.role, 'editor');
  assert.equal(typeof inv.id, 'string');
  assert.equal(typeof inv.createdAt, 'string');
  assert.equal(typeof inv.expiresAt, 'string');
  assert.equal(inv.status, 'pending');
  assert.equal(inv.link, invited!.link, 'the people panel copies the same link the invite answered');
  assert.equal(inv.invitedByName, 'Alice');
  assert.equal(inv.passwordSetup, false);
  assert.deepEqual(people.requests, [], 'managers get the open requests they may answer');
});

test('invite: with appUrl set, the link goes where the app lives, like the inbox message', async () => {
  const env = await boot({ appUrl: 'https://app.team.example/' });
  const projectId = await seed(env);
  const r = await env.as('alice@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'viewer' });
  assert.equal(r.status, 200);
  assert.equal(r.json.link, `https://app.team.example/#/team/project/${projectId}`);
  const share = ((await env.as('olly@test', 'GET', '/api/v1/inbox')).json.messages as Array<Record<string, any>>).find((m) => m.kind === 'share')!;
  assert.equal(share.cta.url, r.json.link);
});

test('error bodies carry the codes the shell words', async () => {
  const env = await boot({}, { policy: { invites: { projectRoles: ['viewer', 'editor'] } } });
  const projectId = await seed(env);
  const role = await env.as('alice@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'manager' });
  assert.equal(role.status, 403);
  assert.equal(role.json.error.code, 'ROLE_NOT_ALLOWED');
  const vicId = await env.userId('vic@test');
  const patch = await env.as('alice@test', 'PATCH', `/api/v1/projects/${projectId}/members/${vicId}`, { role: 'manager' });
  assert.deepEqual([patch.status, patch.json.error.code], [403, 'ROLE_NOT_ALLOWED']);
  const asViewer = await env.as('vic@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'viewer' });
  assert.deepEqual([asViewer.status, asViewer.json.error.code], [403, 'FORBIDDEN']);

  assert.equal((await env.as('alice@test', 'PATCH', `/api/v1/projects/${projectId}`, { archived: true })).status, 200);
  const archived = await env.as('alice@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['olly@test'], role: 'viewer' });
  assert.deepEqual([archived.status, archived.json.error.code], [409, 'PROJECT_ARCHIVED']);
});

test('identity rows carry subjectHash, and the remove route takes it', async () => {
  const env = await boot();
  await env.login('alice@test');
  const alice = (await env.store.findUsersByEmail('alice@test'))[0]!;
  await env.store.linkIdentity({
    identitySub: 'github:42', userId: alice.id, idp: 'github', email: 'alice@mail.test', emailVerified: true,
    linkedAt: new Date().toISOString(),
  });
  const got = await env.as('alice@test', 'GET', '/api/v1/me/identities');
  assert.equal(got.status, 200);
  const rows = got.json.identities as Array<Record<string, any>>;
  assert.equal(rows.length, 2);
  for (const r of rows) {
    for (const key of ['idp', 'subjectHash', 'displayName', 'linkedAt', 'canUnlink']) assert.ok(key in r, `${key} on every row`);
    assert.match(r.subjectHash, /^[0-9a-f]{16}$/);
  }
  const account = rows.find((r) => r.idp === 'dev')!;
  assert.deepEqual([account.canUnlink, account.unlinkBlocked], [false, 'account']);
  const github = rows.find((r) => r.idp === 'github')!;
  assert.equal(github.canUnlink, true);

  const refused = await env.as('alice@test', 'DELETE', `/api/v1/me/identities/dev/${account.subjectHash}`);
  assert.deepEqual([refused.status, refused.json.error.code], [409, 'ACCOUNT_SIGN_IN']);
  const removed = await env.as('alice@test', 'DELETE', `/api/v1/me/identities/github/${github.subjectHash}`);
  assert.equal(removed.status, 204);
  assert.ok(removed.headers.getSetCookie().some((c) => c.startsWith('lw_session=')), 'a fresh cookie keeps this device signed in');
});

test('org-config carries what the shell gates People and saving on', async () => {
  const env = await boot({}, { policy: { invites: { allow: 'members', domains: ['example.com'], maxTtlHours: 48, projectRoles: ['viewer', 'editor'] } } });
  await env.login('vic@test');
  const cfg = (await env.as('vic@test', 'GET', '/api/v1/org-config')).json;
  assert.equal(typeof cfg.can['user.invite'], 'boolean');
  assert.equal(typeof cfg.can['session.edit'], 'boolean');
  assert.equal(typeof cfg.can['session.create'], 'boolean');
  assert.equal(typeof cfg.can['project.create'], 'boolean');
  assert.deepEqual(cfg.invites, { domains: ['example.com'], maxTtlHours: 48, projectRoles: ['viewer', 'editor'], passwordSetup: false, passwordDomains: [] });
  assert.deepEqual(cfg.requests, { project: true });
});
