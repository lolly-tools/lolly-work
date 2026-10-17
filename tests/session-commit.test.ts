// SPDX-License-Identifier: MPL-2.0
/**
 * Every writer of a stored session goes through the commit service (plan 221,
 * store `commitSessionRevision`): PUT, bulk edits, a restore without a live
 * room, and a room's write-back and crash recovery. The store here refuses the
 * separate `casSession` and `appendSessionRevision` calls those writers used to
 * make, so a writer that bypassed the service would fail. A commit that fails
 * leaves no head, revision or version behind. The store's own rules are the
 * conformance suite's (tests/store-conformance.ts).
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
import { createRoomPersistence } from '../server/src/collab/persistence.ts';
import type { SessionRevisionCommit, SessionRevisionCommitResult, Store } from '../server/src/store/types.ts';

let server: Server;
let base = '';
const raw = createMemoryStore();
const commits: SessionRevisionCommit[] = [];
/** Throws instead of committing while set. */
let failCommits = false;
const bypassed = (name: string) => async (): Promise<never> => { throw new Error(`${name} bypassed commitSessionRevision`); };
const store: Store = new Proxy(raw, {
  get(target, key, receiver) {
    if (key === 'casSession') return bypassed('casSession');
    if (key === 'appendSessionRevision') return bypassed('appendSessionRevision');
    if (key === 'commitSessionRevision') {
      return async (commit: SessionRevisionCommit): Promise<SessionRevisionCommitResult> => {
        commits.push(commit);
        if (failCommits) throw new Error('database unavailable');
        return target.commitSessionRevision(commit);
      };
    }
    return Reflect.get(target, key, receiver);
  },
});

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-session-commit-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', 'commit-restore'), { recursive: true });
  await writeFile(join(pack, 'tools', 'commit-restore', 'tool.json'), JSON.stringify({ id: 'commit-restore', inputs: [{ id: 'title', type: 'text' }] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Commit service', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    policy: { activity: { auditSessionUpdates: true } },
    dev: { enabled: true, users: [
      { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
      { email: 'alice@test', name: 'Alice Eng', groups: ['team-eng'] },
    ] },
  }));
  const app = buildApp({ config, store, secrets: { session: 'commit-session', link: 'commit-link' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => { server.closeAllConnections(); server.close(); });

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const call = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
});

let projectId = '';
async function sessionFor(alice: string, toolId: string, inputs: Record<string, unknown>): Promise<string> {
  if (!projectId) {
    const res = await call(alice, 'POST', '/api/v1/projects', { name: 'Commits', visibility: { groups: ['team-eng'] } });
    assert.equal(res.status, 201);
    projectId = (await res.json() as { id: string }).id;
  }
  const res = await call(alice, 'POST', `/api/v1/projects/${projectId}/sessions`, { toolId, inputs, meta: { label: toolId } });
  assert.equal(res.status, 201);
  return (await res.json() as { id: string }).id;
}

test('a PUT commits the head, its revision, a save version and its audit event together', async () => {
  const alice = await login('alice@test');
  const id = await sessionFor(alice, 'commit-put', { title: 'Draft' });
  const aliceId = (await raw.findUsersByEmail('alice@test'))[0]!.id;
  commits.length = 0;
  const put = await call(alice, 'PUT', `/api/v1/sessions/${id}`, { rev: 1, inputs: { title: 'Saved' } });
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal(commits.length, 1, 'one commit');
  assert.deepEqual([commits[0]!.expectedRev, commits[0]!.version?.kind, commits[0]!.audit?.action], [1, 'save', 'session.update']);
  assert.deepEqual((await raw.listSessionRevisions(id)).map((r) => [r.rev, r.inputs, r.actor]), [[2, { title: 'Saved' }, aliceId]]);
  const versions = await raw.listSessionVersions(id, { limit: 10 });
  assert.deepEqual(versions.map((v) => [v.kind, v.rev, v.createdBy]), [['save', 2, aliceId]]);
  const audited = (await raw.listAudit()).filter((e) => e.action === 'session.update' && e.subject === `session:${id}`);
  assert.deepEqual(audited.map((e) => e.payload?.rev), [2]);
});

test('a PUT whose commit fails answers 500 and leaves no head, revision, version or audit event', async () => {
  const alice = await login('alice@test');
  const id = await sessionFor(alice, 'commit-fail', { title: 'Draft' });
  const audit = (await raw.listAudit()).length;
  failCommits = true;
  try {
    const put = await call(alice, 'PUT', `/api/v1/sessions/${id}`, { rev: 1, inputs: { title: 'Lost' } });
    assert.equal(put.status, 500);
  } finally { failCommits = false; }
  const stored = await raw.getSession(id);
  assert.deepEqual([stored?.rev, stored?.inputs], [1, { title: 'Draft' }]);
  assert.deepEqual(await raw.listSessionRevisions(id), []);
  assert.deepEqual(await raw.listSessionVersions(id, { limit: 10 }), []);
  assert.equal((await raw.listAudit()).length, audit);
});

test('a bulk edit commits a revision and a save version with each session it changes, and audits once', async () => {
  const admin = await login('admin@test');
  const alice = await login('alice@test');
  const ids = [await sessionFor(alice, 'commit-bulk', { title: 'One', date: '2026-01-01' }), await sessionFor(alice, 'commit-bulk', { title: 'Two', date: '2026-01-01' })];
  const adminId = (await raw.findUsersByEmail('admin@test'))[0]!.id;
  const audit = (await raw.listAudit()).length;
  commits.length = 0;
  const res = await call(admin, 'POST', '/api/v1/sessions/bulk', { filter: { toolId: 'commit-bulk' }, set: { date: '2026-12-25' } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { applied: 2, skipped: [] });
  assert.equal(commits.length, 2, 'one commit per session');
  for (const id of ids) {
    const [revision] = await raw.listSessionRevisions(id);
    assert.deepEqual([revision?.rev, revision?.inputs.date, revision?.actor], [2, '2026-12-25', adminId], id);
    const versions = await raw.listSessionVersions(id, { limit: 10 });
    assert.deepEqual(versions.map((v) => [v.kind, v.rev, v.createdBy, v.contributors]), [['save', 2, adminId, [{ id: adminId, kind: 'user', edits: 1 }]]], id);
    assert.equal((await raw.getSessionVersion(id, versions[0]!.id))?.inputs.date, '2026-12-25');
  }
  const added = (await raw.listAudit()).slice(audit);
  assert.deepEqual(added.map((e) => e.action), ['sessions.bulk'], 'one event for the sweep');
});

test('a restore without a live room commits the document with its revision, restore row and audit event', async () => {
  const alice = await login('alice@test');
  const id = await sessionFor(alice, 'commit-restore', { title: 'Then' });
  const saved = await call(alice, 'POST', `/api/v1/sessions/${id}/versions`, { label: 'Then', requestId: 'commit-save-1' });
  assert.equal(saved.status, 201, await saved.clone().text());
  const versionId = (await saved.json() as { version: { id: string } }).version.id;
  assert.equal((await call(alice, 'PUT', `/api/v1/sessions/${id}`, { rev: 1, inputs: { title: 'Now' } })).status, 200);
  commits.length = 0;
  const res = await call(alice, 'POST', `/api/v1/sessions/${id}/versions/${versionId}/restore`, { requestId: 'commit-restore-1' });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { revision: number; restored: string | null; before: string };
  assert.equal(commits.length, 1, 'one commit');
  assert.deepEqual([commits[0]!.version?.kind, commits[0]!.version?.requestId, commits[0]!.audit?.action], ['restore', 'commit-restore-1', 'session.restore']);
  assert.deepEqual([(await raw.getSession(id))?.inputs, body.revision], [{ title: 'Then' }, 3]);
  assert.deepEqual((await raw.listSessionRevisions(id)).map((r) => [r.rev, r.inputs.title]), [[3, 'Then'], [2, 'Now']]);
  const row = await raw.getSessionVersion(id, body.restored!);
  assert.deepEqual([row?.kind, row?.rev, row?.restoredFrom, row?.beforeId], ['restore', 3, versionId, body.before]);
  const audited = (await raw.listAudit()).filter((e) => e.action === 'session.restore' && e.subject === `session:${id}`);
  assert.equal(audited.length, 1, 'audited once, in the commit');
  assert.deepEqual(audited[0]?.payload, { versionId, beforeVersionId: body.before, revision: 3, live: false, skipped: 0, vetoed: 0 });

  // The same request again answers with the first result and commits nothing.
  commits.length = 0;
  const again = await call(alice, 'POST', `/api/v1/sessions/${id}/versions/${versionId}/restore`, { requestId: 'commit-restore-1' });
  assert.deepEqual(await again.json(), body);
  assert.equal(commits.length, 0);
});

test('a room\'s write-back and crash recovery commit their revision and audit event together', async () => {
  const alice = await login('alice@test');
  const id = await sessionFor(alice, 'commit-room', { title: 'Before', accent: '#000000' });
  const aliceId = (await raw.findUsersByEmail('alice@test'))[0]!.id;
  const persistence = createRoomPersistence({ store });
  commits.length = 0;
  const quiesced = await persistence.quiesce(id, { toInputs: (stored) => ({ ...stored, title: 'From the room' }) },
    { ops: 1, writers: [{ kind: 'member', userId: aliceId }], baseRev: 1 });
  assert.deepEqual(quiesced, { written: true, rev: 2 });
  assert.deepEqual([commits.length, commits[0]?.audit?.action, commits[0]?.audit?.payload?.rev], [1, 'collab.quiesce', 2]);
  assert.deepEqual((await raw.listSessionRevisions(id)).map((r) => [r.rev, r.inputs.title, r.actor]), [[2, 'From the room', aliceId]]);

  // A snapshot that outlived its room is a write-back a crash lost: hydrating commits it.
  const current = (await raw.getSession(id))!;
  await raw.putCollabSnapshot({ sessionId: id, inputs: { ...current.inputs, title: 'Recovered' }, baseRev: current.rev, ops: 3, updatedAt: new Date().toISOString() });
  commits.length = 0;
  const hydrated = await persistence.hydrate(current);
  assert.deepEqual([hydrated.recovered, hydrated.rev, hydrated.inputs.title], [true, 3, 'Recovered']);
  assert.deepEqual([commits.length, commits[0]?.audit?.action, commits[0]?.actor], [1, 'collab.recover', 'collab']);
  assert.deepEqual((await raw.listSessionRevisions(id)).map((r) => r.rev), [3, 2]);
  assert.equal(await raw.getCollabSnapshot(id), null);
});
