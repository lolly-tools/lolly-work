// SPDX-License-Identifier: MPL-2.0
/**
 * GUEST principals in a live collab room (plans/14 §6, plans/02 §8) - "temporary
 * external collaboration is the same room, not a separate mechanism."
 *
 * The whole point of the feature is that almost nothing is special about a
 * guest: one roster, one set of caps, one presence relay, one veto, one audit
 * shape, one write-back. So this file is mostly checks that a guest is treated
 * exactly like a member - and a small, sharp set of checks on the four places it
 * cannot be:
 *
 *   1. WHERE it may be. A guest-edit link binds to one session and that is the
 *      whole of a guest's reach. Every other session id is refused with the same
 *      403 an unauthorized member gets, before the session is read, so the
 *      404/403/410 spread the member path preserves is not an existence oracle
 *      for a guest.
 *   2. WHETHER it may write - the link's KIND, never a role table. A guest holds
 *      no role row (`ROLE_ACTIONS.guest` is `[]`) and no grants, so the module
 *      that decides this imports nothing from `../rbac` and the test below
 *      asserts that structurally rather than trusting a reviewer to notice.
 *   3. WHO it is in presence: `"Sam (guest of Andy)"`, built server-side.
 *   4. HOW its work is attributed: `guest:<linkId>` on the audit trail and on
 *      the quiesce revision, and never the inviter's identity on either.
 *
 * Bootstrap is the house http-test shape (tests/collab/gateway.test.ts): own
 * server, own memory store, a temp pack with a real tool.json so the declared-
 * input whitelist is exercised. The extra move here is a real
 * `POST /api/v1/links` + `GET /l/:id`, so the guest cookie under test is one the
 * product actually mints rather than one this file forges.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';

import { parseConfig, type InstanceConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { buildApp } from '../../server/src/api/app.ts';
import {
  createCollabGateway, COLLAB_WS_PREFIX, CLOSE, ERR, type CollabGateway,
} from '../../server/src/collab/gateway.ts';
import { WRITER_CAP_PER_USER } from '../../server/src/collab/rooms.ts';
import { COLLAB_ACTOR } from '../../server/src/collab/persistence.ts';
import {
  GUEST_GROUP, GUEST_FALLBACK_NAME, guestDisplayName, guestLinkRole, guestSeatOf,
} from '../../server/src/collab/guests.ts';
import { guestActor, type GuestSession } from '../../server/src/iam/sessions.ts';
import type { LinkKind, LinkRecord } from '../../server/src/links/sign.ts';
import { mayEditCollab, mayJoinCollab } from '../../server/src/rbac/evaluate.ts';

const TOOL_ID = 'deck';
const TOOL_INPUTS = [
  { id: 'title', type: 'text' },
  { id: 'accent', type: 'color' },
  { id: 'slides', type: 'blocks' },
];

const SECRETS = { session: 'sc', link: 'lc' };

let server: Server;
let collab: CollabGateway;
let baseConfig: InstanceConfig;
let base = '';
let wsBase = '';
let store: ReturnType<typeof createMemoryStore>;
let pack = '';

let projectId = '';
let sessionId = '';
let aliceCookie = '';
let aliceId = '';
let adminCookie = '';
let adminId = '';
let bobCookie = '';
let bobId = '';
let carolCookie = '';
let carolId = '';
let daveCookie = '';
let daveId = '';
/** The guest-edit link bound to `sessionId`, and a cookie minted from it. */
let linkId = '';
let guestCookie = '';
/** "Ada Admin" - the inviter's display name, as the roster must render it. */
const INVITER_NAME = 'Ada Admin';

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-collab-guest-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', TOOL_ID), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL_ID, 'tool.json'), JSON.stringify({ id: TOOL_ID, inputs: TOOL_INPUTS }));

  baseConfig = parseConfig(JSON.stringify({
    instance: { name: 'Guest Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'alice@test', name: 'Alice Eng', groups: ['team-eng'] },
        // A plain member, in no project's visibility group, who nonetheless
        // holds an explicit `link.create-guest` grant below - the fix-pass
        // regression for "the mint route never checked the minter could see
        // the target session at all".
        { email: 'bob@test', name: 'Bob Sales', groups: ['team-sales'] },
        // TWO disposable inviters, distinct from admin/alice/each other: the
        // fix-pass regressions below permanently disable carol's account and
        // permanently revoke dave's grant, and must not disturb
        // `adminCookie`/`aliceCookie`, which every other test in this file
        // still relies on, nor each other.
        { email: 'carol@test', name: 'Carol Temp', groups: ['team-eng'] },
        { email: 'dave@test', name: 'Dave Temp', groups: ['team-eng'] },
      ],
    },
  }));
  store = createMemoryStore();
  collab = createCollabGateway({ config: baseConfig, store, secrets: SECRETS });
  const app = buildApp({
    config: baseConfig, store, secrets: SECRETS, listCollabRooms: () => collab.snapshot(),
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

  aliceCookie = await login('alice@test');
  adminCookie = await login('admin@test');
  bobCookie = await login('bob@test');
  carolCookie = await login('carol@test');
  daveCookie = await login('dave@test');
  const users = await store.listUsers();
  aliceId = users.find((u) => u.email === 'alice@test')!.id;
  adminId = users.find((u) => u.email === 'admin@test')!.id;
  bobId = users.find((u) => u.email === 'bob@test')!.id;
  carolId = users.find((u) => u.email === 'carol@test')!.id;
  daveId = users.find((u) => u.email === 'dave@test')!.id;
  // bob, carol and dave all mint guest-edit links in the tests below despite
  // none carrying the `admin` group that grants `link.create-guest` by
  // default - an explicit per-user grant, matching plans/02 §8's "minting is
  // governed per group", not "admin only".
  for (const id of [bobId, carolId, daveId]) {
    await store.putGrant({ principal: `user:${id}`, action: 'link.create-guest', resource: '*', effect: 'allow' });
  }

  const project = await json(aliceCookie, 'POST', '/api/v1/projects', {
    name: 'Guests', visibility: { groups: ['team-eng'] },
  });
  assert.equal(project.status, 201);
  projectId = (await project.json() as { id: string }).id;
  sessionId = await makeSession(aliceCookie, projectId, { title: 'Draft', accent: '#0c322c' });

  const link = await mintGuestLink(sessionId);
  linkId = link.id;
  guestCookie = await guestCookieFor(link.path, 'Sam');
});

