// SPDX-License-Identifier: MPL-2.0
/**
 * LOAD SHAPES, not benchmarks (OSS plans/100 §10, plans/14 §6). Four properties a
 * room has to hold when more than one person is actually in it, each driven with
 * the smallest N that exercises the property, all in-process against the same
 * bootstrap `tests/collab/gateway.test.ts` uses (real `node:http`, real `ws`
 * clients, real memory store, a real `tools/<id>/tool.json` so the declared-input
 * whitelist and the lane check are live rather than skipped):
 *
 *   1. TEN WRITERS CONVERGE. Ten sockets interleave randomized op batches whose
 *      CONTENT is a SEEDED PRNG (`mulberry32`, no wall clock) - deterministic
 *      per socket, so which ops each one sends and in what order it sends its
 *      own batches never varies between runs. The actual WIRE INTERLEAVING
 *      across the ten sockets is not seeded - it is whatever order ten real
 *      `ws` clients happen to arrive at the server through node's event loop - 
 *      so a convergence bug that depends on THAT ordering (the class of bug this
 *      test exists to catch) will not reproduce from the seed alone; only a bug
 *      that depends on op content reliably will. Each client folds what it sent
 *      and what it received into its own `ReferenceCanvasDoc` - the same
 *      document the shell keeps. Every client's final state must be
 *      byte-identical to every other's AND to a late joiner's `join-ack.docState`,
 *      which is the only copy that came from the server.
 *   2. ROOM HEALTH UNDER ABUSE. One client floods until its rate cap disconnects
 *      IT; the other nine keep their sockets, keep writing, and still converge.
 *      A cap that took the room down with the abuser would be worse than no cap.
 *   3. CHURN. 200 join/leave cycles leave no ghost: the roster empties, and the
 *      room's own per-member maps come back to baseline (`Room.internals()` - 
 *      counts only). The replay filter deliberately does NOT empty (it is keyed by
 *      a peer-chosen client id and bounded by eviction, `noteClock`), so the
 *      assertion on it is the BOUND, and it is asserted by exceeding it.
 *   4. PRESENCE STORM. Frames inside the cap are relayed, cost the store nothing
 *      at all (no audit row, no revision, no snapshot row, no session write), and
 *      are gone the moment the sender leaves.
 *
 * Everything is bounded by counted frames rather than by sleeping: the barriers
 * below wait for exact delivery counts, then for quiescence, so the file has no
 * wall-clock dependency beyond the settle poll.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { mulberry32 } from '@lolly-tools/core/canvas-op-testkit';
import { CANVAS_OP_VERSION, ReferenceCanvasDoc } from '@lolly-tools/core/canvas-op-v1';
import type { BoxId, BoxRow, CanvasDocState, CanvasOp, ParamValue } from '@lolly-tools/core/canvas-op-v1';

import { parseConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { buildApp } from '../../server/src/api/app.ts';
import {
  createCollabGateway, COLLAB_WS_PREFIX, CLOSE, OPS_MESSAGES_PER_SEC,
  type CollabGateway,
} from '../../server/src/collab/gateway.ts';
import {
  MAX_TRACKED_CLIENTS, PRESENCE_FRAMES_PER_SEC, WRITER_CAP,
  Room, type RoomMember, type ServerFrame,
} from '../../server/src/collab/rooms.ts';
import type { SessionRecord } from '../../server/src/store/types.ts';

const TOOL_ID = 'deck';
const TOOL_INPUTS: Array<{ id: string; type: string }> = [
  { id: 'title', type: 'text' },
  { id: 'headline', type: 'text' },
  { id: 'accent', type: 'color' },
  { id: 'slides', type: 'blocks' },
];
/** The scalar inputs a `param` op may address (the lane check refuses `slides`). */
const SCALARS = ['title', 'headline', 'accent'] as const;

/** Ten distinct accounts: WRITER_CAP is per room but WRITER_CAP_PER_USER is 3, so
 *  ten writer seats can only be reached by distinct users. */
