// SPDX-License-Identifier: MPL-2.0
/**
 * What an access request never gives away (plans/74 invite spec, security
 * rules 8, 10, 18 and 21):
 *   - asking answers the same 202 bytes whether the request was stored,
 *     already open, or never could be (an unknown or archived project, access
 *     already there, requests off, a session that is gone), and nobody is
 *     told about the ones that were not stored;
 *   - your own asks list only your own rows, the same for a project you
 *     never asked about as for one that does not exist;
 *   - only a signed-in person asks or answers: no cookie, a service token
 *     and a cross-site page are all refused;
 *   - a manager of one project answers nothing on another;
 *   - audit rows carry a note's length, never its text, and never a link.
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
import { fileRequest } from '../server/src/access/requests.ts';
import type { RequestDeps } from '../server/src/access/types.ts';
import { createNotifier } from '../server/src/notify/notify.ts';
import { createPeopleNotifier } from '../server/src/notify/people.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const PEOPLE = [
  { email: 'owner@test', name: 'Olive Owner', groups: ['owner'] },
  { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
  { email: 'alice@test', name: 'Alice', groups: [] },
  { email: 'mona@test', name: 'Mona', groups: [] },
  { email: 'vic@test', name: 'Vic', groups: [] },
  { email: 'olly@test', name: 'Olly', groups: [] },
];

async function boot(policy: Record<string, unknown> = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-asks-sec-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Team Hub', baseUrl: 'https://team.example', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: PEOPLE },
    policy: { requests: { join: true }, ...policy },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sSec', link: 'lSec' } });
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
  const raw = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: (text ? JSON.parse(text) : null) as any, headers: res.headers };
  };
  const as = async (email: string, method: string, path: string, body?: unknown) => raw(method, path, { cookie: await login(email) }, body);
  const user = async (email: string) => {
    await login(email);
    return (await store.findUsersByEmail(email))[0]!;
  };
  const deps: RequestDeps = {
    store, config, now: Date.now,
    audit: (actor, action, subject, payload) => store.appendAudit({ at: new Date().toISOString(), actor, action, subject, ...(payload ? { payload } : {}) }),
    people: createPeopleNotifier({ store, config, notifier: createNotifier({ config, secrets: { session: 'sSec', link: 'lSec' } }) }),
  };
  for (const p of PEOPLE) await login(p.email);
  const made = await as('alice@test', 'POST', '/api/v1/projects', { name: 'Launch' });
  assert.equal(made.status, 201);
  const projectId = made.json.id as string;
  const at = new Date().toISOString();
  await store.putProjectMember({ projectId, userId: (await user('mona@test')).id, role: 'manager', addedBy: 'user:seed', addedAt: at });
  await store.putProjectMember({ projectId, userId: (await user('vic@test')).id, role: 'viewer', addedBy: 'user:seed', addedAt: at });
  return { base, store, config, login, raw, as, user, deps, projectId };
}

/** The parts of an answer a script could compare. */
const answerOf = (r: { status: number; text: string; headers: Headers }) =>
  ({ status: r.status, body: r.text, type: r.headers.get('content-type'), cache: r.headers.get('cache-control') });

test('every ask answers the same bytes, and only a stored request tells anyone', async () => {
  const env = await boot();
  const ask = (email: string, path: string, role = 'editor') => env.as(email, 'POST', path, { role, note: 'hello' });
  const created = answerOf(await ask('olly@test', `/api/v1/projects/${env.projectId}/access-requests`));
  const messagesAfterCreate = (await env.store.listMessages()).length;
  assert.equal(messagesAfterCreate, 1, 'the stored request told its approvers');

  const archived = await env.as('alice@test', 'POST', '/api/v1/projects', { name: 'Old' });
  const old = (await env.store.getProject(archived.json.id))!;
  await env.store.putProject({ ...old, archivedAt: new Date().toISOString() });
  const session = await env.as('alice@test', 'POST', `/api/v1/projects/${env.projectId}/sessions`, { toolId: 'poster', inputs: {}, meta: {} });
  assert.equal(session.status, 201);

  const states = {
    duplicate: await ask('olly@test', `/api/v1/projects/${env.projectId}/access-requests`),
    unknownProject: await ask('olly@test', '/api/v1/projects/prj_doesnotexist/access-requests'),
    archivedProject: await ask('olly@test', `/api/v1/projects/${old.id}/access-requests`),
    alreadyViews: await ask('vic@test', `/api/v1/projects/${env.projectId}/access-requests`, 'viewer'),
    alreadyEdits: await ask('alice@test', `/api/v1/projects/${env.projectId}/access-requests`),
    unknownSession: await ask('olly@test', '/api/v1/sessions/ses_doesnotexist/access-requests'),
  };
  for (const [name, r] of Object.entries(states)) assert.deepEqual(answerOf(r), created, name);
  assert.equal((await env.store.listMessages()).length, messagesAfterCreate, 'nothing reached anyone');
  assert.equal((await env.store.listAccessRequests({ status: 'open', now: new Date().toISOString() })).length, 1);

  const off = await boot({ requests: { project: false } });
  const offAnswer = answerOf(await off.as('olly@test', 'POST', `/api/v1/projects/${off.projectId}/access-requests`, { role: 'editor', note: 'hello' }));
  assert.deepEqual(offAnswer, created, 'requests switched off');
  assert.deepEqual(await off.store.listMessages(), []);
});