after(() => {
  collab.close();
  server.close();
});

// ── http helpers ──────────────────────────────────────────────────────────────

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

async function makeSession(cookie: string, project: string, inputs: Record<string, unknown>): Promise<string> {
  const res = await json(cookie, 'POST', `/api/v1/projects/${project}/sessions`, {
    toolId: TOOL_ID, toolVersion: '1.0.0', inputs, meta: { label: 'guest fixture' },
  });
  assert.equal(res.status, 201);
  return (await res.json() as { id: string }).id;
}

/** Mint a real guest-edit link over a session - `link.create-guest` is admin-only,
 *  so the INVITER is the admin while the session's own author is alice. That
 *  separation is what makes the attribution assertions mean anything: a guest's
 *  write must name neither. */
async function mintGuestLink(target: string): Promise<{ id: string; path: string }> {
  const res = await json(adminCookie, 'POST', '/api/v1/links', {
    kind: 'guest-edit',
    target: { toolId: TOOL_ID, sessionId: target },
    projectId,
  });
  assert.equal(res.status, 201, 'the inviter may mint a guest-edit link');
  const body = await res.json() as { id: string; url: string };
  const url = new URL(body.url);
  return { id: body.id, path: `${url.pathname}${url.search}` };
}

/** Open the link the way a guest's browser does, and keep the cookie it is
 *  handed. `name` absent → the resolver's own 'Guest' default; `name=''` → an
 *  empty stored name, which is what exercises the gateway-side fallback. */
async function guestCookieFor(path: string, name?: string): Promise<string> {
  const url = name === undefined ? `${base}${path}` : `${base}${path}&name=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  assert.equal(res.status, 200, 'a live guest-edit link admits a guest');
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_guest='));
  assert.ok(cookie, 'guest cookie set');
  return cookie.split(';')[0] as string;
}

// ── ws client (tests/collab/gateway.test.ts's helper, parameterised by host) ──

interface Frame { t: string; [k: string]: unknown }

class Client {
  readonly frames: Frame[] = [];
  closeCode: number | null = null;
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  private closeWaiters: Array<(code: number) => void> = [];
  private readonly consumed = new Set<Frame>();

  constructor(session: string, cookie: string, host: string = wsBase) {
    this.ws = new WebSocket(`${host}${COLLAB_WS_PREFIX}${session}`, { headers: { cookie } });
    this.ready = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.ready.catch(() => undefined);
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

  closed(timeoutMs = 3000): Promise<number> {
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

/** The HTTP status of a REFUSED upgrade - the gateway answers a plain response on
 *  the raw socket, so a refusal has a real status. 101 means it completed. */
function upgradeStatus(session: string, cookie: string, host: string = wsBase): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${host}${COLLAB_WS_PREFIX}${session}`, { headers: { cookie } });
    const timer = setTimeout(() => reject(new Error('no response to the upgrade')), 3000);
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      resolve(res.statusCode ?? 0);
    });
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      resolve(101);
    });
    ws.on('error', () => undefined);
  });
}

const param = (key: string, value: unknown, client: string, clock: number): CanvasOp =>
  ({ k: 'param', key, value, origin: { client, clock } }) as CanvasOp;

/** Poll until `check` passes - quiesce and the leave audit ride a promise chain
 *  the socket close does not await, so a fixed sleep is a flake waiting to
 *  happen. */
