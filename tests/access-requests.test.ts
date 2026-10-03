// SPDX-License-Identifier: MPL-2.0
/**
 * Access requests over real HTTP (plans/74 invite spec R6 to R12; security
 * rules 9 to 13, 20 and 21):
 *   - asking for a project or from a session link, your own asks, withdraw;
 *   - the list shows only what the caller may answer now, and approve and
 *     decline ask that again, against what the request stored;
 *   - approving a project request shares the project at the approved role
 *     and tells the person, naming the approver; declining does not name them;
 *   - exactly one of two answers wins, and the other learns who answered;
 *   - a join request becomes an invitation, and the person's next sign-in
 *     is admitted; a switch request either gives an existing account what
 *     the invitation carried, or moves the invitation to the new address.
 * Join and switch requests are filed through the requests core, as the
 * sign-in pages file them; everything after that goes through the routes.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { fileRequest } from '../server/src/access/requests.ts';
import { readInviteToken } from '../server/src/access/invite-token.ts';
import type { RequestDeps } from '../server/src/access/types.ts';
import { createNotifier } from '../server/src/notify/notify.ts';
import { createPeopleNotifier } from '../server/src/notify/people.ts';
import type { Store } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

// ── a stub OIDC issuer, for the people who sign in from outside ─────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const ISSUER = 'https://accounts.google.test';
const b64u = (v: Buffer | string): string => Buffer.from(v).toString('base64url');
function signIdToken(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${b64u(createSign('sha256').update(`${head}.${body}`).sign(privateKey))}`;
}
type Current = { nonce: string; claims: Record<string, unknown> };
function issuerFetch(current: Current): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [JWK] });
    if (url === `${ISSUER}/token`) {
      return Response.json({ id_token: signIdToken({ iss: ISSUER, aud: 'g-client', nonce: current.nonce, exp: Math.floor(Date.now() / 1000) + 300, ...current.claims }) });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

const PEOPLE = [
  { email: 'owner@test', name: 'Olive Owner', groups: ['owner'] },
  { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
  { email: 'alice@test', name: 'Alice', groups: [] },
  { email: 'mona@test', name: 'Mona', groups: [] },
  { email: 'vic@test', name: 'Vic', groups: [] },
  { email: 'olly@test', name: 'Olly', groups: [] },
];

/** Dev sign-in for the people above; with `gated`, a Google-like issuer
 *  whose sign-ins need an invitation (admission on, join requests on). */
