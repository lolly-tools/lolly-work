// SPDX-License-Identifier: MPL-2.0
/**
 * The collab governance bits (OSS plans/100 §7 item 7, `plans/14` §6 "Landed
 * 2026-08-09"): `private-collab` joining `GOVERNABLE_FLAGS` is covered in
 * `tests/feature-flags.test.ts`. This file covers the other two asks:
 *
 *   1. `collab.join`/`collab.edit` in org-config's `can[]`, per role, and how
 *      each interacts with fine-grained grants — `collab.join` is a REAL
 *      action in the RBAC role table (rides with `session.view`); `collab.edit`
 *      deliberately is not — it is `mayEditCollab()`, i.e. `session.edit`
 *      itself under another name (`server/src/rbac/evaluate.ts`).
 *   2. That the gateway's writer/observer decision and the advertised
 *      `can['collab.edit']` bit cannot drift apart — a structural check that
 *      the gateway routes through the shared helper rather than re-deriving
 *      the answer, plus an end-to-end check over a real socket + a real
 *      `GET /api/v1/org-config` for every reachable role.
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

import { evaluate, mayEditCollab, ROLES, type Grant, type PrincipalCtx, type Role } from '../../server/src/rbac/evaluate.ts';
import { assembleOrgConfig } from '../../server/src/policy/org-config.ts';
import { parseConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { buildApp } from '../../server/src/api/app.ts';
import { createCollabGateway, COLLAB_WS_PREFIX, type CollabGateway } from '../../server/src/collab/gateway.ts';
import type { InstanceConfig } from '../../server/src/config/instance.ts';
import type { UserRecord } from '../../server/src/store/types.ts';

const CONFIG = {
  instance: { name: 'Test' },
  policy: { telemetry: 'standard', telemetryAttribution: 'opt-in' },
} as unknown as InstanceConfig;

function userWithRole(role: Role, groups: string[] = []): UserRecord {
  const now = new Date().toISOString();
  return {
    id: `u-${role}`, sub: `dev:${role}@x`, email: `${role}@x`,
    idpGroups: groups, localGroups: [], groups, role,
    sessionEpoch: 0, createdAt: now, lastSeenAt: now,
  };
}

const canOf = (role: Role, grants: Grant[] = []) =>
  assembleOrgConfig({ config: CONFIG, user: userWithRole(role), overlays: new Map(), grants, inboxUnread: 0 }).can;

// ── 1a. per-role table, no grants ───────────────────────────────────────────

test('collab.join: every role that can read a session gets it, guest does not', () => {
  const expected: Record<Role, boolean> = {
    viewer: true, member: true, author: true, approver: true, admin: true, owner: true, guest: false,
  };
  for (const role of ROLES) {
    assert.equal(canOf(role)['collab.join'], expected[role], `collab.join for ${role}`);
  }
});

test('collab.edit: exactly the roles that hold session.edit by default', () => {
  const expected: Record<Role, boolean> = {
    viewer: false, member: true, author: true, approver: true, admin: true, owner: true, guest: false,
  };
  for (const role of ROLES) {
    assert.equal(canOf(role)['collab.edit'], expected[role], `collab.edit for ${role}`);
    // Same table, the OTHER way round: whatever the role default says about
    // session.edit itself must match, since collab.edit IS that action.
    assert.equal(
      canOf(role)['collab.edit'],
      evaluate({ groups: [], role }, 'session.edit', ['*'], []),
      `collab.edit tracks session.edit's own role default for ${role}`,
    );
  }
});

// ── 1b. grants: collab.edit rides session.edit's grants, not its own ───────

test('a session.edit deny grant flips collab.edit off without touching collab.join', () => {
  const ctx: PrincipalCtx = { userId: 'u-member', groups: [], role: 'member' };
  const deny: Grant = { principal: 'user:u-member', action: 'session.edit', resource: '*', effect: 'deny' };
  const can = canOf('member', [deny]);
  assert.equal(can['collab.edit'], false);
  assert.equal(can['collab.join'], true, 'collab.join is unaffected — it is a different action');
  assert.equal(can['collab.edit'], mayEditCollab(ctx, [deny]), 'agrees with the shared helper');
});

test('a session.edit ALLOW grant lifts a viewer to collab.edit, exactly as it would session.edit itself', () => {
  const ctx: PrincipalCtx = { userId: 'u-viewer', groups: [], role: 'viewer' };
  const allow: Grant = { principal: 'user:u-viewer', action: 'session.edit', resource: '*', effect: 'allow' };
  assert.equal(canOf('viewer', [allow])['collab.edit'], true);
  assert.equal(evaluate(ctx, 'session.edit', ['*'], [allow]), true, 'sanity: the grant really does lift session.edit');
});

test('a grant on the LITERAL action "collab.edit" has NO effect — it is not a real action', () => {
  // If this ever started passing the OTHER way, collab.edit would be reading
  // its own grants again — the exact drift `mayEditCollab` exists to prevent
  // (an admin could deny collab.edit and forget session.edit, or vice versa).
  const denyCollabEdit: Grant = { principal: 'user:u-member', action: 'collab.edit', resource: '*', effect: 'deny' };
  assert.equal(canOf('member', [denyCollabEdit])['collab.edit'], true, 'still true — session.edit was never touched');
  const allowCollabEditForViewer: Grant = { principal: 'user:u-viewer', action: 'collab.edit', resource: '*', effect: 'allow' };
  assert.equal(canOf('viewer', [allowCollabEditForViewer])['collab.edit'], false, 'still false — no session.edit grant');
});

test('unlike collab.edit, collab.join DOES read its own grants (it is a real action)', () => {
  const denyJoin: Grant = { principal: 'user:u-viewer', action: 'collab.join', resource: '*', effect: 'deny' };
  assert.equal(canOf('viewer', [denyJoin])['collab.join'], false);
  const allowJoinForGuest: Grant = { principal: 'user:u-guest', action: 'collab.join', resource: '*', effect: 'allow' };
  assert.equal(canOf('guest', [allowJoinForGuest])['collab.join'], true);
});

// ── 2a. structural: the gateway may not re-derive the writer decision ──────

test('the gateway imports mayEditCollab and never re-derives the writer decision with its own evaluate() call', async () => {
  const src = await readFile(
    fileURLToPath(new URL('../../server/src/collab/gateway.ts', import.meta.url)),
    'utf8',
  );
  const importLine = src.split('\n').find((l) => l.includes("from '../rbac/evaluate.ts'"));
  assert.ok(importLine, 'gateway.ts imports from rbac/evaluate.ts');
  assert.ok(importLine!.includes('mayEditCollab'), 'imports the shared helper');
  // A bare `evaluate` identifier in that import's named list (not as part of
  // `mayEditCollab`) would mean the file can call evaluate(…) directly again —
  // exactly the duplication mayEditCollab exists to prevent.
  const named = importLine!.match(/\{([^}]*)\}/)?.[1] ?? '';
  const idents = named.split(',').map((s) => s.replace(/^type\s+/, '').trim());
  assert.ok(!idents.includes('evaluate'), `evaluate must not be imported directly; got [${idents.join(', ')}]`);

  const calls = [...src.matchAll(/\bmayEditCollab\(/g)].length;
  assert.ok(calls >= 2, `expected mayEditCollab() called from both admit() and authorizeOps(), got ${calls}`);
});

// ── 2b. end-to-end: real gateway writer seat vs real org-config bit ────────

const TOOL_ID = 'notes';
/** A shared group every dev user below carries, purely for project visibility
 *  (the RBAC role itself still comes from the role-named group, or its
 *  absence for a plain member — `roleFromGroups`). */