async function until(check: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A second gateway (its own http server) over the SAME store - the house shape
 *  for a case that needs a different config or a short keepalive. */
async function standUp(over: Record<string, unknown>, pingIntervalMs?: number): Promise<{
  wsBase: string; close: () => void;
}> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Guest Hub', baseUrl: 'http://localhost', pack },
    dev: baseConfig.dev,
    ...over,
  }));
  const gw = createCollabGateway({ config, store, secrets: SECRETS, ...(pingIntervalMs ? { pingIntervalMs } : {}) });
  const app = buildApp({ config, store, secrets: SECRETS });
  const srv = createServer((req, res) => void app(req, res));
  srv.on('upgrade', (req, socket, head) => {
    if (!gw.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => srv.listen(0, () => r()));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    wsBase: `ws://127.0.0.1:${port}`,
    close: () => {
      gw.close();
      srv.close();
    },
  };
}

// ── 1. the seat a guest gets ──────────────────────────────────────────────────

test('a guest joins the session its link binds it to, as a writer, named "<name> (guest of <inviter>)"', async () => {
  const guest = new Client(sessionId, guestCookie);
  try {
    const ack = await guest.join();
    const you = ack.you as { role: string; name: string; userId: string };
    assert.equal(you.role, 'writer', 'a guest-EDIT link is a writer seat');
    assert.equal(you.name, `Sam (guest of ${INVITER_NAME})`, 'plans/02 §8, rendered server-side');
    assert.equal(you.userId, guestActor(linkId), 'the principal is the LINK — a guest is pseudonymous');
    // The seed document is the ordinary one; a guest is not handed a lesser room.
    assert.equal((ack.docState as { params: Record<string, unknown> }).params['title'], 'Draft');
  } finally {
    guest.close();
    await guest.closed();
  }
});

test('a guest is refused on ANY other session — the same 403 an unauthorized member gets', async () => {
  // Three shapes of "not your session", all of which must look identical from
  // the outside: a sibling session the guest was not invited to, one in a project
  // it could never see, and an id that does not exist at all. If these differed,
  // a guest could walk session ids and learn which exist.
  const sibling = await makeSession(aliceCookie, projectId, { title: 'not yours' });
  const privRes = await json(adminCookie, 'POST', '/api/v1/projects', { name: 'Private', visibility: 'private' });
  const privId = (await privRes.json() as { id: string }).id;
  const privSession = await makeSession(adminCookie, privId, { title: 'secret' });

  assert.equal(await upgradeStatus(sibling, guestCookie), 403, 'a sibling session in the same project');
  assert.equal(await upgradeStatus(privSession, guestCookie), 403, 'a session in a project it cannot see');
  assert.equal(await upgradeStatus('ses_does_not_exist', guestCookie), 403, 'a session id that does not exist');

  // …and the member baseline it must be indistinguishable from.
  assert.equal(await upgradeStatus(privSession, aliceCookie), 403, 'an unauthorized member gets the same status');
  // The guest's OWN session is the one thing that works.
  assert.equal(await upgradeStatus(sessionId, guestCookie), 101);
});

test('a guest cookie is refused once its link is revoked, and once guest links are switched off', async () => {
  const one = await makeSession(aliceCookie, projectId, { title: 'revocable' });
  const link = await mintGuestLink(one);
  const cookie = await guestCookieFor(link.path, 'Kim');
  assert.equal(await upgradeStatus(one, cookie), 101, 'precondition: the link is live');

  const off = await standUp({ policy: { guestLinks: { enabled: false } } });
  try {
    assert.equal(
      await upgradeStatus(one, cookie, off.wsBase), 403,
      'the instance kill switch reaches an already-minted cookie, not just minting',
    );
  } finally {
    off.close();
  }

  const revoked = await json(adminCookie, 'POST', `/api/v1/links/${link.id}/revoke`);
  assert.equal(revoked.status, 200);
  assert.equal(await upgradeStatus(one, cookie), 403, 'revoking the link admits nobody (plans/02 §8)');
});

// ── 2. writer/observer comes from the LINK, never from RBAC ──────────────────

test('guests are outside the RBAC tables, and this wave does not widen them', () => {
  // The premise of deriving a guest's seat from its link: `evaluate` has nothing
  // to say about a guest, by construction. If either of these ever answered true
  // from the role table, somebody gave the guest role default actions and the
  // gateway's guest branch would be reading a second, contradictory source.
  const ctx = { groups: [GUEST_GROUP], role: 'guest' as const };
  assert.equal(mayJoinCollab(ctx, []), false, 'ROLE_ACTIONS.guest is empty');
  assert.equal(mayEditCollab(ctx, []), false);
});

test('the guest seat module cannot reach the RBAC engine (structural, not remembered)', async () => {
  const src = await readFile(
    fileURLToPath(new URL('../../server/src/collab/guests.ts', import.meta.url)),
    'utf8',
  );
  const imports = [...src.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1] as string);
  for (const spec of imports) {
    assert.ok(
      !/\/rbac\//.test(spec) && !spec.endsWith('/evaluate.ts'),
      `a guest's authority is its link, not a grant table — found '${spec}'`,
    );
  }
  assert.ok(src.includes('guestLinkRole'), 'the writer/observer decision really does live here');
});

