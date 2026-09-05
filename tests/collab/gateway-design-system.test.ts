// SPDX-License-Identifier: MPL-2.0
/**
 * The collab gateway's design-system gate (OSS `plans/186` §3.10, this repo's
 * `plans/14` §6): a room hosted here runs under exactly ONE design system, the
 * one this deployment governs, and the gateway refuses a client that says it is
 * rendering with a different one.
 *
 * The carrier is the UPGRADE URL - `?ds=<brand profile>&dsi=<instance base>` -
 * so the refusal is the same plain HTTP status on the raw socket that every
 * other gate here answers with. What these cases pin is the tolerance as much as
 * the rule: a client that names nothing joins (that is every shell built before
 * the field existed), a client that names only one half has only that half
 * checked, and a trailing slash or a capital letter in the instance base is not
 * a different instance.
 *
 * Two deployments stand up, because the rule has two shapes. `hub` mounts a
 * profile-aware pack (the `brands/<name>/` + `.lolly-profile` + catalog-symlink
 * layout of `tests/brand-profiles.test.ts`), where the profile name is checked
 * as well. `plain` mounts an ordinary single-brand pack, where there is nothing
 * to compare a name against and the instance check is the whole gate.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import { parseConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { buildApp } from '../../server/src/api/app.ts';
import {
  createCollabGateway, designSystemClaim, sameInstanceBase, COLLAB_WS_PREFIX,
  type CollabGateway,
} from '../../server/src/collab/gateway.ts';

const TOOL_ID = 'deck';
const SECRETS = { session: 'sD', link: 'lD' };
/** The two deployments' bases. Neither is where the test server actually
 *  listens, and that is the point: the gate compares what a client claims
 *  against the CONFIGURED base, not against the host it dialled. */
const HUB_BASE = 'http://brand.example';
const PLAIN_BASE = 'http://plain.example';
/** The active brand profile on the hub's pack; `other` is the one it is not. */
const ACTIVE_PROFILE = 'suse';
const OTHER_PROFILE = 'lolly-start';

interface Deployment {
  wsBase: string;
  base: string;
  cookie: string;
  sessionId: string;
  gateway: CollabGateway;
  server: Server;
}

let hub: Deployment;
let plain: Deployment;

/** One brand profile inside a profile-aware pack: its own catalog with an
 *  assets index and a tools index. The shape `tests/brand-profiles.test.ts`
 *  writes, plus the tools index the collab suites' packs carry. */
async function writeProfile(root: string, name: string): Promise<void> {
  const catalog = join(root, 'brands', name, 'catalog');
  await mkdir(join(catalog, 'assets'), { recursive: true });
  await mkdir(join(catalog, 'tools'), { recursive: true });
  await writeFile(join(catalog, 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: [{
      id: `${name}/tokens/brand`,
      type: 'tokens',
      name: `${name} tokens`,
      formats: [{ format: 'json', url: `/catalog/${name}/tokens/brand.json` }],
    }],
  }));
  await writeFile(join(catalog, 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(catalog, name, 'tokens'), { recursive: true });
  await writeFile(join(catalog, name, 'tokens', 'brand.json'), JSON.stringify({
    color: { brand: { primary: { $value: '#30ba78', $type: 'color' } } },
  }));
}

/** The tool the fixture session is made with. Lives outside `catalog/`, so it is
 *  shared by every profile. */
async function writeTool(root: string): Promise<void> {
  await mkdir(join(root, 'tools', TOOL_ID), { recursive: true });
  await writeFile(join(root, 'tools', TOOL_ID, 'tool.json'), JSON.stringify({
    id: TOOL_ID,
    inputs: [{ id: 'title', type: 'text' }],
  }));
}

/** A profile-aware pack: two brands, `suse` active, `catalog` a relative symlink
 *  at the one the marker names. */
async function profileAwarePack(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-ds-hub-'));
  await writeProfile(root, ACTIVE_PROFILE);
  await writeProfile(root, OTHER_PROFILE);
  await writeFile(join(root, '.lolly-profile'), `${ACTIVE_PROFILE}\n`);
  await symlink(join('brands', ACTIVE_PROFILE, 'catalog'), join(root, 'catalog'));
  await writeTool(root);
  return root;
}

