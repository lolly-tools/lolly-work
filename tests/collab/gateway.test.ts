// SPDX-License-Identifier: MPL-2.0
/**
 * The collab ws gateway over a REAL socket (plans/14 §6, OSS plans/100 §7): a
 * real `ws` client against a real `node:http` server wired exactly as main.ts
 * wires it - router on request, gateway on upgrade.
 *
 * The house http-test bootstrap (see tests/sessions.test.ts): own server, own
 * memory store, a temp pack, dev users in three groups. This file adds one thing
 * the other suites do not need - a real `tools/<id>/tool.json` in the pack, so
 * the gateway's declared-input whitelist is exercised rather than skipped.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { parseConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { buildApp } from '../../server/src/api/app.ts';
import {
  createCollabGateway, collabSessionId, isAllowedOrigin, parseOp, COLLAB_WS_PREFIX, CLOSE, ERR,
  MAX_SOCKETS_PER_USER, OPS_MESSAGES_PER_SEC, OPS_PER_SEC,
  type CollabGateway,
} from '../../server/src/collab/gateway.ts';
import { WRITER_CAP, WRITER_CAP_PER_USER, MAX_OPS_PER_MESSAGE, PRESENCE_FRAMES_PER_SEC } from '../../server/src/collab/rooms.ts';

const TOOL_ID = 'deck';
/** The tool's declared inputs - the gateway's own-property whitelist. The TYPE is
 *  part of the contract too: it is what tells the gateway which lane an input
 *  lives in (a `blocks` input is a collection; everything else is a scalar param),
 *  so a manifest without types leaves the lane check with nothing to check. */
const TOOL_INPUTS: Array<{ id: string; type: string }> = [
  { id: 'title', type: 'text' },
  { id: 'accent', type: 'color' },
  { id: 'headline', type: 'text' },
  { id: 'slides', type: 'blocks' },
];
/** Distinct accounts for the WRITER_CAP case: the per-room seat cap is only
 *  reachable by distinct USERS now that one account is capped at
 *  WRITER_CAP_PER_USER seats of its own. */
const WRITER_POOL = Array.from({ length: WRITER_CAP + 1 }, (_, i) => `w${i}@test`);

let server: Server;
let collab: CollabGateway;
let base = '';
let wsBase = '';
let store: ReturnType<typeof createMemoryStore>;
/** The parsed instance config, hoisted so a case can stand up a SECOND gateway
 *  over the same store - the seat-re-authorization case needs a short ping
 *  period, and 30 s of real time is not a test. */
let gatewayConfig: ReturnType<typeof parseConfig>;
let projectId = '';
let sessionId = '';
let aliceCookie = '';
let bobCookie = '';
let adminCookie = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-collab-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', TOOL_ID), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL_ID, 'tool.json'), JSON.stringify({
    id: TOOL_ID,
    inputs: TOOL_INPUTS,
  }));

  const config = gatewayConfig = parseConfig(JSON.stringify({
    instance: { name: 'Collab Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'alice@test', name: 'Alice Eng', groups: ['team-eng'] },
        { email: 'bob@test', name: 'Bob Design', groups: ['team-design'] },
        { email: 'ro@test', name: 'Rita Reader', groups: ['team-eng'] },
        ...WRITER_POOL.map((email, i) => ({ email, name: `Writer ${i}`, groups: ['team-eng'] })),
      ],
    },
  }));
  store = createMemoryStore();
  // collab is built FIRST so its room snapshot can be injected into the HTTP
  // app, exactly as main.ts wires it - see app.ts's `listCollabRooms`.
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
  await seedFixtures();
});

after(() => {
  collab.close();
  server.close();
});

// ── http helpers (tests/sessions.test.ts's shape) ─────────────────────────────

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

async function makeSession(cookie: string, projectId: string, inputs: Record<string, unknown>): Promise<string> {
  const res = await json(cookie, 'POST', `/api/v1/projects/${projectId}/sessions`, {
    toolId: TOOL_ID, toolVersion: '1.0.0', inputs, meta: { label: 'collab fixture' },
  });
  assert.equal(res.status, 201);
  return (await res.json() as { id: string }).id;
}

// ── ws client helper ──────────────────────────────────────────────────────────

interface Frame { t: string; [k: string]: unknown }

class Client {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  /** Settled once, in the constructor - a promise created later would wait on an
   *  `open` event that has already fired (two clients built back to back). */
  private readonly ready: Promise<void>;
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private closeWaiters: Array<(code: number) => void> = [];
  private readonly consumed = new Set<Frame>();

  constructor(sessionId: string, cookie: string) {
    this.ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${sessionId}`, { headers: { cookie } });
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.ready.catch(() => undefined); // never an unhandled rejection
    this.ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Frame;
      this.frames.push(frame);
      const still: typeof this.waiters = [];
      for (const w of this.waiters) {
        if (w.match(frame)) w.resolve(frame);
        else still.push(w);
      }
      this.waiters = still;
    });
    this.ws.on('close', (code) => {
      this.closeCode = code;
      for (const w of this.closeWaiters) w(code);
      this.closeWaiters = [];
    });
    this.ws.on('error', () => undefined);
  }

  open(): Promise<void> {
    return this.ready;
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** The next frame matching `t` (already-received frames count). */
  next(t: string, timeoutMs = 2000): Promise<Frame> {
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

  closed(timeoutMs = 2000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  /** Join and return the ack. */
  async join(opVersion: string = CANVAS_OP_VERSION): Promise<Frame> {
    await this.open();
    this.send({ t: 'join', opVersion });
    return this.next('join-ack');
  }

  close(): void {
    this.ws.close();
  }
}

/** Nothing of type `t` arrives within `ms` - the "peers never see it" assertion. */
async function silentFor(client: Client, t: string, ms = 250): Promise<void> {
  const before = client.frames.filter((f) => f.t === t).length;
  await new Promise((r) => setTimeout(r, ms));
  const after = client.frames.filter((f) => f.t === t).length;
  assert.equal(after, before, `expected no '${t}' frame, got ${after - before}`);
}

const param = (key: string, value: unknown, client: string, clock: number): CanvasOp =>
  ({ k: 'param', key, value, origin: { client, clock } }) as CanvasOp;

// Shared fixtures, built by the bootstrap above (one `before`, so ordering is
// not a question).
async function seedFixtures(): Promise<void> {
  aliceCookie = await login('alice@test');
  bobCookie = await login('bob@test');
  adminCookie = await login('admin@test');
  // Visible to BOTH groups so a locked-for-one-group overlay has an unlocked peer.
  const project = await json(aliceCookie, 'POST', '/api/v1/projects', {
    name: 'Collab', visibility: { groups: ['team-eng', 'team-design'] },
  });
  assert.equal(project.status, 201);
  projectId = (await project.json() as { id: string }).id;
  sessionId = await makeSession(aliceCookie, projectId, {
    title: 'Draft',
    accent: '#0c322c',
    slides: [
      { id: 'row-a', heading: 'One', body: 'first' },
      { id: 'row-b', heading: 'Two', body: 'second' },
    ],
    // Not expressible in canvas-op v1.1 - must be reported, never silently dropped.
    logo: { assetId: 'suse/logo/primary', width: 120 },
  });
}

// ── 1. auth ───────────────────────────────────────────────────────────────────

test('a cookie-less upgrade is refused 401 before any handshake', async () => {
  const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${sessionId}`);
  const status = await new Promise<number>((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => reject(new Error('handshake completed without a cookie')));
    ws.on('error', () => undefined);
    setTimeout(() => reject(new Error('no response')), 2000);
  });
  assert.equal(status, 401);
});