test('there is no view-only guest tier today — guestLinkRole is the one place one would land', () => {
  // Documented rather than tested-for-behaviour because the tier does not exist:
  // `GET /l/:id` mints a guest cookie for `guest-edit` and for nothing else
  // (share/embed/download render bytes and mint no principal at all). This asserts
  // the shape a read-only tier would slot into - one arm here, and the gateway
  // needs no change because it already asks this function.
  const kinds: LinkKind[] = ['share', 'embed', 'download', 'guest-edit'];
  for (const kind of kinds) {
    const role = guestLinkRole({ ...record(), kind });
    assert.equal(role, kind === 'guest-edit' ? 'writer' : null, `${kind} link`);
  }
});

// ── 3. the pure binding decision ─────────────────────────────────────────────

const NOW = 1_800_000_000_000;

function record(over: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: 'lnk1',
    kind: 'guest-edit',
    target: { toolId: TOOL_ID, sessionId: 'ses_bound' },
    exp: Math.floor(NOW / 1000) + 3600,
    createdBy: 'u-inviter',
    createdAt: new Date(NOW).toISOString(),
    ...over,
  };
}

function cookieClaims(over: Partial<GuestSession> = {}): GuestSession {
  return { linkId: 'lnk1', toolId: TOOL_ID, sessionRef: 'ses_bound', inviter: 'u-inviter', name: 'Sam', ...over };
}

test('guestSeatOf: the link is the authority, and every refusal is the same refusal', () => {
  const ok = guestSeatOf(record(), cookieClaims(), 'ses_bound', NOW);
  assert.ok(ok, 'the bound session is admitted');
  assert.equal(ok.principalId, guestActor('lnk1'));
  assert.equal(ok.role, 'writer');

  assert.equal(guestSeatOf(record(), cookieClaims(), 'ses_other', NOW), null, 'any other session id');
  assert.equal(
    guestSeatOf(record({ target: { toolId: TOOL_ID } }), cookieClaims({ sessionRef: undefined }), 'ses_bound', NOW),
    null,
    'a link that names only a tool binds to no room at all',
  );
  assert.equal(guestSeatOf(record({ revokedAt: 'x' }), cookieClaims(), 'ses_bound', NOW), null, 'revoked');
  assert.equal(guestSeatOf(record(), cookieClaims(), 'ses_bound', NOW + 2 * 3600_000), null, 'expired');
  assert.equal(guestSeatOf(record({ kind: 'share' }), cookieClaims(), 'ses_bound', NOW), null, 'not a guest link');
  assert.equal(
    guestSeatOf(record(), cookieClaims({ linkId: 'lnk2' }), 'ses_bound', NOW), null,
    'a cookie for a different link cannot borrow this one',
  );
  assert.equal(
    guestSeatOf(record(), cookieClaims({ sessionRef: 'ses_stale' }), 'ses_bound', NOW), null,
    'cookie and link disagree — neither reading is safe to write with',
  );
});

test('guestDisplayName: the fallback still says who vouched', () => {
  assert.equal(guestDisplayName('Sam', 'Andy Fitz'), 'Sam (guest of Andy Fitz)');
  assert.equal(guestDisplayName('', 'Andy Fitz'), `${GUEST_FALLBACK_NAME} (guest of Andy Fitz)`);
  assert.equal(guestDisplayName(undefined, 'Andy Fitz'), `${GUEST_FALLBACK_NAME} (guest of Andy Fitz)`);
  assert.equal(guestDisplayName('   ', 'Andy Fitz'), `${GUEST_FALLBACK_NAME} (guest of Andy Fitz)`);
  // A name is relayed to every peer, and `sanitizePresence` stamps the SERVER's
  // name over whatever the client claimed - so the one field a peer cannot forge
  // must not be the one that can smuggle a terminal escape.
  assert.equal(guestDisplayName(`Sa\u001b[2Jm`, 'Andy'), 'Sa[2Jm (guest of Andy)');
  assert.equal(
    guestDisplayName('x'.repeat(200), 'y'.repeat(200)),
    `${'x'.repeat(60)} (guest of ${'y'.repeat(60)})`,
    'both halves are bounded — a roster entry is not a payload',
  );
});

// ── 4. presence identity, over a real socket ─────────────────────────────────

