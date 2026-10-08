// SPDX-License-Identifier: MPL-2.0
/**
 * Live comment events over a real socket (plan 76 milestone 4, spec 2.7, rule
 * S-9): after a saved comment write, the people in the session's live room get
 * `{ t: 'comment', threadId, revision }` and fetch only that thread.
 *
 * Wired as main.ts wires it: the gateway on upgrade, the HTTP app on request,
 * and the app's `roomEvents` bridge calling `collab.notifyComment`. The rules
 * proven here:
 *
 *   - every comment write kind (create, reply, edit, resolve, reopen, delete)
 *     sends one frame with the thread's new revision, and reads send none;
 *   - the frame carries ids and the revision only, never text or names;
 *   - only seats admitted as people who may read the session's comments
 *     receive it: not guests, not agent seats, not a member whose `comment.view`
 *     is denied, not a room for another session;
 *   - a member who loses comment access stops receiving frames at the next
 *     seat re-check without losing the seat, and gets them back the same way;
 *   - telling a session with no open room opens nothing.
 *
 * Room-level cases (frame rebuilding, invalid ids, `peek`) live in
 * tests/collab/rooms.test.ts.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import type { CommentThread } from '@lolly-tools/core/canvas-review-v1';
import { parseConfig, type InstanceConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { buildApp } from '../../server/src/api/app.ts';
import { createCollabGateway, COLLAB_WS_PREFIX, type CollabGateway } from '../../server/src/collab/gateway.ts';
import type { UserRecord } from '../../server/src/store/types.ts';

const SECRETS = { session: 'events-session', link: 'events-link' };
// Agent seats are offered only on `design` sessions (agents/access.ts).
const TOOL_ID = 'design';
const SESSION = 'ses_events';
const OTHER_SESSION = 'ses_elsewhere';
// Rooms hold a database lease, so a second gateway gets sessions of its own.
const RECHECK_SESSION = 'ses_recheck';
const OFF_SESSION = 'ses_off';
// Never joined by anyone.
const IDLE_SESSION = 'ses_idle';
const PATH = `/api/v1/sessions/${SESSION}/comments`;

let server: Server;
let collab: CollabGateway;
let config: InstanceConfig;
let store: ReturnType<typeof createMemoryStore>;
let base = '';
let wsBase = '';
const cookies = new Map<string, string>();
const users = new Map<string, UserRecord>();
let guestCookie = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-comment-events-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', TOOL_ID), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL_ID, 'tool.json'), JSON.stringify({ id: TOOL_ID, inputs: [{ id: 'title', type: 'text' }] }));

  config = parseConfig(JSON.stringify({
    instance: { name: 'Comment Events', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'alice@test', name: 'Alice Owner', groups: ['team-eng'] },
        { email: 'bob@test', name: 'Bob Editor', groups: ['team-eng'] },
        { email: 'vic@test', name: 'Vic Viewer', groups: ['team-ops'] },
        { email: 'rita@test', name: 'Rita Reader', groups: ['team-ops'] },
        { email: 'olga@test', name: 'Olga Elsewhere', groups: ['team-sales'] },
      ],
    },
  }));
  store = createMemoryStore();
  collab = createCollabGateway({ config, store, secrets: SECRETS });
  const app = buildApp({
    config, store, secrets: SECRETS, listCollabRooms: () => collab.snapshot(),
    roomEvents: (id, frame) => collab.notifyComment(id, frame),
  });
  server = createServer((req, res) => void app(req, res));
  server.on('upgrade', (req, socket, head) => {
    if (!collab.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;

  for (const name of ['admin', 'alice', 'bob', 'vic', 'rita', 'olga']) {
    const res = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    cookies.set(name, res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    users.set(name, (await store.findUsersByEmail(`${name}@test`))[0]!);
  }
  const now = new Date().toISOString();
  const alice = users.get('alice')!, olga = users.get('olga')!;
  await store.putProject({ id: 'prj_events', ownerId: alice.id, name: 'Events', visibility: 'private', createdAt: now, updatedAt: now });
  for (const [name, role] of [['bob', 'editor'], ['vic', 'viewer'], ['rita', 'viewer']] as const) {
    await store.putProjectMember({ projectId: 'prj_events', userId: users.get(name)!.id, role, addedBy: alice.id, addedAt: now });
  }
  for (const id of [SESSION, RECHECK_SESSION, OFF_SESSION, IDLE_SESSION]) {
    await store.putSession({ id, projectId: 'prj_events', toolId: TOOL_ID, toolVersion: '1', inputs: { title: 'Draft' }, meta: {},
      createdBy: alice.id, updatedBy: alice.id, rev: 1, updatedAt: now });
  }
  await store.putProject({ id: 'prj_elsewhere', ownerId: olga.id, name: 'Elsewhere', visibility: 'private', createdAt: now, updatedAt: now });
  await store.putSession({ id: OTHER_SESSION, projectId: 'prj_elsewhere', toolId: TOOL_ID, toolVersion: '1', inputs: { title: 'Other' }, meta: {},
    createdBy: olga.id, updatedBy: olga.id, rev: 1, updatedAt: now });
  // Rita stays a viewer who may join the room, but may not read this session's comments.
  await store.putGrant({ principal: `user:${users.get('rita')!.id}`, action: 'comment.view', resource: `session:${SESSION}`, effect: 'deny' });

  // A real guest-edit link and the cookie its resolver hands out.
  const link = await call('admin', 'POST', '/api/v1/links', { kind: 'guest-edit', target: { toolId: TOOL_ID, sessionId: SESSION }, projectId: 'prj_events' });
  assert.equal(link.status, 201, await link.clone().text());
  const url = new URL((await link.json() as { url: string }).url);
  const opened = await fetch(`${base}${url.pathname}${url.search}&name=Sam`);
  assert.equal(opened.status, 200);
  guestCookie = opened.headers.getSetCookie().find((c) => c.startsWith('lw_guest='))!.split(';')[0]!;
});

after(() => {
  collab.close();
  server.closeAllConnections();
  server.close();
});

const call = (name: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method,
  headers: { cookie: cookies.get(name)!, ...(body ? { 'content-type': 'application/json' } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

// ── ws client (tests/collab/gateway.test.ts's helper, trimmed) ────────────────

interface Frame { t: string; [k: string]: unknown }

class Client {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private waiters: Array<{ t: string; resolve: (f: Frame) => void }> = [];
  private readonly consumed = new Set<Frame>();

  constructor(session: string, cookie: string, socketBase = wsBase) {
    this.ws = new WebSocket(`${socketBase}${COLLAB_WS_PREFIX}${session}`, { headers: { cookie } });
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.ready.catch(() => undefined);
    this.ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      this.frames.push(frame);
      const waiter = this.waiters.find((w) => w.t === frame.t);
      if (waiter) {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        this.consumed.add(frame);
        waiter.resolve(frame);
      }
    });
    this.ws.on('close', (code) => { this.closeCode = code; });
    this.ws.on('error', () => undefined);
  }

  /** The next unconsumed frame of type `t` (frames already received count). */
  next(t: string, timeoutMs = 2000): Promise<Frame> {
    const seen = this.frames.find((f) => f.t === t && !this.consumed.has(f));
    if (seen) {
      this.consumed.add(seen);
      return Promise.resolve(seen);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for '${t}' frame`)), timeoutMs);
      this.waiters.push({ t, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  }

  async join(): Promise<Frame> {
    await this.ready;
    this.ws.send(JSON.stringify({ t: 'join', opVersion: CANVAS_OP_VERSION }));
    return this.next('join-ack');
  }

  comments(): Frame[] {
    return this.frames.filter((f) => f.t === 'comment');
  }

  async close(): Promise<void> {
    if (this.closeCode !== null) return;
    const closed = new Promise<void>((resolve) => this.ws.once('close', () => resolve()));
    this.ws.close();
    await closed;
  }
}

/** No `comment` frame reaches any of `clients` within `ms`. */
async function noCommentFrames(clients: Client[], ms = 250): Promise<void> {
  const before = clients.map((c) => c.comments().length);
  await new Promise((r) => setTimeout(r, ms));
  clients.forEach((c, i) => assert.equal(c.comments().length, before[i], 'no comment frame expected'));
}

async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const anchor = { kind: 'canvas', surface: 'page', x: 0.5, y: 0.5 };
const threadOf = async (res: Response): Promise<CommentThread> => {
  assert.ok(res.status === 200 || res.status === 201, `comment write answered ${res.status}: ${await res.clone().text()}`);
  return (await res.json() as { thread: CommentThread }).thread;
};

// ── writes and reads ──────────────────────────────────────────────────────────

test('every saved comment write sends one frame with the new revision; reads send none', async () => {
  const alice = new Client(SESSION, cookies.get('alice')!);
  const bob = new Client(SESSION, cookies.get('bob')!);
  try {
    await alice.join();
    await bob.join();

    const expectFrame = async (thread: CommentThread) => {
      for (const peer of [alice, bob]) {
        assert.deepEqual(await peer.next('comment'), { t: 'comment', threadId: thread.id, revision: thread.revision });
      }
    };

    let thread = await threadOf(await call('alice', 'POST', PATH, { id: 'th_writes', messageId: 'm1', anchor, body: 'Move the logo left.' }));
    assert.equal(thread.revision, 1);
    await expectFrame(thread);
    thread = await threadOf(await call('bob', 'POST', `${PATH}/th_writes`, { revision: thread.revision, action: 'reply', messageId: 'm2', body: 'On it.' }));
    await expectFrame(thread);
    thread = await threadOf(await call('bob', 'POST', `${PATH}/th_writes`, { revision: thread.revision, action: 'edit', messageId: 'm2', body: 'Done.' }));
    await expectFrame(thread);
    thread = await threadOf(await call('alice', 'POST', `${PATH}/th_writes`, { revision: thread.revision, action: 'resolve' }));
    await expectFrame(thread);
    thread = await threadOf(await call('alice', 'POST', `${PATH}/th_writes`, { revision: thread.revision, action: 'reopen' }));
    await expectFrame(thread);
    thread = await threadOf(await call('bob', 'POST', `${PATH}/th_writes`, { revision: thread.revision, action: 'delete', messageId: 'm2' }));
    await expectFrame(thread);
    assert.equal(thread.revision, 6);

    // No text and no names ride on any frame.
    for (const frame of [...alice.comments(), ...bob.comments()]) {
      assert.deepEqual(Object.keys(frame).sort(), ['revision', 't', 'threadId']);
    }
    assert.ok(!JSON.stringify([...alice.frames, ...bob.frames]).includes('Move the logo'), 'comment text never reaches the socket');

    // Reads, and a refused write, change nothing and tell nobody.
    assert.equal((await call('bob', 'GET', PATH)).status, 200);
    assert.equal((await call('bob', 'GET', `${PATH}/th_writes`)).status, 200);
    assert.equal((await call('bob', 'POST', `/api/v1/sessions/${SESSION}/comment-reads`, { threadIds: ['th_writes'] })).status, 200);
    assert.equal((await call('bob', 'POST', `${PATH}/th_writes`, { revision: 1, action: 'reply', messageId: 'm3', body: 'Stale.' })).status, 409);
    await noCommentFrames([alice, bob]);
    assert.equal(alice.comments().length, 6);
    assert.equal(bob.comments().length, 6);
  } finally {
    await alice.close();
    await bob.close();
  }
});

// ── who receives a frame ──────────────────────────────────────────────────────

test('frames reach only people who may read the comments: not guests, agents, denied members or other rooms', async () => {
  const alice = new Client(SESSION, cookies.get('alice')!);
  const vic = new Client(SESSION, cookies.get('vic')!);
  const rita = new Client(SESSION, cookies.get('rita')!);
  const guest = new Client(SESSION, guestCookie);
  const olga = new Client(OTHER_SESSION, cookies.get('olga')!);
  const now = new Date().toISOString();
  const agent = {
    id: 'agt_events', sessionId: SESSION, projectId: 'prj_events', userId: users.get('alice')!.id, createdBy: users.get('alice')!.id,
    label: 'Helper', role: 'editor' as const, tokenHash: 'a'.repeat(64), createdAt: now, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  try {
    for (const client of [alice, vic, rita, guest, olga]) await client.join();
    assert.ok(await store.createDocumentAgent(agent));
    await collab.agents.read(agent); // seats the agent in the same room

    assert.equal(collab.notifyComment(SESSION, { t: 'comment', threadId: 'th_who', revision: 4 }), 2, 'alice and vic only');
    for (const reader of [alice, vic]) {
      assert.deepEqual(await reader.next('comment'), { t: 'comment', threadId: 'th_who', revision: 4 }, 'a viewer receives it too');
    }
    await noCommentFrames([rita, guest, olga]);

    // The same through the routes: the HTTP write reaches the same people.
    await threadOf(await call('vic', 'POST', PATH, { id: 'th_route', messageId: 'm1', anchor, body: 'Looks good.' }));
    for (const reader of [alice, vic]) assert.equal((await reader.next('comment')).threadId, 'th_route');
    await noCommentFrames([rita, guest, olga]);
    assert.deepEqual([...rita.comments(), ...guest.comments(), ...olga.comments()], []);
  } finally {
    await collab.agents.disconnect(agent.id);
    for (const client of [alice, vic, rita, guest, olga]) await client.close();
  }
});

test('telling a session with no open room opens nothing', async () => {
  const rooms = collab.rooms();
  assert.equal(collab.notifyComment(IDLE_SESSION, { t: 'comment', threadId: 'th_none', revision: 1 }), 0);
  assert.equal(collab.notifyComment('ses_missing', { t: 'comment', threadId: 'th_none', revision: 1 }), 0);
  assert.equal(collab.rooms(), rooms, 'no room was opened by a comment event');
});

// ── the seat re-check ─────────────────────────────────────────────────────────

/** A second gateway over the same store, with a short heartbeat so the seat
 *  re-check runs in test time (tests/collab/gateway.test.ts does the same). */
async function fastGateway(overrides: Partial<InstanceConfig['policy']> = {}) {
  const gateway = createCollabGateway({
    config: { ...config, policy: { ...config.policy, ...overrides } }, store, secrets: SECRETS, pingIntervalMs: 60,
  });
  const http = createServer((_req, res) => void res.end());
  http.on('upgrade', (req, socket, head) => {
    if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const port = (http.address() as { port: number }).port;
  return {
    gateway, wsBase: `ws://127.0.0.1:${port}`,
    close: () => { gateway.close(); http.closeAllConnections(); http.close(); },
  };
}