async function boot(over: Record<string, unknown> = {}, opts: { gated?: boolean; store?: Store } = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-asks-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const current: Current = { nonce: '', claims: {} };
  const { policy, ...rest } = over as { policy?: Record<string, unknown> };
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Team Hub', baseUrl: 'https://team.example', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: PEOPLE },
    ...(opts.gated ? { idp: { issuer: ISSUER, clientId: 'g-client', displayName: 'Google', admission: { emails: ['ana@example.com'] } } } : {}),
    policy: { requests: { join: true }, ...(policy ?? {}) },
    ...rest,
  }));
  const store = opts.store ?? createMemoryStore();
  const app = buildApp({
    config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sAsk', link: 'lAsk' },
    ...(opts.gated ? { fetchImpl: issuerFetch(current) } : {}),
  });
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
  const call = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json: json as any, text, headers: res.headers };
  };
  const as = async (email: string, method: string, path: string, body?: unknown) => call(await login(email), method, path, body);
  const user = async (email: string) => {
    await login(email);
    return (await store.findUsersByEmail(email))[0]!;
  };
  /** Sign in through the stub issuer: 302 admitted, 403 refused. */
  const oidcSignIn = async (claims: Record<string, unknown>) => {
    const started = await fetch(`${base}/api/auth/login`, { redirect: 'manual' });
    assert.equal(started.status, 302);
    const authorize = new URL(started.headers.get('location')!);
    current.nonce = authorize.searchParams.get('nonce')!;
    current.claims = { email_verified: true, ...claims };
    const stateCookie = started.headers.getSetCookie().find((c) => c.startsWith('lw_state='))!.split(';')[0]!;
    const done = await fetch(`${base}/api/auth/callback?code=xyz&state=${authorize.searchParams.get('state')}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
    const session = done.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];
    return { status: done.status, session };
  };
  // The requests core as the sign-in pages call it, over the app's store.
  const deps: RequestDeps = {
    store, config, now: Date.now,
    audit: (actor, action, subject, payload) => store.appendAudit({ at: new Date().toISOString(), actor, action, subject, ...(payload ? { payload } : {}) }),
    people: createPeopleNotifier({ store, config, notifier: createNotifier({ config, secrets: { session: 'sAsk', link: 'lAsk' } }) }),
  };
  const audits = async (action: string) => (await store.listAudit()).filter((e) => e.action === action);
  const inbox = async (email: string) => (await as(email, 'GET', '/api/v1/inbox')).json.messages as Array<{ id: string; title: string; body?: string; data?: Record<string, string> }>;
  return { base, store, config, login, call, as, user, oidcSignIn, deps, audits, inbox };
}

type Env = Awaited<ReturnType<typeof boot>>;

/** Alice owns a private project; Mona manages it and Vic views it. Olly is
 *  on nobody's project. Everyone has signed in once. */
async function seed(env: Env, name = 'Launch') {
  for (const p of PEOPLE) await env.login(p.email);
  const made = await env.as('alice@test', 'POST', '/api/v1/projects', { name });
  assert.equal(made.status, 201);
  const projectId = made.json.id as string;
  const at = new Date().toISOString();
  await env.store.putProjectMember({ projectId, userId: (await env.user('mona@test')).id, role: 'manager', addedBy: 'user:seed', addedAt: at });
  await env.store.putProjectMember({ projectId, userId: (await env.user('vic@test')).id, role: 'viewer', addedBy: 'user:seed', addedAt: at });
  return projectId;
}

const openRequests = async (env: Env) => env.store.listAccessRequests({ status: 'open', now: new Date().toISOString() });
const answerOf = (r: { status: number; text: string }) => ({ status: r.status, body: r.text });
/** A retired notice ends at the instant it was retired, and the inbox shows
 *  a message until the millisecond after its end, so a check for its absence
 *  waits that long. */
const pastRetirement = () => new Promise((r) => setTimeout(r, 3));

// ── asking ──────────────────────────────────────────────────────────────────

test('asking for a project: stored once, told to its managers, listed as yours, withdrawn', async () => {
  const env = await boot();
  const projectId = await seed(env);
  const sent = await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor', note: 'For the poster' });
  assert.equal(sent.status, 202);
  assert.deepEqual(sent.json, { ok: true });
  assert.equal((await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor' })).status, 202);
  const [open, ...more] = await openRequests(env);
  assert.equal(more.length, 0, 'one open request per person and project');
  assert.equal(open?.note, 'For the poster');
  assert.equal(open?.currentRole, 'none');

  const notice = (await env.inbox('mona@test')).find((m) => m.id === `msg_req_${open!.id}`);
  assert.equal(notice?.title, 'Olly asks to edit Launch');
  assert.ok((await env.inbox('alice@test')).some((m) => m.id === `msg_req_${open!.id}`), 'the owner hears too');
  assert.ok(!(await env.inbox('vic@test')).some((m) => m.id === `msg_req_${open!.id}`), 'a viewer does not');

  const mine = await env.as('olly@test', 'GET', `/api/v1/access-requests/mine?projectId=${projectId}`);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.requests.map((r: { id: string; status: string; role: string }) => [r.id, r.status, r.role]), [[open!.id, 'open', 'editor']]);
  assert.equal((await env.as('olly@test', 'GET', '/api/v1/access-requests/mine')).status, 400, 'a target is required');
  assert.equal((await env.as('olly@test', 'GET', `/api/v1/access-requests/mine?projectId=${projectId}&sessionId=x`)).status, 400, 'only one');

  assert.equal((await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/withdraw`, {})).status, 404, 'only the person who asked withdraws');
  const withdrawn = await env.as('olly@test', 'POST', `/api/v1/access-requests/${open!.id}/withdraw`, {});
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.json.request.status, 'withdrawn');
  await pastRetirement();
  assert.ok(!(await env.inbox('mona@test')).some((m) => m.id === `msg_req_${open!.id}`), 'the notice leaves the approvers\' inbox');
  const again = await env.as('olly@test', 'POST', `/api/v1/access-requests/${open!.id}/withdraw`, {});
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'ALREADY_ANSWERED');
  assert.deepEqual((await env.audits('access.withdraw')).map((e) => e.payload), [{ kind: 'project' }]);
});

test('asking from a session link records the session and resolves its project', async () => {
  const env = await boot();
  const projectId = await seed(env);
  const made = await env.as('alice@test', 'POST', `/api/v1/projects/${projectId}/sessions`, { toolId: 'poster', inputs: {}, meta: { label: 'Spring poster' } });
  assert.equal(made.status, 201);
  const sessionId = made.json.id as string;
  assert.equal((await env.as('olly@test', 'POST', `/api/v1/sessions/${sessionId}/access-requests`, { role: 'viewer' })).status, 202);
  const [open] = await openRequests(env);
  assert.equal(open?.projectId, projectId);
  assert.equal(open?.viaSessionId, sessionId);
  const mine = await env.as('olly@test', 'GET', `/api/v1/access-requests/mine?sessionId=${sessionId}`);
  assert.deepEqual(mine.json.requests.map((r: { id: string }) => r.id), [open!.id]);
  const listed = await env.as('mona@test', 'GET', '/api/v1/access-requests');
  assert.deepEqual(listed.json.requests[0].session, { id: sessionId, name: 'Spring poster' });
  assert.deepEqual(listed.json.requests[0].project, { id: projectId, name: 'Launch' });
});