test('a member who cannot see the project is refused 403; an unknown session 404', async () => {
  const outsider = await login('admin@test'); // admin sees all - use a private project instead
  const priv = await json(outsider, 'POST', '/api/v1/projects', { name: 'Private', visibility: 'private' });
  const privId = (await priv.json() as { id: string }).id;
  const privSession = await makeSession(outsider, privId, { title: 'secret' });

  const status = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${privSession}`, { headers: { cookie: aliceCookie } });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => reject(new Error('joined a project it cannot see')));
    ws.on('error', () => undefined);
    setTimeout(() => reject(new Error('no response')), 2000);
  });
  assert.equal(status, 403);

  const missing = await new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}ses_nope`, { headers: { cookie: aliceCookie } });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => reject(new Error('joined a session that does not exist')));
    ws.on('error', () => undefined);
    setTimeout(() => reject(new Error('no response')), 2000);
  });
  assert.equal(missing, 404);
});

test('an upgrade outside /ws/collab/ is destroyed, not routed', async () => {
  const ws = new WebSocket(`${wsBase}/ws/something-else`);
  await new Promise<void>((resolve, reject) => {
    ws.on('error', () => resolve()); // socket destroyed → client errors
    ws.on('open', () => reject(new Error('a non-collab upgrade completed')));
    setTimeout(() => reject(new Error('no response')), 2000);
  });
});

test('a session id that is not valid percent-encoding is refused, not thrown', () => {
  // `new URL` does NOT validate percent-escapes in a path, so every one of these
  // reaches `decodeURIComponent`, which throws URIError. handleUpgrade is called
  // synchronously from server.on('upgrade'), so a throw here would escape into
  // node's HTTP parser as an uncaught exception and exit the process - an
  // unauthenticated remote kill switch, reachable before any auth runs.
  for (const url of [`${COLLAB_WS_PREFIX}%`, `${COLLAB_WS_PREFIX}%zz`, `${COLLAB_WS_PREFIX}%e0%a4%a`, `${COLLAB_WS_PREFIX}a%`]) {
    assert.equal(collabSessionId(url), null, `${url} is refused`);
  }
  assert.equal(collabSessionId(`${COLLAB_WS_PREFIX}ses%5Fone`), 'ses_one', 'valid encoding still decodes');
});

test('a raw malformed-escape upgrade is answered, and the process survives it', async () => {
  // The end-to-end structure of the case above, over a real socket: no cookie, no
  // session, no membership. If the throw escaped, this connection would not merely
  // fail - the server would be gone, and every later case in this file with it.
  const outcome = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}%`);
    ws.on('unexpected-response', (_req, res) => resolve(`http:${res.statusCode}`));
    ws.on('error', () => resolve('destroyed'));
    ws.on('open', () => resolve('open'));
    setTimeout(() => reject(new Error('no response')), 2000);
  });
  assert.notEqual(outcome, 'open', 'a malformed session id never completes a handshake');

  // The server is still serving - the actual assertion.
  const res = await fetch(`${base}/api/v1/sessions/${sessionId}`, { headers: { cookie: aliceCookie } });
  assert.equal(res.status, 200, 'the control plane survived the malformed upgrade');
});

test('a cross-site upgrade is refused: a browser-stamped foreign Origin never reaches the cookie', async () => {
  // CORS does not apply to a ws handshake, and the browser attaches the session
  // cookie regardless - so a page on evil.example opening this URL would have
  // received the whole docState plus every op and presence frame after it. The
  // only thing standing in the way was SameSite=Lax, a browser-behaviour
  // assumption rather than a check this server performs.
  const withOrigin = (origin: string) => new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${sessionId}`, {
      headers: { cookie: aliceCookie, origin },
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', () => undefined);
    setTimeout(() => reject(new Error('no response')), 2000);
  });

  assert.equal(await withOrigin('https://evil.example'), 403, 'a foreign origin is refused');
  assert.equal(await withOrigin('http://localhost'), 101, 'the instance’s own baseUrl origin is fine');
  // Non-browser clients send no Origin at all - every other case in this file
  // proves that path still works, and a header the caller controls was never
  // the authorization anyway (the cookie is). What it buys is the one thing a
  // hostile PAGE cannot forge: where it came from.
  assert.equal(isAllowedOrigin(undefined, { baseUrl: 'https://work.example' }, false), true);
  assert.equal(isAllowedOrigin('https://work.example', { baseUrl: 'https://work.example' }, false), true);
  assert.equal(isAllowedOrigin('https://app.example', { baseUrl: 'https://work.example', appUrl: 'https://app.example' }, false), true);
  assert.equal(isAllowedOrigin('https://work.example.evil.test', { baseUrl: 'https://work.example' }, false), false);
  assert.equal(isAllowedOrigin('http://localhost:5173', { baseUrl: 'https://work.example' }, false), false);
  assert.equal(isAllowedOrigin('http://localhost:5173', { baseUrl: 'https://work.example' }, true), true, 'dev only');
  assert.equal(isAllowedOrigin('not a url', { baseUrl: 'https://work.example' }, true), false);
  // Same-origin is decided against the request's own Host, not the config: an
  // instance behind a reverse proxy or on a vanity domain must not lose collab
  // because `baseUrl` was written for link-building. TLS terminated in front of
  // us means the browser says https while we serve http, so scheme is ignored
  // for this leg - the host is what a browser cannot forge.
  assert.equal(isAllowedOrigin('https://vanity.example', {}, false, 'vanity.example'), true);
  assert.equal(isAllowedOrigin('https://evil.example', {}, false, 'vanity.example'), false);
  assert.equal(isAllowedOrigin('https://vanity.example:8443', {}, false, 'vanity.example'), false, 'port is part of the host');
});

// ── 2. seeding ────────────────────────────────────────────────────────────────

