/**
 * The partner action allowlist (plans/82 M6, scope-2 A).
 *
 * A partner programme member can only ever be allowed the actions in
 * PARTNER_ACTIONS (rbac/evaluate.ts). A delegated admin grant (grant.edit,
 * policy.edit, programme.manage, catalog.edit, collections, links, providers, audit,
 * telemetry, fleet) or a member default partners do not get (group.create,
 * delivery.create) is refused for them, whatever the grants say. Staff holding the
 * same grants are unchanged, and the grants API says which grants do not apply.
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
import { PARTNER_ACTIONS, evaluate } from '../server/src/rbac/evaluate.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let ritaId = '';

/** Each removed action, a route that requires it, and a body when it writes. */
const REMOVED: Array<{ action: string; method: string; path: string; body?: unknown }> = [
  { action: 'grant.edit', method: 'GET', path: '/api/v1/grants' },
  { action: 'policy.edit', method: 'GET', path: '/api/v1/org-config/preview?groups=marketing' },
  { action: 'programme.manage', method: 'GET', path: '/api/v1/programmes' },
  { action: 'catalog.edit', method: 'GET', path: '/api/v1/catalog/rights/marks' },
  { action: 'catalog.collection.manage', method: 'GET', path: '/api/v1/catalog/collections' },
  { action: 'link.revoke', method: 'GET', path: '/api/v1/links?all=1' },
  { action: 'catalog.provider.read', method: 'GET', path: '/api/v1/catalog/providers' },
  { action: 'audit.export', method: 'GET', path: '/api/v1/audit' },
  { action: 'telemetry.view', method: 'GET', path: '/api/v1/telemetry/summary' },
  { action: 'fleet.view', method: 'GET', path: '/api/v1/fleet' },
  { action: 'group.create', method: 'POST', path: '/api/v1/share-groups', body: { name: 'Our crew', members: [] } },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-allowlist-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Allowlist Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@reseller.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'al', link: 'll' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  await send(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: [] });
  await login('rita@reseller.test');
  ritaId = (await store.getUserBySub('dev:rita@reseller.test'))!.id;
  await send(admin, 'PUT', `/api/v1/users/${ritaId}/local-groups`, { groups: ['programme-resellers'] });
  // The same delegated grants to the programme and to a staff group.
  for (const { action } of REMOVED) {
    for (const group of ['programme-resellers', 'marketing']) {
      await store.putGrant({ principal: `group:${group}`, action, resource: '*', effect: 'allow' } as never);
    }
  }
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const send = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('a partner holding a delegated admin grant is refused it; staff holding the same grant are not', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  for (const { action, method, path, body } of REMOVED) {
    const partner = await send(rita, method, path, body);
    assert.equal(partner.status, 403, `${action}: ${method} ${path} for the partner`);
    const own = await send(staff, method, path, body);
    assert.notEqual(own.status, 403, `${action}: ${method} ${path} for staff (${own.status})`);
  }
});

test('a partner with grant.edit cannot take their own programme scope away', async () => {
  const rita = await login('rita@reseller.test');
  assert.equal((await send(rita, 'PUT', `/api/v1/users/${ritaId}/local-groups`, { groups: [] })).status, 403);
  assert.ok((await store.getUser(ritaId))?.localGroups.includes('programme-resellers'), 'still in the programme');
});

test('the rule sits in the decision itself: role defaults and grants alike, for people and tokens', () => {
  const grants = [{ principal: 'group:programme-resellers', action: 'audit.export', resource: '*', effect: 'allow' as const }];
  const partner = { userId: 'u1', groups: ['partner', 'programme-resellers'], role: 'member' as const };
  const token = { groups: ['partner', 'programme-resellers'], role: 'automation' as const };
  assert.equal(evaluate(partner, 'audit.export', ['*'], grants), false, 'a grant does not open it');
  assert.equal(evaluate(token, 'audit.export', ['*'], []), false, 'nor the automation role default a programme token holds');
  assert.equal(evaluate(token, 'export.server', ['*'], []), true, 'the render API stays open to a programme token');
  assert.equal(evaluate(partner, 'delivery.create', ['*'], []), false, 'nor a member default partners do not get');
  const opened = [...PARTNER_ACTIONS].map((action) => ({ principal: 'group:programme-resellers', action, resource: '*', effect: 'allow' as const }));
  for (const action of PARTNER_ACTIONS) assert.equal(evaluate(partner, action, ['*'], opened), true, `${action} stays grantable to partners`);
  assert.equal(evaluate({ userId: 'a1', groups: ['admin', 'programme-resellers'], role: 'admin' }, 'audit.export', ['*'], []), true, 'admins are never scoped');
});

test('the partner\'s org-config offers no New group and no Send to', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  const can = async (cookie: string) => ((await (await send(cookie, 'GET', '/api/v1/org-config')).json()) as { can: Record<string, boolean> }).can;
  const partner = await can(rita);
  assert.equal(partner['group.create'], false);
  assert.equal(partner['delivery.create'], false);
  assert.equal(partner['export.download'], true, 'the partner\'s own work is unchanged');
  assert.equal((await can(staff))['group.create'], true);
});

test('the grants API says which grants do not apply to partner programme members', async () => {
  const admin = await login('admin@test');
  const { grants } = await (await send(admin, 'GET', '/api/v1/grants')).json() as { grants: Array<{ principal: string; action: string; partnerScope?: string }> };
  const of = (principal: string, action: string) => grants.find((g) => g.principal === principal && g.action === action);
  assert.equal(of('group:programme-resellers', 'grant.edit')?.partnerScope, 'Does not apply to partner programme members: grant.edit is not available to partners.');
  assert.equal(of('group:marketing', 'grant.edit')?.partnerScope, undefined, 'a staff grant applies');
  const created = await (await send(admin, 'POST', '/api/v1/grants', { principal: `user:${ritaId}`, action: 'audit.export', resource: '*', effect: 'allow' })).json() as { partnerScope?: string };
  assert.equal(created.partnerScope, 'Does not apply to partner programme members: audit.export is not available to partners.', 'said at the moment it is set');
  const toolUse = await (await send(admin, 'POST', '/api/v1/grants', { principal: 'group:programme-resellers', action: 'tool.use', resource: '*', effect: 'allow' })).json() as { partnerScope?: string };
  assert.equal(toolUse.partnerScope, undefined, 'a partner action carries no note');
});