test('a peer sees the guest as "<name> (guest of <inviter>)" — in the roster, the peer-join, and every presence frame', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'presence' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, 'Sam');
  const alice = new Client(seed, aliceCookie);
  const guest = new Client(seed, cookie);
  try {
    await alice.join();
    const ack = await guest.join();

    const peerJoin = await alice.next('peer-join');
    const member = peerJoin.member as { name: string; userId: string; role: string };
    assert.equal(member.name, `Sam (guest of ${INVITER_NAME})`);
    assert.equal(member.userId, guestActor(link.id));
    assert.equal(member.role, 'writer');

    // The joiner's own roster names the member it arrived beside, unchanged - 
    // guests do not get a different roster shape.
    const roster = ack.roster as Array<{ name: string }>;
    assert.equal(roster.length, 1);
    assert.equal(roster[0]?.name, 'Alice Eng');

    // A relayed presence frame carries the SERVER's identity, so a guest cannot
    // appear as a colleague by claiming to be one.
    guest.send({ t: 'presence', frame: { name: 'Alice Eng', userId: aliceId, cursor: { x: 1, y: 2 } } });
    const relayed = await alice.next('presence');
    const frame = relayed.frame as { name: string; userId: string };
    assert.equal(frame.name, `Sam (guest of ${INVITER_NAME})`, 'stamped, never taken from the frame');
    assert.equal(frame.userId, guestActor(link.id));
  } finally {
    alice.close();
    guest.close();
    await Promise.all([alice.closed(), guest.closed()]);
  }
});

test('a guest who chose no name is "Guest (guest of <inviter>)"', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'anon' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, ''); // an empty stored name
  const guest = new Client(seed, cookie);
  try {
    const ack = await guest.join();
    assert.equal((ack.you as { name: string }).name, `${GUEST_FALLBACK_NAME} (guest of ${INVITER_NAME})`);
  } finally {
    guest.close();
    await guest.closed();
  }
});

// ── 5. a guest's ops are ordinary ops ────────────────────────────────────────

test("an edit-link guest's ops converge with a member's, both ways", async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'converge', accent: '#000000' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, 'Sam');
  const alice = new Client(seed, aliceCookie);
  const guest = new Client(seed, cookie);
  try {
    await alice.join();
    await guest.join();
    await alice.next('peer-join');

    guest.send({ t: 'ops', ops: [param('title', 'from the guest', 'g1', 1)] });
    const toAlice = await alice.next('ops');
    assert.deepEqual((toAlice.ops as CanvasOp[]).map((o) => (o as { key: string }).key), ['title']);

    alice.send({ t: 'ops', ops: [param('accent', '#ff0000', 'a1', 1)] });
    const toGuest = await guest.next('ops');
    assert.deepEqual((toGuest.ops as CanvasOp[]).map((o) => (o as { key: string }).key), ['accent']);
  } finally {
    alice.close();
    guest.close();
    await Promise.all([alice.closed(), guest.closed()]);
  }
});

test('the input-lock veto still applies to a guest, under the synthetic `guests` group', async () => {
  // plans/02 §8: "a guest can be given the narrowest input surface of anyone."
  // The overlay rule names no guest - it names the group every guest carries, and
  // the SAME rule leaves the member beside them untouched.
  await store.putOverlay({
    toolId: TOOL_ID,
    version: 1,
    inputAccess: { accent: [{ groups: [GUEST_GROUP], level: 'locked' }] },
  });
  const seed = await makeSession(aliceCookie, projectId, { title: 'locked', accent: '#000000' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, 'Sam');
  const alice = new Client(seed, aliceCookie);
  const guest = new Client(seed, cookie);
  try {
    await alice.join();
    await guest.join();
    await alice.next('peer-join');

    guest.send({ t: 'ops', ops: [param('accent', '#ff0000', 'g2', 1)] });
    const err = await guest.next('error');
    assert.equal(err.code, ERR.INPUT_LOCKED);
    assert.deepEqual(err.inputs, ['accent']);

    // The same input, the same room, a member: allowed.
    alice.send({ t: 'ops', ops: [param('accent', '#00ff00', 'a2', 1)] });
    const toGuest = await guest.next('ops');
    assert.equal((toGuest.ops as Array<{ key: string }>)[0]?.key, 'accent');
  } finally {
    await store.deleteOverlay(TOOL_ID);
    alice.close();
    guest.close();
    await Promise.all([alice.closed(), guest.closed()]);
  }
});

test('a revoked link closes a live guest socket on its next gesture', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'mid-room revoke' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, 'Sam');
  const guest = new Client(seed, cookie);
  try {
    await guest.join();
    const revoked = await json(adminCookie, 'POST', `/api/v1/links/${link.id}/revoke`);
    assert.equal(revoked.status, 200);
    guest.send({ t: 'ops', ops: [param('title', 'after the revoke', 'g3', 1)] });
    assert.equal(await guest.closed(), CLOSE.UNAUTHORIZED, 'the same close a revoked member gets');
  } finally {
    guest.close();
  }
});

