// SPDX-License-Identifier: MPL-2.0
/**
 * Versions of live documents (plan 76 milestone 4, R2; spec 2.8, rules S-11 and
 * S-20): how a room turns accepted batches into automatic and closing versions,
 * and how a saved version is restored through the room.
 *
 *   - the recorder writes `auto` 120 s after the last change, or 600 s into a
 *     run of continuous changes, and `close` when the room closes, each from the
 *     durable session row and with the people who edited since the last one;
 *   - a restore runs on the room's document queue: an edit queued before it is
 *     in its 'before' version, the restore commits as ONE batch that every peer
 *     receives and converges on, editing claims are cancelled, and a restore
 *     that would pass a ceiling commits nothing (RESTORE_INCOMPLETE);
 *   - through the gateway's `versions` bridge, a restore opens the room when
 *     none is open and closes it again, and passes the restoring person's own
 *     write checks (an observer is refused, a locked input is vetoed).
 *
 * The HTTP routes, idempotency, audit and the no-gateway path are
 * tests/version-restore.test.ts's subject.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { CANVAS_OP_VERSION, ReferenceCanvasDoc, type CanvasCheckpoint, type CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { parseConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import type { SessionRecord, SessionVersion, Store, UserRecord } from '../../server/src/store/types.ts';
import { MAX_BOXES_PER_COLLECTION, Room, RoomRestoreError, type RoomMember, type ServerFrame } from '../../server/src/collab/rooms.ts';
import { createCollabGateway, COLLAB_WS_PREFIX, type CollabGateway } from '../../server/src/collab/gateway.ts';
import { buildApp } from '../../server/src/api/app.ts';
import { createVersionRecorder, VERSION_IDLE_MS, VERSION_INTERVAL_MS, type RecorderTimers } from '../../server/src/versions/recorder.ts';
import { RestoreError, type RestoreBefore } from '../../server/src/versions/restore.ts';

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A clock the test owns: timers fire only when `advance` passes them. */
function manualTimers(): { timers: RecorderTimers; advance(ms: number): void } {
  let now = 0;
  let next = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      set(fn, ms) { const id = ++next; due.set(id, { at: now + ms, fn }); return id; },
      clear(id) { due.delete(id as number); },
    },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const first = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!first) break;
        due.delete(first[0]);
        now = first[1].at;
        first[1].fn();
      }
      now = end;
    },
  };
}

async function documentOf(store: Store, tag: string, inputs: Record<string, unknown>): Promise<{ session: SessionRecord; user: UserRecord }> {
  const user = await store.upsertUserBySub({ sub: `versions-${tag}`, email: `${tag}@versions.test`, firstname: 'Vera', groups: [], role: 'member' });
  const now = new Date().toISOString();
  await store.putProject({ id: `prj_${tag}`, name: tag, visibility: 'private', ownerId: user.id, createdAt: now });
  const session: SessionRecord = { id: `ses_${tag}`, projectId: `prj_${tag}`, toolId: 'design', toolVersion: '1', inputs, meta: { label: tag },
    createdBy: user.id, updatedBy: user.id, rev: 1, updatedAt: now };
  await store.putSession(session);
  return { session, user };
}

const seat = (id: string, userId: string, extra: Partial<RoomMember> = {}): RoomMember & { sent: ServerFrame[] } => {
  const sent: ServerFrame[] = [];
  return { id, userId, name: id, role: 'writer', opVersion: CANVAS_OP_VERSION, send: (frame) => { sent.push(frame); }, sent, ...extra };
};

const param = (key: string, value: string, client: string, clock: number): CanvasOp => ({ k: 'param', key, value, origin: { client, clock } });

