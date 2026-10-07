// SPDX-License-Identifier: MPL-2.0
/**
 * Live collaboration acceptance over the real WebSocket protocol (plan 76
 * milestone 4, spec 2.16 W3 and 2.18 T1-P).
 *
 * LOCAL (default): starts this branch's HTTP app and collab gateway on a free
 * port, with dev sign-in, a private pack and a memory store (or, with
 * `--postgres`, a disposable PostgreSQL cluster made with `initdb`; set
 * LOLLY_PG_BIN when it is not on PATH). It then plays several people against it
 * with real sockets and HTTP calls, and checks the upgrade gates, joining, the
 * op lanes and vetoes, presence, editing claims, live comment events, saved
 * versions and restores, closing, and the socket ceilings. It ends with the
 * comment latency probe below. Nothing outside the process is touched.
 *
 * REMOTE (`--base`): runs ONLY the comment latency probe (T1-P) against a
 * deployed instance, as two people whose session cookies are read from files:
 * the owner posts `--samples` comments `--spacing-ms` apart on `--session`; the
 * member, connected to that document's room, times the `comment` frame and the
 * single-thread fetch from the owner's POST response. Each probe message is
 * deleted afterwards. Run it only when the release plan authorizes it.
 *
 *   node scripts/collab-ws-acceptance.ts [--postgres] [--samples 20] [--spacing-ms 150] [--out evidence.json]
 *   node scripts/collab-ws-acceptance.ts --base https://host --owner-cookie-file a.txt --member-cookie-file b.txt \
 *        --session ses_x [--samples 20] [--spacing-ms 3000] [--out evidence.json]
 *
 * Exit 0 when every check passes (and the latency p95 is within 1 s), else 1.
 * The evidence file holds check names, timings and counts; never a cookie.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';

import { CANVAS_OP_VERSION, ReferenceCanvasDoc, type CanvasCheckpoint, type CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { buildApp } from '../server/src/api/app.ts';
import { createCollabGateway, COLLAB_WS_PREFIX, type CollabGateway } from '../server/src/collab/gateway.ts';
import { MAX_OPS_PER_MESSAGE } from '../server/src/collab/rooms.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { Store, UserRecord } from '../server/src/store/types.ts';

const { values: args } = parseArgs({ options: {
  postgres: { type: 'boolean', default: false },
  base: { type: 'string' },
  'owner-cookie-file': { type: 'string' },
  'member-cookie-file': { type: 'string' },
  session: { type: 'string' },
  samples: { type: 'string' },
  'spacing-ms': { type: 'string' },
  out: { type: 'string' },
} });
const REMOTE = typeof args.base === 'string';
const SAMPLES = Number(args.samples ?? 20);
const SPACING_MS = Number(args['spacing-ms'] ?? (REMOTE ? 3000 : 150));
const LATENCY_BUDGET_MS = 1000;
if (!Number.isInteger(SAMPLES) || SAMPLES < 1 || SAMPLES > 200 || !Number.isFinite(SPACING_MS) || SPACING_MS < 0) {
  console.error('--samples must be 1 to 200 and --spacing-ms a number of milliseconds');
  process.exit(2);
}

// ── the record ────────────────────────────────────────────────────────────────

interface Check { id: number; name: string; ok: boolean; ms: number; detail?: string }
const checks: Check[] = [];
async function check(name: string, run: () => Promise<string | void> | string | void): Promise<void> {
  const started = performance.now();
  try {
    const detail = await run();
    checks.push({ id: checks.length + 1, name, ok: true, ms: Math.round(performance.now() - started), ...(detail ? { detail } : {}) });
    console.log(`  ok   ${String(checks.length).padStart(2)} ${name}${detail ? ` (${detail})` : ''}`);
  } catch (error) {
    const detail = (error as Error)?.message?.split('\n')[0] ?? String(error);
    checks.push({ id: checks.length + 1, name, ok: false, ms: Math.round(performance.now() - started), detail });
    console.log(`  FAIL ${String(checks.length).padStart(2)} ${name}: ${detail}`);
  }
}

// ── a socket client ───────────────────────────────────────────────────────────

interface Frame { t: string; [key: string]: unknown }

class Client {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  readonly opened: Promise<void>;
  readonly status: Promise<number | null>;
  private readonly ws: WebSocket;
  constructor(url: string, cookie: string | undefined, origin?: string) {
    this.ws = new WebSocket(url, { headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });
    let settle: (status: number | null) => void = () => {};
    this.status = new Promise((resolve) => { settle = resolve; });
    this.ws.on('unexpected-response', (_req, res) => { settle(res.statusCode ?? null); res.resume(); });
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => { settle(101); resolve(); });
      this.ws.once('error', (error) => { settle(null); reject(error); });
    });
    this.opened.catch(() => undefined);
    this.ws.on('message', (data) => { this.frames.push(JSON.parse(String(data)) as Frame); });
    this.ws.on('close', (code) => { this.closeCode = code; });
    this.ws.on('error', () => undefined);
  }
  /** The first frame of type `t` received after index `after`. */
  async next(t: string, after = 0, timeoutMs = 3000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.slice(after).find((f) => f.t === t);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no '${t}' frame within ${timeoutMs} ms`);
      await sleep(5);
    }
  }
  count(t: string, after = 0): number { return this.frames.slice(after).filter((f) => f.t === t).length; }
  get mark(): number { return this.frames.length; }
  async join(extra: Record<string, unknown> = {}): Promise<Frame> {
    await this.opened;
    const mark = this.mark;
    this.send({ t: 'join', opVersion: CANVAS_OP_VERSION, presenceVersion: 1, interactionVersion: 1, ...extra });
    return this.next('join-ack', mark);
  }
  send(frame: unknown): void { this.ws.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); }
  async closed(timeoutMs = 3000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null) {
      if (Date.now() > deadline) throw new Error('the socket stayed open');
      await sleep(5);
    }
    return this.closeCode;
  }
  async close(): Promise<void> {
    if (this.closeCode !== null) return;
    this.ws.close();
    await this.closed().catch(() => undefined);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? NaN;
};
let counter = 0;
const id = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${(++counter).toString(36)}`;

// ── the latency probe (local and remote) ─────────────────────────────────────

interface Latency { samples: number; frame: { p50: number; p95: number; max: number }; thread: { p50: number; p95: number; max: number }; missed: number }

async function latencyProbe(base: string, ownerCookie: string, memberCookie: string, sessionId: string): Promise<Latency> {
  const wsBase = base.replace(/^http/, 'ws');
  const member = new Client(`${wsBase}${COLLAB_WS_PREFIX}${encodeURIComponent(sessionId)}`, memberCookie, base);
  await member.join();
  const frameMs: number[] = [];
  const threadMs: number[] = [];
  const posted: Array<{ threadId: string; messageId: string; revision: number }> = [];
  let missed = 0;
  try {
    for (let i = 0; i < SAMPLES; i++) {
      if (i) await sleep(SPACING_MS);
      const threadId = id('thr_probe');
      const messageId = id('msg_probe');
      const mark = member.mark;
      const res = await fetch(`${base}/api/v1/sessions/${sessionId}/comments`, { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ id: threadId, messageId, anchor: { kind: 'canvas', surface: 'probe', x: 10 + i, y: 10 }, body: `Latency probe ${i + 1} of ${SAMPLES}` }) });
      const answered = performance.now();
      if (res.status !== 201) throw new Error(`comment POST answered ${res.status}`);
      const { thread } = await res.json() as { thread: { revision: number } };
      posted.push({ threadId, messageId, revision: thread.revision });
      try {
        const deadline = Date.now() + 5000;
        let frame: Frame | undefined;
        while (!frame) {
          frame = member.frames.slice(mark).find((f) => f.t === 'comment' && f.threadId === threadId);
          if (frame) break;
          if (Date.now() > deadline) throw new Error('missed');
          await sleep(2);
        }
        frameMs.push(performance.now() - answered);
        const fetched = await fetch(`${base}/api/v1/sessions/${sessionId}/comments/${threadId}`, { headers: { cookie: memberCookie } });
        if (fetched.status !== 200) throw new Error(`thread GET answered ${fetched.status}`);
        await fetched.arrayBuffer();
        threadMs.push(performance.now() - answered);
      } catch (error) {
        if ((error as Error).message !== 'missed') throw error;
        missed++;
      }
    }
  } finally {
    await member.close();
    // Leave no probe text behind: each probe message is deleted (the thread
    // then reads as a deleted message to anyone who opens it).
    for (const p of posted) {
      await fetch(`${base}/api/v1/sessions/${sessionId}/comments/${p.threadId}`, { method: 'POST', headers: { cookie: ownerCookie, 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ action: 'delete', messageId: p.messageId, revision: p.revision }) }).then((r) => r.arrayBuffer()).catch(() => undefined);
    }
  }
  const tenth = (ms: number) => Math.round(ms * 10) / 10;
  const stats = (values: number[]) => ({ p50: tenth(percentile(values, 50)), p95: tenth(percentile(values, 95)), max: tenth(Math.max(...values)) });
  return { samples: SAMPLES, frame: stats(frameMs), thread: stats(threadMs), missed };
}

