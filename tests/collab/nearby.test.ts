// SPDX-License-Identifier: LicenseRef-Lolly-Work-Proprietary
/**
 * Instance-mediated "nearby" (server/src/collab/nearby.ts + the two
 * /api/v1/collab/nearby routes, plans/26 §8):
 *   - the registry itself: opt-in, self-exclusion, the `near` (same-IP) hint, sort
 *     order, TTL sweep;
 *   - the routes end-to-end: member opt-in + list, unauthenticated refusal, guests
 *     excluded (no member session), policy-disabled 404, and the Vercel-shaped 501
 *     when no registry is injected.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

import { parseConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { buildApp } from '../../server/src/api/app.ts';
import { createNearbyRegistry, NEARBY_TTL_MS } from '../../server/src/collab/nearby.ts';

// ── the registry ─────────────────────────────────────────────────────────────

test('registry: opt-in, self-exclusion, and the same-IP near hint', () => {
  let clock = 1000;
  const reg = createNearbyRegistry({ now: () => clock });
  reg.setVisible('u-andy', 'Andy', '10.0.0.5');
  reg.setVisible('u-priya', 'Priya', '10.0.0.5'); // same subnet as caller below
  reg.setVisible('u-sam', 'Sam', '203.0.113.9');  // elsewhere

  // Andy asks, from 10.0.0.5: never lists himself; Priya is near, Sam is not.
  const list = reg.list('u-andy', '10.0.0.5');
  assert.deepEqual(list, [
    { userId: 'u-priya', name: 'Priya', near: true },
    { userId: 'u-sam', name: 'Sam', near: false },
  ]);
});

test('registry: near-first, then alphabetical within a band', () => {
  const clock = 5;
  const reg = createNearbyRegistry({ now: () => clock });
  reg.setVisible('u1', 'Zoe', '1.1.1.1');   // near
  reg.setVisible('u2', 'Alan', '1.1.1.1');  // near
  reg.setVisible('u3', 'Bea', '2.2.2.2');   // far
  reg.setVisible('u4', 'Amy', '2.2.2.2');   // far
  const names = reg.list('caller', '1.1.1.1').map((m) => `${m.name}:${m.near}`);
  assert.deepEqual(names, ['Alan:true', 'Zoe:true', 'Amy:false', 'Bea:false']);
});

test('registry: clear removes a member; TTL sweeps a stale one', () => {
  let clock = 0;
  const reg = createNearbyRegistry({ now: () => clock });
  reg.setVisible('u1', 'A', '1.1.1.1');
  reg.setVisible('u2', 'B', '1.1.1.1');
  reg.clear('u1');
  assert.equal(reg.size(), 1);
  // Advance past the TTL: the survivor ages off on the next read.
  clock += NEARBY_TTL_MS + 1;
  assert.equal(reg.size(), 0);
  assert.deepEqual(reg.list('caller', '1.1.1.1'), []);
});

test('registry: setVisible refreshes the stamp, keeping a member alive across the TTL', () => {
  let clock = 0;
  const reg = createNearbyRegistry({ now: () => clock });
  reg.setVisible('u1', 'A', '1.1.1.1');
  clock += NEARBY_TTL_MS - 1;
  reg.setVisible('u1', 'A', '1.1.1.1'); // refresh just before expiry
  clock += NEARBY_TTL_MS - 1;
  assert.equal(reg.size(), 1);
});

// ── the routes ───────────────────────────────────────────────────────────────

const SECRETS = { session: 's3', link: 'l3' };
const DEV_USERS = [
  { email: 'andy@test', name: 'Andy', groups: ['staff'] },  // → member (has collab.join)
  { email: 'priya@test', name: 'Priya', groups: ['staff'] },
];

function makeConfig(overrides: Record<string, unknown>) {
  return parseConfig(JSON.stringify({
    instance: { name: 'Nearby Test', baseUrl: 'http://localhost', pack: '.' },
    dev: { enabled: true, users: DEV_USERS },
    ...overrides,
  }));
}

let mainSrv: Server, disabledSrv: Server, noRegSrv: Server;
let mainBase = '', disabledBase = '', noRegBase = '';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

before(async () => {
  const store = createMemoryStore();
  // Enabled + a registry injected — the ordinary long-lived-server shape.
  const mainApp = buildApp({ config: makeConfig({ policy: { defaultAccessMode: 'open' } }), store, secrets: SECRETS, nearby: createNearbyRegistry() });
  // Enabled but NO registry injected — the Vercel shape (must 501).
  const noRegApp = buildApp({ config: makeConfig({ policy: { defaultAccessMode: 'open' } }), store, secrets: SECRETS });
  // Policy-disabled (must 404) — registry present but off.
  const disabledApp = buildApp({ config: makeConfig({ policy: { defaultAccessMode: 'open', nearby: { enabled: false } } }), store, secrets: SECRETS, nearby: createNearbyRegistry() });

  mainSrv = createServer((req, res) => void mainApp(req, res));
  noRegSrv = createServer((req, res) => void noRegApp(req, res));
  disabledSrv = createServer((req, res) => void disabledApp(req, res));
  mainBase = await listen(mainSrv);
  noRegBase = await listen(noRegSrv);
  disabledBase = await listen(disabledSrv);
});

after(() => { mainSrv.close(); noRegSrv.close(); disabledSrv.close(); });

/** Dev login → the member session cookie. Works against any app sharing SECRETS. */
async function login(email: string): Promise<string> {
  const res = await fetch(`${mainBase}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0] as string;
}

test('routes: unauthenticated GET and POST are refused', async () => {
  assert.equal((await fetch(`${mainBase}/api/v1/collab/nearby`)).status, 401);
  const post = await fetch(`${mainBase}/api/v1/collab/nearby`, { method: 'POST', body: '{"visible":true}' });
  assert.equal(post.status, 401);
});

test('routes: a member opts in, another member sees them (near over loopback)', async () => {
  const andy = await login('andy@test');
  const priya = await login('priya@test');

  // Andy turns himself visible.
  const opt = await fetch(`${mainBase}/api/v1/collab/nearby`, {
    method: 'POST', headers: { cookie: andy, 'content-type': 'application/json' }, body: JSON.stringify({ visible: true }),
  });
  assert.equal(opt.status, 200);
  assert.deepEqual(await opt.json(), { visible: true });

  // Priya lists: she sees Andy, and both are on loopback so near is true.
  const list = await (await fetch(`${mainBase}/api/v1/collab/nearby`, { headers: { cookie: priya } })).json() as { members: Array<{ userId: string; name: string; near: boolean }> };
  const andyRow = list.members.find((m) => m.name === 'Andy');
  assert.ok(andyRow, 'Andy is listed');
  assert.equal(andyRow!.near, true);

  // Andy does not see himself.
  const andySees = await (await fetch(`${mainBase}/api/v1/collab/nearby`, { headers: { cookie: andy } })).json() as { members: Array<{ name: string }> };
  assert.equal(andySees.members.some((m) => m.name === 'Andy'), false);
});

test('routes: opting out removes a member from the list', async () => {
  const andy = await login('andy@test');
  const priya = await login('priya@test');
  await fetch(`${mainBase}/api/v1/collab/nearby`, { method: 'POST', headers: { cookie: andy, 'content-type': 'application/json' }, body: JSON.stringify({ visible: true }) });
  await fetch(`${mainBase}/api/v1/collab/nearby`, { method: 'POST', headers: { cookie: andy, 'content-type': 'application/json' }, body: JSON.stringify({ visible: false }) });
  const list = await (await fetch(`${mainBase}/api/v1/collab/nearby`, { headers: { cookie: priya } })).json() as { members: Array<{ name: string }> };
  assert.equal(list.members.some((m) => m.name === 'Andy'), false);
});

test('routes: policy-disabled instance answers 404', async () => {
  const andy = await login('andy@test');
  const res = await fetch(`${disabledBase}/api/v1/collab/nearby`, { headers: { cookie: andy } });
  assert.equal(res.status, 404);
});

test('routes: no injected registry (Vercel shape) answers 501', async () => {
  const andy = await login('andy@test');
  const res = await fetch(`${noRegBase}/api/v1/collab/nearby`, { headers: { cookie: andy } });
  assert.equal(res.status, 501);
});