/** Let queued promise work (store writes) settle without moving any timer. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

// ── the recorder ──────────────────────────────────────────────────────────────

test('an automatic version comes 120 s after the last change, with each principal counted once', async () => {
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'idle', { title: 'Draft' });
  const clock = manualTimers();
  const recorder = createVersionRecorder({ store, sessionId: session.id, timers: clock.timers });
  recorder.touch({ kind: 'member', userId: user.id });
  clock.advance(60_000);
  recorder.touch({ kind: 'member', userId: user.id });
  recorder.touch({ kind: 'agent', agentId: 'agt_1', userId: user.id });
  recorder.touch({ kind: 'guest', linkId: 'lnk_a' });
  recorder.touch({ kind: 'guest', linkId: 'lnk_b' });
  clock.advance(VERSION_IDLE_MS - 1);
  await recorder.flush();
  assert.deepEqual(await store.listSessionVersions(session.id, { limit: 10 }), [], 'not before the idle time has passed');
  clock.advance(1);
  await recorder.flush();
  const [auto] = await store.listSessionVersions(session.id, { limit: 10 });
  assert.equal(auto?.kind, 'auto');
  assert.equal(auto.rev, session.rev);
  assert.deepEqual(auto.contributors, [
    { id: 'guest', kind: 'guest', edits: 2 },
    { id: user.id, kind: 'user', edits: 2 },
    { id: 'agt_1', kind: 'agent', edits: 1 },
  ], 'guests together as one entry with no link id; most edits first');
  assert.deepEqual((await store.getSessionVersion(session.id, auto.id))?.inputs, session.inputs, 'content is the durable row');
  assert.equal(recorder.pending, false);
});

test('continuous changes still get a version every 600 s, and nothing more often', async () => {
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'interval', { title: 'v0' });
  const clock = manualTimers();
  const recorder = createVersionRecorder({ store, sessionId: session.id, timers: clock.timers });
  for (let minute = 0; minute < 10; minute++) {
    await store.putSession({ ...session, inputs: { title: `v${minute + 1}` }, rev: session.rev + minute + 1 });
    recorder.touch({ kind: 'member', userId: user.id });
    clock.advance(60_000);
  }
  await recorder.flush();
  let versions = await store.listSessionVersions(session.id, { limit: 10 });
  assert.equal(versions.length, 1, `one automatic version at ${VERSION_INTERVAL_MS / 1000} s although the idle timer never fired`);
  assert.deepEqual([versions[0]!.rev, versions[0]!.contributors[0]!.edits], [session.rev + 10, 10]);
  // The next run starts with the next change, not with the last version.
  clock.advance(VERSION_INTERVAL_MS);
  await recorder.flush();
  assert.equal((await store.listSessionVersions(session.id, { limit: 10 })).length, 1, 'no change, no version');
  await store.putSession({ ...session, inputs: { title: 'later' }, rev: session.rev + 11 });
  recorder.touch({ kind: 'member', userId: user.id });
  clock.advance(VERSION_IDLE_MS);
  await recorder.flush();
  versions = await store.listSessionVersions(session.id, { limit: 10 });
  assert.deepEqual(versions.map((v) => v.rev), [session.rev + 11, session.rev + 10]);
});

test('closing writes the pending changes as a close version, once; unchanged content adds no row', async () => {
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'close', { title: 'Draft' });
  const clock = manualTimers();
  const recorder = createVersionRecorder({ store, sessionId: session.id, timers: clock.timers });
  await recorder.close();
  assert.deepEqual(await store.listSessionVersions(session.id, { limit: 10 }), [], 'nothing pending, nothing written');

  const second = createVersionRecorder({ store, sessionId: session.id, timers: clock.timers });
  second.touch({ kind: 'member', userId: user.id });
  await second.close();
  await second.close();
  second.touch({ kind: 'member', userId: user.id });
  clock.advance(VERSION_INTERVAL_MS);
  await second.flush();
  const versions = await store.listSessionVersions(session.id, { limit: 10 });
  assert.deepEqual(versions.map((v) => v.kind), ['close'], 'one close version; a stopped recorder writes nothing more');

  // Same content as the latest version: the store answers with that version.
  const third = createVersionRecorder({ store, sessionId: session.id, timers: clock.timers });
  third.touch({ kind: 'member', userId: user.id });
  clock.advance(VERSION_IDLE_MS);
  await third.flush();
  assert.equal((await store.listSessionVersions(session.id, { limit: 10 })).length, 1, 'digest dedupe');
});

test('a failed version write keeps its contributors; a deleted document gets none', async () => {
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'failing', { title: 'Draft' });
  const clock = manualTimers();
  let failures = 1;
  const errors: unknown[] = [];
  const flaky: Store = { ...store, async putSessionVersion(v) {
    if (failures-- > 0) throw new Error('database unavailable');
    return store.putSessionVersion(v);
  } };
  const recorder = createVersionRecorder({ store: flaky, sessionId: session.id, timers: clock.timers, onError: (e) => errors.push(e) });
  recorder.touch({ kind: 'member', userId: user.id });
  clock.advance(VERSION_IDLE_MS);
  await recorder.flush();
  assert.equal(errors.length, 1);
  assert.equal(recorder.pending, true, 'the changes are still waiting for a version');
  recorder.touch({ kind: 'agent', agentId: 'agt_2', userId: user.id });
  clock.advance(VERSION_IDLE_MS);
  await recorder.flush();
  const [auto] = await store.listSessionVersions(session.id, { limit: 10 });
  assert.deepEqual(auto?.contributors.map((c) => [c.kind, c.id, c.edits]), [['agent', 'agt_2', 1], ['user', user.id, 1]]);

  await store.putSession({ ...session, deletedAt: new Date().toISOString() });
  recorder.touch({ kind: 'member', userId: user.id });
  await recorder.close();
  assert.equal(errors.length, 1, 'a deleted document is skipped, not an error');
  assert.equal((await store.listSessionVersions(session.id, { limit: 10 })).length, 1);
});

// ── a store-backed room ───────────────────────────────────────────────────────

test('a live room writes an auto version after the idle time and a close version when it closes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'room', { title: 'Draft' });
  const room = await Room.open(session, undefined, store);
  const alice = seat('alice', user.id);
  room.join(alice);
  await room.applyBatch(alice, 'b1', ['op1'], [param('title', 'refused', 'alice', 1)], new Set());
  const first = param('title', 'first', 'alice', 2);
  await room.applyBatch(alice, 'b2', ['op2'], [first], new Set([first]));
  t.mock.timers.tick(VERSION_IDLE_MS);
  await settle();
  let versions = await store.listSessionVersions(session.id, { limit: 10 });
  assert.deepEqual(versions.map((v) => [v.kind, v.rev]), [['auto', session.rev + 1]], 'a refused batch is not an edit; the accepted one is');
  const second = param('title', 'second', 'alice', 3);
  await room.applyBatch(alice, 'b3', ['op3'], [second], new Set([second]));
  await room.quiesce();
  versions = await store.listSessionVersions(session.id, { limit: 10 });
  assert.deepEqual(versions.map((v) => [v.kind, v.rev]), [['close', session.rev + 2], ['auto', session.rev + 1]]);
  assert.equal((await store.listSessionRevisions(session.id))[0]?.actor, user.id, 'and the one quiesce revision names Alice');
});

/** Room-level restore hooks: everything accepted, 'before' recorded in memory. */
function acceptAll(befores: RestoreBefore[]) {
  return {
    authorize: async (ops: CanvasOp[]) => ({ accepted: ops, vetoed: [], skipped: [], full: false }),
    beforeCommit: async (before: RestoreBefore) => { befores.push(before); return `ver_before_${befores.length}`; },
  };
}