test('a note over 280 characters or a role other than view or edit is refused; the 21st ask in a day gets 429', async () => {
  const env = await boot();
  const projectId = await seed(env);
  const long = await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor', note: 'x'.repeat(281) });
  assert.equal(long.status, 400);
  assert.equal(long.json.error.field, 'note');
  assert.equal((await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor', note: `  ${'é'.repeat(280)}  ` })).status, 202,
    '280 characters, counted after trimming');
  for (const role of ['manager', 'owner', undefined]) {
    const bad = await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role });
    assert.equal(bad.status, 400, String(role));
    assert.equal(bad.json.error.field, 'role');
  }
  assert.equal((await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'viewer', note: 5 })).status, 400);
  // The one ask above counted; 19 more fill the day, the next waits.
  for (let i = 0; i < 19; i++) {
    assert.equal((await env.as('olly@test', 'POST', `/api/v1/projects/prj_nope_${i}/access-requests`, { role: 'viewer' })).status, 202);
  }
  const held = await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'viewer' });
  assert.equal(held.status, 429);
  assert.equal(held.json.error.code, 'RATE_LIMITED');
  assert.ok(Number(held.headers.get('retry-after')) > 0, 'retry-after says when');
  assert.equal((await env.as('vic@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor' })).status, 202, 'per person');
});

// ── who may answer ──────────────────────────────────────────────────────────

test('the list shows what the caller may answer now: managers, the owner and admins, never the asker or a viewer', async () => {
  const env = await boot();
  const projectId = await seed(env);
  await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor', note: 'hi' });
  const [open] = await openRequests(env);
  const listed = async (email: string) => (await env.as(email, 'GET', '/api/v1/access-requests')).json.requests.map((r: { id: string }) => r.id);
  for (const email of ['mona@test', 'alice@test', 'admin@test', 'owner@test']) assert.deepEqual(await listed(email), [open!.id], email);
  for (const email of ['vic@test', 'olly@test']) assert.deepEqual(await listed(email), [], email);

  const view = (await env.as('mona@test', 'GET', '/api/v1/access-requests')).json.requests[0];
  assert.equal(view.kind, 'project');
  assert.equal(view.status, 'open');
  assert.equal(view.email, 'olly@test');
  assert.equal(view.name, 'Olly');
  assert.equal(view.note, 'hi');
  assert.equal(view.role, 'editor');
  assert.equal(view.currentRole, 'none');
  assert.equal(view.answeredBy, null);

  for (const action of ['approve', 'decline']) {
    const no = await env.as('vic@test', 'POST', `/api/v1/access-requests/${open!.id}/${action}`, {});
    assert.equal(no.status, 403, `a viewer cannot ${action}`);
    assert.equal((await env.as('olly@test', 'POST', `/api/v1/access-requests/${open!.id}/${action}`, {})).status, 403, `nobody ${action}s their own`);
  }
  assert.equal((await env.as('mona@test', 'POST', '/api/v1/access-requests/req_unknown/approve', {})).status, 404);
  assert.equal((await env.as('mona@test', 'GET', '/api/v1/access-requests?status=closed')).status, 400);
  assert.equal((await env.as('mona@test', 'GET', '/api/v1/access-requests?status=answered&since=soon')).status, 400);

  // Demoted since the request was filed: no longer an approver.
  await env.store.updateProjectMemberRole(projectId, (await env.user('mona@test')).id, 'editor');
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/approve`, {})).status, 403);
  assert.deepEqual(await listed('mona@test'), []);
  assert.equal((await env.store.getAccessRequest(open!.id))?.status, 'open', 'nothing changed');
});

// ── approving and declining a project request ───────────────────────────────

test('approve: the role is the approver\'s choice within policy, the project is the stored one, and the answer names the approver', async () => {
  const env = await boot({ policy: { invites: { projectRoles: ['viewer', 'editor'] } } });
  const projectId = await seed(env);
  const other = await seed(env, 'Elsewhere');
  await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor' });
  const [open] = await openRequests(env);

  const manager = await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/approve`, { role: 'manager' });
  assert.equal(manager.status, 400, 'a role outside policy.invites.projectRoles');
  assert.equal(manager.json.error.code, 'ROLE_NOT_ALLOWED');
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/approve`, { role: 'boss' })).status, 400);
  assert.equal((await env.store.getAccessRequest(open!.id))?.status, 'open');

  const ok = await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/approve`, { role: 'viewer', projectId: other });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'added');
  assert.equal(ok.json.request.status, 'approved');
  assert.equal(ok.json.request.answerRole, 'viewer');
  assert.deepEqual(ok.json.request.answeredBy, { name: 'Mona' });
  const olly = await env.user('olly@test');
  assert.equal((await env.store.getProjectMember(projectId, olly.id))?.role, 'viewer', 'shared at the approved role');
  assert.equal(await env.store.getProjectMember(other, olly.id), null, 'a projectId in the body is ignored');

  const told = await env.inbox('olly@test');
  assert.deepEqual(told.map((m) => m.title), ['Mona gave you view access to Launch'], 'the answer, and no share message as well');
  assert.equal(told[0]?.data?.outcome, 'approved');
  await pastRetirement();
  assert.ok(!(await env.inbox('mona@test')).some((m) => m.id === `msg_req_${open!.id}`), 'the request notice is retired');

  const mine = (await env.as('olly@test', 'GET', `/api/v1/access-requests/mine?projectId=${projectId}`)).json.requests;
  assert.deepEqual(mine.map((r: { status: string; answerRole: string }) => [r.status, r.answerRole]), [['approved', 'viewer']]);
  const [row] = await env.audits('access.approve');
  assert.deepEqual(row?.payload, { kind: 'project', email: 'olly@test', role: 'viewer', outcome: 'added', projectId });
  assert.equal(row?.actor, `user:${(await env.user('mona@test')).id}`);
  const answered = await env.as('alice@test', 'GET', '/api/v1/access-requests?status=answered');
  assert.deepEqual(answered.json.requests.map((r: { id: string; status: string }) => [r.id, r.status]), [[open!.id, 'approved']]);
  assert.deepEqual((await env.as('alice@test', 'GET', '/api/v1/access-requests')).json.requests, [], 'no longer open');
});