test('the doc is seeded from the stored session: scalars → params, blocks → a named collection, the rest declared unsynced', async () => {
  const alice = new Client(sessionId, aliceCookie);
  const ack = await alice.join();
  const doc = ack.docState as {
    params: Record<string, unknown>;
    collections?: Record<string, { order: string[]; boxes: Record<string, Record<string, unknown>> }>;
  };
  assert.equal(doc.params['title'], 'Draft');
  assert.equal(doc.params['accent'], '#0c322c');
  assert.ok(!('slides' in doc.params), 'a blocks input is a collection, not a param');

  const slides = doc.collections?.['slides'];
  assert.ok(slides, 'the blocks input seeded a collection keyed by its input id');
  assert.deepEqual(slides.order, ['row-a', 'row-b'], 'stored row order preserved, keyed by the rows own ids');
  assert.equal(slides.boxes['row-a']?.heading, 'One');
  assert.equal(slides.boxes['row-b']?.body, 'second');

  assert.deepEqual(ack.unsynced, ['logo'], 'a non-scalar, non-blocks input is DECLARED unsynced, never silently dropped');
  assert.equal(ack.serverClock, 0, 'seed ops carry clock 0 so any client op beats them');
  assert.equal(ack.opVersion, CANVAS_OP_VERSION);
  assert.deepEqual(ack.roster, [], 'the roster excludes the joiner itself');
  alice.close();
  await alice.closed();
});

// ── 3. observers ──────────────────────────────────────────────────────────────

test('a member without session.edit joins as an observer and cannot write', async () => {
  const roCookie = await login('ro@test');
  const rita = (await store.listUsers()).find((u) => u.email === 'ro@test');
  assert.ok(rita);
  await store.putGrant({ principal: `user:${rita.id}`, action: 'session.edit', resource: '*', effect: 'deny' });

  const observer = new Client(sessionId, roCookie);
  const ack = await observer.join();
  assert.equal((ack.you as { role: string }).role, 'observer');
  assert.equal(ack.notice, 'no-edit-grant');

  const writer = new Client(sessionId, aliceCookie);
  await writer.join();

  observer.send({ t: 'ops', ops: [param('title', 'observer wrote this', 'obs', 5)] });
  const err = await observer.next('error');
  assert.equal(err.code, ERR.OBSERVER_READ_ONLY);
  await silentFor(writer, 'ops');

  observer.close();
  writer.close();
  await Promise.all([observer.closed(), writer.closed()]);
  await store.deleteGrant({ principal: `user:${rita.id}`, action: 'session.edit', resource: '*', effect: 'deny' });
});

// ── 4. the policy veto ────────────────────────────────────────────────────────

test('a locked input is dropped at the gateway: sender-only error, peers never see it, the socket survives', async () => {
  // headline is locked for team-eng (alice) and editable for everyone else (bob).
  await store.putOverlay({
    toolId: TOOL_ID,
    version: 1,
    inputAccess: {
      headline: [{ groups: ['team-eng'], level: 'locked', value: 'Approved headline' }],
      accent: [{ groups: ['team-eng'], level: 'choice', allow: ['#0c322c', '#30ba78'] }],
    },
  });

  const alice = new Client(sessionId, aliceCookie);
  const bob = new Client(sessionId, bobCookie);
  try {
    await alice.join();
    await bob.join();
    await alice.next('peer-join');

    alice.send({ t: 'ops', ops: [param('headline', 'sneaky rewrite', 'alice', 10)] });
    const err = await alice.next('error');
    assert.equal(err.code, ERR.INPUT_LOCKED);
    assert.deepEqual(err.inputs, ['headline']);
    await silentFor(bob, 'ops');

    // choice: an out-of-set value dies the same way the render path kills it
    alice.send({ t: 'ops', ops: [param('accent', '#ff0000', 'alice', 11)] });
    const notAllowed = await alice.next('error');
    assert.equal(notAllowed.code, ERR.INPUT_NOT_ALLOWED);
    await silentFor(bob, 'ops');

    // the same input from a group the overlay does not lock still flows
    bob.send({ t: 'ops', ops: [param('headline', 'bob may write this', 'bob', 12)] });
    const relayed = await alice.next('ops');
    assert.equal((relayed.ops as CanvasOp[]).length, 1);

    // and alice's connection is fine - a veto is not a disconnect
    alice.send({ t: 'ops', ops: [param('title', 'still writing', 'alice', 13)] });
    const ok = await bob.next('ops');
    assert.equal(((ok.ops as CanvasOp[])[0] as { key: string }).key, 'title');
  } finally {
    alice.close();
    bob.close();
    await Promise.all([alice.closed(), bob.closed()]);
    await store.deleteOverlay(TOOL_ID);
  }
});

test('an overlay edit takes effect on the NEXT op, with no cache window', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'fresh' });
  const alice = new Client(seed, aliceCookie);
  try {
    await alice.join();
    // writable now …
    alice.send({ t: 'ops', ops: [param('title', 'before the lock', 'alice', 2)] });
    await silentFor(alice, 'error');
    // … locked a moment later, with no grace period
    await store.putOverlay({
      toolId: TOOL_ID,
      version: 3,
      inputAccess: { title: [{ groups: ['*'], level: 'locked', value: 'pinned' }] },
    });
    alice.send({ t: 'ops', ops: [param('title', 'after the lock', 'alice', 3)] });
    assert.equal((await alice.next('error')).code, ERR.INPUT_LOCKED);
  } finally {
    alice.close();
    await alice.closed();
    await store.deleteOverlay(TOOL_ID);
  }
});

test('a mid-room revocation lands on the next gesture, not the next reconnect', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'revoke' });
  const roCookie = await login('ro@test');
  const rita = (await store.listUsers()).find((u) => u.email === 'ro@test');
  assert.ok(rita);

  const client = new Client(seed, roCookie);
  try {
    const ack = await client.join();
    assert.equal((ack.you as { role: string }).role, 'writer', 'joined with edit rights');
    client.send({ t: 'ops', ops: [param('title', 'while allowed', 'r', 2)] });
    await silentFor(client, 'error');

    // grant revoked while the socket stays open
    await store.putGrant({ principal: `user:${rita.id}`, action: 'session.edit', resource: '*', effect: 'deny' });
    client.send({ t: 'ops', ops: [param('title', 'after revocation', 'r', 3)] });
    assert.equal((await client.next('error')).code, ERR.OBSERVER_READ_ONLY);

    // and a disabled account loses the socket outright
    await store.deleteGrant({ principal: `user:${rita.id}`, action: 'session.edit', resource: '*', effect: 'deny' });
    await store.setUserDisabled(rita.id, new Date().toISOString());
    client.send({ t: 'ops', ops: [param('title', 'after disable', 'r', 4)] });
    assert.equal(await client.closed(), CLOSE.UNAUTHORIZED);
  } finally {
    client.close();
    await store.setUserDisabled(rita.id, null);
  }
});