test('a member who loses comment access stops receiving frames at the next re-check, and keeps the seat', async () => {
  const fast = await fastGateway();
  const bob = new Client(RECHECK_SESSION, cookies.get('bob')!, fast.wsBase);
  const deny = { principal: `user:${users.get('bob')!.id}`, action: 'comment.view', resource: '*', effect: 'deny' } as const;
  try {
    await bob.join();
    const event = { t: 'comment' as const, threadId: 'th_recheck', revision: 1 };
    assert.equal(fast.gateway.notifyComment(RECHECK_SESSION, event), 1);
    await bob.next('comment');

    await store.putGrant({ ...deny });
    await until(() => fast.gateway.notifyComment(RECHECK_SESSION, event) === 0, 'the re-check clears commentView');
    const seen = bob.comments().length;
    await new Promise((r) => setTimeout(r, 200)); // several more heartbeats
    assert.equal(fast.gateway.notifyComment(RECHECK_SESSION, event), 0);
    assert.equal(bob.closeCode, null, 'losing comment access does not cost the room seat');

    await store.deleteGrant({ ...deny });
    await until(() => fast.gateway.notifyComment(RECHECK_SESSION, { ...event, revision: 2 }) === 1, 'the re-check restores commentView');
    await until(() => bob.comments().some((f) => f.revision === 2), 'the restored frame arrives');
    assert.ok(bob.comments().slice(seen).every((f) => f.revision === 2), 'nothing arrived while access was denied');
  } finally {
    await store.deleteGrant({ ...deny });
    await bob.close();
    fast.close();
  }
});

test('with comments switched off, a member is admitted without comment events', async () => {
  const off = await fastGateway({ comments: { enabled: false } });
  const alice = new Client(OFF_SESSION, cookies.get('alice')!, off.wsBase);
  try {
    await alice.join();
    assert.equal(off.gateway.notifyComment(OFF_SESSION, { t: 'comment', threadId: 'th_off', revision: 1 }), 0);
    await noCommentFrames([alice]);
  } finally {
    await alice.close();
    off.close();
  }
});