test('an IDLE guest observer loses the room too — the seat re-check rides the keepalive', async () => {
  // A guest who only watches has no next gesture, so "the revocation lands on the
  // next op" would be silent about exactly the seat a revoking operator cares
  // most about. Short ping so this is 70 ms rather than 30 s.
  const seed = await makeSession(aliceCookie, projectId, { title: 'idle guest' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, 'Sam');
  const fast = await standUp({}, 40);
  const guest = new Client(seed, cookie, fast.wsBase);
  try {
    await guest.join();
    await json(adminCookie, 'POST', `/api/v1/links/${link.id}/revoke`);
    assert.equal(await guest.closed(), CLOSE.UNAUTHORIZED, 'closed without ever sending an op');
  } finally {
    guest.close();
    fast.close();
  }
});

// ── 6. caps count guests like members ────────────────────────────────────────

test('room caps count guests: one link holds WRITER_CAP_PER_USER seats and no more', async () => {
  // A guest's principal is its LINK, so everyone who was forwarded one invite
  // shares one per-principal writer budget - an invite is not a way around the
  // ceiling that stops one account filling a room.
  const seed = await makeSession(aliceCookie, projectId, { title: 'capped' });
  const link = await mintGuestLink(seed);
  const clients: Client[] = [];
  try {
    for (let i = 0; i < WRITER_CAP_PER_USER; i++) {
      const c = new Client(seed, await guestCookieFor(link.path, `Guest ${i}`));
      clients.push(c);
      const ack = await c.join();
      assert.equal((ack.you as { role: string }).role, 'writer', `guest ${i} is a writer`);
      assert.equal(ack.notice, undefined);
    }
    const extra = new Client(seed, await guestCookieFor(link.path, 'One too many'));
    clients.push(extra);
    const ack = await extra.join();
    assert.equal((ack.you as { role: string }).role, 'observer');
    assert.equal(ack.notice, 'room-full-view-only');

    // …and the admin console counts them like anybody else.
    const room = collab.snapshot().find((r) => r.sessionId === seed);
    assert.ok(room, 'the room is listed');
    assert.equal(room.memberCount, WRITER_CAP_PER_USER + 1);
    assert.equal(room.writerCount, WRITER_CAP_PER_USER);
    assert.equal(room.observerCount, 1);
    assert.ok(
      room.members.every((m) => m.name.includes('(guest of ')),
      'the panel names them as guests, because the room does',
    );
  } finally {
    for (const c of clients) c.close();
    await Promise.all(clients.map((c) => c.closed()));
  }
});

// ── 7. audit + attribution ───────────────────────────────────────────────────

test('collab.join/leave for a guest carry the guest principal, the link and the inviter — keys only', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'audited' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, 'Sam');
  const before = (await store.listAudit()).length;
  const guest = new Client(seed, cookie);
  await guest.join();
  guest.send({ t: 'ops', ops: [param('title', 'a secret headline', 'g4', 1)] });
  await new Promise((r) => setTimeout(r, 100));
  guest.close();
  await guest.closed();

  await until(async () => (await store.listAudit())
    .slice(before)
    .some((e) => e.action === 'collab.leave' && e.subject === `session:${seed}`));

  const events = (await store.listAudit()).slice(before).filter((e) => e.subject === `session:${seed}`);
  const joined = events.find((e) => e.action === 'collab.join');
  const left = events.find((e) => e.action === 'collab.leave');
  assert.ok(joined && left);
  for (const e of [joined, left]) {
    assert.equal(e.actor, guestActor(link.id), 'the actor shape the audit module already uses for guests');
    assert.equal(e.payload?.['linkId'], link.id);
    assert.equal(e.payload?.['inviter'], adminId, 'accountability rides on the inviter (plans/02 §8)');
    assert.equal(e.payload?.['projectId'], projectId);
    assert.equal(e.payload?.['toolId'], TOOL_ID);
  }
  assert.equal(joined.payload?.['role'], 'writer');
  // Keys and ids, never a value and never the pseudonym the guest typed.
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes('a secret headline'), 'never a value');
  assert.ok(!dump.includes('Sam'), 'never the chosen display name');
});

test("a guest's write-back names the guest on the revision, and leaves updated_by a real user", async () => {
  // The session's author is alice; the link's inviter is the admin. So a
  // revision that named either would be naming somebody who did not make the
  // edit - the inviter's identity most of all, which is the one this must never
  // borrow (plans/02 §8: guests are audited AS guests, against their inviter,
  // not as their inviter).
  const seed = await makeSession(aliceCookie, projectId, { title: 'before the guest' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, 'Sam');
  const guest = new Client(seed, cookie);
  await guest.join();
  guest.send({ t: 'ops', ops: [param('title', 'after the guest', 'g5', 1)] });
  await new Promise((r) => setTimeout(r, 100));
  guest.close();
  await guest.closed();

  await until(async () => ((await store.listSessionRevisions(seed)).length > 0));

  const stored = await store.getSession(seed);
  assert.ok(stored);
  assert.equal(stored.inputs['title'], 'after the guest', 'the guest edit landed as an ordinary revision');
  assert.equal(stored.updatedBy, aliceId, 'updated_by is a FK to users(id) — it keeps a real user, untouched');
  assert.notEqual(stored.updatedBy, adminId, 'and it is emphatically not the inviter');

  const revs = await store.listSessionRevisions(seed);
  assert.equal(revs.length, 1, 'ONE history — a guest room writes a normal session revision');
  assert.equal(revs[0]?.actor, guestActor(link.id), 'the revision names the guest principal');
  assert.notEqual(revs[0]?.actor, COLLAB_ACTOR, 'not the anonymous room actor a member-written room gets');
  assert.notEqual(revs[0]?.actor, adminId);
});

test("a member's write-back is unchanged by any of this — still 'collab', still their user id", async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'member only' });
  const alice = new Client(seed, aliceCookie);
  await alice.join();
  alice.send({ t: 'ops', ops: [param('title', 'member edit', 'a5', 1)] });
  await new Promise((r) => setTimeout(r, 100));
  alice.close();
  await alice.closed();

  await until(async () => ((await store.listSessionRevisions(seed)).length > 0));
  const revs = await store.listSessionRevisions(seed);
  assert.equal(revs[0]?.actor, COLLAB_ACTOR);
  assert.equal((await store.getSession(seed))?.updatedBy, aliceId);
});