const WRITERS = Array.from({ length: WRITER_CAP }, (_, i) => `soak${i}@test`);
/** Churn accounts. 200 cycles over 12 accounts is 17 upgrades each, comfortably
 *  under CONNECTS_PER_USER_PER_MIN (30) - the cap is per user for exactly this
 *  reason, so the test has to respect it rather than route around it. */
const CHURNERS = Array.from({ length: 12 }, (_, i) => `churn${i}@test`);

let server: Server;
let collab: CollabGateway;
let base = '';
let wsBase = '';
let store: ReturnType<typeof createMemoryStore>;
let projectId = '';
let ownerCookie = '';
const cookies = new Map<string, string>();

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-soak-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', TOOL_ID), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL_ID, 'tool.json'), JSON.stringify({ id: TOOL_ID, inputs: TOOL_INPUTS }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Soak Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'owner@test', name: 'Olive Owner', groups: ['team-eng'] },
        { email: 'anchor@test', name: 'Anna Anchor', groups: ['team-eng'] },
        { email: 'late@test', name: 'Lena Late', groups: ['team-eng'] },
        ...WRITERS.map((email, i) => ({ email, name: `Soak ${i}`, groups: ['team-eng'] })),
        ...CHURNERS.map((email, i) => ({ email, name: `Churn ${i}`, groups: ['team-eng'] })),
      ],
    },
  }));
  store = createMemoryStore();
  collab = createCollabGateway({ config, store, secrets: { session: 'sc', link: 'lc' } });
  const app = buildApp({
    config, store, secrets: { session: 'sc', link: 'lc' }, listCollabRooms: () => collab.snapshot(),
  });
  server = createServer((req, res) => void app(req, res));
  server.on('upgrade', (req, socket, head) => {
    if (!collab.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;

  ownerCookie = await login('owner@test');
  const project = await json(ownerCookie, 'POST', '/api/v1/projects', {
    name: 'Soak', visibility: { groups: ['team-eng'] },
  });
  assert.equal(project.status, 201);
  projectId = (await project.json() as { id: string }).id;
  for (const email of ['anchor@test', 'late@test', ...WRITERS, ...CHURNERS]) {
    cookies.set(email, await login(email));
  }
});

after(() => {
  collab.close();
  server.close();
});

// ── http helpers (tests/collab/gateway.test.ts's shape) ───────────────────────

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

async function makeSession(inputs: Record<string, unknown> = {}): Promise<string> {
  const res = await json(ownerCookie, 'POST', `/api/v1/projects/${projectId}/sessions`, {
    toolId: TOOL_ID, toolVersion: '1.0.0', inputs, meta: { label: 'soak' },
  });
  assert.equal(res.status, 201);
  return (await res.json() as { id: string }).id;
}

const cookieFor = (email: string): string => {
  const c = cookies.get(email);
  assert.ok(c, `logged in as ${email}`);
  return c;
};

// ── ws client (gateway.test.ts's Client, plus delivery counters) ──────────────

interface Frame { t: string; [k: string]: unknown }

class Client {
  readonly frames: Frame[] = [];
  /** Ops DELIVERED to this socket (peers' only - the gateway never echoes). */
  opsReceived = 0;
  presenceReceived = 0;
  closeCode: number | null = null;
  /** This client's own view of the document: its own ops applied locally, plus
   *  every op the room relayed. Exactly what the shell keeps. */
  readonly doc = new ReferenceCanvasDoc('soak');
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private closeWaiters: Array<(code: number) => void> = [];
  private readonly consumed = new Set<Frame>();
  private ticks: Array<() => void> = [];

  constructor(sessionId: string, cookie: string) {
    this.ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${sessionId}`, { headers: { cookie } });
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.ready.catch(() => undefined);
    this.ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      this.frames.push(frame);
      if (frame.t === 'ops') {
        const ops = frame.ops as CanvasOp[];
        this.opsReceived += ops.length;
        for (const op of ops) this.doc.apply(op);
      }
      if (frame.t === 'presence') this.presenceReceived++;
      const still: typeof this.waiters = [];
      for (const w of this.waiters) {
        if (w.match(frame)) w.resolve(frame);
        else still.push(w);
      }
      this.waiters = still;
      for (const tick of this.ticks) tick();
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
      for (const w of this.closeWaiters) w(code);
      this.closeWaiters = [];
      for (const tick of this.ticks) tick();
    });
    this.ws.on('error', () => undefined);
  }

  open(): Promise<void> {
    return this.ready;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Send one op batch AND apply it locally, the way a real client does. */
  sendOps(ops: CanvasOp[]): void {
    for (const op of ops) this.doc.apply(op);
    this.send({ t: 'ops', ops });
  }

  next(t: string, timeoutMs = 4000): Promise<Frame> {
    const seen = this.frames.find((f) => f.t === t && !this.consumed.has(f));
    if (seen) {
      this.consumed.add(seen);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for '${t}' frame`)), timeoutMs);
      this.waiters.push({
        match: (f) => f.t === t,
        resolve: (f) => {
          clearTimeout(timer);
          this.consumed.add(f);
          resolve(f);
        },
      });
    });
  }

  /** Resolve once `predicate` holds - re-checked on every inbound frame. */
  until(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what}`)), timeoutMs);
      const tick = (): void => {
        if (!predicate()) return;
        clearTimeout(timer);
        this.ticks = this.ticks.filter((t) => t !== tick);
        resolve();
      };
      this.ticks.push(tick);
    });
  }

  closed(timeoutMs = 4000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  async join(opVersion: string = CANVAS_OP_VERSION): Promise<Frame> {
    await this.open();
    this.send({ t: 'join', opVersion });
    return this.next('join-ack');
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll a server-side condition. Used only for state the gateway does not push - 
 *  a seat is released by a close handler queued behind that connection's pending
 *  work, so there is no frame to wait on. */
async function pollUntil(predicate: () => boolean, what: string, tries = 200, everyMs = 25): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** The live room for a session, as the admin snapshot sees it. */
const roomOf = (sessionId: string) => collab.snapshot().find((r) => r.sessionId === sessionId);

/** Wait until nothing more is being delivered: the total op count across these
 *  clients is unchanged over two consecutive samples. The barrier for anything
 *  whose exact delivery count cannot be predicted (a flood cut off mid-stream). */
async function quiescent(clients: Client[], sampleMs = 80, maxSamples = 40): Promise<void> {
  const total = (): number => clients.reduce((n, c) => n + c.opsReceived, 0);
  let last = -1;
  for (let i = 0; i < maxSamples; i++) {
    const before = total();
    await sleep(sampleMs);
    if (total() === before && before === last) return;
    last = before;
  }
  throw new Error('op delivery never quiesced');
}

// ── document comparison (the testkit's serialization, over both shapes) ───────

function serialize(s: CanvasDocState): string {
  const cols = s.collections === undefined ? [] : [...s.collections.entries()];
  return JSON.stringify({
    order: s.order,
    boxes: [...s.boxes.entries()],
    params: [...s.params.entries()],
    collections: cols
      .map(([id, c]) => [id, { order: c.order, boxes: [...c.boxes.entries()] }] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });
}

/** A `join-ack.docState` in the same shape a `ReferenceCanvasDoc` reports. */
function docStateOf(ack: Frame): CanvasDocState {
  const wire = ack.docState as {
    order: BoxId[];
    boxes: Record<BoxId, BoxRow>;
    params: Record<string, ParamValue>;
    collections?: Record<string, { order: BoxId[]; boxes: Record<BoxId, BoxRow> }>;
  };
  const state: CanvasDocState = {
    order: wire.order,
    boxes: new Map(Object.entries(wire.boxes)),
    params: new Map(Object.entries(wire.params)),
  };
  if (wire.collections) {
    state.collections = new Map(
      Object.entries(wire.collections).map(([col, c]) => [
        col, { order: c.order, boxes: new Map(Object.entries(c.boxes)) },
      ]),
    );
  }
  return state;
}

// ── deterministic op generation (seeded; no wall clock) ───────────────────────

/**
 * One client's batches. Each batch is ONE gesture, so it carries ONE origin - 
 * which is both what the shell emits (`onLocalChange` mints one per gesture) and
 * what the room's replay filter is written against (the whole batch is judged
 * against the PRE-batch high-water mark).
 *
 * Contention is deliberate and deterministic: every client writes the same three
 * scalar inputs (LWW resolves by `(clock, client)`) and every client adds rows to
 * the SAME `slides` collection (order resolves by `(orderKey, BoxId)`), while row
 * EDITS stay within a client's own rows, which is what a real gesture does.
 */
function batchesFor(idx: number, seed: number, nBatches: number): CanvasOp[][] {
  const rng = mulberry32(seed + idx * 977);
  const client = `dev-${idx}`;
  const mine: BoxId[] = [];
  const batches: CanvasOp[][] = [];
  let rowN = 0;
  for (let b = 0; b < nBatches; b++) {
    const origin = { client, clock: b + 1 };
    const ops: CanvasOp[] = [];
    const n = 1 + rng.int(4);
    for (let i = 0; i < n; i++) {
      const roll = mine.length === 0 ? 0.5 : rng.next();
      if (roll < 0.35) {
        ops.push({ k: 'param', key: rng.pick(SCALARS), value: `${client}#${b}.${i}`, origin });
      } else if (roll < 0.65) {
        const id = `${client}-r${rowN++}`;
        mine.push(id);
        ops.push({
          k: 'add', col: 'slides', id, orderKey: `${String(idx).padStart(2, '0')}${String(rowN).padStart(4, '0')}`,
          row: { heading: `${id} h`, body: `${id} b` }, origin,
        });
      } else if (roll < 0.8) {
        ops.push({ k: 'field', col: 'slides', id: rng.pick(mine), field: 'heading', value: `edit ${b}.${i}`, origin });
      } else if (roll < 0.93) {
        ops.push({ k: 'geom', col: 'slides', id: rng.pick(mine), fields: { x: rng.int(500), y: rng.int(500) }, origin });
      } else {
        ops.push({ k: 'remove', col: 'slides', id: rng.pick(mine), origin });
      }
    }
    batches.push(ops);
  }
  return batches;
}