const READ_GROUP = 'perm-read';
const ROLE_GROUPS: Array<{ role: Exclude<Role, 'viewer' | 'guest'>; groups: string[] }> = [
  { role: 'member', groups: [READ_GROUP] },
  { role: 'author', groups: [READ_GROUP, 'author'] },
  { role: 'approver', groups: [READ_GROUP, 'approver'] },
  { role: 'admin', groups: [READ_GROUP, 'admin'] },
  { role: 'owner', groups: [READ_GROUP, 'owner'] },
];

let server: Server;
let collab: CollabGateway;
let base = '';
let wsBase = '';
let sessionId = '';
/** Module-scoped so a test can write a grant directly, the way the gateway
 *  suite does — the console's grants API is exercised elsewhere; what matters
 *  here is the decision, not the route that recorded it. */
let store: ReturnType<typeof createMemoryStore>;
const cookies = new Map<string, string>();

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-collab-perm-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'tools', TOOL_ID), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL_ID, 'tool.json'), JSON.stringify({
    id: TOOL_ID,
    inputs: [{ id: 'title', type: 'text' }],
  }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Perms Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        ...ROLE_GROUPS.map((r) => ({ email: `${r.role}@test`, name: r.role, groups: r.groups })),
        { email: 'restricted@test', name: 'Restricted Member', groups: [READ_GROUP] },
        // An ordinary member of the project whose GROUP is denied collab.join
        // below — the "rooms are switched off for contractors" operator move.
        { email: 'nojoin@test', name: 'No Join', groups: [READ_GROUP, 'contractors'] },
      ],
    },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sc', link: 'lc' } });
  collab = createCollabGateway({ config, store, secrets: { session: 'sc', link: 'lc' } });
  server = createServer((req, res) => void app(req, res));
  server.on('upgrade', (req, socket, head) => {
    if (!collab.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;

  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
    assert.ok(cookie);
    cookies.set(email, cookie!.split(';')[0] as string);
    return cookies.get(email)!;
  };

  await Promise.all([
    ...ROLE_GROUPS.map((r) => login(`${r.role}@test`)),
    login('restricted@test'),
    login('nojoin@test'),
  ]);
  const adminCookie = cookies.get('admin@test')!;

  // A project every principal above can see: admin/owner bypass via role, and
  // everyone else — member/author/approver/restricted — shares READ_GROUP.
  const projectRes = await fetch(`${base}/api/v1/projects`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Perms', visibility: { groups: [READ_GROUP] } }),
  });
  assert.equal(projectRes.status, 201);
  const projectId = (await projectRes.json() as { id: string }).id;

  const sessionRes = await fetch(`${base}/api/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: TOOL_ID, toolVersion: '1.0.0', inputs: { title: 'x' }, meta: { label: 'perm fixture' } }),
  });
  assert.equal(sessionRes.status, 201);
  sessionId = (await sessionRes.json() as { id: string }).id;

  // restricted@test is a member with session.edit explicitly denied — the
  // "eligible reader, no edit right" shape (plans/14 §6).
  const restricted = (await store.listUsers()).find((u) => u.email === 'restricted@test');
  assert.ok(restricted);
  await store.putGrant({ principal: `user:${restricted.id}`, action: 'session.edit', resource: '*', effect: 'deny' });
});

after(() => {
  collab.close();
  server.close();
});

async function orgConfigCan(cookie: string): Promise<Record<string, boolean>> {
  const res = await fetch(`${base}/api/v1/org-config`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json() as { can: Record<string, boolean> }).can;
}

/** The HTTP status of a REFUSED upgrade — the gateway answers a plain response
 *  on the raw socket, so a refusal has a real status instead of a mystery
 *  disconnect. Resolves 101 when the handshake actually completes. */
function upgradeStatus(cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${sessionId}`, { headers: { cookie } });
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

function joinAndGetRole(cookie: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}${COLLAB_WS_PREFIX}${sessionId}`, { headers: { cookie } });
    const timer = setTimeout(() => reject(new Error('timeout waiting for join-ack')), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', opVersion: CANVAS_OP_VERSION })));
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { t: string; you?: { role: string } };
      if (frame.t === 'join-ack') {
        clearTimeout(timer);
        ws.close();
        resolve(frame.you!.role);
      }
    });
    ws.on('error', reject);
  });
}

for (const { role } of ROLE_GROUPS) {
  test(`role ${role}: real gateway writer seat agrees with real org-config can['collab.edit']`, async () => {
    const cookie = cookies.get(`${role}@test`)!;
    const [can, wireRole] = await Promise.all([orgConfigCan(cookie), joinAndGetRole(cookie)]);
    // Captured before any assert.equal narrows wireRole's literal type — the
    // agreement check below compares this boolean, not the raw string, so it
    // stays meaningful regardless of which branch a future role table takes.
    const isWriter = wireRole === 'writer';
    assert.equal(can['collab.edit'], true, `${role} holds session.edit by default`);
    assert.equal(isWriter, true, `${role} got a writer seat`);
    assert.equal(isWriter, can['collab.edit'], `${role}: gateway seat and org-config bit agree`);
  });
}

test('a collab.join deny: the advertised bit and the real socket agree — both refuse', async () => {
  // The drift this file exists to prevent, on the OTHER collab bit. `collab.join`
  // is a real action with real grants, the console offers it, and org-config
  // answers `false` for a denied principal — while the gateway consulted it
  // nowhere and admitted them anyway, as a writer, with the whole document. An
  // advertised capability the server does not enforce is worse than no bit at
  // all: an operator reads "rooms are off for contractors" off a screen that is
  // telling the truth about nothing.
  const cookie = cookies.get('nojoin@test')!;
  assert.equal((await orgConfigCan(cookie))['collab.join'], true, 'precondition: no deny yet');
  assert.equal(await joinAndGetRole(cookie), 'writer', 'precondition: an ordinary seat');

  const deny = { principal: 'group:contractors', action: 'collab.join', resource: '*', effect: 'deny' } as const;
  await store.putGrant({ ...deny });
  try {
    const can = await orgConfigCan(cookie);
    assert.equal(can['collab.join'], false, 'the bit the shell is told');
    assert.equal(can['collab.edit'], true, 'session.edit is untouched — this is a room gate, not an edit gate');
    assert.equal(await upgradeStatus(cookie), 403, 'and the socket the shell would open');
  } finally {
    await store.deleteGrant({ ...deny });
  }
  assert.equal(await joinAndGetRole(cookie), 'writer', 'lifting the deny restores the seat');
});

test('a member with session.edit denied: real gateway seats an observer, org-config says collab.edit false', async () => {
  const cookie = cookies.get('restricted@test')!;
  const [can, wireRole] = await Promise.all([orgConfigCan(cookie), joinAndGetRole(cookie)]);
  const isWriter = wireRole === 'writer';
  assert.equal(can['collab.join'], true, 'still an eligible reader — presence-visible');
  assert.equal(can['collab.edit'], false);
  assert.equal(wireRole, 'observer');
  assert.equal(isWriter, can['collab.edit'], 'gateway seat and org-config bit agree (both false/observer)');
});