test('two answers at once: one 200, one 409 ALREADY_ANSWERED that says who answered and how', async () => {
  const env = await boot();
  const projectId = await seed(env);
  await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor' });
  const [open] = await openRequests(env);
  const both = await Promise.all([
    env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/approve`, { role: 'viewer' }),
    env.as('alice@test', 'POST', `/api/v1/access-requests/${open!.id}/approve`, { role: 'editor' }),
  ]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const won = both.find((r) => r.status === 200)!;
  const lost = both.find((r) => r.status === 409)!;
  assert.equal(lost.json.error.code, 'ALREADY_ANSWERED');
  assert.equal(lost.json.request.status, 'approved');
  assert.deepEqual(lost.json.request.answeredBy, won.json.request.answeredBy);
  assert.equal(lost.json.request.answerRole, won.json.request.answerRole);
  assert.deepEqual(lost.json.error.request, lost.json.request, 'also inside the error object');
  assert.equal((await env.audits('access.approve')).length, 1, 'one approval, one change');
  const late = await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/decline`, {});
  assert.equal(late.status, 409);
});

test('decline: the request is closed, the asker hears without the approver\'s name, and may ask again', async () => {
  const env = await boot();
  const projectId = await seed(env);
  await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor', note: 'pls' });
  const [open] = await openRequests(env);
  const no = await env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/decline`, {});
  assert.equal(no.status, 200);
  assert.equal(no.json.request.status, 'declined');
  const told = await env.inbox('olly@test');
  assert.deepEqual(told.map((m) => m.title), ['Your request for Launch was not approved']);
  assert.ok(!JSON.stringify(told).includes('Mona'), 'a decline never names who declined');
  assert.deepEqual((await env.audits('access.decline')).map((e) => e.payload), [{ kind: 'project', email: 'olly@test', projectId }]);
  assert.equal((await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor' })).status, 202);
  assert.equal((await openRequests(env)).length, 1, 'a new ask after a decline');
});

test('a project archived, or an asker disabled, since the ask: 409 and the request ends', async () => {
  const env = await boot();
  const projectId = await seed(env);
  await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor' });
  await env.as('vic@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor' });
  const [first, second] = await openRequests(env);
  const project = (await env.store.getProject(projectId))!;

  await env.store.setUserDisabled((await env.user(second!.email)).id, new Date().toISOString());
  const gone = await env.as('mona@test', 'POST', `/api/v1/access-requests/${second!.id}/approve`, {});
  assert.equal(gone.status, 409);
  assert.equal(gone.json.error.code, 'REQUESTER_UNAVAILABLE');
  assert.equal((await env.store.getAccessRequest(second!.id))?.status, 'expired');

  await env.store.putProject({ ...project, archivedAt: new Date().toISOString() });
  const archived = await env.as('mona@test', 'POST', `/api/v1/access-requests/${first!.id}/approve`, {});
  assert.equal(archived.status, 409);
  assert.equal(archived.json.error.code, 'PROJECT_ARCHIVED');
  assert.equal((await env.store.getAccessRequest(first!.id))?.status, 'expired');
  await pastRetirement();
  assert.ok(!(await env.inbox('mona@test')).some((m) => m.id.startsWith('msg_req_')), 'both notices retired');
});

// ── join and switch requests ────────────────────────────────────────────────

test('join: a manager cannot approve; an admin does, and the person\'s next sign-in is admitted', async () => {
  const env = await boot({}, { gated: true });
  await seed(env);
  assert.equal((await env.oidcSignIn({ sub: 'g-sam', email: 'sam@example.com', name: 'Sam K' })).status, 403, 'not invited');
  const filed = await fileRequest(env.deps, { kind: 'join', identity: { email: 'sam@example.com', idp: 'primary', sub: 'g-sam', name: 'Sam K' }, note: 'From the poster team' });
  assert.equal(filed.outcome, 'created');
  const id = filed.request!.id;

  assert.deepEqual((await env.as('mona@test', 'GET', '/api/v1/access-requests')).json.requests, [], 'a manager does not answer joins');
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/access-requests/${id}/approve`, {})).status, 403);
  const [view] = (await env.as('admin@test', 'GET', '/api/v1/access-requests')).json.requests;
  assert.equal(view.kind, 'join');
  assert.equal(view.provider, 'Google');
  assert.equal(view.name, 'Sam K');
  assert.equal(view.project, null);

  const ok = await env.as('admin@test', 'POST', `/api/v1/access-requests/${id}/approve`, { role: 'manager' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'invited');
  assert.equal(ok.json.invitation.email, 'sam@example.com');
  assert.equal(ok.json.invitation.createdVia, 'request');
  assert.match(ok.json.link, /^https:\/\/team\.example\/l\/invite\//);
  assert.equal(ok.json.message.text, 'You can now sign in to Team Hub. Open https://team.example and sign in as sam@example.com with Google.');
  assert.equal(ok.json.request.answerRole, null, 'a join takes no role');

  const signedIn = await env.oidcSignIn({ sub: 'g-sam', email: 'sam@example.com', name: 'Sam K' });
  assert.equal(signedIn.status, 302, 'admitted by the new invitation');
  const sam = (await env.store.findUsersByEmail('sam@example.com'))[0]!;
  assert.equal((await env.store.findActiveInvitation('sam@example.com'))?.acceptedUserId, sam.id);
  const [row] = await env.audits('access.approve');
  assert.equal((row?.payload as { outcome: string }).outcome, 'invited');
});