const countOps = (batches: CanvasOp[][]): number => batches.reduce((n, b) => n + b.length, 0);

// ── 1. ten writers converge ───────────────────────────────────────────────────

test('ten writers interleaving randomized batches converge — with each other and with the server', async () => {
  const seed = await makeSession();
  const clients: Client[] = [];
  const plans = WRITERS.map((_, i) => batchesFor(i, 0xc0ffee, 8));
  const perClient = plans.map(countOps);
  const total = perClient.reduce((a, b) => a + b, 0);

  try {
    for (const email of WRITERS) {
      const c = new Client(seed, cookieFor(email));
      clients.push(c);
      const ack = await c.join();
      assert.equal((ack.you as { role: string }).role, 'writer', `${email} took a writer seat`);
    }

    // Interleave: round N of every client goes out before round N+1 of any.
    for (let b = 0; b < plans[0]!.length; b++) {
      for (let i = 0; i < clients.length; i++) clients[i]!.sendOps(plans[i]![b]!);
    }

    // Barrier: every client has been delivered every op it did not send itself.
    // That is stronger than a sleep - an op reaching a peer PROVES the room
    // applied it, so this also proves nothing was silently dropped.
    await Promise.all(clients.map((c, i) => c.until(
      () => c.opsReceived >= total - perClient[i]!,
      `client ${i} to receive ${total - perClient[i]!} peer ops`,
    )));
    await quiescent(clients);

    for (let i = 0; i < clients.length; i++) {
      assert.equal(clients[i]!.opsReceived, total - perClient[i]!, `client ${i} got its peers' ops exactly once`);
      assert.equal(clients[i]!.closeCode, null, `client ${i} is still connected`);
    }

    // Every client's own document is identical …
    const truth = serialize(clients[0]!.doc.state());
    for (let i = 1; i < clients.length; i++) {
      assert.equal(serialize(clients[i]!.doc.state()), truth, `client ${i} diverged from client 0`);
    }

    // … and identical to the copy that came from the SERVER, which is the only
    // one nobody in this test computed: a late joiner's whole-document ack.
    const late = new Client(seed, cookieFor('late@test'));
    clients.push(late);
    const ack = await late.join();
    assert.equal(
      (ack.you as { role: string }).role, 'observer',
      'the eleventh seat is view-only (WRITER_CAP), and still receives the whole document',
    );
    assert.equal(ack.notice, 'room-full-view-only');
    assert.equal(serialize(docStateOf(ack)), truth, 'the server’s document is the one the clients converged on');

    const room = roomOf(seed);
    assert.ok(room, 'the room is live');
    assert.equal(room.opsApplied, total, 'the room applied every op that was sent — none deduped away');
    assert.equal(room.memberCount, WRITER_CAP + 1);
    assert.equal(room.writerCount, WRITER_CAP);
  } finally {
    for (const c of clients) c.close();
    await Promise.all(clients.map((c) => c.closed().catch(() => 0)));
  }
});