// ── 8. fix-pass regressions (2026-08-09) ────────────────────────────────────

test('POST /api/v1/links refuses to mint a guest-edit link on a session the minter cannot see', async () => {
  // bob holds `link.create-guest` (granted in `before()`) but is in no group
  // the fixture's shared project is visible to, and is not its owner - so
  // before this fix, holding the grant alone was enough to mint a writer seat
  // on ANY session id in the instance, bypassing `canSeeProject` entirely.
  const res = await json(bobCookie, 'POST', '/api/v1/links', {
    kind: 'guest-edit', target: { toolId: TOOL_ID, sessionId }, projectId,
  });
  assert.equal(res.status, 403, 'bob cannot see the project this session lives in');

  // Sanity: bob genuinely cannot read the session directly either - the mint
  // route now enforces the SAME gate `GET /api/v1/sessions/:id` does, so a
  // mint can never reach further than a plain read of the same session would.
  const direct = await json(bobCookie, 'GET', `/api/v1/sessions/${sessionId}`);
  assert.equal(direct.status, 403);

  // A session id that does not exist at all gets the ordinary 404 - not a
  // different code that would make session ids enumerable via minting.
  const missing = await json(bobCookie, 'POST', '/api/v1/links', {
    kind: 'guest-edit', target: { toolId: TOOL_ID, sessionId: 'ses_does_not_exist' },
  });
  assert.equal(missing.status, 404);

  // Carol (team-eng, genuinely a project member) mints on the SAME session and
  // succeeds - the fix is a visibility check, not a blanket refusal.
  const ok = await json(carolCookie, 'POST', '/api/v1/links', {
    kind: 'guest-edit', target: { toolId: TOOL_ID, sessionId }, projectId,
  });
  assert.equal(ok.status, 201, 'a minter who can actually see the session is unaffected');
  const { id } = await ok.json() as { id: string };
  await json(adminCookie, 'POST', `/api/v1/links/${id}/revoke`); // tidy up - this session is reused above
});

test('a guest is refused once its INVITER is disabled — on the next gesture, and via the idle keepalive', async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'inviter disabled, active' });
  const mint = await json(carolCookie, 'POST', '/api/v1/links', {
    kind: 'guest-edit', target: { toolId: TOOL_ID, sessionId: seed }, projectId,
  });
  assert.equal(mint.status, 201);
  const minted = await mint.json() as { url: string };
  const mintedUrl = new URL(minted.url);
  const cookie = await guestCookieFor(`${mintedUrl.pathname}${mintedUrl.search}`, 'Kim');

  const idleSeed = await makeSession(aliceCookie, projectId, { title: 'inviter disabled, idle' });
  const idleMint = await json(carolCookie, 'POST', '/api/v1/links', {
    kind: 'guest-edit', target: { toolId: TOOL_ID, sessionId: idleSeed }, projectId,
  });
  assert.equal(idleMint.status, 201);
  const idleMinted = await idleMint.json() as { url: string };
  const idleUrl = new URL(idleMinted.url);
  const fast = await standUp({}, 40);
  const idleCookie = await guestCookieFor(`${idleUrl.pathname}${idleUrl.search}`, 'Kim');

  const active = new Client(seed, cookie);
  const idle = new Client(idleSeed, idleCookie, fast.wsBase);
  try {
    await active.join();
    await idle.join();

    const disabled = await json(adminCookie, 'POST', `/api/v1/users/${carolId}/disabled`, { disabled: true });
    assert.equal(disabled.status, 200, "carol's account is disabled — the standard offboarding lever");

    // The gesture path: a socket that IS sending something loses its seat on
    // the next batch, without waiting for the link's own (up to a week) TTL.
    active.send({ t: 'ops', ops: [param('title', 'after the inviter was disabled', 'g6', 1)] });
    assert.equal(await active.closed(), CLOSE.UNAUTHORIZED, "a disabled inviter reaches an already-open socket");

    // The keepalive path: an OBSERVER-shaped guest that never sends a gesture
    // loses the seat too, on the same short ping this fixture uses for the
    // "idle guest" test above.
    assert.equal(await idle.closed(), CLOSE.UNAUTHORIZED, 'an idle guest is not exempt either');
  } finally {
    active.close();
    idle.close();
    fast.close();
  }

  // And carol's own session is now dead too (an ordinary consequence of
  // disabling an account, not new behaviour) - minting itself refuses her.
  const mintAfter = await json(carolCookie, 'POST', '/api/v1/links', {
    kind: 'guest-edit', target: { toolId: TOOL_ID, sessionId: seed },
  });
  assert.equal(mintAfter.status, 401, "carol's own cookie stopped authenticating the moment she was disabled");
});