test('an edit queued before a restore is in its before version, and the restore lands as one batch (S-20)', async () => {
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'race', { title: 'Draft', slides: [{ id: 's1', heading: 'One' }] });
  const room = await Room.open(session, undefined, store);
  const peer = seat('peer', user.id);
  const watcher = seat('watcher', user.id, { role: 'observer' });
  const restorer = seat('restore_1', user.id, { hidden: true });
  for (const s of [peer, watcher, restorer]) room.join(s);
  try {
    const edit = param('title', 'peer edit', 'peer', 1);
    const befores: RestoreBefore[] = [];
    const queued = room.applyBatch(peer, 'peer-batch', ['peer-op'], [edit], new Set([edit]));
    const restored = room.restoreInputs(restorer, { title: 'Version', slides: [{ id: 's1', heading: 'One' }, { id: 's2', heading: 'Two' }] }, acceptAll(befores));
    await queued;
    const outcome = await restored;
    assert.equal(befores[0]?.inputs.title, 'peer edit', 'the peer commit between the gate and the batch is in before');
    assert.equal(befores[0]?.revision, session.rev + 1);
    assert.deepEqual([outcome.revision, outcome.committed, outcome.live], [session.rev + 2, true, true]);
    assert.equal(outcome.inputs.title, 'Version');
    assert.deepEqual((outcome.inputs.slides as Array<{ id: string }>).map((s) => s.id), ['s1', 's2']);
    const fromRestore = watcher.sent.filter((f) => f.t === 'ops' && f.from === restorer.id);
    assert.equal(fromRestore.length, 1, 'one batch reaches each peer');
    assert.equal(peer.sent.filter((f) => f.t === 'ops' && f.from === restorer.id).length, 1);
    assert.equal(restorer.sent.filter((f) => f.t === 'ops' && f.from === restorer.id).length, 0, 'the restoring seat is not echoed');
    assert.equal((await store.getSession(session.id))?.rev, session.rev + 2);
  } finally { await room.quiesce(); }
  assert.equal((await store.listSessionRevisions(session.id))[0]?.actor, user.id);
  assert.deepEqual(await store.listSessionVersions(session.id, { limit: 10 }).then((v) => v.map((x) => x.kind)), ['close'],
    'the peer edit gets its close version; the restore is not counted as an automatic edit');
});