// ── 2. room health under abuse ────────────────────────────────────────────────

test('a sustained flood disconnects the flooder alone — the other nine stay up and converge', async () => {
  const seed = await makeSession();
  const clients: Client[] = [];
  try {
    for (const email of WRITERS) {
      const c = new Client(seed, cookieFor(email));
      clients.push(c);
      await c.join();
    }
    const flooder = clients[0]!;
    const survivors = clients.slice(1);

    // One socket, one message per op, far past OPS_MESSAGES_PER_SEC. Every op is
    // individually LEGAL - the abuse is the rate, which is the whole point of a
    // cap that is separate from the per-message op count.
    for (let i = 0; i < OPS_MESSAGES_PER_SEC + 20; i++) {
      flooder.send({ t: 'ops', ops: [{ k: 'param', key: 'title', value: `flood ${i}`, origin: { client: 'dev-0', clock: i + 1 } }] });
    }
    assert.equal(await flooder.closed(), CLOSE.OPS_RATE, 'the flooder is disconnected by its own rate cap');

    // The room is unharmed: nine sockets, still open, still writing.
    await quiescent(survivors);
    for (const [i, c] of survivors.entries()) {
      assert.equal(c.closeCode, null, `survivor ${i} kept its socket through the flood`);
    }

    const sentinelStart = survivors.map((c) => c.opsReceived);
    for (const [i, c] of survivors.entries()) {
      c.sendOps([{ k: 'param', key: 'headline', value: `after the flood ${i}`, origin: { client: `dev-${i + 1}`, clock: 9000 } }]);
    }
    await Promise.all(survivors.map((c, i) => c.until(
      () => c.opsReceived >= sentinelStart[i]! + survivors.length - 1,
      `survivor ${i} to see the other eight sentinels`,
    )));
    await quiescent(survivors);

    const truth = serialize(survivors[0]!.doc.state());
    for (let i = 1; i < survivors.length; i++) {
      assert.equal(serialize(survivors[i]!.doc.state()), truth, `survivor ${i} diverged`);
    }
    // The flooder's seat is released by a close handler queued behind its own
    // pending ops, so wait for the room to say so rather than for the socket.
    await pollUntil(() => roomOf(seed)?.memberCount === survivors.length, 'the flooder’s seat to be released');
    assert.equal(roomOf(seed)?.writerCount, survivors.length, 'the other nine kept theirs');

    const late = new Client(seed, cookieFor('late@test'));
    clients.push(late);
    const ack = await late.join();
    assert.equal(
      serialize(docStateOf(ack)), truth,
      'the room’s document agrees with the survivors — including whatever the flooder landed before it was cut off',
    );
    assert.equal(
      (ack.you as { role: string }).role, 'writer',
      'and the seat the flooder lost is a seat somebody else can have — a disconnect is not a leak',
    );
    assert.equal(roomOf(seed)?.memberCount, survivors.length + 1);
  } finally {
    for (const c of clients) c.close();
    await Promise.all(clients.map((c) => c.closed().catch(() => 0)));
  }
});