test('a project-visibility revocation lands on the next gesture, not the next reconnect', async () => {
  // The grant half of this is covered above. THIS half is the one the gateway
  // used to check exactly once, at the handshake: `admit()` resolves the project
  // and captures the row, and nothing re-read it - so a member removed from a
  // project's visibility group kept writing into it for the life of the socket,
  // and the writes landed as a real session revision on quiesce. The HTTP
  // surface answered 403 for the same person, on the same session, throughout.
  const created = await json(aliceCookie, 'POST', '/api/v1/projects', {
    name: 'Revocable', visibility: { groups: ['team-eng', 'team-design'] },
  });
  assert.equal(created.status, 201);
  const revocableId = (await created.json() as { id: string }).id;
  const seed = await makeSession(aliceCookie, revocableId, { title: 'seed' });

  const bob = new Client(seed, bobCookie); // team-design - in, for now
  try {
    assert.equal(((await bob.join()).you as { role: string }).role, 'writer');
    bob.send({ t: 'ops', ops: [param('title', 'while visible', 'b', 2)] });
    await silentFor(bob, 'error');

    const patched = await json(aliceCookie, 'PATCH', `/api/v1/projects/${revocableId}`, {
      visibility: { groups: ['team-eng'] },
    });
    assert.equal(patched.status, 200);
    // The HTTP surface has already stopped answering for him …
    assert.equal((await json(bobCookie, 'GET', `/api/v1/sessions/${seed}`)).status, 403);
    // … and so does the socket, on the very next gesture.
    bob.send({ t: 'ops', ops: [param('title', 'written after revocation', 'b', 3)] });
    assert.equal(await bob.closed(), CLOSE.UNAUTHORIZED, 'the socket closes rather than degrading to observer');
  } finally {
    bob.close();
  }

  // The room quiesces on that close: what it commits is everything he wrote
  // while eligible, and nothing after.
  await new Promise((r) => setTimeout(r, 200));
  const stored = await store.getSession(seed);
  assert.equal(stored?.inputs['title'], 'while visible', 'the post-revocation op never reached the document');
});

test('a session tombstoned mid-room stops accepting ops on the next gesture', async () => {
  // Same capture, other field: `session.deletedAt` was read once in `admit()`.
  const seed = await makeSession(aliceCookie, projectId, { title: 'doomed' });
  const alice = new Client(seed, aliceCookie);
  try {
    await alice.join();
    alice.send({ t: 'ops', ops: [param('title', 'while alive', 'a', 2)] });
    await silentFor(alice, 'error');

    assert.equal((await json(aliceCookie, 'DELETE', `/api/v1/sessions/${seed}`)).status, 200);
    assert.equal((await json(aliceCookie, 'GET', `/api/v1/sessions/${seed}`)).status, 410);

    alice.send({ t: 'ops', ops: [param('title', 'written after deletion', 'a', 3)] });
    assert.equal(await alice.closed(), CLOSE.UNAUTHORIZED);
  } finally {
    alice.close();
  }
  await new Promise((r) => setTimeout(r, 200));
  const stored = await store.getSession(seed);
  assert.ok(stored?.deletedAt, 'still tombstoned — a live room cannot resurrect it');
  assert.notEqual(stored?.inputs['title'], 'written after deletion');
});

test('collab.join is enforced at the socket: revoked mid-room it closes, and a fresh upgrade is 403', async () => {
  // `collab.join` is a real grantable action (rbac/evaluate.ts ROLE_ACTIONS) that
  // the console offers and org-config advertises - and that the gateway did not
  // consult at all, so denying it left the principal joining as a WRITER with the
  // whole document. It is the one control an operator would reach for to switch
  // rooms off for a group.
  const seed = await makeSession(aliceCookie, projectId, { title: 'join-grant' });
  const roCookie = await login('ro@test');
  const rita = (await store.listUsers()).find((u) => u.email === 'ro@test');
  assert.ok(rita);
  const deny = { principal: `user:${rita.id}`, action: 'collab.join', resource: '*', effect: 'deny' } as const;

  const client = new Client(seed, roCookie);
  try {
    assert.equal(((await client.join()).you as { role: string }).role, 'writer', 'precondition: no deny yet');
    await store.putGrant({ ...deny });
    client.send({ t: 'ops', ops: [param('title', 'after the deny', 'r', 2)] });
    assert.equal(await client.closed(), CLOSE.UNAUTHORIZED, 'the open socket does not outlive the grant');

    // …and a reconnect does not get back in either - refused before the handshake.
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${seed}`, { headers: { cookie: roCookie } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('a principal denied collab.join completed a handshake')));
      ws.on('error', () => undefined);
      setTimeout(() => reject(new Error('no response')), 2000);
    });
    assert.equal(status, 403);
  } finally {
    client.close();
    await store.deleteGrant({ ...deny });
  }

  // Lifting the deny restores the seat - the gate is the grant, not a latch.
  const restored = new Client(seed, roCookie);
  assert.equal(((await restored.join()).you as { role: string }).role, 'writer');
  restored.close();
  await restored.closed();
});

test('an idle OBSERVER loses the room too — the seat is re-authorized on the heartbeat', async () => {
  // The other half of the same hole. `authorizeOps` lands a revocation on the
  // next GESTURE - and an observer never makes one: they sit and receive the
  // whole document, every op and every presence frame. A member removed from the
  // project's group would keep reading a live room until they chose to leave.
  // Its own gateway, so the ping period can be driven without a 30 s test.
  const proj = await json(aliceCookie, 'POST', '/api/v1/projects', {
    name: 'Idle observer', visibility: { groups: ['team-eng', 'team-design'] },
  });
  const pid = (await proj.json() as { id: string }).id;
  const seed = await makeSession(aliceCookie, pid, { title: 'watched' });

  const fast = createCollabGateway({
    config: gatewayConfig, store, secrets: { session: 'sc', link: 'lc' }, pingIntervalMs: 60,
  });
  const fastServer = createServer((req, res) => void res.end());
  fastServer.on('upgrade', (req, socket, head) => {
    if (!fast.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => fastServer.listen(0, () => r()));
  const addr = fastServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  const ws = new WebSocket(`ws://127.0.0.1:${port}${COLLAB_WS_PREFIX}${seed}`, { headers: { cookie: bobCookie } });
  try {
    const closed = Promise.race([
      new Promise<number>((resolve) => ws.on('close', (code) => resolve(code))),
      new Promise<number>((_r, reject) => setTimeout(() => reject(new Error('the seat was never re-authorized')), 4000)),
    ]);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ t: 'join', opVersion: CANVAS_OP_VERSION }));
    await new Promise<void>((resolve) => ws.on('message', () => resolve())); // join-ack

    // Bob now sends NOTHING at all. The revocation still has to reach him.
    assert.equal((await json(aliceCookie, 'PATCH', `/api/v1/projects/${pid}`, {
      visibility: { groups: ['team-eng'] },
    })).status, 200);
    assert.equal(await closed, CLOSE.UNAUTHORIZED, 'the seat is dropped without a gesture');
  } finally {
    ws.close();
    fast.close();
    fastServer.close();
  }
});