test('a restore that would pass a ceiling commits nothing and writes no before version (S-20)', async () => {
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'ceiling', { slides: [{ id: 's1', heading: 'One' }] });
  const room = await Room.open(session, undefined, store);
  const restorer = seat('restore_2', user.id, { hidden: true });
  room.join(restorer);
  try {
    const rows = Array.from({ length: MAX_BOXES_PER_COLLECTION + 1 }, (_, i) => ({ id: `r${i}`, heading: `${i}` }));
    const befores: RestoreBefore[] = [];
    await assert.rejects(room.restoreInputs(restorer, { slides: rows }, acceptAll(befores)),
      (error: unknown) => error instanceof RoomRestoreError && error.code === 'RESTORE_INCOMPLETE');
    assert.deepEqual(befores, []);
    const stored = await store.getSession(session.id);
    assert.deepEqual([stored?.rev, stored?.inputs], [session.rev, session.inputs], 'nothing half applied');
    // The room still works afterwards.
    const ok = await room.restoreInputs(restorer, { slides: [{ id: 's1', heading: 'Uno' }] }, acceptAll(befores));
    assert.equal(ok.committed, true);
  } finally { await room.quiesce(); }
});

test('a restore cancels every editing claim and drops what authorize refuses', async () => {
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'claims', { title: 'Draft', locked: 'Approved', slides: [{ id: 's1', heading: 'One' }] });
  const room = await Room.open(session, undefined, store);
  const holder = seat('holder', user.id, { interactionVersion: 1 });
  const restorer = seat('restore_3', user.id, { hidden: true });
  room.join(holder); room.join(restorer);
  try {
    const answer = await room.requestClaim(holder, 'acquire', { kind: 'text', collection: 'slides', ids: ['s1'], field: 'heading' });
    assert.ok('claim' in answer);
    const outcome = await room.restoreInputs(restorer, { title: 'Version', locked: 'Changed', slides: [{ id: 's1', heading: 'Restored' }] }, {
      authorize: async (ops) => ({
        accepted: ops.filter((op) => !(op.k === 'param' && op.key === 'locked')), vetoed: ['locked'], skipped: [], full: false,
      }),
      beforeCommit: async () => 'ver_before',
    });
    const claimFrames = holder.sent.filter((f): f is Extract<ServerFrame, { t: 'claims' }> => f.t === 'claims');
    assert.deepEqual(claimFrames.at(-1)?.claims, [], 'the holder is told its claim is gone');
    assert.deepEqual(outcome.vetoed, ['locked']);
    assert.equal(outcome.inputs.locked, 'Approved', 'a vetoed input keeps its value');
    assert.deepEqual((outcome.inputs.slides as Array<{ heading: string }>)[0]?.heading, 'Restored', 'the claimed row is restored');
  } finally { await room.quiesce(); }
});