test('join into a project the approver manages: the invitation carries it, and the first sign-in opens it', async () => {
  const env = await boot({}, { gated: true });
  const projectId = await seed(env);
  const filed = await fileRequest(env.deps, { kind: 'join', identity: { email: 'sam@example.com', idp: 'primary', sub: 'g-sam', name: 'Sam K' } });
  const ok = await env.as('admin@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, { projectId, role: 'editor' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'invited');
  assert.equal(ok.json.request.answerRole, 'editor');
  assert.equal(readInviteToken(new URL(ok.json.link).pathname.split('/').pop()!, ['lAsk'])?.projectId, projectId, 'the link opens the project');
  const admin = await env.user('admin@test');
  assert.deepEqual((await env.store.findActiveInvitation('sam@example.com'))?.projects, [{ projectId, role: 'editor', invitedBy: `user:${admin.id}` }]);
  const [row] = await env.audits('access.approve');
  assert.deepEqual(row?.payload, {
    kind: 'join', email: 'sam@example.com', outcome: 'invited', invitationId: ok.json.invitation.id, projectId, role: 'editor',
  });
  assert.equal((await env.oidcSignIn({ sub: 'g-sam', email: 'sam@example.com' })).status, 302);
  const sam = (await env.store.findUsersByEmail('sam@example.com'))[0]!;
  assert.equal((await env.store.getProjectMember(projectId, sam.id))?.role, 'editor', 'acceptance applied the project');
});

test('join into a project: only one the approver manages, a role the policy gives, and a live project', async () => {
  const env = await boot({ policy: { requests: { join: true }, invites: { allow: 'members', projectRoles: ['viewer', 'editor'] } } }, { gated: true });
  const projectId = await seed(env);
  const filed = await fileRequest(env.deps, { kind: 'join', identity: { email: 'sam@example.com', idp: 'primary', sub: 'g-sam' } });
  const url = `/api/v1/access-requests/${filed.request!.id}/approve`;
  // Olly may invite (allow: members) but manages no project.
  const notTheirs = await env.as('olly@test', 'POST', url, { projectId, role: 'viewer' });
  assert.equal(notTheirs.status, 403);
  assert.equal(notTheirs.json.error.field, 'projectId');
  assert.deepEqual(answerOf(await env.as('olly@test', 'POST', url, { projectId: 'prj_nope', role: 'viewer' })), answerOf(notTheirs), 'no project and not yours read alike');
  assert.equal((await env.as('mona@test', 'POST', url, { projectId, role: 'manager' })).json.error.code, 'ROLE_NOT_ALLOWED');
  assert.equal((await env.as('mona@test', 'POST', url, { projectId: 42 })).status, 400);
  const project = (await env.store.getProject(projectId))!;
  await env.store.putProject({ ...project, archivedAt: new Date().toISOString() });
  assert.equal((await env.as('mona@test', 'POST', url, { projectId, role: 'viewer' })).status, 400, 'archived');
  assert.equal((await env.store.getAccessRequest(filed.request!.id))?.status, 'open', 'none of these answered the request');
  await env.store.putProject(project);
  const ok = await env.as('mona@test', 'POST', url, { projectId, role: 'viewer' });
  assert.equal(ok.status, 200, 'a manager who may invite (allow: members) adds them to her project');
  assert.equal(ok.json.outcome, 'invited');
});

test('join: an account whose invitation was revoked gets a new one, not "already"', async () => {
  const env = await boot({}, { gated: true });
  await seed(env);
  const sent = await env.as('admin@test', 'POST', '/api/v1/invitations', { emails: ['sam@example.com'] });
  assert.equal(sent.status, 201);
  assert.equal((await env.oidcSignIn({ sub: 'g-sam', email: 'sam@example.com' })).status, 302);
  const inv = (await env.store.findActiveInvitation('sam@example.com'))!;
  assert.equal((await env.as('admin@test', 'DELETE', `/api/v1/invitations/${inv.id}`)).status, 200);
  assert.equal((await env.oidcSignIn({ sub: 'g-sam', email: 'sam@example.com' })).status, 403, 'revoked: refused');

  const filed = await fileRequest(env.deps, { kind: 'join', identity: { email: 'sam@example.com', idp: 'primary', sub: 'g-sam' } });
  const ok = await env.as('admin@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'invited');
  assert.equal((await env.oidcSignIn({ sub: 'g-sam', email: 'sam@example.com' })).status, 302, 'admitted again');
});

test('switch to an existing account: the projects the approver manages move to it; groups need grant.edit', async () => {
  const env = await boot();
  const projectId = await seed(env);
  const mona = await env.user('mona@test');
  await env.store.putLocalGroup({ name: 'team', createdAt: new Date().toISOString() });
  const { invitation } = await env.store.createInvitation({
    id: 'inv_wendy', email: 'wendy@example.com', groups: ['team'], invitedBy: `user:${mona.id}`, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), projects: [{ projectId, role: 'editor', invitedBy: `user:${mona.id}` }], createdVia: 'project',
  });
  const olly = await env.user('olly@test');
  const filed = await fileRequest(env.deps, {
    kind: 'switch', identity: { email: 'olly@test', idp: 'dev', sub: 'dev:olly@test', name: 'Olly' }, invitationId: invitation.id, projectId, userId: olly.id,
    note: 'Same person',
  });
  assert.equal(filed.outcome, 'created');

  const [view] = (await env.as('mona@test', 'GET', '/api/v1/access-requests')).json.requests;
  assert.equal(view.kind, 'switch');
  assert.deepEqual(view.invitation, { id: invitation.id, maskedEmail: 'we•••@example.com', inviter: 'Mona' });
  const ok = await env.as('mona@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'added');
  assert.deepEqual(ok.json.added, [{ projectId, role: 'editor' }]);
  assert.deepEqual(ok.json.skipped, { projects: [], groups: ['team'] }, 'a manager without grant.edit gives no groups');
  assert.equal((await env.store.getProjectMember(projectId, olly.id))?.role, 'editor');
  assert.deepEqual((await env.store.getUser(olly.id))?.localGroups, []);
  assert.deepEqual((await env.inbox('olly@test')).map((m) => m.title), ['Mona gave you edit access to Launch']);
  const left = (await env.store.getInvitation(invitation.id))!;
  assert.deepEqual(left.projects, [], 'the project left the invitation');
  assert.equal(left.revokedAt, undefined, 'its group is still for the invited address');
});

test('switch to an existing account by an admin: groups given, and an invitation left empty is revoked so its link ends', async () => {
  const env = await boot();
  const projectId = await seed(env);
  const admin = await env.user('admin@test');
  await env.store.putLocalGroup({ name: 'team', createdAt: new Date().toISOString() });
  const make = async (id: string, email: string, groups: string[]) => (await env.store.createInvitation({
    id, email, groups, invitedBy: `user:${admin.id}`, createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(), projects: [{ projectId, role: 'viewer', invitedBy: `user:${admin.id}` }], createdVia: 'project',
  })).invitation;
  const olly = await env.user('olly@test');
  const withGroups = await make('inv_g', 'gwen@example.com', ['team']);
  const filed = await fileRequest(env.deps, {
    kind: 'switch', identity: { email: 'olly@test', idp: 'dev', sub: 'dev:olly@test' }, invitationId: withGroups.id, projectId, userId: olly.id,
  });
  const ok = await env.as('admin@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, {});
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.skipped, { projects: [], groups: [] });
  assert.deepEqual((await env.store.getUser(olly.id))?.localGroups, ['team']);

  const vic = await env.user('vic@test');
  const bare = await make('inv_b', 'bea@example.com', []);
  const filedBare = await fileRequest(env.deps, {
    kind: 'switch', identity: { email: 'vic@test', idp: 'dev', sub: 'dev:vic@test' }, invitationId: bare.id, projectId, userId: vic.id,
  });
  const done = await env.as('admin@test', 'POST', `/api/v1/access-requests/${filedBare.request!.id}/approve`, {});
  assert.equal(done.status, 200);
  assert.equal(done.json.outcome, 'already', 'vic already views the project; nothing else on the invitation');
  assert.ok((await env.store.getInvitation(bare.id))?.revokedAt, 'nothing left on a project-made invitation: revoked');
  assert.ok((await env.audits('invite.revoke')).some((e) => e.subject === `invitation:${bare.id}`));
});

test('switch without an account: the invitation moves to the verified address, and that sign-in is admitted and accepted', async () => {
  const env = await boot({}, { gated: true });
  const projectId = await seed(env);
  const invited = await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['tara@example.com'], role: 'editor' });
  assert.equal(invited.status, 200);
  const old = (await env.store.findActiveInvitation('tara@example.com'))!;
  assert.equal((await env.oidcSignIn({ sub: 'g-s2', email: 's2@example.com', name: 'Sue' })).status, 403);

  const filed = await fileRequest(env.deps, {
    kind: 'switch', identity: { email: 's2@example.com', idp: 'primary', sub: 'g-s2', name: 'Sue' }, invitationId: old.id, projectId,
  });
  assert.equal(filed.outcome, 'created');
  assert.equal((await env.as('mona@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, {})).status, 403,
    'a manager without user.invite cannot move an invitation to a new address');
  const ok = await env.as('admin@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'moved');
  assert.equal(ok.json.invitation.email, 's2@example.com');
  const ref = readInviteToken(new URL(ok.json.link).pathname.split('/').pop()!, ['lAsk']);
  assert.equal(ref?.projectId, projectId, 'the link is for the project the request came from');
  assert.match(ok.json.message.text, /sign in as s2@example\.com with Google\.$/);

  assert.ok((await env.store.getInvitation(old.id))?.revokedAt, 'the old invitation is revoked, so its link ends');
  const moved = (await env.store.findActiveInvitation('s2@example.com'))!;
  assert.equal(moved.createdVia, 'request');
  const admin = await env.user('admin@test');
  assert.deepEqual(moved.projects, [{ projectId, role: 'editor', invitedBy: `user:${admin.id}` }], 'now in the approver\'s name');
  const [row] = await env.audits('access.approve');
  assert.deepEqual((row?.payload as { moved: unknown }).moved, { from: old.id, to: moved.id });

  assert.equal((await env.oidcSignIn({ sub: 'g-s2', email: 's2@example.com', name: 'Sue' })).status, 302, 'admitted');
  const sue = (await env.store.findUsersByEmail('s2@example.com'))[0]!;
  assert.equal((await env.store.getInvitation(moved.id))?.acceptedUserId, sue.id, 'accepted');
  assert.equal((await env.store.getProjectMember(projectId, sue.id))?.role, 'editor');
  assert.equal((await env.oidcSignIn({ sub: 'g-tara', email: 'tara@example.com' })).status, 403, 'one invitation never admits two people');
});

test('switch without an admitted account: an address an old account holds still gets the moved invitation', async () => {
  const env = await boot({}, { gated: true });
  const projectId = await seed(env);
  // Sue was let in once; her invitation was revoked since, so she is refused.
  assert.equal((await env.as('admin@test', 'POST', '/api/v1/invitations', { emails: ['s2@example.com'] })).status, 201);
  assert.equal((await env.oidcSignIn({ sub: 'g-s2', email: 's2@example.com' })).status, 302);
  const first = (await env.store.findActiveInvitation('s2@example.com'))!;
  assert.equal((await env.as('admin@test', 'DELETE', `/api/v1/invitations/${first.id}`)).status, 200);
  assert.equal((await env.oidcSignIn({ sub: 'g-s2', email: 's2@example.com' })).status, 403);

  assert.equal((await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['tara@example.com'], role: 'editor' })).status, 200);
  const old = (await env.store.findActiveInvitation('tara@example.com'))!;
  const filed = await fileRequest(env.deps, { kind: 'switch', identity: { email: 's2@example.com', idp: 'primary', sub: 'g-s2' }, invitationId: old.id, projectId });
  const ok = await env.as('admin@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, {});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.outcome, 'moved');
  assert.ok((await env.store.getInvitation(old.id))?.revokedAt);
  assert.equal((await env.oidcSignIn({ sub: 'g-s2', email: 's2@example.com' })).status, 302, 'admitted again');
  const sue = (await env.store.findUsersByEmail('s2@example.com'))[0]!;
  assert.equal((await env.store.getProjectMember(projectId, sue.id))?.role, 'editor', 'with the project the invitation carried');
});

test('switch on an invitation that ended: 409 INVITATION_ENDED and the request ends', async () => {
  const env = await boot();
  const projectId = await seed(env);
  const admin = await env.user('admin@test');
  const { invitation } = await env.store.createInvitation({
    id: 'inv_end', email: 'end@example.com', groups: [], invitedBy: `user:${admin.id}`, createdAt: new Date().toISOString(),
    projects: [{ projectId, role: 'viewer' }], createdVia: 'project',
  });
  const filed = await fileRequest(env.deps, {
    kind: 'switch', identity: { email: 'olly@test', idp: 'dev', sub: 'dev:olly@test' }, invitationId: invitation.id, projectId,
    userId: (await env.user('olly@test')).id,
  });
  await env.store.revokeInvitation(invitation.id, new Date().toISOString());
  const ended = await env.as('admin@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, {});
  assert.equal(ended.status, 409);
  assert.equal(ended.json.error.code, 'INVITATION_ENDED');
  assert.equal((await env.store.getAccessRequest(filed.request!.id))?.status, 'expired');
});

// ── the same on Postgres ────────────────────────────────────────────────────

const pgUrl = process.env.LW_TEST_DATABASE_URL;
test('on Postgres: ask, two answers at once, the answer told, a switch moved', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, () =>
  withFreshPostgres(pgUrl as string, async (store) => {
    const env = await boot({}, { gated: true, store });
    const projectId = await seed(env);
    assert.equal((await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor', note: 'pg' })).status, 202);
    assert.equal((await env.as('olly@test', 'POST', `/api/v1/projects/${projectId}/access-requests`, { role: 'editor' })).status, 202);
    const [open, ...more] = await openRequests(env);
    assert.equal(more.length, 0);
    const both = await Promise.all([
      env.as('mona@test', 'POST', `/api/v1/access-requests/${open!.id}/approve`, { role: 'viewer' }),
      env.as('alice@test', 'POST', `/api/v1/access-requests/${open!.id}/decline`, {}),
    ]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
    const lost = both.find((r) => r.status === 409)!;
    assert.ok(lost.json.request.answeredBy?.name, 'the loser learns who answered');
    assert.equal((await env.inbox('olly@test')).length, 1, 'one answer reaches the asker');
    const mine = (await env.as('olly@test', 'GET', `/api/v1/access-requests/mine?projectId=${projectId}`)).json.requests;
    assert.equal(mine.length, 1);

    const invited = await env.as('admin@test', 'POST', `/api/v1/projects/${projectId}/invite`, { emails: ['tara@example.com'], role: 'editor' });
    assert.equal(invited.status, 200);
    const old = (await store.findActiveInvitation('tara@example.com'))!;
    const filed = await fileRequest(env.deps, { kind: 'switch', identity: { email: 's2@example.com', idp: 'primary', sub: 'g-s2' }, invitationId: old.id, projectId });
    const moved = await env.as('admin@test', 'POST', `/api/v1/access-requests/${filed.request!.id}/approve`, {});
    assert.equal(moved.status, 200);
    assert.equal(moved.json.outcome, 'moved');
    assert.ok((await store.getInvitation(old.id))?.revokedAt);
    assert.equal((await env.oidcSignIn({ sub: 'g-s2', email: 's2@example.com' })).status, 302);
  }));