test('an undeclared input and an unscoped box op are both refused', async () => {
  const alice = new Client(sessionId, aliceCookie);
  await alice.join();

  alice.send({ t: 'ops', ops: [param('not-a-declared-input', 'x', 'alice', 20)] });
  assert.equal((await alice.next('error')).code, ERR.UNKNOWN_INPUT);

  // A box op with no `col` names no input, so no overlay can govern it.
  alice.send({
    t: 'ops',
    ops: [{ k: 'field', id: 'row-a', field: 'heading', value: 'x', origin: { client: 'alice', clock: 21 } }],
  });
  assert.equal((await alice.next('error')).code, ERR.COLLECTION_REQUIRED);

  // …and the same op scoped to the blocks input is accepted.
  alice.send({
    t: 'ops',
    ops: [{ k: 'field', id: 'row-a', col: 'slides', field: 'heading', value: 'Scoped', origin: { client: 'alice', clock: 22 } }],
  });
  await silentFor(alice, 'error');

  alice.close();
  await alice.closed();
});

test('a governed scalar input cannot be re-scoped as a collection to escape its rule', async () => {
  // `governedInputId` resolves a box op to its `col`, so `col: '<inputId>'` names a
  // governed input - but a `choice` rule compares op.VALUE, which a box op does not
  // have, and `ReferenceCanvasDoc.ensure` materialises a collection for any `col`
  // string. Left unchecked, `{k:'add', col:'accent', row:{…}}` walks past the
  // allow-list AND turns a scalar input into an array of attacker-chosen objects on
  // quiesce (docToInputs writes `out[col] = collection.order.map(…)`).
  const seed = await makeSession(aliceCookie, projectId, { title: 'rescope', accent: '#30ba78' });
  await store.putOverlay({
    toolId: TOOL_ID,
    version: 5,
    inputAccess: { accent: [{ groups: ['*'], level: 'choice', allow: ['#0c322c', '#30ba78'] }] },
  });
  const alice = new Client(seed, aliceCookie);
  try {
    await alice.join();

    // the param the rule was written for - refused, as it always was
    alice.send({ t: 'ops', ops: [param('accent', '#ff0000', 'alice', 2)] });
    assert.equal((await alice.next('error')).code, ERR.INPUT_NOT_ALLOWED);

    // the same input reached through the collection lane - refused too
    alice.send({
      t: 'ops',
      ops: [{ k: 'add', id: 'b1', col: 'accent', orderKey: 'a0', row: { value: '#ff0000', anything: 'attacker controlled' }, origin: { client: 'alice', clock: 3 } }],
    });
    const err = await alice.next('error');
    assert.ok(
      err.code === ERR.WRONG_LANE || err.code === ERR.INPUT_NOT_ALLOWED,
      `a box op on a scalar input is refused (got ${String(err.code)})`,
    );

    // …and a locked input is not re-scopable either
    await store.putOverlay({
      toolId: TOOL_ID,
      version: 6,
      inputAccess: { headline: [{ groups: ['*'], level: 'locked', value: 'pinned' }] },
    });
    alice.send({
      t: 'ops',
      ops: [{ k: 'add', id: 'b2', col: 'headline', orderKey: 'a0', row: { value: 'sneak' }, origin: { client: 'alice', clock: 4 } }],
    });
    const locked = await alice.next('error');
    assert.ok(
      locked.code === ERR.WRONG_LANE || locked.code === ERR.INPUT_LOCKED,
      `a box op on a locked scalar input is refused (got ${String(locked.code)})`,
    );
  } finally {
    alice.close();
    await alice.closed();
    await store.deleteOverlay(TOOL_ID);
  }

  // Nothing reached the document: the stored session still has a STRING accent.
  const stored = await store.getSession(seed);
  assert.equal(typeof stored?.inputs['accent'], 'string', 'a scalar input is still a scalar');
});

test('a param op cannot address a blocks input, and a box op cannot address a scalar one', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'lanes', slides: [] });
  const alice = new Client(seed, aliceCookie);
  try {
    await alice.join();
    alice.send({ t: 'ops', ops: [param('slides', 'a string where an array lives', 'alice', 2)] });
    assert.equal((await alice.next('error')).code, ERR.WRONG_LANE);

    alice.send({
      t: 'ops',
      ops: [{ k: 'field', id: 'x', col: 'title', field: 'heading', value: 'v', origin: { client: 'alice', clock: 3 } }],
    });
    assert.equal((await alice.next('error')).code, ERR.WRONG_LANE);

    // the declared lanes themselves still work
    alice.send({ t: 'ops', ops: [param('title', 'fine', 'alice', 4)] });
    alice.send({
      t: 'ops',
      ops: [{ k: 'add', id: 'r9', col: 'slides', orderKey: 'a0', row: { heading: 'fine' }, origin: { client: 'alice', clock: 5 } }],
    });
    await silentFor(alice, 'error');
  } finally {
    alice.close();
    await alice.closed();
  }
});

// ── 5. convergence ────────────────────────────────────────────────────────────

test('two writers interleave; a late joiner sees the converged document', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'start' });
  const alice = new Client(seed, aliceCookie);
  const bob = new Client(seed, bobCookie);
  await alice.join();
  await bob.join();
  await alice.next('peer-join');

  // Interleaved, contending on `title` (bob's clock is higher → bob wins LWW)
  // and each writing a private key plus one collection row.
  alice.send({ t: 'ops', ops: [param('title', 'alice title', 'alice', 3)] });
  bob.send({ t: 'ops', ops: [param('headline', 'bob headline', 'bob', 4)] });
  alice.send({
    t: 'ops',
    ops: [{ k: 'add', id: 'r1', col: 'slides', row: { heading: 'from alice' }, orderKey: 'i', origin: { client: 'alice', clock: 5 } }],
  });
  bob.send({ t: 'ops', ops: [param('title', 'bob title', 'bob', 9)] });

  // both peers saw each other's ops
  await alice.next('ops');
  await bob.next('ops');
  await new Promise((r) => setTimeout(r, 150));

  const late = new Client(seed, aliceCookie);
  const ack = await late.join();
  const doc = ack.docState as {
    params: Record<string, unknown>;
    collections?: Record<string, { order: string[]; boxes: Record<string, Record<string, unknown>> }>;
  };
  assert.equal(doc.params['title'], 'bob title', 'higher Lamport clock wins the contended key');
  assert.equal(doc.params['headline'], 'bob headline');
  assert.equal(doc.collections?.['slides']?.boxes['r1']?.heading, 'from alice');
  assert.equal(ack.serverClock, 9, 'the room reports the highest clock it has applied');
  assert.equal((ack.roster as unknown[]).length, 2, 'the late joiner sees both writers');

  alice.close();
  bob.close();
  late.close();
  await Promise.all([alice.closed(), bob.closed(), late.closed()]);
});