// ── 3. churn ──────────────────────────────────────────────────────────────────

const CHURN_CYCLES = 200;

test(`${CHURN_CYCLES} join/leave cycles leave no ghost in the roster`, async () => {
  const seed = await makeSession();
  // An anchor holds the room open across the whole churn, so what is asserted at
  // the end is ONE room's accumulated state rather than a fresh room per cycle.
  const anchor = new Client(seed, cookieFor('anchor@test'));
  await anchor.join();
  try {
    for (let i = 0; i < CHURN_CYCLES; i++) {
      const c = new Client(seed, cookieFor(CHURNERS[i % CHURNERS.length]!));
      await c.join();
      c.send({ t: 'presence', frame: { cursor: { x: (i % 100) / 100, y: 0.5 }, selection: [] } });
      c.close();
      await c.closed();
    }
    // Each leave is queued behind that connection's pending work, so the last few
    // may still be draining when the loop ends.
    await pollUntil(() => roomOf(seed)?.memberCount === 1, 'the roster to drain back to the anchor');

    const room = roomOf(seed);
    assert.ok(room, 'the anchor kept the room open');
    assert.equal(room.memberCount, 1, 'every one of the 200 seats was released');
    assert.equal(room.members.length, 1);
    assert.equal(collab.rooms(), 1, 'and no second room was minted along the way');

    // A fresh joiner is the honest read of the roster: it is built from the room's
    // member map, and it carries each peer's last presence - so a leaked seat or a
    // leaked presence frame would both show up right here.
    const fresh = new Client(seed, cookieFor('late@test'));
    const ack = await fresh.join();
    const roster = ack.roster as Array<{ id: string; presence?: unknown }>;
    assert.equal(roster.length, 1, 'the roster holds the anchor and nothing else');
    assert.ok(!roster.some((r) => r.presence), 'no departed peer left a presence frame behind');
    fresh.close();
    await fresh.closed();
  } finally {
    anchor.close();
    await anchor.closed();
  }
});