test('a refused restore keeps every editing claim: it changes nothing, claims included', async () => {
  const store = createMemoryStore();
  const { session, user } = await documentOf(store, 'keepclaims', { title: 'Draft', slides: [{ id: 's1', heading: 'One' }] });
  const room = await Room.open(session, undefined, store);
  const holder = seat('holder', user.id, { interactionVersion: 1 });
  const other = seat('other', user.id, { interactionVersion: 1 });
  const restorer = seat('restore_4', user.id, { hidden: true });
  for (const s of [holder, other, restorer]) room.join(s);
  try {
    const target = { kind: 'text' as const, collection: 'slides', ids: ['s1'], field: 'heading' };
    assert.ok('claim' in await room.requestClaim(holder, 'acquire', target));
    const mark = holder.sent.length;
    const version = { title: 'Version', slides: [{ id: 's1', heading: 'Restored' }] };
    const befores: RestoreBefore[] = [];
    // Past a ceiling (RESTORE_INCOMPLETE), refused by the person's own write
    // checks (READ_ONLY), and refused for space by the 'before' write.
    const rows = Array.from({ length: MAX_BOXES_PER_COLLECTION + 1 }, (_, i) => ({ id: i ? `r${i}` : 's1', heading: `${i}` }));
    await assert.rejects(room.restoreInputs(restorer, { ...version, slides: rows }, acceptAll(befores)),
      (error: unknown) => error instanceof RoomRestoreError && error.code === 'RESTORE_INCOMPLETE');
    await assert.rejects(room.restoreInputs(restorer, version, {
      authorize: async () => { throw new RestoreError('READ_ONLY', 'you can view this session but not change it'); },
      beforeCommit: acceptAll(befores).beforeCommit,
    }), (error: unknown) => error instanceof RestoreError && error.code === 'READ_ONLY');
    await assert.rejects(room.restoreInputs(restorer, version, {
      authorize: acceptAll(befores).authorize,
      beforeCommit: async () => { throw new RestoreError('VERSION_SPACE', 'History is full.'); },
    }), (error: unknown) => error instanceof RestoreError && error.code === 'VERSION_SPACE');
    assert.deepEqual(befores, []);
    assert.deepEqual(holder.sent.slice(mark).filter((f) => f.t === 'claims'), [], 'nobody is told a claim went');
    assert.deepEqual(await room.requestClaim(other, 'acquire', target), { reason: 'claimed', blockedBy: 'holder' }, 'the claim still holds');
    assert.equal((await store.getSession(session.id))?.rev, session.rev, 'nothing committed');
    // A restore that does commit still cancels it.
    const outcome = await room.restoreInputs(restorer, version, acceptAll(befores));
    assert.equal(outcome.committed, true);
    assert.deepEqual(holder.sent.slice(mark).filter((f): f is Extract<ServerFrame, { t: 'claims' }> => f.t === 'claims').at(-1)?.claims, []);
  } finally { await room.quiesce(); }
});

// ── through the gateway's versions bridge, over real sockets ──────────────────