// ── 6. presence ───────────────────────────────────────────────────────────────

test('presence is relayed unauthorized, identity-stamped, and never stored', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'presence' });
  await store.putOverlay({
    toolId: TOOL_ID,
    version: 2,
    inputAccess: { headline: [{ groups: ['team-eng'], level: 'locked', value: 'x' }] },
  });
  const auditBefore = (await store.listAudit()).length;

  const alice = new Client(seed, aliceCookie);
  const bob = new Client(seed, bobCookie);
  await alice.join();
  await bob.join();
  await alice.next('peer-join');

  // Focus on the input alice may NOT write. Presence must still relay - the
  // lane is structurally unauthorized.
  alice.send({
    t: 'presence',
    frame: {
      userId: 'spoofed', name: 'Someone Else', color: '#30ba78',
      cursor: { x: 0.4, y: 0.6 }, selection: ['row-a'], focus: 'headline',
      chat: 'x'.repeat(200),
    },
  });
  const relayed = await bob.next('presence');
  const frame = relayed.frame as Record<string, unknown>;
  assert.equal(frame['focus'], 'headline', 'presence on a locked input is relayed, not vetoed');
  assert.equal(frame['name'], 'Alice Eng', 'the server stamps the authenticated name over the claim');
  assert.notEqual(frame['userId'], 'spoofed', 'a peer cannot present as somebody else');
  assert.equal(String(frame['chat']).length, 64, 'cursor chat is clamped to the contract ceiling');

  // Nothing about that frame reached the store.
  const auditAfter = await store.listAudit();
  const added = auditAfter.slice(auditBefore);
  assert.ok(added.every((e) => e.action !== 'collab.presence'), 'presence is never an audit event');
  assert.ok(!JSON.stringify(added).includes('0.4'), 'no presence payload in the audit log');
  const stored = await store.getSession(seed);
  assert.deepEqual(stored?.inputs, { title: 'presence' }, 'presence never touches the session record');

  // A late joiner gets the current presence set with its own entry absent.
  const late = new Client(seed, bobCookie);
  const ack = await late.join();
  const roster = ack.roster as Array<{ id: string; presence?: unknown }>;
  assert.ok(roster.some((r) => r.presence), 'the joiner receives the live presence set');
  assert.ok(!roster.some((r) => r.id === (ack.you as { id: string }).id), '…minus its own entry');

  alice.close();
  bob.close();
  late.close();
  await Promise.all([alice.closed(), bob.closed(), late.closed()]);
  await store.deleteOverlay(TOOL_ID);
});

test('the presence path cannot reach the policy engine (structural, not remembered)', async () => {
  const src = await readFile(
    fileURLToPath(new URL('../../server/src/collab/rooms.ts', import.meta.url)),
    'utf8',
  );
  const imports = [...src.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1] as string);
  for (const spec of imports) {
    assert.ok(
      !/\/(policy|rbac)\//.test(spec) && !spec.endsWith('/overlay.ts') && !spec.endsWith('/evaluate.ts'),
      `rooms.ts owns the whole presence path and must not import the policy engine — found '${spec}'`,
    );
  }
  assert.ok(src.includes('relayPresence'), 'the presence relay really does live in rooms.ts');
});

// ── 7. caps ───────────────────────────────────────────────────────────────────

test(`writer ${WRITER_CAP + 1} is seated as an observer with a room-full notice`, async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'full' });
  const cookies = await Promise.all(WRITER_POOL.map((email) => login(email)));
  const clients: Client[] = [];
  try {
    for (let i = 0; i < WRITER_CAP; i++) {
      const c = new Client(seed, cookies[i] as string);
      clients.push(c);
      const ack = await c.join();
      assert.equal((ack.you as { role: string }).role, 'writer', `client ${i} is a writer`);
      assert.equal(ack.notice, undefined);
    }
    const extra = new Client(seed, cookies[WRITER_CAP] as string);
    clients.push(extra);
    const ack = await extra.join();
    assert.equal((ack.you as { role: string }).role, 'observer');
    assert.equal(ack.notice, 'room-full-view-only');

    extra.send({ t: 'ops', ops: [param('title', 'nope', 'x', 2)] });
    assert.equal((await extra.next('error')).code, ERR.OBSERVER_READ_ONLY);
  } finally {
    for (const c of clients) c.close();
    await Promise.all(clients.map((c) => c.closed()));
  }
});

test(`one account may hold at most ${WRITER_CAP_PER_USER} writer seats in a room`, async () => {
  // WRITER_CAP is per ROOM. Without a per-user half, one account with several tabs
  // (or a script) takes every seat and the room is view-only for everyone else - 
  // a denial of service that needs no more than ordinary edit rights.
  const seed = await makeSession(aliceCookie, projectId, { title: 'seat hog' });
  const clients: Client[] = [];
  try {
    for (let i = 0; i < WRITER_CAP_PER_USER; i++) {
      const c = new Client(seed, aliceCookie);
      clients.push(c);
      assert.equal(((await c.join()).you as { role: string }).role, 'writer', `alice seat ${i}`);
    }
    const hog = new Client(seed, aliceCookie);
    clients.push(hog);
    const ack = await hog.join();
    assert.equal((ack.you as { role: string }).role, 'observer', 'the next seat for the SAME user is view-only');
    assert.equal(ack.notice, 'room-full-view-only');

    // …and the seats it did not take are still there for somebody else.
    const bob = new Client(seed, bobCookie);
    clients.push(bob);
    assert.equal(((await bob.join()).you as { role: string }).role, 'writer', 'a different user still gets a seat');
  } finally {
    for (const c of clients) c.close();
    await Promise.all(clients.map((c) => c.closed()));
  }
});