test('a room’s own maps come back to baseline, and the replay filter stays bounded', async () => {
  // The map sizes are not reachable over a socket - `RoomSnapshot` is the admin
  // shape and deliberately carries counters, not internals - so this half drives
  // a Room directly (rooms.test.ts's shape) and reads `Room.internals()`, which
  // returns numbers and nothing else.
  const now = new Date().toISOString();
  const session: SessionRecord = {
    id: 'ses_churn', projectId: 'prj_churn', toolId: TOOL_ID, toolVersion: '1.0.0',
    inputs: {}, meta: {}, createdBy: 'u1', updatedBy: 'u1', rev: 1, updatedAt: now,
  };
  const room = Room.create(session);
  const seat = (id: string): RoomMember & { sent: ServerFrame[] } => {
    const sent: ServerFrame[] = [];
    return { id, userId: `user-${id}`, name: id, role: 'writer', opVersion: CANVAS_OP_VERSION, send: (f) => { sent.push(f); }, sent };
  };
  const anchor = seat('anchor');
  room.join(anchor);
  const baseline = room.internals();
  assert.deepEqual(
    { members: baseline.members, joinedAt: baseline.joinedAt, presence: baseline.presence },
    { members: 1, joinedAt: 1, presence: 0 },
  );

  for (let i = 0; i < CHURN_CYCLES; i++) {
    const m = seat(`m${i}`);
    room.join(m);
    room.relayPresence(m, { cursor: { x: 0.5, y: 0.5 }, selection: [`row-${i}`] });
    // A distinct peer-chosen client id per cycle - the worst case for the replay
    // filter, which is keyed by exactly that.
    room.applyOps(m, [{ k: 'param', key: 'title', value: `v${i}`, origin: { client: `churn-${i}`, clock: 1 } }]);
    room.leave(m.id);
  }

  const after = room.internals();
  assert.equal(after.members, 1, 'members returns to the anchor');
  assert.equal(after.joinedAt, 1, 'the join-time map tracks membership exactly — no orphan entries');
  assert.equal(after.presence, 0, 'every departed peer’s presence frame is gone');
  assert.equal(after.paramKeys, 1, 'the document grew by the keys that were written, not by the churn');
  assert.equal(after.trackedClients, CHURN_CYCLES, 'one replay-filter entry per distinct client id seen');

  // The filter does NOT empty on leave, by design (`noteClock`: a replay must be
  // recognisable across a reconnect, so the entry outlives the socket). What
  // bounds it is eviction - so the assertion is the CEILING, tested by exceeding
  // it rather than by trusting the constant.
  for (let i = CHURN_CYCLES; i < MAX_TRACKED_CLIENTS + 200; i++) {
    room.applyOps(anchor, [{ k: 'param', key: 'title', value: 'v', origin: { client: `churn-${i}`, clock: 1 } }]);
  }
  assert.equal(
    room.internals().trackedClients, MAX_TRACKED_CLIENTS,
    'the replay filter evicts rather than grows — a peer-chosen key can never be an unbounded map',
  );
  room.leave(anchor.id);
  assert.deepEqual(
    { members: room.internals().members, joinedAt: room.internals().joinedAt, presence: room.internals().presence },
    { members: 0, joinedAt: 0, presence: 0 },
    // Precisely these THREE maps, not "all member state" - `seenUsers` and
    // `opsByUser` (the audit-rollup accounting) are never cleared on leave, by
    // design, and `RoomInternals` does not expose them; see its doc comment.
    'an empty room holds no seated-member, join-time or presence state left over',
  );
});

