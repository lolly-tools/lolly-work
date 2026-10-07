// SPDX-License-Identifier: MPL-2.0
/**
 * The session version routes (plan 76 milestone 4, R2; spec 2.5 and 2.8, rules
 * S-10, S-11, S-19, S-21, S-23 and S-25):
 *
 *   GET    /api/v1/sessions/:id/versions                       viewer+
 *   GET    /api/v1/sessions/:id/versions/:versionId            viewer+
 *   POST   /api/v1/sessions/:id/versions                       editor+, named save
 *   POST   /api/v1/sessions/:id/versions/:versionId/restore    editor+, restore
 *   DELETE /api/v1/sessions/:id/versions/:versionId            manager+
 *
 * One app runs with the collab gateway's `versions` bridge (the long-lived
 * server: every restore goes through a room), one without it (the Vercel
 * function: a compare-and-swap restore). Both use the memory store, and the
 * Postgres driver's version rules are the store conformance suite's subject.
 * Room mechanics (one batch, claims, ceilings) are tests/collab/versions.test.ts's.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createCollabGateway, type CollabGateway } from '../server/src/collab/gateway.ts';
import { hashServiceSecret } from '../server/src/iam/service-tokens.ts';
import type { SessionRecord, Store, UserRecord } from '../server/src/store/types.ts';

const SECRETS = { session: 'versions-route-session', link: 'versions-route-link' };
const PEOPLE = ['alice', 'bob', 'vic', 'mona', 'noname'] as const;
type Person = typeof PEOPLE[number];

interface Harness {
  store: ReturnType<typeof createMemoryStore>;
  base: string;
  server: Server;
  collab?: CollabGateway;
  cookies: Map<Person, string>;
  users: Map<Person, UserRecord>;
}

async function harness(withGateway: boolean, policy: Record<string, unknown> = {}): Promise<Harness> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-version-routes-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', 'design'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design',
    inputs: [{ id: 'title', type: 'text' }, { id: 'locked', type: 'text' }, { id: 'slides', type: 'blocks' }] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Version routes', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    policy,
    dev: { enabled: true, users: [
      { email: 'alice@test', name: 'Alice Owner', groups: ['team'] },
      { email: 'bob@test', name: 'Bob Editor', groups: ['team'] },
      { email: 'vic@test', name: 'Vic Viewer', groups: ['team'] },
      { email: 'mona@test', name: 'Mona Manager', groups: ['team'] },
      { email: 'noname@corp.test', groups: ['team'] },
    ] },
  }));
  const store = createMemoryStore();
  const collab = withGateway ? createCollabGateway({ config, store, secrets: SECRETS }) : undefined;
  const app = buildApp({ config, store, secrets: SECRETS, ...(collab ? { versionRooms: collab.versions } : {}) });
  const server = createServer((req, res) => void app(req, res));
  if (collab) server.on('upgrade', (req, socket, head) => { if (!collab.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookies = new Map<Person, string>();
  const users = new Map<Person, UserRecord>();
  for (const name of PEOPLE) {
    const email = name === 'noname' ? 'noname@corp.test' : `${name}@test`;
    const res = await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    cookies.set(name, res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    users.set(name, (await store.findUsersByEmail(email))[0]!);
  }
  const now = new Date().toISOString();
  const alice = users.get('alice')!;
  await store.putProject({ id: 'prj_v', ownerId: alice.id, name: 'Versions', visibility: 'private', createdAt: now });
  for (const [name, role] of [['bob', 'editor'], ['vic', 'viewer'], ['mona', 'manager'], ['noname', 'editor']] as const) {
    await store.putProjectMember({ projectId: 'prj_v', userId: users.get(name)!.id, role, addedBy: alice.id, addedAt: now });
  }
  return { store, base, server, ...(collab ? { collab } : {}), cookies, users };
}

async function closeHarness(h: Harness): Promise<void> {
  h.collab?.close();
  h.server.closeAllConnections();
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

const call = (h: Harness, who: Person | { bearer: string } | null, method: string, path: string, body?: unknown) => fetch(`${h.base}${path}`, {
  method,
  headers: {
    ...(who === null ? {} : typeof who === 'string' ? { cookie: h.cookies.get(who)! } : { authorization: `Bearer ${who.bearer}` }),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

let requestCounter = 0;
const rid = (): string => `req_${++requestCounter}_${Date.now()}`;

async function sessionIn(h: Harness, id: string, inputs: Record<string, unknown>): Promise<SessionRecord> {
  const alice = h.users.get('alice')!;
  const session: SessionRecord = { id, projectId: 'prj_v', toolId: 'design', toolVersion: '1', inputs, meta: { label: id },
    createdBy: alice.id, updatedBy: alice.id, rev: 1, updatedAt: new Date().toISOString() };
  await h.store.putSession(session);
  return session;
}

interface VersionRow { id: string; kind: string; label?: string; createdBy?: string; createdByName?: string; beforeId?: string; restoredFrom?: string;
  contributors: Array<{ id: string; kind: string; edits: number; name: string }>; inputs?: Record<string, unknown> }

async function save(h: Harness, who: Person, sessionId: string, label = 'Saved', requestId = rid()): Promise<Response> {
  return call(h, who, 'POST', `/api/v1/sessions/${sessionId}/versions`, { label, requestId });
}

async function savedId(h: Harness, sessionId: string, label = 'Saved'): Promise<string> {
  const res = await save(h, 'alice', sessionId, label);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json() as { version: VersionRow }).version.id;
}

const restore = (h: Harness, who: Person, sessionId: string, versionId: string, requestId = rid()) =>
  call(h, who, 'POST', `/api/v1/sessions/${sessionId}/versions/${versionId}/restore`, { requestId });

let live: Harness;
let cas: Harness;
before(async () => { live = await harness(true); cas = await harness(false); });
after(async () => { await closeHarness(live); await closeHarness(cas); });

test('who may do what: viewers read, editors save and restore, managers delete (S-10)', async () => {
  const h = live;
  const s = await sessionIn(h, 'ses_who', { title: 'Draft', locked: 'Approved', slides: [] });
  const other = await sessionIn(h, 'ses_who_other', { title: 'Other' });
  const versionId = await savedId(h, s.id);
  for (const who of ['vic', 'bob', 'mona'] as const) {
    assert.equal((await call(h, who, 'GET', `/api/v1/sessions/${s.id}/versions`)).status, 200, `${who} lists`);
    assert.equal((await call(h, who, 'GET', `/api/v1/sessions/${s.id}/versions/${versionId}`)).status, 200, `${who} reads`);
  }
  const viewerSave = await save(h, 'vic', s.id);
  assert.deepEqual([viewerSave.status, (await viewerSave.json() as { error: { code: string } }).error.code], [403, 'READ_ONLY']);
  const viewerRestore = await restore(h, 'vic', s.id, versionId);
  assert.deepEqual([viewerRestore.status, (await viewerRestore.json() as { error: { code: string } }).error.code], [403, 'READ_ONLY']);
  assert.equal((await call(h, 'bob', 'GET', `/api/v1/sessions/${other.id}/versions/${versionId}`)).status, 404, 'another session\'s version id');
  assert.equal((await restore(h, 'bob', other.id, versionId)).status, 404);
  assert.equal((await call(h, 'bob', 'DELETE', `/api/v1/sessions/${s.id}/versions/${versionId}`)).status, 403, 'an editor cannot delete');

  const project = (await h.store.getProject('prj_v'))!;
  await h.store.putProject({ ...project, archivedAt: new Date().toISOString() });
  try {
    for (const res of [await save(h, 'bob', s.id), await restore(h, 'bob', s.id, versionId)]) {
      assert.deepEqual([res.status, (await res.json() as { error: { code: string } }).error.code], [409, 'PROJECT_ARCHIVED']);
    }
  } finally { await h.store.putProject(project); }

  const deleted = await call(h, 'mona', 'DELETE', `/api/v1/sessions/${s.id}/versions/${versionId}`);
  assert.deepEqual([deleted.status, await deleted.json()], [200, { deleted: true }]);
  assert.equal((await call(h, 'mona', 'DELETE', `/api/v1/sessions/${s.id}/versions/${versionId}`)).status, 404);
  const audit = (await h.store.listAudit()).filter((e) => e.action === 'session.version.delete');
  assert.deepEqual(audit.at(-1)?.payload, { versionId, kind: 'named' });

  await h.store.putSession({ ...(await h.store.getSession(s.id))!, deletedAt: new Date().toISOString() });
  assert.equal((await call(h, 'vic', 'GET', `/api/v1/sessions/${s.id}/versions`)).status, 410);
  assert.equal((await save(h, 'bob', s.id)).status, 410);
});

test('a service token, an outsider and an anonymous caller get nothing (S-19)', async () => {
  const h = live;
  const s = await sessionIn(h, 'ses_tokens', { title: 'Draft' });
  const versionId = await savedId(h, s.id);
  const raw = 'lwt_versions_robot';
  await h.store.putApiToken({ id: 'tok_versions', label: 'robot', role: 'owner', tokenHash: hashServiceSecret(raw), createdBy: 'user:x', createdAt: new Date().toISOString() });
  for (const who of [{ bearer: raw }, null] as const) {
    assert.equal((await call(h, who, 'GET', `/api/v1/sessions/${s.id}/versions`)).status, 401);
    assert.equal((await call(h, who, 'GET', `/api/v1/sessions/${s.id}/versions/${versionId}`)).status, 401);
    assert.equal((await call(h, who, 'POST', `/api/v1/sessions/${s.id}/versions`, { label: 'x', requestId: rid() })).status, 401);
    assert.equal((await call(h, who, 'POST', `/api/v1/sessions/${s.id}/versions/${versionId}/restore`, { requestId: rid() })).status, 401);
    assert.equal((await call(h, who, 'DELETE', `/api/v1/sessions/${s.id}/versions/${versionId}`)).status, 401);
  }
  const project = (await h.store.getProject('prj_v'))!;
  await h.store.deleteProjectMember('prj_v', h.users.get('bob')!.id);
  try {
    assert.equal((await call(h, 'bob', 'GET', `/api/v1/sessions/${s.id}/versions`)).status, 403, 'a person who cannot see the project');
  } finally {
    await h.store.putProjectMember({ projectId: project.id, userId: h.users.get('bob')!.id, role: 'editor', addedBy: project.ownerId, addedAt: new Date().toISOString() });
  }
});

test('a restore through the live room: the response, the two rows, the audit, comments untouched (S-11)', async () => {
  const h = live;
  const s = await sessionIn(h, 'ses_restore', { title: 'Then', locked: 'Approved', slides: [{ id: 's1', heading: 'One' }] });
  const versionId = await savedId(h, s.id, 'Before the rewrite');
  const put = await call(h, 'bob', 'PUT', `/api/v1/sessions/${s.id}`, { rev: 1, inputs: { title: 'Now', locked: 'Approved', slides: [] } });
  assert.equal(put.status, 200);
  const thread = await call(h, 'bob', 'POST', `/api/v1/sessions/${s.id}/comments`, { id: 'thr_restore', messageId: 'msg_restore',
    anchor: { kind: 'canvas', surface: 'main', x: 10, y: 20 }, body: 'Keep this comment' });
  assert.equal(thread.status, 201, await thread.clone().text());
  const readThread = async () => (await call(h, 'bob', 'GET', `/api/v1/sessions/${s.id}/comments/thr_restore`)).json();
  const threadBefore = await readThread();

  const requestId = rid();
  const res = await restore(h, 'bob', s.id, versionId, requestId);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { revision: number; live: boolean; restored: string; before: string; skipped: string[]; vetoed: string[] };
  assert.deepEqual([body.live, body.skipped, body.vetoed], [false, [], []]);
  const stored = (await h.store.getSession(s.id))!;
  assert.deepEqual(stored.inputs, { title: 'Then', locked: 'Approved', slides: [{ id: 's1', heading: 'One' }] });
  assert.equal(body.revision, stored.rev);
  const restoredRow = await h.store.getSessionVersion(s.id, body.restored);
  const beforeRow = await h.store.getSessionVersion(s.id, body.before);
  assert.deepEqual([restoredRow?.kind, restoredRow?.restoredFrom, restoredRow?.beforeId, restoredRow?.createdBy], ['restore', versionId, body.before, h.users.get('bob')!.id]);
  assert.deepEqual([beforeRow?.kind, beforeRow?.inputs.title], ['before', 'Now']);
  assert.deepEqual(restoredRow?.inputs, stored.inputs, 'the restore row records the resulting stored inputs');

  const audit = (await h.store.listAudit()).filter((e) => e.action === 'session.restore');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actor, `user:${h.users.get('bob')!.id}`);
  assert.deepEqual(audit[0]!.payload, { versionId, beforeVersionId: body.before, revision: body.revision, live: false, skipped: 0, vetoed: 0 },
    'ids and counts only');
  const threadAfter = await readThread() as { thread: { messages: Array<{ body: string }> } };
  assert.deepEqual(threadAfter, threadBefore, 'comments are never changed by a restore');
  assert.equal(threadAfter.thread.messages[0]?.body, 'Keep this comment');

  // The same request id answers with the first result and writes nothing more.
  const again = await restore(h, 'bob', s.id, versionId, requestId);
  assert.deepEqual(await again.json(), body);
  assert.equal((await h.store.listSessionVersions(s.id, { limit: 100 })).filter((v) => v.kind === 'restore').length, 1);

  // Undo is restoring the before version.
  const undo = await restore(h, 'bob', s.id, body.before);
  assert.equal(undo.status, 200);
  assert.equal((await h.store.getSession(s.id))!.inputs.title, 'Now');
  assert.equal(h.collab!.rooms(), 0, 'the rooms the restores opened are closed');
});

test('a locked input stays and is vetoed; collab.join denied is 403 (S-19)', async () => {
  for (const h of [live, cas]) {
    const s = await sessionIn(h, 'ses_locked', { title: 'Then', locked: 'Old', slides: [] });
    const versionId = await savedId(h, s.id);
    await h.store.putSession({ ...(await h.store.getSession(s.id))!, inputs: { title: 'Now', locked: 'Approved', slides: [] }, rev: 2 });
    await h.store.putOverlay({ toolId: 'design', version: 1, inputAccess: { locked: [{ groups: ['team'], level: 'locked', value: 'Approved' }] } });
    try {
      const res = await restore(h, 'bob', s.id, versionId);
      assert.equal(res.status, 200, await res.clone().text());
      const body = await res.json() as { vetoed: string[]; skipped: string[] };
      assert.deepEqual(body.vetoed, ['locked'], h.collab ? 'room' : 'compare-and-swap');
      assert.deepEqual([(await h.store.getSession(s.id))!.inputs.title, (await h.store.getSession(s.id))!.inputs.locked], ['Then', 'Approved']);
      const audit = (await h.store.listAudit()).filter((e) => e.action === 'session.restore').at(-1);
      assert.equal(audit?.payload?.vetoed, 1);
    } finally { await h.store.deleteOverlay('design'); }
  }
  const h = live;
  const s = await sessionIn(h, 'ses_nojoin', { title: 'Draft' });
  const versionId = await savedId(h, s.id);
  await h.store.putGrant({ principal: `user:${h.users.get('noname')!.id}`, action: 'collab.join', resource: '*', effect: 'deny' });
  const res = await restore(h, 'noname', s.id, versionId);
  assert.deepEqual([res.status, (await res.json() as { error: { code: string } }).error.code], [403, 'FORBIDDEN']);
  // Without a gateway there is no room to join, so the same person may restore.
  const c = await sessionIn(cas, 'ses_nojoin', { title: 'Draft' });
  const casVersion = await savedId(cas, c.id);
  await cas.store.putGrant({ principal: `user:${cas.users.get('noname')!.id}`, action: 'collab.join', resource: '*', effect: 'deny' });
  assert.equal((await restore(cas, 'noname', c.id, casVersion)).status, 200);
});

test('without a gateway a restore is a compare-and-swap, and refuses while a room holds the session', async () => {
  const h = cas;
  const s = await sessionIn(h, 'ses_cas', { title: 'Then', slides: [{ id: 's1', heading: 'One' }] });
  const versionId = await savedId(h, s.id);
  await h.store.putSession({ ...(await h.store.getSession(s.id))!, inputs: { title: 'Now', slides: [] }, rev: 2 });
  const res = await restore(h, 'bob', s.id, versionId);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { revision: number; live: boolean };
  assert.deepEqual([body.revision, body.live], [3, false]);
  const revisions = await h.store.listSessionRevisions(s.id);
  assert.deepEqual([revisions[0]?.rev, revisions[0]?.actor], [3, h.users.get('bob')!.id], 'attributed to the restorer');

  // Another host's room holds the lease: every attempt loses, and no 'before' row is left behind.
  await h.store.putSession({ ...(await h.store.getSession(s.id))!, inputs: { title: 'Changed again', slides: [] }, rev: 4 });
  assert.equal(await h.store.claimCollab(s.id, 'another-host', 30_000), true);
  try {
    const kinds = async () => (await h.store.listSessionVersions(s.id, { limit: 100 })).map((v) => v.kind).sort();
    const beforeKinds = await kinds();
    const refused = await restore(h, 'bob', s.id, versionId);
    assert.deepEqual([refused.status, (await refused.json() as { error: { code: string } }).error.code], [409, 'SESSION_CHANGED']);
    assert.deepEqual(await kinds(), beforeKinds, 'each lost attempt removed its before row');
  } finally { await h.store.releaseCollab(s.id, 'another-host'); }
});

test('space, limits and rate: VERSION_SPACE, VERSION_LIMIT and 429 (S-21)', async () => {
  const small = await harness(true, { versions: { maxBytes: 2_000 } });
  try {
    const s = await sessionIn(small, 'ses_space', { title: 'x'.repeat(3_000) });
    const res = await save(small, 'alice', s.id);
    assert.deepEqual([res.status, (await res.json() as { error: { code: string } }).error.code], [409, 'VERSION_SPACE']);
  } finally { await closeHarness(small); }

  const h = cas;
  const s = await sessionIn(h, 'ses_limits', { title: 'Draft' });
  const alice = h.users.get('alice')!;
  for (let i = 0; i < 20; i++) {
    const put = await h.store.putSessionVersion({ sessionId: s.id, rev: 1, kind: 'named', label: `v${i}`, inputs: { title: `v${i}` }, meta: {}, contributors: [], createdBy: alice.id });
    assert.ok(typeof put !== 'string');
  }
  const limited = await save(h, 'alice', s.id);
  assert.deepEqual([limited.status, (await limited.json() as { error: { code: string } }).error.code], [409, 'VERSION_LIMIT'], 'the 21st named version by one person');

  const r = await sessionIn(h, 'ses_rate', { title: 'Draft' });
  const statuses: number[] = [];
  let retryAfter: string | null = null;
  for (let i = 0; i < 11; i++) {
    const res = await save(h, 'mona', r.id, `rate ${i}`);
    statuses.push(res.status);
    if (res.status === 429) retryAfter = res.headers.get('retry-after');
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(201));
  assert.equal(statuses[10], 429, 'the 11th save or restore in a minute');
  assert.equal(retryAfter, '60');
  const restoreAfter = await restore(h, 'mona', r.id, 'ver_whatever');
  assert.equal(restoreAfter.status, 429, 'saves and restores share the limit');
});

test('names never carry an email; guests are "Guest"; deleting the session deletes its versions (S-23)', async () => {
  const h = cas;
  const s = await sessionIn(h, 'ses_names', { title: 'Draft' });
  const noname = h.users.get('noname')!;
  const put = await h.store.putSessionVersion({ sessionId: s.id, rev: 1, kind: 'auto', inputs: { title: 'Auto' }, meta: {},
    contributors: [{ id: noname.id, kind: 'user', edits: 3 }, { id: 'lnk_secret_link', kind: 'guest', edits: 2 }, { id: 'agt_missing', kind: 'agent', edits: 1 }] });
  assert.ok(typeof put !== 'string');
  const saved = await save(h, 'noname', s.id, 'By someone without a name');
  assert.equal(saved.status, 201);
  const listed = await call(h, 'vic', 'GET', `/api/v1/sessions/${s.id}/versions`);
  const text = await listed.text();
  assert.equal(text.includes('@'), false, 'no email address anywhere in the listing');
  assert.equal(text.includes('lnk_secret_link'), false, 'no guest link id');
  const { versions } = JSON.parse(text) as { versions: VersionRow[] };
  const auto = versions.find((v) => v.kind === 'auto')!;
  assert.deepEqual(auto.contributors.map((c) => [c.kind, c.id, c.name]), [['user', noname.id, 'noname'], ['guest', 'guest', 'Guest'], ['agent', 'agt_missing', 'Agent']]);
  assert.equal(versions.find((v) => v.kind === 'named')?.createdByName, 'noname');

  const del = await call(h, 'alice', 'DELETE', `/api/v1/sessions/${s.id}`);
  assert.equal(del.status, 200);
  assert.equal(await h.store.getSessionVersion(s.id, put.version.id), null);
  assert.deepEqual(await h.store.listSessionVersions(s.id, { limit: 100 }), []);
});

test('request ids: a named save and a restore with one id are independent; concurrent identical restores make one row (S-25)', async () => {
  const h = live;
  const s = await sessionIn(h, 'ses_ids', { title: 'Then', slides: [] });
  const shared = rid();
  const first = await save(h, 'bob', s.id, 'Shared id', shared);
  assert.equal(first.status, 201);
  const firstId = (await first.json() as { version: VersionRow }).version.id;
  const repeat = await save(h, 'bob', s.id, 'Shared id', shared);
  assert.deepEqual([repeat.status, (await repeat.json() as { version: VersionRow }).version.id], [200, firstId], 'a repeated save answers with its row');
  await h.store.putSession({ ...(await h.store.getSession(s.id))!, inputs: { title: 'Now', slides: [] }, rev: 2 });
  const answers = await Promise.all([restore(h, 'bob', s.id, firstId, shared), restore(h, 'bob', s.id, firstId, shared)]);
  const bodies = await Promise.all(answers.map((r) => r.json()));
  assert.deepEqual(answers.map((r) => r.status), [200, 200]);
  assert.deepEqual(bodies[0], bodies[1], 'both callers get the one result');
  const versions = await h.store.listSessionVersions(s.id, { limit: 100 });
  assert.deepEqual(versions.map((v) => v.kind).sort(), ['before', 'named', 'restore'], 'one restore and one before row, beside the named one');
  const audit = (await h.store.listAudit()).filter((e) => e.subject === `session:${s.id}` && ['session.restore', 'session.version.save'].includes(e.action));
  assert.deepEqual(audit.map((e) => e.action).sort(), ['session.restore', 'session.version.save'], 'one save audited (not its repeat), one restore');
  for (const event of audit) {
    for (const value of Object.values(event.payload ?? {})) assert.ok(['string', 'number', 'boolean'].includes(typeof value), 'scalars only');
    assert.equal(JSON.stringify(event.payload).includes('Then'), false, 'never an input value');
  }
  const saveAudit = audit.find((e) => e.action === 'session.version.save');
  assert.deepEqual(saveAudit?.payload, { versionId: firstId, labelLength: 'Shared id'.length });
});

test('a REST save writes a save version; one that changed nothing adds no row; GET /revisions still answers', async () => {
  const h = cas;
  const s = await sessionIn(h, 'ses_rest', { title: 'Draft' });
  const put = await call(h, 'bob', 'PUT', `/api/v1/sessions/${s.id}`, { rev: 1, inputs: { title: 'Saved over REST' } });
  assert.equal(put.status, 200);
  const again = await call(h, 'bob', 'PUT', `/api/v1/sessions/${s.id}`, { rev: 2, inputs: { title: 'Saved over REST' } });
  assert.equal(again.status, 200);
  const versions = await h.store.listSessionVersions(s.id, { limit: 10 });
  assert.deepEqual(versions.map((v) => [v.kind, v.rev, v.createdBy]), [['save', 2, h.users.get('bob')!.id]], 'the second save is the same content');
  assert.deepEqual(versions[0]!.contributors, [{ id: h.users.get('bob')!.id, kind: 'user', edits: 1 }]);
  const revisions = await call(h, 'bob', 'GET', `/api/v1/sessions/${s.id}/revisions`);
  assert.equal(revisions.status, 200);
  assert.equal((await revisions.json() as { revisions: unknown[] }).revisions.length, 2);
});

test('input validation: labels, request ids, limits and cursors', async () => {
  const h = cas;
  const s = await sessionIn(h, 'ses_validation', { title: 'Draft' });
  for (const body of [{ label: '', requestId: rid() }, { label: 'x'.repeat(121), requestId: rid() }, { label: 'ok' }, { label: 'ok', requestId: 'bad id!' }]) {
    assert.equal((await call(h, 'alice', 'POST', `/api/v1/sessions/${s.id}/versions`, body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await call(h, 'alice', 'POST', `/api/v1/sessions/${s.id}/versions/ver_x/restore`, {})).status, 400);
  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'before=bad%20id']) {
    assert.equal((await call(h, 'alice', 'GET', `/api/v1/sessions/${s.id}/versions?${query}`)).status, 400, query);
  }
  for (let i = 0; i < 3; i++) await h.store.putSessionVersion({ sessionId: s.id, rev: 1, kind: 'named', label: `n${i}`, inputs: { title: `n${i}` }, meta: {}, contributors: [], createdBy: h.users.get('alice')!.id });
  const page = await (await call(h, 'alice', 'GET', `/api/v1/sessions/${s.id}/versions?limit=2`)).json() as { versions: VersionRow[]; before?: string };
  assert.equal(page.versions.length, 2);
  assert.equal(page.before, page.versions[1]!.id);
  const rest = await (await call(h, 'alice', 'GET', `/api/v1/sessions/${s.id}/versions?limit=2&before=${page.before}`)).json() as { versions: VersionRow[]; before?: string };
  assert.deepEqual([rest.versions.length, rest.before], [1, undefined]);
});

/** Keep the type checker honest about the store shape this file relies on. */
export type _StoreUsed = Pick<Store, 'putSessionVersion' | 'listSessionVersions' | 'getSessionVersion'>;