test('the ops LANE is rate-capped, not just the per-message op count', async () => {
  // The op-count cap bounds one message; nothing bounded the stream. Every ops
  // message costs three uncached store reads (authorizeOps re-reads identity,
  // grants and the overlay on purpose, so a revocation lands on the next gesture),
  // so an unthrottled writer saturates the store with messages that are each
  // perfectly legal.
  const seed = await makeSession(aliceCookie, projectId, { title: 'flood' });
  const flooder = new Client(seed, aliceCookie);
  await flooder.join();
  for (let i = 0; i < OPS_MESSAGES_PER_SEC + 5; i++) {
    flooder.send({ t: 'ops', ops: [param('title', `v${i}`, 'a', i + 2)] });
  }
  assert.equal(await flooder.closed(), CLOSE.OPS_RATE, 'the message rate is capped');

  // …and so is the op count summed ACROSS messages, which a message cap alone
  // would let through at MAX_OPS_PER_MESSAGE × OPS_MESSAGES_PER_SEC.
  const batcher = new Client(seed, aliceCookie);
  await batcher.join();
  const perMessage = Math.ceil(OPS_PER_SEC / 4);
  let clock = 2;
  for (let m = 0; m < 6; m++) {
    batcher.send({
      t: 'ops',
      ops: Array.from({ length: perMessage }, () => param('title', 'v', 'b', clock++)),
    });
  }
  assert.equal(await batcher.closed(), CLOSE.OPS_RATE, 'the ops-per-second ceiling is enforced too');
});

