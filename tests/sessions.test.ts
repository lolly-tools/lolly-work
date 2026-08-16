/**
 * Shared workspaces over real HTTP (plans/08 §6b): project visibility, session
 * CRUD, optimistic rev CAS, tombstones, bounded revisions, and multi-edit
 * (dry-run diff → atomic apply by exact input id, one audit event, grant-gated).
 *
 * Own server + pack (like catalog-lifecycle.test.ts): an admin, two members
 * sharing a group, and one outsider.
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

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-sessions-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Workspace Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'alice@test', name: 'Alice Eng', groups: ['team-eng'] },
        { email: 'bob@test', name: 'Bob Eng', groups: ['team-eng'] },
        { email: 'carol@test', name: 'Carol Design', groups: ['team-design'] },
      ],
    },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's3', link: 'l3' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  assert.ok(cookie, 'session cookie set');
  return cookie.split(';')[0] as string;
}
const json = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

// Shared across tests within the file: the team project + a poster session.
let teamProjectId = '';
let posterSessionId = '';

test('guests/anon are refused (member-only)', async () => {
  assert.equal((await fetch(`${base}/api/v1/projects`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/sessions/anything`)).status, 401);
});

test('project create + visibility: in-group member sees a team project; outsider does not; admin sees all', async () => {
  const alice = await login('alice@test');
  const create = await json(alice, 'POST', '/api/v1/projects', { name: 'Summit 2026', visibility: { groups: ['team-eng'] } });
  assert.equal(create.status, 201);
  const project = await create.json() as { id: string; visibility: unknown; sessionCount: number };
  teamProjectId = project.id;
  assert.deepEqual(project.visibility, { groups: ['team-eng'] });
  assert.equal(project.sessionCount, 0);

  // owner sees it
  const aliceList = await (await json(alice, 'GET', '/api/v1/projects')).json() as { projects: Array<{ id: string }> };
  assert.ok(aliceList.projects.some((p) => p.id === teamProjectId));

  // bob (same group) sees it
  const bob = await login('bob@test');
  const bobList = await (await json(bob, 'GET', '/api/v1/projects')).json() as { projects: Array<{ id: string }> };
  assert.ok(bobList.projects.some((p) => p.id === teamProjectId), 'in-group member sees the team project');

  // carol (other group) does NOT
  const carol = await login('carol@test');
  const carolList = await (await json(carol, 'GET', '/api/v1/projects')).json() as { projects: Array<{ id: string }> };
  assert.ok(!carolList.projects.some((p) => p.id === teamProjectId), 'outsider does not see the team project');
  assert.equal((await json(carol, 'GET', `/api/v1/projects/${teamProjectId}/sessions`)).status, 403);

  // admin sees all
  const admin = await login('admin@test');
  const adminList = await (await json(admin, 'GET', '/api/v1/projects')).json() as { projects: Array<{ id: string }> };
  assert.ok(adminList.projects.some((p) => p.id === teamProjectId), 'admin sees every project');
});

test('session create / get / list', async () => {
  const alice = await login('alice@test');
  const create = await json(alice, 'POST', `/api/v1/projects/${teamProjectId}/sessions`, {
    toolId: 'poster', toolVersion: '1.0.0', inputs: { title: 'Draft', date: '2026-09-01' }, meta: { label: 'Keynote badge' },
  });
  assert.equal(create.status, 201);
  const created = await create.json() as { id: string; rev: number };
  posterSessionId = created.id;
  assert.equal(created.rev, 1);

  // list is WITHOUT inputs
  const list = await (await json(alice, 'GET', `/api/v1/projects/${teamProjectId}/sessions`)).json() as {
    sessions: Array<{ id: string; label: string; rev: number; inputs?: unknown }>;
  };
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0]?.label, 'Keynote badge');
  assert.equal(list.sessions[0]?.inputs, undefined, 'list omits inputs (cheap)');

  // full get carries inputs
  const full = await (await json(alice, 'GET', `/api/v1/sessions/${posterSessionId}`)).json() as {
    inputs: Record<string, unknown>; rev: number; projectId: string;
  };
  assert.deepEqual(full.inputs, { title: 'Draft', date: '2026-09-01' });
  assert.equal(full.rev, 1);

  // project row now reports a session count
  const projects = await (await json(alice, 'GET', '/api/v1/projects')).json() as { projects: Array<{ id: string; sessionCount: number }> };
  assert.equal(projects.projects.find((p) => p.id === teamProjectId)?.sessionCount, 1);
});

test('CAS: two PUTs with the same stale rev — first wins, second 409 with current', async () => {
  const alice = await login('alice@test');
  const first = await json(alice, 'PUT', `/api/v1/sessions/${posterSessionId}`, { rev: 1, inputs: { title: 'Final', date: '2026-09-01' }, meta: { label: 'Keynote badge' } });
  assert.equal(first.status, 200);
  assert.equal((await first.json() as { rev: number }).rev, 2);

  const second = await json(alice, 'PUT', `/api/v1/sessions/${posterSessionId}`, { rev: 1, inputs: { title: 'Clobber' }, meta: {} });
  assert.equal(second.status, 409);
  const conflict = await second.json() as { error: { code: string }; current: { rev: number; inputs: Record<string, unknown> } };
  assert.equal(conflict.error.code, 'CONFLICT');
  assert.equal(conflict.current.rev, 2, 'conflict carries the current server session');
  assert.equal(conflict.current.inputs.title, 'Final', 'the loser did not overwrite the winner');
});

test('revisions grow on edit', async () => {
  const alice = await login('alice@test');
  const revs1 = await (await json(alice, 'GET', `/api/v1/sessions/${posterSessionId}/revisions`)).json() as { revisions: Array<{ rev: number }> };
  assert.equal(revs1.revisions.length, 1, 'one revision after one successful edit');
  assert.equal(revs1.revisions[0]?.rev, 2);

  // another edit (now at rev 2)
  const edit = await json(alice, 'PUT', `/api/v1/sessions/${posterSessionId}`, { rev: 2, inputs: { title: 'Final v2' }, meta: {} });
  assert.equal(edit.status, 200);
  const revs2 = await (await json(alice, 'GET', `/api/v1/sessions/${posterSessionId}/revisions`)).json() as { revisions: Array<{ rev: number }> };
  assert.equal(revs2.revisions.length, 2, 'revisions grew');
  assert.equal(revs2.revisions[0]?.rev, 3, 'newest first');
});

test('tombstone: DELETE then GET 410 and list excludes it', async () => {
  const alice = await login('alice@test');
  // a throwaway session to delete (keep the poster one for later multi-edit)
  const created = await (await json(alice, 'POST', `/api/v1/projects/${teamProjectId}/sessions`, { toolId: 'poster', inputs: {}, meta: { label: 'scratch' } })).json() as { id: string };
  const del = await json(alice, 'DELETE', `/api/v1/sessions/${created.id}`);
  assert.equal(del.status, 200);

  const get = await json(alice, 'GET', `/api/v1/sessions/${created.id}`);
  assert.equal(get.status, 410);
  assert.equal((await get.json() as { error: { code: string } }).error.code, 'SESSION_DELETED');

  const list = await (await json(alice, 'GET', `/api/v1/projects/${teamProjectId}/sessions`)).json() as { sessions: Array<{ id: string }> };
  assert.ok(!list.sessions.some((s) => s.id === created.id), 'tombstoned session excluded from the list');

  // delete is idempotent
  assert.equal((await json(alice, 'DELETE', `/api/v1/sessions/${created.id}`)).status, 200);
});

test('multi-edit: dryRun diffs then apply mutates exactly the set fields, bumps rev, one audit event; non-matching filter is a no-op', async () => {
  const admin = await login('admin@test');
  const alice = await login('alice@test');

  // add a second poster + a flyer so the toolId filter must discriminate
  const poster2 = await (await json(alice, 'POST', `/api/v1/projects/${teamProjectId}/sessions`, {
    toolId: 'poster', inputs: { title: 'Second', date: '2026-10-01' }, meta: { label: 'Second poster' },
  })).json() as { id: string };
  const flyer = await (await json(alice, 'POST', `/api/v1/projects/${teamProjectId}/sessions`, {
    toolId: 'flyer', inputs: { title: 'Flyer', date: '2026-10-01' }, meta: { label: 'A flyer' },
  })).json() as { id: string };

  // dryRun: filter by toolId=poster (2 sessions), set date only
  const dry = await json(admin, 'POST', '/api/v1/sessions/bulk', {
    filter: { toolId: 'poster' }, set: { date: '2026-12-25' }, dryRun: true,
  });
  assert.equal(dry.status, 200);
  const preview = await dry.json() as { matched: number; diffs: Array<{ sessionId: string; before: Record<string, unknown>; after: Record<string, unknown> }> };
  assert.equal(preview.matched, 2, 'both poster sessions matched, flyer excluded');
  assert.ok(preview.diffs.every((d) => d.after.date === '2026-12-25'));
  assert.ok(preview.diffs.some((d) => d.before.date === '2026-10-01'));

  const auditBefore = (await store.listAudit()).length;

  // apply
  const apply = await json(admin, 'POST', '/api/v1/sessions/bulk', { filter: { toolId: 'poster' }, set: { date: '2026-12-25' } });
  assert.equal(apply.status, 200);
  assert.equal((await apply.json() as { applied: number }).applied, 2);

  // poster2: date changed, other fields intact, rev bumped from 1 → 2
  const p2 = await (await json(admin, 'GET', `/api/v1/sessions/${poster2.id}`)).json() as { inputs: Record<string, unknown>; rev: number };
  assert.equal(p2.inputs.date, '2026-12-25', 'set field applied by exact id');
  assert.equal(p2.inputs.title, 'Second', 'unrelated field untouched');
  assert.equal(p2.rev, 2, 'rev bumped');

  // flyer untouched (different toolId)
  const fl = await (await json(admin, 'GET', `/api/v1/sessions/${flyer.id}`)).json() as { inputs: Record<string, unknown>; rev: number };
  assert.equal(fl.inputs.date, '2026-10-01', 'non-matching toolId not touched');
  assert.equal(fl.rev, 1);

  // exactly ONE sessions.bulk audit event, keys only (no values)
  const auditAfter = await store.listAudit();
  const bulkEvents = auditAfter.filter((e) => e.action === 'sessions.bulk');
  assert.equal(bulkEvents.length, 1, 'one bulk audit event for the apply');
  const evt = bulkEvents[0];
  assert.equal(auditAfter.length, auditBefore + 1, 'bulk audits ONE event — not one per session mutated');
  assert.deepEqual(evt?.payload?.keys, ['date']);
  assert.equal(evt?.payload?.matched, 2);
  assert.equal(evt?.payload?.toolId, 'poster');
  assert.ok(!JSON.stringify(evt?.payload).includes('2026-12-25'), 'audit never carries input values');

  // non-matching toolId filter touches nothing
  const none = await json(admin, 'POST', '/api/v1/sessions/bulk', { filter: { toolId: 'no-such-tool' }, set: { date: 'x' } });
  assert.equal((await none.json() as { applied: number }).applied, 0);
});

// ── write-path CAS integrity (plans/23 §3.B) ───────────────────────────────────
// These three drive the races deterministically by briefly patching the shared
// memory store - a latch or a stale snapshot, never a sleep - because the whole
// point is the await-gap BETWEEN a handler's read and its write.

test('two truly concurrent PUTs at the same rev: exactly one 200, one 409, one revision — history and inputs agree', async () => {
  const alice = await login('alice@test');
  const bob = await login('bob@test');
  const created = await (await json(alice, 'POST', `/api/v1/projects/${teamProjectId}/sessions`, {
    toolId: 'poster', inputs: { title: 'Racing' }, meta: { label: 'race' },
  })).json() as { id: string; rev: number };

  // Latch getSession so NEITHER handler reaches its casSession until BOTH have
  // read rev 1 - the scheduler can no longer save the second writer by letting
  // the first finish early, which is what makes the race deterministic. Only
  // the first two reads are latched: the loser re-reads after its CAS refusal
  // (that is the fix under test) and must pass straight through.
  const real = store.getSession.bind(store);
  let parked: (() => void) | null = null;
  let latched = 0;
  store.getSession = async (id: string) => {
    if (id === created.id && latched < 2) {
      latched += 1;
      if (latched === 1) await new Promise<void>((r) => { parked = r; });
      else parked?.();
    }
    return real(id);
  };
  try {
    const [a, b] = await Promise.all([
      json(alice, 'PUT', `/api/v1/sessions/${created.id}`, { rev: 1, inputs: { title: 'Alice won' }, meta: { label: 'race' } }),
      json(bob, 'PUT', `/api/v1/sessions/${created.id}`, { rev: 1, inputs: { title: 'Bob won' }, meta: { label: 'race' } }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409], 'exactly one writer lands; the other is refused, not silently discarded');
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    const won = await winner.json() as { rev: number; inputs: Record<string, unknown> };
    assert.equal(won.rev, 2);
    const conflict = await loser.json() as { error: { code: string }; current: { rev: number; inputs: Record<string, unknown> } };
    assert.equal(conflict.error.code, 'CONFLICT');
    assert.deepEqual(conflict.current.inputs, won.inputs, 'the 409 carries the winner, so the loser can rebase');

    const revs = await store.listSessionRevisions(created.id);
    const rev2 = revs.filter((r) => r.rev === 2);
    assert.equal(rev2.length, 1, 'one revision row for rev 2 — never two writers sharing a rev');
    assert.deepEqual(rev2[0]?.inputs, won.inputs, 'history agrees with sessions.inputs');
  } finally {
    store.getSession = real;
  }
});

test('bulk racing a single PUT: the PUT survives and bulk reports the session as skipped', async () => {
  const admin = await login('admin@test');
  const alice = await login('alice@test');
  const created = await (await json(alice, 'POST', `/api/v1/projects/${teamProjectId}/sessions`, {
    toolId: 'racer', inputs: { title: 'Original', date: '2026-01-01' }, meta: { label: 'bulk race' },
  })).json() as { id: string; rev: number };

  // Interleave deterministically: bulk's matched list is a snapshot, so land a
  // full PUT AFTER bulk has read it but BEFORE bulk writes - inside the
  // listSessionsFiltered call itself.
  const real = store.listSessionsFiltered.bind(store);
  store.listSessionsFiltered = async (filter: Parameters<typeof real>[0]) => {
    const snapshot = await real(filter);
    store.listSessionsFiltered = real; // once - the PUT below must see the real store
    const put = await json(alice, 'PUT', `/api/v1/sessions/${created.id}`, { rev: 1, inputs: { title: 'Edited meanwhile', date: '2026-01-01' }, meta: { label: 'bulk race' } });
    assert.equal(put.status, 200);
    return snapshot;
  };
  try {
    const res = await json(admin, 'POST', '/api/v1/sessions/bulk', { filter: { toolId: 'racer' }, set: { date: '2026-12-25' } });
    assert.equal(res.status, 200);
    const out = await res.json() as { applied: number; skipped: Array<{ sessionId: string; rev: number }> };
    assert.equal(out.applied, 0, 'the stale snapshot must not be written over the fresh edit');
    assert.deepEqual(out.skipped, [{ sessionId: created.id, rev: 1 }], 'the loser is reported so the operator can re-run');

    const after = await (await json(alice, 'GET', `/api/v1/sessions/${created.id}`)).json() as { inputs: Record<string, unknown>; rev: number };
    assert.equal(after.inputs.title, 'Edited meanwhile', "the concurrent PUT's write survives the sweep");
    assert.equal(after.rev, 2, 'no blind bump on top of the PUT');
  } finally {
    store.listSessionsFiltered = real;
  }
});

test('a PUT that loses its race to a DELETE gets 410, and the tombstone is never resurrected', async () => {
  const alice = await login('alice@test');
  const created = await (await json(alice, 'POST', `/api/v1/projects/${teamProjectId}/sessions`, {
    toolId: 'poster', inputs: { title: 'Doomed' }, meta: { label: 'tombstone race' },
  })).json() as { id: string };

  // The handler's first read sees the session alive (a stale pre-DELETE
  // snapshot); the CAS then refuses (the stored row is tombstoned) and the
  // re-read must answer 410 - not 409, and never a resurrected row.
  const live = await store.getSession(created.id);
  assert.ok(live);
  assert.equal((await json(alice, 'DELETE', `/api/v1/sessions/${created.id}`)).status, 200);
  const real = store.getSession.bind(store);
  let served = false;
  store.getSession = async (id: string) => {
    if (id === created.id && !served) { served = true; return live; }
    return real(id);
  };
  try {
    const put = await json(alice, 'PUT', `/api/v1/sessions/${created.id}`, { rev: 1, inputs: { title: 'Zombie' }, meta: {} });
    assert.equal(put.status, 410);
    assert.equal((await put.json() as { error: { code: string } }).error.code, 'SESSION_DELETED');
  } finally {
    store.getSession = real;
  }
  const stored = await store.getSession(created.id);
  assert.ok(stored?.deletedAt, 'the tombstone stands');
  assert.equal(stored?.inputs.title, 'Doomed', 'the losing write never landed');
});

test('conflicts are instrumented: session.conflict audited values-free, and stats/overview folds refusals + bulk skips into conflicts30d', async () => {
  // By this point in the file exactly three conflicts have occurred: the stale
  // 409 in the early-CAS test, the concurrent-PUT race loser, and the bulk
  // sweep's one skipped session (the tombstone race is a deletion, not a
  // conflict). The fold is the plans/14 §9 gate instrument (plans/23 §3.D).
  const conflicts = (await store.listAudit()).filter((e) => e.action === 'session.conflict');
  assert.equal(conflicts.length, 2, 'each refused PUT audits one session.conflict');
  for (const e of conflicts) {
    assert.match(e.subject, /^session:/);
    assert.equal(typeof e.payload?.rev, 'number');
    assert.equal(typeof e.payload?.sentRev, 'number');
    const flat = JSON.stringify(e.payload);
    for (const leaked of ['Clobber', 'Alice won', 'Bob won']) {
      assert.ok(!flat.includes(leaked), 'a conflict event never carries input values');
    }
  }

  const admin = await login('admin@test');
  const stats = await (await json(admin, 'GET', '/api/v1/stats/overview')).json() as { sessions: { conflicts30d: number } };
  assert.equal(stats.sessions.conflicts30d, 3, 'two refused PUTs + one bulk skip');
});

test('stats/series: zero-filled day buckets of audit-action counts — clamped span, counts only, dashboard-tier', async () => {
  // Members without telemetry.view get 403 - the console header hides itself.
  const alice = await login('alice@test');
  assert.equal((await json(alice, 'GET', '/api/v1/stats/series')).status, 403);

  const admin = await login('admin@test');
  const wide = await json(admin, 'GET', '/api/v1/stats/series?days=1000');
  assert.equal(wide.status, 200);
  const { days } = await wide.json() as { days: Array<{ date: string; counts: Record<string, number> }> };
  assert.equal(days.length, 90, 'span clamps to 90');
  const today = days[days.length - 1]!;
  assert.equal(today.date, new Date().toISOString().slice(0, 10), 'the window ends today');
  assert.ok(days.every((d) => d.counts && typeof d.counts === 'object'), 'every day is a real bucket, quiet days included');
  assert.ok((today.counts['session.conflict'] ?? 0) >= 2, "this file's own conflicts fold into today's bucket");
  const flat = JSON.stringify(days);
  assert.ok(!flat.includes('Alice won') && !flat.includes('admin@test') && !flat.includes('session:'),
    'counts only — never values, actors, or subjects');
  const narrow = await (await json(admin, 'GET', '/api/v1/stats/series?days=2')).json() as { days: unknown[] };
  assert.equal(narrow.days.length, 7, 'span clamps up to 7');
});

test('grant gate: a plain member cannot bulk-edit without project.manage → 403', async () => {
  const alice = await login('alice@test'); // member: has session.edit, NOT project.manage
  const res = await json(alice, 'POST', '/api/v1/sessions/bulk', { filter: { toolId: 'poster' }, set: { date: 'x' }, dryRun: true });
  assert.equal(res.status, 403);
});

// ── Interim deprovisioning + configurable session TTL (plan Rec 6) ─────────────

test('disabled member: an existing session is refused within one request', async () => {
  const alice = await login('alice@test');
  assert.equal((await json(alice, 'GET', '/api/v1/projects')).status, 200);
  const aliceId = (await store.listUsers()).find((u) => u.email === 'alice@test')!.id;
  await store.setUserDisabled(aliceId, new Date().toISOString());
  // Same still-unexpired cookie - the disable takes effect immediately (memberOf gate).
  assert.equal((await json(alice, 'GET', '/api/v1/projects')).status, 401);
  const sess = await fetch(`${base}/api/auth/session`, { headers: { cookie: alice } });
  assert.equal(sess.status, 401);
  // Disable also bumped the session epoch, so re-enabling does NOT revive the
  // old cookie (it was revoked, not merely gated) - a fresh login works.
  await store.setUserDisabled(aliceId, null);
  assert.equal((await json(alice, 'GET', '/api/v1/projects')).status, 401);
  const fresh = await login('alice@test');
  assert.equal((await json(fresh, 'GET', '/api/v1/projects')).status, 200);
});

test('disabled admin: RBAC routes reject via memberOf (401, before RBAC 403)', async () => {
  const admin = await login('admin@test');
  assert.equal((await json(admin, 'GET', '/api/v1/audit')).status, 200);
  const adminId = (await store.listUsers()).find((u) => u.email === 'admin@test')!.id;
  await store.setUserDisabled(adminId, new Date().toISOString());
  assert.equal((await json(admin, 'GET', '/api/v1/audit')).status, 401); // not 403
  await store.setUserDisabled(adminId, null); // re-enable so later tests can log in
});

test('session cookie Max-Age reflects the configured sessionTtlHours', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-ttl-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'TTL', baseUrl: 'http://localhost', pack },
    policy: { sessionTtlHours: 3 },
    dev: { enabled: true, users: [{ email: 'x@test', name: 'X', groups: [] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 's', link: 'l' } });
  const srv = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => srv.listen(0, () => r()));
  const addr = srv.address();
  const b = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const res = await fetch(`${b}/api/auth/dev?email=x@test`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!;
  const maxAge = /Max-Age=(\d+)/.exec(cookie)?.[1];
  assert.equal(maxAge, String(3 * 3600));
  srv.close();
});