test('your own asks: the same empty answer for a project you never asked about as for one that does not exist', async () => {
  const env = await boot();
  const real = await env.as('olly@test', 'GET', `/api/v1/access-requests/mine?projectId=${env.projectId}`);
  const none = await env.as('olly@test', 'GET', '/api/v1/access-requests/mine?projectId=prj_doesnotexist');
  const noSession = await env.as('olly@test', 'GET', '/api/v1/access-requests/mine?sessionId=ses_doesnotexist');
  assert.deepEqual(answerOf(real), answerOf(none));
  assert.deepEqual(answerOf(noSession), answerOf(none));
  // Someone else's ask is not yours to see.
  await env.as('vic@test', 'POST', `/api/v1/projects/${env.projectId}/access-requests`, { role: 'editor' });
  assert.deepEqual((await env.as('olly@test', 'GET', `/api/v1/access-requests/mine?projectId=${env.projectId}`)).json, { requests: [] });
});

test('only a signed-in person asks or answers: no cookie, a service token and a cross-site page are refused', async () => {
  const env = await boot();
  await env.as('olly@test', 'POST', `/api/v1/projects/${env.projectId}/access-requests`, { role: 'editor' });
  const [open] = await env.store.listAccessRequests({ status: 'open', now: new Date().toISOString() });
  const routes: Array<[string, string, unknown?]> = [
    ['POST', `/api/v1/projects/${env.projectId}/access-requests`, { role: 'editor' }],
    ['POST', '/api/v1/sessions/ses_x/access-requests', { role: 'editor' }],
    ['GET', `/api/v1/access-requests/mine?projectId=${env.projectId}`],
    ['POST', `/api/v1/access-requests/${open!.id}/withdraw`, {}],
    ['GET', '/api/v1/access-requests'],
    ['POST', `/api/v1/access-requests/${open!.id}/approve`, {}],
    ['POST', `/api/v1/access-requests/${open!.id}/decline`, {}],
  ];
  const minted = await env.as('owner@test', 'POST', '/api/v1/tokens', { label: 'Script', role: 'admin' });
  assert.equal(minted.status, 201);
  const bearer = `Bearer ${minted.json.token as string}`;
  for (const [method, path, body] of routes) {
    assert.equal((await env.raw(method, path, {}, body)).status, 401, `${method} ${path} without a session`);
    assert.equal((await env.raw(method, path, { authorization: bearer }, body)).status, 401, `${method} ${path} with a service token`);
  }
  const crossSite = await env.raw('POST', `/api/v1/access-requests/${open!.id}/approve`, {
    cookie: await env.login('mona@test'), origin: 'https://evil.example',
  }, {});
  assert.equal(crossSite.status, 403, 'a page on another site cannot approve with the cookie');
  assert.equal((await env.store.getAccessRequest(open!.id))?.status, 'open');
});

test('a manager of one project answers nothing on another, whatever the body says', async () => {
  const env = await boot();
  const other = await env.as('alice@test', 'POST', '/api/v1/projects', { name: 'Elsewhere' });
  await env.as('olly@test', 'POST', `/api/v1/projects/${other.json.id}/access-requests`, { role: 'editor' });
  const [open] = await env.store.listAccessRequests({ status: 'open', now: new Date().toISOString() });
  assert.deepEqual((await env.as('mona@test', 'GET', '/api/v1/access-requests')).json.requests, []);
  const no = await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/approve`, { role: 'editor', projectId: env.projectId });
  assert.equal(no.status, 403);
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/decline`, {})).status, 403);
  assert.equal((await env.store.getAccessRequest(open!.id))?.status, 'open');
  // A join request is not a manager's to answer either.
  const join = await fileRequest(env.deps, { kind: 'join', identity: { email: 'sam@example.com', idp: 'primary', sub: 'g-sam' } });
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/access-requests/${join.request!.id}/approve`, {})).status, 403);
});

test('audit rows carry a note\'s length, never its text, and never a link', async () => {
  const env = await boot();
  const secret = 'SECRET-NOTE-7f3a';
  await env.as('olly@test', 'POST', `/api/v1/projects/${env.projectId}/access-requests`, { role: 'editor', note: secret });
  const [project] = await env.store.listAccessRequests({ status: 'open', now: new Date().toISOString() });
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/access-requests/${project!.id}/approve`, {})).status, 200);
  const join = await fileRequest(env.deps, { kind: 'join', identity: { email: 'sam@example.com', idp: 'primary', sub: 'g-sam' }, note: secret });
  const approved = await env.as('admin@test', 'POST', `/api/v1/access-requests/${join.request!.id}/approve`, {});
  assert.equal(approved.status, 200);
  const declined = await fileRequest(env.deps, { kind: 'join', identity: { email: 'dee@example.com', idp: 'primary', sub: 'g-dee' }, note: secret });
  assert.equal((await env.as('admin@test', 'POST', `/api/v1/access-requests/${declined.request!.id}/decline`, {})).status, 200);

  const audit = JSON.stringify(await env.store.listAudit());
  assert.ok(!audit.includes(secret), 'no note text');
  assert.ok(!audit.includes('/l/invite/'), 'no invite link');
  const asked = (await env.store.listAudit()).find((e) => e.action === 'access.request' && (e.payload as { kind: string }).kind === 'project');
  assert.equal((asked?.payload as { noteChars: number }).noteChars, secret.length);
  for (const action of ['access.approve', 'access.decline']) {
    assert.ok((await env.store.listAudit()).some((e) => e.action === action), action);
  }
});