test(`one account may hold at most ${MAX_SOCKETS_PER_USER} sockets, and reconnect churn is capped`, async () => {
  // Each connect/disconnect cycle writes 2–3 hash-chained audit rows, and
  // appendAudit takes an instance-global advisory lock - so an unthrottled
  // reconnect loop from ONE authenticated member serialises audit writes for every
  // other operation on the instance, and floods the log.
  const seed = await makeSession(aliceCookie, projectId, { title: 'sockets' });
  const cookie = await login('w0@test');
  const held: Client[] = [];
  try {
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i++) {
      const c = new Client(seed, cookie);
      held.push(c);
      await c.open();
    }
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${seed}`, { headers: { cookie } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error(`a ${MAX_SOCKETS_PER_USER + 1}th socket was admitted`)));
      ws.on('error', () => undefined);
      setTimeout(() => reject(new Error('no response')), 2000);
    });
    assert.equal(status, 429, 'the ceiling is a refusal BEFORE the handshake, with a real status');

    // Another account is unaffected - the cap is per user, not global capacity.
    const other = new Client(seed, bobCookie);
    held.push(other);
    await other.open();
  } finally {
    for (const c of held) c.close();
    await Promise.all(held.map((c) => c.closed()));
  }
});

test('over-sized op batches and presence floods close the socket with a typed code', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'caps' });

  const flooder = new Client(seed, aliceCookie);
  await flooder.join();
  const tooMany = Array.from({ length: MAX_OPS_PER_MESSAGE + 1 }, (_, i) => param('title', `v${i}`, 'a', i + 1));
  flooder.send({ t: 'ops', ops: tooMany });
  assert.equal(await flooder.closed(), CLOSE.OPS_RATE);

  const chatty = new Client(seed, aliceCookie);
  await chatty.join();
  for (let i = 0; i < PRESENCE_FRAMES_PER_SEC + 5; i++) {
    chatty.send({ t: 'presence', frame: { cursor: { x: i / 100, y: 0 }, selection: [] } });
  }
  assert.equal(await chatty.closed(), CLOSE.PRESENCE_RATE);
});

// ── 8. version negotiation ────────────────────────────────────────────────────

test('a major-version mismatch joins observer-only', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'skew' });
  const stale = new Client(seed, aliceCookie);
  const ack = await stale.join('2.0.0');
  assert.equal((ack.you as { role: string }).role, 'observer');
  assert.equal(ack.notice, 'op-version-observer');

  stale.send({ t: 'ops', ops: [param('title', 'from the future', 'z', 1)] });
  assert.equal((await stale.next('error')).code, ERR.OBSERVER_READ_ONLY);
  stale.close();
  await stale.closed();
});

test('a v1.0 peer never receives a collection-scoped op it would mis-route', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'skew2' });
  const modern = new Client(seed, aliceCookie);
  const old = new Client(seed, bobCookie);
  await modern.join(CANVAS_OP_VERSION);
  await old.join('1.0.0');
  await modern.next('peer-join');

  modern.send({
    t: 'ops',
    ops: [{ k: 'add', id: 'rz', col: 'slides', row: { heading: 'scoped' }, orderKey: 'i', origin: { client: 'm', clock: 4 } }],
  });
  await silentFor(old, 'ops', 300);

  // a collection-blind param op still reaches it
  modern.send({ t: 'ops', ops: [param('title', 'plain', 'm', 5)] });
  const got = await old.next('ops');
  assert.equal(((got.ops as CanvasOp[])[0] as { k: string }).k, 'param');

  modern.close();
  old.close();
  await Promise.all([modern.closed(), old.closed()]);
});

// ── 9. audit ──────────────────────────────────────────────────────────────────

test('one collab.join + one collab.leave per member, and one keys-only rollup on room close', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'audit' });
  const before = (await store.listAudit()).length;

  const alice = new Client(seed, aliceCookie);
  const bob = new Client(seed, bobCookie);
  await alice.join();
  await bob.join();
  alice.send({ t: 'ops', ops: [param('title', 'never in the log', 'a', 2)] });
  await bob.next('ops');

  alice.close();
  bob.close();
  await Promise.all([alice.closed(), bob.closed()]);
  await new Promise((r) => setTimeout(r, 200));

  const events = (await store.listAudit()).slice(before).filter((e) => e.subject === `session:${seed}`);
  assert.equal(events.filter((e) => e.action === 'collab.join').length, 2, 'one join event per member');
  assert.equal(events.filter((e) => e.action === 'collab.leave').length, 2, 'one leave event per member');

  const rollups = events.filter((e) => e.action === 'collab.rollup');
  assert.equal(rollups.length, 1, 'exactly one rollup, on room close');
  const payload = rollups[0]?.payload as { ops: number; users: number; keys: string[]; byUser: Record<string, number> };
  assert.equal(payload.ops, 1);
  assert.equal(payload.users, 2);
  assert.deepEqual(payload.keys, ['title'], 'the rollup carries input KEYS');
  assert.ok(!JSON.stringify(rollups[0]).includes('never in the log'), 'never a value, never a keystroke');
  assert.equal(Object.keys(payload.byUser).length, 1, 'per-user edit counts');
  assert.equal(collab.rooms(), 0, 'the room is gone once the last member leaves');
});

// ── admin console: GET /api/v1/collab/rooms (OSS plans/100 §7, plans/14 §6) ───

test('GET /api/v1/collab/rooms: no live rooms → an admin sees an empty list', async () => {
  // The previous test's own last assertion is this test's precondition: it just
  // proved `collab.rooms() === 0`, so this file's tests run serially and
  // nothing is left over to make the "empty" case flaky.
  assert.equal(collab.rooms(), 0, 'precondition: nothing left over from the prior test');
  const res = await json(adminCookie, 'GET', '/api/v1/collab/rooms');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { rooms: [] });
});

test('GET /api/v1/collab/rooms is refused to a member without telemetry.view', async () => {
  const res = await json(aliceCookie, 'GET', '/api/v1/collab/rooms');
  assert.equal(res.status, 403);
});

test('GET /api/v1/collab/rooms reports a live room’s roster and counters, never an input value', async () => {
  // Force a genuine observer seat (the same recipe as the observer test above)
  // so writerCount/observerCount and both roles are exercised, not just a room
  // of writers.
  const roCookie = await login('ro@test');
  const rita = (await store.listUsers()).find((u) => u.email === 'ro@test');
  assert.ok(rita);
  await store.putGrant({ principal: `user:${rita.id}`, action: 'session.edit', resource: '*', effect: 'deny' });

  const seed = await makeSession(aliceCookie, projectId, { title: 'rooms-api' });
  const writer = new Client(seed, aliceCookie);
  const observer = new Client(seed, roCookie);
  await writer.join();
  const obsAck = await observer.join();
  assert.equal((obsAck.you as { role: string }).role, 'observer');
  writer.send({ t: 'ops', ops: [param('title', 'never leaves this room', 'w', 2)] });
  await observer.next('ops');

  const res = await json(adminCookie, 'GET', '/api/v1/collab/rooms');
  assert.equal(res.status, 200);
  const body = await res.json() as { rooms: Array<Record<string, unknown>> };
  const room = body.rooms.find((r) => r.sessionId === seed);
  assert.ok(room, 'the live room is listed');
  assert.equal(room.sessionLabel, 'collab fixture', 'label comes from the stored session, not the room');
  assert.equal(room.toolId, TOOL_ID);
  assert.equal(room.memberCount, 2);
  assert.equal(room.writerCount, 1);
  assert.equal(room.observerCount, 1);
  assert.equal(room.opsApplied, 1);
  assert.equal(typeof room.startedAt, 'number');

  const members = room.members as Array<Record<string, unknown>>;
  assert.equal(members.length, 2);
  assert.deepEqual(members.map((m) => m.role).sort(), ['observer', 'writer']);
  for (const m of members) {
    assert.equal(typeof m.name, 'string');
    assert.ok((m.name as string).length > 0);
    assert.equal(typeof m.joinedAt, 'number');
    assert.deepEqual(Object.keys(m).sort(), ['joinedAt', 'name', 'role'], 'names + role + joinedAt only — no userId, no presence');
  }
  // keys-never-values (§11.21): the input VALUE the writer just sent must never
  // reach an admin-only counters endpoint, even indirectly.
  assert.ok(!JSON.stringify(body).includes('never leaves this room'));

  writer.close();
  observer.close();
  await Promise.all([writer.closed(), observer.closed()]);
  await new Promise((r) => setTimeout(r, 200));
  await store.deleteGrant({ principal: `user:${rita.id}`, action: 'session.edit', resource: '*', effect: 'deny' });

  const after = await json(adminCookie, 'GET', '/api/v1/collab/rooms');
  const stillListed = (await after.json() as { rooms: Array<{ sessionId: string }> }).rooms
    .some((r) => r.sessionId === seed);
  assert.equal(stillListed, false, 'the room is gone once everyone has left');
});

// ── op parsing hardening (fix-pass regression: the room-wedge finding) ──────

test('originOf refuses an out-of-range or non-integer clock — a Lamport clock is a small counter, never a float extreme', () => {
  // A Lamport clock is minted by `+1` per op (canvas-op-testkit); nothing
  // honest ever produces one near float precision limits. Before this,
  // `Number.isFinite` alone let `1e308` through, and `1e308 + 1 === 1e308` in
  // float - so that op's clock became BOTH `Room.serverClock` and the replay
  // filter's high-water mark for whatever `origin.client` it named, FOREVER:
  // no later, honest clock from that client could ever beat it again, and the
  // register the op wrote could never be overwritten by anyone.
  const proto = { k: 'param' as const, key: 'title', value: 'x' };
  assert.equal(parseOp({ ...proto, origin: { client: 'c', clock: 1e308 } }), null, 'float-extreme clock refused');
  assert.equal(parseOp({ ...proto, origin: { client: 'c', clock: Number.MAX_VALUE } }), null);
  assert.equal(parseOp({ ...proto, origin: { client: 'c', clock: 1.5 } }), null, 'a non-integer clock is refused too');
  assert.equal(parseOp({ ...proto, origin: { client: 'c', clock: Number.NaN } }), null);
  assert.equal(parseOp({ ...proto, origin: { client: 'c', clock: Number.POSITIVE_INFINITY } }), null);
  assert.equal(parseOp({ ...proto, origin: { client: 'c', clock: -1 } }), null, 'negative, still refused as before');
  // The ordinary, honest range keeps working exactly as it always did.
  assert.ok(parseOp({ ...proto, origin: { client: 'c', clock: 0 } }));
  assert.ok(parseOp({ ...proto, origin: { client: 'c', clock: 1 } }));
  assert.ok(parseOp({ ...proto, origin: { client: 'c', clock: Number.MAX_SAFE_INTEGER } }));
});

test('a poisoned-clock op is refused at the socket and never lands — a later, honest op from the same claimed client id still converges', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'clock guard' });
  const alice = new Client(seed, aliceCookie);
  const admin = new Client(seed, adminCookie);
  try {
    await alice.join();
    await admin.join();
    await alice.next('peer-join');

    // The whole BATCH is refused (one malformed op invalidates its message),
    // so the peer never sees it - a vetoed/malformed op never existed as far
    // as the room is concerned.
    alice.send({
      t: 'ops',
      ops: [{ k: 'param', key: 'title', value: 'poisoned', origin: { client: 'victim', clock: 1e308 } }],
    });
    assert.equal((await alice.next('error')).code, ERR.INVALID_OP);
    await silentFor(admin, 'ops');

    // A legitimate, safely-integer clock claiming the SAME `origin.client` still
    // lands and converges - proving the room's replay filter and `serverClock`
    // were never poisoned into refusing (or freezing) that client id.
    alice.send({ t: 'ops', ops: [param('title', 'fine', 'victim', 2)] });
    const relayed = await admin.next('ops');
    assert.equal((relayed.ops as CanvasOp[]).map((o) => (o as { key: string }).key)[0], 'title');
  } finally {
    alice.close();
    admin.close();
    await Promise.all([alice.closed(), admin.closed()]);
  }
});