/** An ordinary pack: one catalog, no `brands/` dir, so `listBrandProfiles`
 *  reports unavailable and the gate has only the instance half to check. */
async function plainPack(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lw-ds-plain-'));
  await mkdir(join(root, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(root, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(root, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await writeFile(join(root, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await writeTool(root);
  return root;
}

/** The house http-test bootstrap (tests/collab/gateway.test.ts): own server, own
 *  memory store, gateway on `upgrade`, one member with a project and a session. */
async function standUp(name: string, baseUrl: string, pack: string): Promise<Deployment> {
  const config = parseConfig(JSON.stringify({
    instance: { name, baseUrl, pack },
    dev: { enabled: true, users: [{ email: 'alice@test', name: 'Alice Eng', groups: ['team-eng'] }] },
  }));
  const store = createMemoryStore();
  const gateway = createCollabGateway({ config, store, secrets: SECRETS });
  const app = buildApp({ config, store, secrets: SECRETS, listCollabRooms: () => gateway.snapshot() });
  const server = createServer((req, res) => void app(req, res));
  server.on('upgrade', (req, socket, head) => {
    if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;

  const login = await fetch(`${base}/api/auth/dev?email=alice%40test`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const setCookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  assert.ok(setCookie, 'session cookie set');
  const cookie = setCookie.split(';')[0] as string;

  const project = await fetch(`${base}/api/v1/projects`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Design systems', visibility: { groups: ['team-eng'] } }),
  });
  assert.equal(project.status, 201);
  const projectId = (await project.json() as { id: string }).id;

  const session = await fetch(`${base}/api/v1/projects/${projectId}/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      toolId: TOOL_ID, toolVersion: '1.0.0', inputs: { title: 'Draft' }, meta: { label: 'ds fixture' },
    }),
  });
  assert.equal(session.status, 201);
  const sessionId = (await session.json() as { id: string }).id;

  return { wsBase: `ws://127.0.0.1:${port}`, base, cookie, sessionId, gateway, server };
}

interface UpgradeResult {
  /** 101 when the handshake completed, otherwise the refusal's status. */
  status: number;
  /** The refusal's reason phrase, which is where the machine code rides. */
  code: string;
  /** The refusal body: the code, then the sentence a person can act on. */
  body: string;
}

/** Dial the gateway with a query string and report what came back. A completed
 *  handshake is joined for real (`join` → `join-ack`) before it is closed, so a
 *  case that says "joins" has watched a seat happen, not just a socket open. */
function upgrade(dep: Deployment, query: string): Promise<UpgradeResult> {
  return new Promise((resolve, reject) => {
    const url = `${dep.wsBase}${COLLAB_WS_PREFIX}${dep.sessionId}${query}`;
    const ws = new WebSocket(url, { headers: { cookie: dep.cookie } });
    const timer = setTimeout(() => reject(new Error('no response to the upgrade')), 5000);
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      const done = () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode ?? 0, code: res.statusMessage ?? '', body });
      };
      res.on('end', done);
      res.on('close', done);
      res.on('error', done);
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'join', opVersion: CANVAS_OP_VERSION }));
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { t: string };
      if (frame.t !== 'join-ack') return;
      clearTimeout(timer);
      ws.close();
      resolve({ status: 101, code: 'JOIN_ACK', body: '' });
    });
    ws.on('error', () => undefined);
  });
}

before(async () => {
  hub = await standUp('Brand Hub', HUB_BASE, await profileAwarePack());
  plain = await standUp('Plain Hub', PLAIN_BASE, await plainPack());
});

after(() => {
  for (const dep of [hub, plain]) {
    if (!dep) continue;
    dep.gateway.close();
    dep.server.close();
  }
});

// ── the parse, on its own ─────────────────────────────────────────────────────

test('a claim is only a claim when a value is actually there', () => {
  assert.equal(designSystemClaim('/ws/collab/s1'), null);
  assert.equal(designSystemClaim('/ws/collab/s1?ds=&dsi='), null, 'blank values are not a claim');
  assert.equal(designSystemClaim(undefined), null);
  assert.deepEqual(designSystemClaim('/ws/collab/s1?ds=suse'), { id: 'suse', instance: null });
  assert.deepEqual(
    designSystemClaim('/ws/collab/s1?ds=suse&dsi=http%3A%2F%2Fbrand.example'),
    { id: 'suse', instance: 'http://brand.example' },
  );
});

test('two instance bases are the same deployment past a slash or a capital', () => {
  assert.equal(sameInstanceBase('http://brand.example/', 'http://brand.example'), true);
  assert.equal(sameInstanceBase('HTTP://Brand.Example', 'http://brand.example'), true);
  assert.equal(sameInstanceBase('http://brand.example/console', 'http://brand.example'), true);
  assert.equal(sameInstanceBase('http://other.example', 'http://brand.example'), false);
  // Two values that are not URLs at all must not collapse into one match.
  assert.equal(sameInstanceBase('suse', 'lolly-start'), false);
  assert.equal(sameInstanceBase(undefined, 'http://brand.example'), false);
});

// ── the gate, over a real socket ──────────────────────────────────────────────

test('a client that names no design system joins, exactly as it did before', async () => {
  const result = await upgrade(hub, '');
  assert.equal(result.status, 101);
});

test('the governed design system joins: the active profile at this instance', async () => {
  const result = await upgrade(hub, `?ds=${ACTIVE_PROFILE}&dsi=${encodeURIComponent(HUB_BASE)}`);
  assert.equal(result.status, 101);
});

test('a trailing slash on the instance base is not a different instance', async () => {
  const result = await upgrade(hub, `?ds=${ACTIVE_PROFILE}&dsi=${encodeURIComponent(`${HUB_BASE}/`)}`);
  assert.equal(result.status, 101);
});

test('a design system from another instance is refused DESIGN_SYSTEM_MISMATCH', async () => {
  const result = await upgrade(hub, `?ds=${ACTIVE_PROFILE}&dsi=${encodeURIComponent('http://elsewhere.example')}`);
  assert.equal(result.status, 403);
  assert.equal(result.code, 'DESIGN_SYSTEM_MISMATCH');
  // The refusal names what to switch to, not what the client sent.
  assert.match(result.body, /DESIGN_SYSTEM_MISMATCH/);
  assert.match(result.body, new RegExp(`"${ACTIVE_PROFILE}" design system`));
  assert.match(result.body, new RegExp(HUB_BASE.replace(/[.]/g, '\\.')));
  assert.equal(result.body.includes('elsewhere.example'), false);
});

test('the wrong brand profile on a profile-aware pack is refused, instance or no', async () => {
  const result = await upgrade(hub, `?ds=${OTHER_PROFILE}&dsi=${encodeURIComponent(HUB_BASE)}`);
  assert.equal(result.status, 403);
  assert.equal(result.code, 'DESIGN_SYSTEM_MISMATCH');
  assert.match(result.body, new RegExp(`"${ACTIVE_PROFILE}" design system`));
});

test('half a claim is half a check: an instance with no profile name still joins', async () => {
  const result = await upgrade(hub, `?dsi=${encodeURIComponent(HUB_BASE)}`);
  assert.equal(result.status, 101);
});

test('a pack with no brand profiles checks the instance and nothing else', async () => {
  const named = await upgrade(plain, `?ds=whatever-it-calls-it&dsi=${encodeURIComponent(PLAIN_BASE)}`);
  assert.equal(named.status, 101, 'there is only one design system here, so the name is not compared');

  const elsewhere = await upgrade(plain, `?ds=whatever-it-calls-it&dsi=${encodeURIComponent(HUB_BASE)}`);
  assert.equal(elsewhere.status, 403);
  assert.equal(elsewhere.code, 'DESIGN_SYSTEM_MISMATCH');
  // No profile to name, so the message falls back to the plain phrase.
  assert.match(elsewhere.body, /this instance's design system/);
});