const SECRETS = { session: 'versions-session', link: 'versions-link' };
let server: Server;
let collab: CollabGateway;
let gwStore: ReturnType<typeof createMemoryStore>;
let base = '';
let wsBase = '';
const cookies = new Map<string, string>();
const users = new Map<string, UserRecord>();

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-versions-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', 'design'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design',
    inputs: [{ id: 'title', type: 'text' }, { id: 'locked', type: 'text' }, { id: 'slides', type: 'blocks' }] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Versions', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'alice@test', name: 'Alice Owner', groups: ['team'] },
      { email: 'bob@test', name: 'Bob Editor', groups: ['team'] },
      { email: 'vic@test', name: 'Vic Viewer', groups: ['team'] },
    ] },
  }));
  gwStore = createMemoryStore();
  collab = createCollabGateway({ config, store: gwStore, secrets: SECRETS });
  const app = buildApp({ config, store: gwStore, secrets: SECRETS, versionRooms: collab.versions });
  server = createServer((req, res) => void app(req, res));
  server.on('upgrade', (req, socket, head) => { if (!collab.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  for (const name of ['alice', 'bob', 'vic']) {
    const res = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    cookies.set(name, res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    users.set(name, (await gwStore.findUsersByEmail(`${name}@test`))[0]!);
  }
  const now = new Date().toISOString();
  const alice = users.get('alice')!;
  await gwStore.putProject({ id: 'prj_gw', ownerId: alice.id, name: 'Gateway', visibility: 'private', createdAt: now });
  await gwStore.putProjectMember({ projectId: 'prj_gw', userId: users.get('bob')!.id, role: 'editor', addedBy: alice.id, addedAt: now });
  await gwStore.putProjectMember({ projectId: 'prj_gw', userId: users.get('vic')!.id, role: 'viewer', addedBy: alice.id, addedAt: now });
});

after(() => {
  collab.close();
  server.closeAllConnections();
  server.close();
});

interface Frame { t: string; [k: string]: unknown }

class Client {
  readonly frames: Frame[] = [];
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  constructor(session: string, cookie: string) {
    this.ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${session}`, { headers: { cookie } });
    this.ready = new Promise<void>((resolve, reject) => { this.ws.once('open', () => resolve()); this.ws.once('error', reject); });
    this.ws.on('message', (data) => { this.frames.push(JSON.parse(String(data)) as Frame); });
    this.ws.on('error', () => undefined);
  }
  async next(t: string, after = 0, timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.slice(after).find((f) => f.t === t);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timeout waiting for '${t}'`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  async join(): Promise<Frame> {
    await this.ready;
    this.ws.send(JSON.stringify({ t: 'join', opVersion: CANVAS_OP_VERSION, interactionVersion: 1 }));
    return this.next('join-ack');
  }
  send(frame: unknown): void { this.ws.send(JSON.stringify(frame)); }
  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.ws.once('close', () => resolve()));
    this.ws.close();
    await closed;
  }
}

async function gwDocument(id: string, inputs: Record<string, unknown>): Promise<SessionRecord> {
  const alice = users.get('alice')!;
  const session: SessionRecord = { id, projectId: 'prj_gw', toolId: 'design', toolVersion: '1', inputs, meta: {}, createdBy: alice.id,
    updatedBy: alice.id, rev: 1, updatedAt: new Date().toISOString() };
  await gwStore.putSession(session);
  return session;
}

async function namedVersion(session: SessionRecord, inputs: Record<string, unknown>): Promise<SessionVersion> {
  const put = await gwStore.putSessionVersion({ sessionId: session.id, rev: session.rev, kind: 'named', label: 'Saved', inputs, meta: {},
    contributors: [], createdBy: users.get('alice')!.id });
  assert.ok(typeof put !== 'string');
  return (await gwStore.getSessionVersion(session.id, put.version.id))!;
}

const beforeWriter = (session: SessionRecord, requestId: string) => async (before: RestoreBefore): Promise<string> => {
  const put = await gwStore.putSessionVersion({ sessionId: session.id, rev: before.revision, kind: 'before', inputs: before.inputs, meta: before.meta,
    contributors: [], createdBy: users.get('alice')!.id, requestId });
  assert.ok(typeof put !== 'string' && put.created);
  return put.version.id;
};

/** A peer's view of the document: its join checkpoint with the ops it received. */
function viewOf(client: Client): ReturnType<ReferenceCanvasDoc['state']> {
  const doc = new ReferenceCanvasDoc('peer');
  const ack = client.frames.find((f) => f.t === 'join-ack')!;
  doc.restore(ack.checkpoint as CanvasCheckpoint);
  for (const frame of client.frames) if (frame.t === 'ops') for (const op of frame.ops as CanvasOp[]) doc.apply(op);
  return doc.state();
}

test('a restore through a live room: one batch, both peers converge, claims cancelled (S-11)', async () => {
  const session = await gwDocument('ses_live', { title: 'Now', locked: 'Approved', slides: [{ id: 's1', heading: 'One' }, { id: 's2', heading: 'Two' }] });
  const target = await namedVersion(session, { title: 'Then', locked: 'Approved', slides: [{ id: 's2', heading: 'Two (then)' }] });
  const alice = new Client(session.id, cookies.get('alice')!);
  const bob = new Client(session.id, cookies.get('bob')!);
  await alice.join(); await bob.join();
  bob.send({ t: 'claim', requestId: 'claim_1', action: 'acquire', target: { kind: 'text', collection: 'slides', ids: ['s1'], field: 'heading' } });
  assert.ok((await bob.next('claim-result')).claim, 'bob holds a claim');
  const marks = [alice.frames.length, bob.frames.length];
  const result = await collab.versions.restore({ sessionId: session.id, user: users.get('alice')!, target, beforeCommit: beforeWriter(session, 'live_1') });
  assert.deepEqual([result.live, result.revision, result.skipped, result.vetoed], [true, session.rev + 1, [], []]);
  await alice.next('ops', marks[0]); await bob.next('ops', marks[1]);
  for (const [client, mark] of [[alice, marks[0]!], [bob, marks[1]!]] as const) {
    assert.equal(client.frames.slice(mark).filter((f) => f.t === 'ops').length, 1, 'exactly one ops frame per peer');
    assert.deepEqual(client.frames.slice(mark).filter((f) => f.t === 'claims').at(-1)?.claims, [], 'claims cancelled for everyone');
  }
  const late = new Client(session.id, cookies.get('vic')!);
  const ack = await late.join();
  for (const client of [alice, bob]) assert.deepEqual(JSON.stringify(viewOf(client)), JSON.stringify(viewOf(late)), 'every peer converges on the restored document');
  assert.deepEqual((ack.docState as { params: Record<string, unknown> }).params.title, 'Then');
  assert.deepEqual((result.inputs.slides as Array<{ id: string; heading: string }>), [{ id: 's2', heading: 'Two (then)' }]);
  const beforeRow = await gwStore.getSessionVersion(session.id, result.beforeId);
  assert.equal(beforeRow?.kind, 'before');
  assert.deepEqual(beforeRow?.inputs, session.inputs, 'before is the document the restore replaced');
  for (const client of [alice, bob, late]) await client.close();
});

test('a restore with no open room opens one for the restore and closes it again', async () => {
  const session = await gwDocument('ses_cold', { title: 'Now', locked: 'Approved', slides: [] });
  const target = await namedVersion(session, { title: 'Then', locked: 'Approved', slides: [{ id: 'n1', heading: 'New' }] });
  // The previous case's room closes once its sockets' leave handlers have run.
  for (let i = 0; i < 200 && collab.rooms() > 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(collab.rooms(), 0);
  const result = await collab.versions.restore({ sessionId: session.id, user: users.get('bob')!, target, beforeCommit: beforeWriter(session, 'cold_1') });
  assert.deepEqual([result.live, result.revision], [false, session.rev + 1]);
  assert.equal(collab.rooms(), 0, 'the room the restore opened is closed');
  const stored = await gwStore.getSession(session.id);
  assert.deepEqual(stored?.inputs, { title: 'Then', locked: 'Approved', slides: [{ id: 'n1', heading: 'New' }] });
  assert.equal(stored?.updatedBy, users.get('bob')!.id);
  assert.equal((await gwStore.listSessionRevisions(session.id))[0]?.actor, users.get('bob')!.id, 'the quiesce revision names the restorer');
});

test('a restore passes the restoring person\'s own write checks: an observer is refused, a locked input is vetoed (S-19)', async () => {
  const session = await gwDocument('ses_checks', { title: 'Now', locked: 'Approved', slides: [] });
  const target = await namedVersion(session, { title: 'Then', locked: 'Overridden', slides: [] });
  await assert.rejects(collab.versions.restore({ sessionId: session.id, user: users.get('vic')!, target, beforeCommit: beforeWriter(session, 'vic_1') }),
    (error: unknown) => error instanceof RestoreError && error.code === 'READ_ONLY');
  assert.equal((await gwStore.getSession(session.id))?.rev, session.rev, 'nothing written for a viewer');
  await gwStore.putOverlay({ toolId: 'design', version: 1, inputAccess: { locked: [{ groups: ['team'], level: 'locked', value: 'Approved' }] } });
  try {
    const result = await collab.versions.restore({ sessionId: session.id, user: users.get('alice')!, target, beforeCommit: beforeWriter(session, 'alice_1') });
    assert.deepEqual(result.vetoed, ['locked']);
    assert.deepEqual([result.inputs.title, result.inputs.locked], ['Then', 'Approved']);
  } finally { await gwStore.deleteOverlay('design'); }
  await gwStore.putGrant({ principal: `user:${users.get('bob')!.id}`, action: 'collab.join', resource: '*', effect: 'deny' });
  await assert.rejects(collab.versions.restore({ sessionId: session.id, user: users.get('bob')!, target, beforeCommit: beforeWriter(session, 'bob_1') }),
    (error: unknown) => error instanceof RestoreError && error.code === 'FORBIDDEN');
  assert.equal(collab.rooms(), 0);
});