// ── 4. presence storm ─────────────────────────────────────────────────────────

test('a presence storm inside the cap is relayed, costs the store nothing, and dies with the sender', async () => {
  const seed = await makeSession({ title: 'stormy' });
  const sender = new Client(seed, cookieFor('soak0@test'));
  const peer = new Client(seed, cookieFor('soak1@test'));
  await sender.join();
  await peer.join();
  await sender.next('peer-join');

  const before = {
    audit: (await store.listAudit()).length,
    revisions: (await store.listSessionRevisions(seed)).length,
    session: await store.getSession(seed),
  };

  // One frame under the per-second ceiling: relayed, not disconnected. The chat
  // string is a marker no other frame carries, so "did any of this reach a store
  // row" is answerable by searching the log for it.
  const MARKER = 'presence-marker-e7f3';
  const storm = PRESENCE_FRAMES_PER_SEC - 1;
  for (let i = 0; i < storm; i++) {
    sender.send({ t: 'presence', frame: { cursor: { x: i / storm, y: 0.5 }, selection: [`row-${i}`], chat: MARKER } });
  }
  await peer.until(() => peer.presenceReceived >= storm, `${storm} relayed presence frames`);
  assert.equal(peer.presenceReceived, storm, 'every frame inside the cap was relayed, none coalesced away');
  assert.equal(sender.closeCode, null, 'a storm inside the cap does not disconnect');
  assert.equal(peer.closeCode, null);

  // Not one byte of it reached the store: presence has no route there (rooms.ts
  // owns the whole path and imports no store), and it must not have tripped the
  // snapshot cadence either - that is driven by op BATCHES, and there were none.
  const audit = await store.listAudit();
  assert.equal(audit.length, before.audit, 'no audit row — presence is never an event');
  assert.equal((await store.listSessionRevisions(seed)).length, before.revisions, 'no revision');
  assert.equal(await store.getCollabSnapshot(seed), null, 'no room-snapshot row');
  const session = await store.getSession(seed);
  assert.equal(session?.rev, before.session?.rev, 'the session record did not move');
  assert.deepEqual(session?.inputs, before.session?.inputs);
  const everything = JSON.stringify([audit, session, await store.listSessionRevisions(seed)]);
  assert.ok(!everything.includes(MARKER), 'no presence payload anywhere the store can be read');
  assert.ok(!everything.includes('row-7'), 'not the selection either');

  // And it is ephemeral: the sender leaves, and the frame leaves with it.
  sender.close();
  await sender.closed();
  await peer.next('peer-leave');
  const late = new Client(seed, cookieFor('late@test'));
  const ack = await late.join();
  const roster = ack.roster as Array<{ id: string; presence?: unknown }>;
  assert.equal(roster.length, 1, 'only the peer is still seated');
  assert.ok(!roster.some((r) => r.presence), 'the departed sender’s presence is gone, not remembered');

  peer.close();
  late.close();
  await Promise.all([peer.closed(), late.closed()]);
});