test("a guest is refused once its inviter loses `link.create-guest` — the SAME per-gesture/keepalive re-check as the link's own liveness", async () => {
  const seed = await makeSession(aliceCookie, projectId, { title: 'inviter grant revoked' });
  const mint = await json(daveCookie, 'POST', '/api/v1/links', {
    kind: 'guest-edit', target: { toolId: TOOL_ID, sessionId: seed }, projectId,
  });
  assert.equal(mint.status, 201, "dave still holds the grant at mint time");
  const minted = await mint.json() as { url: string };
  const mintedUrl = new URL(minted.url);
  const cookie = await guestCookieFor(`${mintedUrl.pathname}${mintedUrl.search}`, 'Kim');

  const guest = new Client(seed, cookie);
  try {
    await guest.join();

    // Revoke ONLY the grant - dave's account stays enabled throughout, so this
    // is genuinely testing plans/02 §8's SECOND revocation lever ("the inviter
    // losing `link.create-guest`"), not the account-disabled lever the test
    // above covers.
    await store.putGrant({ principal: `user:${daveId}`, action: 'link.create-guest', resource: '*', effect: 'deny' });

    guest.send({ t: 'ops', ops: [param('title', 'after the grant was revoked', 'g8', 1)] });
    assert.equal(
      await guest.closed(), CLOSE.UNAUTHORIZED,
      'the inviter losing link.create-guest kills the live guest session immediately (plans/02 §8)',
    );
  } finally {
    guest.close();
    // Leave dave able to mint again for any test that might run after this one.
    await store.deleteGrant({ principal: `user:${daveId}`, action: 'link.create-guest', resource: '*', effect: 'deny' });
  }
});

test('a guest is locked out of an input governed for OTHER groups, while a member outside those groups is unaffected', async () => {
  // The shape an operator actually writes: a lock scoped to the tool's real
  // editing population (never to `guests`, which did not exist when most
  // overlays were authored). plans/02 §8 promised a guest could be given "the
  // narrowest input surface of anyone" - before this fix, that population's
  // OWN lock left the field wide open for the one principal outside every
  // named group.
  await store.putOverlay({
    toolId: TOOL_ID,
    version: 2,
    inputAccess: { accent: [{ groups: ['team-marketing', 'team-sales'], level: 'locked', value: '#000000' }] },
  });
  const seed = await makeSession(aliceCookie, projectId, { title: 'governed unmatched', accent: '#111111' });
  const link = await mintGuestLink(seed);
  const cookie = await guestCookieFor(link.path, 'Sam');
  const alice = new Client(seed, aliceCookie);
  const guest = new Client(seed, cookie);
  try {
    await alice.join();
    await guest.join();
    await alice.next('peer-join');

    guest.send({ t: 'ops', ops: [param('accent', '#ff0000', 'g7', 1)] });
    const err = await guest.next('error');
    assert.equal(err.code, ERR.INPUT_LOCKED, 'governed-but-unmatched now locks a guest out, not leaves it editable');
    assert.deepEqual(err.inputs, ['accent']);

    // alice (team-eng) is ALSO outside ['team-marketing','team-sales'], and her
    // write is UNCHANGED - this fix is guest-specific, never a new default for
    // members, who keep the pre-existing "no matching rule ⇒ editable" fallback.
    alice.send({ t: 'ops', ops: [param('accent', '#00ff00', 'a7', 1)] });
    const toGuest = await guest.next('ops');
    assert.equal((toGuest.ops as Array<{ key: string }>)[0]?.key, 'accent');
  } finally {
    await store.deleteOverlay(TOOL_ID);
    alice.close();
    guest.close();
    await Promise.all([alice.closed(), guest.closed()]);
  }
});

test('a chosen name cannot forge a second "(guest of …)" clause — parens are stripped from the CHOSEN half only', () => {
  const rendered = guestDisplayName('Alice Eng (guest of Ada Admin)', 'Bob Sales');
  assert.equal(rendered, 'Alice Eng guest of Ada Admin (guest of Bob Sales)');
  assert.equal(
    [...rendered.matchAll(/\(guest of /g)].length, 1,
    'exactly one real "(guest of " clause survives — never a forged second one',
  );
  // The inviter's half is untouched: it is a real member's directory name, not
  // user input, and may legitimately contain parens.
  assert.equal(guestDisplayName('Sam', 'Dr. Andy (Design)'), 'Sam (guest of Dr. Andy (Design))');
});