// ── local mode ────────────────────────────────────────────────────────────────

interface Local {
  base: string; wsBase: string; store: Store; collab: CollabGateway; server: Server;
  cookies: Map<string, string>; users: Map<string, UserRecord>; guestCookie: string; close(): Promise<void>;
}

async function startLocal(): Promise<Local> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-ws-acceptance-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', 'design'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design', inputs: [
    { id: 'title', type: 'text' }, { id: 'locked', type: 'text' }, { id: 'slides', type: 'blocks' },
  ] }));
  let closeDatabase = async () => {};
  let store: Store;
  if (args.postgres) {
    const { createCollabPostgresFixture } = await import('../tests/collab/postgres-fixture.ts');
    const fixture = await createCollabPostgresFixture();
    store = fixture.store;
    closeDatabase = fixture.close;
    console.log(`database: disposable ${fixture.version}`);
  } else {
    store = createMemoryStore();
    console.log('database: memory store');
  }
  const people = [
    ['owner', 'Olive Owner', ['team']], ['alice', 'Alice Editor', ['team']], ['bob', 'Bob Editor', ['team']],
    ['vic', 'Vic Viewer', ['team']], ['rita', 'Rita Reader', ['team']], ['olga', 'Olga Outsider', ['elsewhere']],
  ] as const;
  const config = parseConfig(JSON.stringify({
    instance: { name: 'WebSocket acceptance', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    policy: { guestLinks: { enabled: true } },
    dev: { enabled: true, users: people.map(([name, display, groups]) => ({ email: `${name}@acceptance.test`, name: display, groups })) },
  }));
  const secrets = { session: 'ws-acceptance-session', link: 'ws-acceptance-link' };
  const collab = createCollabGateway({ config, store, secrets, pingIntervalMs: 500 });
  const app = buildApp({ config, store, secrets, listCollabRooms: () => collab.snapshot(), projectPresence: (p) => collab.projectPresence(p),
    agentRooms: collab.agents, roomEvents: (sessionId, frame) => collab.notifyComment(sessionId, frame), versionRooms: collab.versions });
  const server = createServer((req, res) => void app(req, res));
  server.on('upgrade', (req, socket, head) => { if (!collab.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  config.instance.baseUrl = base;
  const cookies = new Map<string, string>();
  const users = new Map<string, UserRecord>();
  for (const [name] of people) {
    const res = await fetch(`${base}/api/auth/dev?email=${name}@acceptance.test`, { redirect: 'manual' });
    assert.equal(res.status, 302, `dev sign-in for ${name}`);
    cookies.set(name, res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    users.set(name, (await store.findUsersByEmail(`${name}@acceptance.test`))[0]!);
  }
  const now = new Date().toISOString();
  const owner = users.get('owner')!;
  await store.putProject({ id: 'prj_acceptance', name: 'Acceptance', visibility: 'private', ownerId: owner.id, createdAt: now });
  for (const [name, role] of [['alice', 'editor'], ['bob', 'editor'], ['vic', 'viewer'], ['rita', 'viewer']] as const) {
    await store.putProjectMember({ projectId: 'prj_acceptance', userId: users.get(name)!.id, role, addedBy: owner.id, addedAt: now });
  }
  for (const [sessionId, inputs] of [
    ['ses_live', { title: 'Draft', locked: 'Approved', slides: [{ id: 's1', heading: 'One' }, { id: 's2', heading: 'Two' }] }],
    ['ses_gone', { title: 'Deleted' }],
    ['ses_probe', { title: 'Latency' }],
    ['ses_ceilings', { title: 'Ceilings' }],
  ] as const) {
    await store.putSession({ id: sessionId, projectId: 'prj_acceptance', toolId: 'design', toolVersion: '1', inputs, meta: { label: sessionId },
      createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: now, ...(sessionId === 'ses_gone' ? { deletedAt: now } : {}) });
  }
  // Rita may join the room but not read its comments.
  await store.putGrant({ principal: `user:${users.get('rita')!.id}`, action: 'comment.view', resource: 'session:ses_live', effect: 'deny' });
  await store.putOverlay({ toolId: 'design', version: 1, inputAccess: { locked: [{ groups: ['team'], level: 'locked', value: 'Approved' }] } });
  await store.putGrant({ principal: `user:${owner.id}`, action: 'link.create-guest', resource: '*', effect: 'allow' });
  const link = await fetch(`${base}/api/v1/links`, { method: 'POST', headers: { cookie: cookies.get('owner')!, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'guest-edit', target: { toolId: 'design', sessionId: 'ses_live' }, projectId: 'prj_acceptance' }) });
  assert.equal(link.status, 201, `guest link: ${await link.clone().text()}`);
  const url = new URL((await link.json() as { url: string }).url);
  const opened = await fetch(`${base}${url.pathname}${url.search}&name=Gail`);
  const guestCookie = opened.headers.getSetCookie().find((c) => c.startsWith('lw_guest='))!.split(';')[0]!;
  return {
    base, wsBase: `ws://127.0.0.1:${port}`, store, collab, server, cookies, users, guestCookie,
    async close() {
      collab.close();
      await collab.drain();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDatabase();
      await rm(pack, { recursive: true, force: true });
    },
  };
}

async function runLocal(): Promise<Latency> {
  const l = await startLocal();
  const ws = (sessionId: string, who: string | null, origin?: string) =>
    new Client(`${l.wsBase}${COLLAB_WS_PREFIX}${sessionId}`, who === null ? undefined : who === 'guest' ? l.guestCookie : l.cookies.get(who), origin);
  const http = (who: string, method: string, path: string, body?: unknown) => fetch(`${l.base}${path}`, {
    method, headers: { cookie: l.cookies.get(who)!, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const S = 'ses_live';
  const param = (key: string, value: string, client: string, clock: number) => ({ k: 'param', key, value, origin: { client, clock } });
  const ops = (client: Client, list: unknown[], batch = id('batch')) => {
    const ids = list.map(() => id('op'));
    client.send({ t: 'ops', batchId: batch, ids, ops: list });
    return { batch, ids };
  };
  const receiptOf = async (client: Client, batch: string, after: number) => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const found = client.frames.slice(after).find((f) => f.t === 'receipt' && f.batchId === batch);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no receipt for ${batch}`);
      await sleep(5);
    }
  };
  const errorOf = (client: Client, code: string, after: number) => client.next('error', after).then(async () => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const found = client.frames.slice(after).find((f) => f.t === 'error' && f.code === code);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${code} error`);
      await sleep(5);
    }
  });
  const revisionsOf = async (sessionId: string) => ((await (await http('owner', 'GET', `/api/v1/sessions/${sessionId}/revisions`)).json()) as { revisions: Array<{ rev: number; actor: string }> }).revisions;

  console.log('upgrade gates');
  await check('an anonymous upgrade is refused 401', async () => assert.equal(await ws(S, null).status, 401));
  await check('a browser Origin from another site is refused 403', async () => assert.equal(await ws(S, 'alice', 'https://elsewhere.example').status, 403));
  await check('a person outside the project is refused 403', async () => assert.equal(await ws(S, 'olga').status, 403));
  await check('an unknown document is 404', async () => assert.equal(await ws('ses_missing', 'alice').status, 404));
  await check('a deleted document is 410', async () => assert.equal(await ws('ses_gone', 'alice').status, 410));
  await check('a design-system claim from another instance is refused 403', async () =>
    assert.equal(await new Client(`${l.wsBase}${COLLAB_WS_PREFIX}${S}?dsi=https://other.example`, l.cookies.get('alice')).status, 403));

  console.log('joining');
  const owner = ws(S, 'owner'), alice = ws(S, 'alice'), vic = ws(S, 'vic'), rita = ws(S, 'rita');
  let ack: Frame = { t: '' };
  await check('the owner joins and receives the whole document', async () => {
    ack = await owner.join();
    assert.equal((ack.docState as { params: Record<string, unknown> }).params.title, 'Draft');
    assert.equal(ack.opVersion, CANVAS_OP_VERSION);
    assert.ok(ack.you && ack.checkpoint, 'you and checkpoint');
  });
  await check('an editor joins and the owner is told', async () => {
    const mark = owner.mark;
    const joined = await alice.join();
    assert.equal(((joined.you as { role: string }).role), 'writer');
    const peer = await owner.next('peer-join', mark);
    assert.equal((peer.member as { name: string }).name, 'Alice Editor');
  });
  await check('a viewer joins as an observer and is told why', async () => {
    const joined = await vic.join();
    assert.deepEqual([(joined.you as { role: string }).role, joined.notice], ['observer', 'no-edit-grant']);
  });
  await check('a late joiner sees everyone else in the roster, never itself', async () => {
    const joined = await rita.join();
    const roster = (joined.roster as Array<{ name: string }>).map((r) => r.name).sort();
    assert.deepEqual(roster, ['Alice Editor', 'Olive Owner', 'Vic Viewer']);
  });

  console.log('edits');
  const revisionsAtStart = (await revisionsOf(S)).length;
  let first = { batch: '', ids: [] as string[] };
  await check('an editor\'s edit is accepted with a durable receipt and reaches every peer', async () => {
    const marks = [alice.mark, owner.mark, vic.mark] as const;
    first = ops(alice, [param('title', 'Edited live', 'alice', 1)]);
    const receipt = await receiptOf(alice, first.batch, marks[0]);
    assert.deepEqual([receipt.acceptedIds, receipt.rejectedIds], [first.ids, []]);
    assert.equal(receipt.durableRevision, 2);
    for (const [client, mark] of [[owner, marks[1]], [vic, marks[2]]] as const) {
      const frame = await client.next('ops', mark);
      assert.equal((frame.ops as Array<{ value: unknown }>)[0]?.value, 'Edited live');
    }
  });
  await check('a replayed batch answers its receipt again and is not re-broadcast', async () => {
    const marks = [alice.mark, owner.mark] as const;
    alice.send({ t: 'ops', batchId: first.batch, ids: first.ids, ops: [param('title', 'Edited live', 'alice', 1)] });
    const receipt = await receiptOf(alice, first.batch, marks[0]);
    assert.deepEqual(receipt.acceptedIds, first.ids);
    await sleep(100);
    assert.equal(owner.count('ops', marks[1]), 0);
  });
  await check('an observer\'s edit is refused and receipted as rejected', async () => {
    const mark = vic.mark;
    const sent = ops(vic, [param('title', 'By a viewer', 'vic', 1)]);
    await errorOf(vic, 'OBSERVER_READ_ONLY', mark);
    assert.deepEqual((await receiptOf(vic, sent.batch, mark)).rejectedIds, sent.ids);
  });
  for (const [name, op, code] of [
    ['an undeclared input is refused', param('nonexistent', 'x', 'alice', 2), 'UNKNOWN_INPUT'],
    ['a scalar write to a blocks input is refused', param('slides', 'x', 'alice', 3), 'WRONG_LANE'],
    ['a locked input is refused', param('locked', 'Changed', 'alice', 4), 'INPUT_LOCKED'],
    ['a box op with no collection is refused', { k: 'field', id: 's1', field: 'heading', value: 'x', origin: { client: 'alice', clock: 5 } }, 'COLLECTION_REQUIRED'],
  ] as const) {
    await check(name, async () => {
      const mark = alice.mark;
      const sent = ops(alice, [op]);
      await errorOf(alice, code, mark);
      assert.deepEqual((await receiptOf(alice, sent.batch, mark)).rejectedIds, sent.ids);
    });
  }
  await check('a malformed op fails the whole batch', async () => {
    const mark = alice.mark;
    alice.send({ t: 'ops', batchId: id('bad'), ids: [id('op')], ops: [{ k: 'param', key: 'title' }] });
    await errorOf(alice, 'INVALID_OP', mark);
  });
  await check('live edits add no session revision', async () => assert.equal((await revisionsOf(S)).length, revisionsAtStart));

  console.log('presence and claims');
  await check('presence is relayed to peers', async () => {
    const mark = owner.mark;
    alice.send({ t: 'presence', frame: { v: 1, seq: 1, state: { cursor: { x: 5, y: 6 } } } });
    const frame = await owner.next('presence', mark);
    assert.ok(frame.from);
  });
  let claimId = '';
  await check('an editing claim is granted, and an overlapping one is refused', async () => {
    let mark = alice.mark;
    alice.send({ t: 'claim', requestId: id('claim'), action: 'acquire', target: { kind: 'text', collection: 'slides', ids: ['s1'], field: 'heading' } });
    const granted = await alice.next('claim-result', mark);
    claimId = (granted.claim as { id: string }).id;
    assert.ok(claimId);
    mark = owner.mark;
    owner.send({ t: 'claim', requestId: id('claim'), action: 'acquire', target: { kind: 'text', collection: 'slides', ids: ['s1'], field: 'heading' } });
    assert.equal((await owner.next('claim-result', mark)).reason, 'claimed');
  });
  await check('every peer is told the room\'s claims', async () => {
    const claims = owner.frames.filter((f) => f.t === 'claims').at(-1)?.claims as Array<{ id: string }> | undefined;
    assert.ok(claims?.some((c) => c.id === claimId));
  });

  console.log('live comment events');
  const guest = ws(S, 'guest');
  await guest.join();
  let threadId = '';
  await check('a new comment sends a frame to people who may read comments, within 1 s', async () => {
    const marks = new Map([owner, alice, vic, rita, guest].map((c) => [c, c.mark]));
    threadId = id('thr');
    const started = performance.now();
    const res = await http('owner', 'POST', `/api/v1/sessions/${S}/comments`, { id: threadId, messageId: id('msg'), anchor: { kind: 'canvas', surface: 'main', x: 1, y: 2 }, body: 'Please check the title' });
    assert.equal(res.status, 201);
    for (const client of [owner, alice, vic]) {
      const frame = await client.next('comment', marks.get(client));
      assert.deepEqual(Object.keys(frame).sort(), ['revision', 't', 'threadId'], 'ids and the revision only');
      assert.deepEqual([frame.threadId, frame.revision], [threadId, 1]);
    }
    const ms = Math.round(performance.now() - started);
    assert.ok(ms < 1000, `${ms} ms`);
    return `${ms} ms`;
  });
  await check('a member denied comment.view and a guest get no comment frame', async () => {
    await sleep(150);
    assert.equal(rita.count('comment'), 0);
    assert.equal(guest.count('comment'), 0);
  });
  await check('the changed thread is fetched on its own after the frame', async () => {
    const res = await http('alice', 'GET', `/api/v1/sessions/${S}/comments/${threadId}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { thread: { revision: number } }).thread.revision, 1);
  });
  await check('a reply sends the thread\'s next revision', async () => {
    const mark = owner.mark;
    const res = await http('alice', 'POST', `/api/v1/sessions/${S}/comments/${threadId}`, { action: 'reply', messageId: id('msg'), body: 'Done', revision: 1 });
    assert.equal(res.status, 200);
    assert.equal((await owner.next('comment', mark)).revision, 2);
  });

  console.log('versions');
  let named = '';
  await check('the version list answers people who may view', async () => {
    for (const who of ['vic', 'alice']) assert.equal((await http(who, 'GET', `/api/v1/sessions/${S}/versions`)).status, 200);
  });
  await check('an editor saves a named version of the live document', async () => {
    const res = await http('alice', 'POST', `/api/v1/sessions/${S}/versions`, { label: 'Before the restore', requestId: id('req') });
    assert.equal(res.status, 201);
    const { version } = await res.json() as { version: { id: string; kind: string; createdByName: string } };
    assert.deepEqual([version.kind, version.createdByName], ['named', 'Alice Editor']);
    named = version.id;
  });
  await check('a viewer cannot save or restore', async () => {
    assert.equal((await http('vic', 'POST', `/api/v1/sessions/${S}/versions`, { label: 'x', requestId: id('req') })).status, 403);
    assert.equal((await http('vic', 'POST', `/api/v1/sessions/${S}/versions/${named}/restore`, { requestId: id('req') })).status, 403);
  });
  const edit = ops(alice, [param('title', 'After the save', 'alice', 20), { k: 'remove', col: 'slides', id: 's2', origin: { client: 'alice', clock: 21 } }]);
  await receiptOf(alice, edit.batch, 0);
  let restoreBody: Record<string, unknown> = {};
  const restoreRequest = id('req');
  await check('a restore reaches everyone as one batch and every peer converges', async () => {
    const marks = new Map([owner, alice, vic].map((c) => [c, c.mark]));
    const res = await http('bob', 'POST', `/api/v1/sessions/${S}/versions/${named}/restore`, { requestId: restoreRequest });
    assert.equal(res.status, 200, await res.clone().text());
    restoreBody = await res.json() as Record<string, unknown>;
    assert.equal(restoreBody.live, true);
    for (const client of [owner, alice, vic]) {
      await client.next('ops', marks.get(client));
      assert.equal(client.count('ops', marks.get(client)), 1, 'one ops frame');
    }
    const late = ws(S, 'bob');
    const lateAck = await late.join();
    const view = (client: Client) => {
      const doc = new ReferenceCanvasDoc('acceptance');
      doc.restore(client.frames.find((f) => f.t === 'join-ack')!.checkpoint as CanvasCheckpoint);
      for (const frame of client.frames) if (frame.t === 'ops') for (const op of frame.ops as CanvasOp[]) doc.apply(op);
      return JSON.stringify(doc.state());
    };
    for (const client of [owner, alice, vic]) assert.equal(view(client), view(late));
    assert.equal((lateAck.docState as { params: Record<string, unknown> }).params.title, 'Edited live');
    await late.close();
  });
  await check('the restore cancelled the editing claims', async () => {
    const claims = owner.frames.filter((f) => f.t === 'claims').at(-1)?.claims as unknown[];
    assert.deepEqual(claims, []);
  });
  await check('the same request id answers with the first result', async () => {
    const res = await http('bob', 'POST', `/api/v1/sessions/${S}/versions/${named}/restore`, { requestId: restoreRequest });
    assert.deepEqual(await res.json(), restoreBody);
  });
  await check('Undo restores the version the restore replaced', async () => {
    const mark = owner.mark;
    const res = await http('bob', 'POST', `/api/v1/sessions/${S}/versions/${String(restoreBody.before)}/restore`, { requestId: id('req') });
    assert.equal(res.status, 200);
    const frame = await owner.next('ops', mark);
    assert.ok((frame.ops as Array<{ k: string; key?: string; value?: unknown }>).some((op) => op.key === 'title' && op.value === 'After the save'));
  });
  await check('an editor cannot delete a version; the owner can', async () => {
    assert.equal((await http('alice', 'DELETE', `/api/v1/sessions/${S}/versions/${named}`)).status, 403);
    assert.equal((await http('owner', 'DELETE', `/api/v1/sessions/${S}/versions/${named}`)).status, 200);
  });

  console.log('closing');
  // One more edit, so the closing version has content no earlier version has
  // (a version equal to the newest one is not written again).
  const last = ops(alice, [param('title', 'Final words', 'alice', 40)]);
  await receiptOf(alice, last.batch, 0);
  for (const client of [owner, alice, vic, rita, guest]) await client.close();
  await check('the room closes when its last member leaves', async () => {
    const deadline = Date.now() + 3000;
    while (l.collab.rooms() > 0) {
      if (Date.now() > deadline) throw new Error(`${l.collab.rooms()} rooms still open`);
      await sleep(10);
    }
  });
  await check('closing appends one revision, named "collab" for several writers', async () => {
    const revisions = await revisionsOf(S);
    assert.equal(revisions.length, revisionsAtStart + 1);
    assert.equal(revisions[0]?.actor, 'collab');
  });
  await check('closing writes a version with its contributors, named without email', async () => {
    const { versions } = await (await http('owner', 'GET', `/api/v1/sessions/${S}/versions`)).json() as { versions: Array<{ kind: string; contributors: Array<{ name: string }> }> };
    const close = versions.find((v) => v.kind === 'close');
    assert.ok(close, `kinds: ${versions.map((v) => v.kind).join(', ')}`);
    assert.ok(close.contributors.some((c) => c.name === 'Alice Editor'));
    assert.equal(JSON.stringify(versions).includes('@'), false);
  });
  await check('a reopened room starts from the stored document', async () => {
    const again = ws(S, 'alice');
    const reopened = await again.join();
    const stored = await l.store.getSession(S);
    assert.equal((reopened.docState as { params: Record<string, unknown> }).params.title, stored?.inputs.title);
    await again.close();
  });

  console.log('socket ceilings');
  await check(`more than ${MAX_OPS_PER_MESSAGE} ops in one message closes the socket (4009)`, async () => {
    const flood = ws('ses_ceilings', 'alice');
    await flood.join();
    flood.send({ t: 'ops', batchId: id('flood'), ids: [], ops: Array.from({ length: MAX_OPS_PER_MESSAGE + 1 }, (_, i) => param('title', `${i}`, 'flood', i + 1)) });
    assert.equal(await flood.closed(), 4009);
  });
  await check('a frame that is not JSON closes the socket (4004)', async () => {
    const broken = ws('ses_ceilings', 'alice');
    await broken.join();
    broken.send('not json');
    assert.equal(await broken.closed(), 4004);
  });
  await check('an unknown frame type is answered, not disconnected', async () => {
    const newer = ws('ses_ceilings', 'alice');
    await newer.join();
    const mark = newer.mark;
    newer.send({ t: 'from-the-future' });
    assert.equal((await newer.next('error', mark)).code, 'UNKNOWN_FRAME');
    assert.equal(newer.closeCode, null);
    await newer.close();
  });

  console.log(`comment latency probe (${SAMPLES} samples, ${SPACING_MS} ms apart)`);
  let latency: Latency = { samples: 0, frame: { p50: NaN, p95: NaN, max: NaN }, thread: { p50: NaN, p95: NaN, max: NaN }, missed: 0 };
  await check(`comment write to peer frame p95 within ${LATENCY_BUDGET_MS} ms`, async () => {
    latency = await latencyProbe(l.base, l.cookies.get('owner')!, l.cookies.get('alice')!, 'ses_probe');
    assert.equal(latency.missed, 0, `${latency.missed} frames missed`);
    assert.ok(latency.frame.p95 <= LATENCY_BUDGET_MS && latency.thread.p95 <= LATENCY_BUDGET_MS);
    return `frame p50 ${latency.frame.p50} ms, p95 ${latency.frame.p95} ms; thread p50 ${latency.thread.p50} ms, p95 ${latency.thread.p95} ms`;
  });
  await l.close();
  return latency;
}

// ── main ──────────────────────────────────────────────────────────────────────

const started = new Date().toISOString();
let latency: Latency;
if (REMOTE) {
  const base = String(args.base).replace(/\/+$/, '');
  if (!args['owner-cookie-file'] || !args['member-cookie-file'] || !args.session) {
    console.error('--base needs --owner-cookie-file, --member-cookie-file and --session');
    process.exit(2);
  }
  const cookieOf = async (file: string) => (await readFile(file, 'utf8')).trim().split(/;\s*/).find((c) => c.startsWith('lw_session=')) ?? '';
  const [ownerCookie, memberCookie] = await Promise.all([cookieOf(args['owner-cookie-file']), cookieOf(args['member-cookie-file'])]);
  if (!ownerCookie || !memberCookie) { console.error('each cookie file must hold an lw_session cookie'); process.exit(2); }
  console.log(`remote comment latency probe against ${base} (${SAMPLES} samples, ${SPACING_MS} ms apart)`);
  latency = { samples: 0, frame: { p50: NaN, p95: NaN, max: NaN }, thread: { p50: NaN, p95: NaN, max: NaN }, missed: 0 };
  await check(`comment write to peer frame p95 within ${LATENCY_BUDGET_MS} ms`, async () => {
    latency = await latencyProbe(base, ownerCookie, memberCookie, String(args.session));
    assert.equal(latency.missed, 0, `${latency.missed} frames missed`);
    assert.ok(latency.frame.p95 <= LATENCY_BUDGET_MS && latency.thread.p95 <= LATENCY_BUDGET_MS);
    return `frame p50 ${latency.frame.p50} ms, p95 ${latency.frame.p95} ms; thread p50 ${latency.thread.p50} ms, p95 ${latency.thread.p95} ms`;
  });
} else {
  latency = await runLocal();
}
const failed = checks.filter((c) => !c.ok);
const evidence = { kind: 'collab-ws-acceptance', mode: REMOTE ? 'remote' : args.postgres ? 'local-postgres' : 'local-memory',
  ...(REMOTE ? { base: String(args.base) } : {}), started, finished: new Date().toISOString(),
  passed: checks.length - failed.length, failed: failed.length, latency, checks };
if (args.out) await writeFile(args.out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${failed.length ? 'FAIL' : 'PASS'} collab WebSocket acceptance: ${checks.length - failed.length}/${checks.length} checks`);
process.exit(failed.length ? 1 : 0);
