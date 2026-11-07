// SPDX-License-Identifier: MPL-2.0
/**
 * Company groups count in partner scope (plans/82 M1 part 2). A company is a
 * partner organisation inside a programme, wrapping the reserved group
 * `company-<id>`. Something shared with a company's group reaches that
 * company's people and nobody else's: a collection, an instance asset, a
 * connected provider and an injectable. Someone who manages programmes may
 * publish into a company's group without joining it. Before this, partner
 * scope looked at `programme-*` groups only, so anything shared with a
 * company reached nobody.
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
import { visibleTo } from '../server/src/injectables/registry.ts';
import { isPartnerGroup, partnerGroupsOf } from '../server/src/programmes/types.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const ASSETS = [
  { id: 'acme/tokens', name: 'Tokens', type: 'tokens', file: 'tokens.json', body: '{}' },
  { id: 'acme/price-list', name: 'Acme price list', type: 'raster', file: 'acme-prices.png', body: 'png' },
  { id: 'acme/globex-sheet', name: 'Globex sheet', type: 'raster', file: 'globex.png', body: 'png' },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-company-scope-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }] }));
  for (const a of ASSETS) await writeFile(join(pack, 'catalog', 'assets', 'acme', a.file), a.body);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: ASSETS.map((a) => ({ id: a.id, name: a.name, type: a.type, formats: [{ format: a.file.split('.').pop(), url: `/catalog/assets/acme/${a.file}` }] })),
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'rita@acme.test', groups: [] },
      { email: 'gus@globex.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  await store.putCollection({ id: 'acme-kit', name: 'Acme kit', members: ['acme/price-list'], groups: ['company-acme'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  await store.putCollection({ id: 'globex-kit', name: 'Globex kit', members: ['acme/globex-sheet'], groups: ['company-globex'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, secrets: { session: 'sc', link: 'lc' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const json = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const feed = async (cookie: string) => {
  const f = (await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } })).json()) as { assets: Array<{ id: string }>; collections?: Array<{ id: string }> };
  return { assets: f.assets.map((a) => a.id).sort(), collections: (f.collections ?? []).map((c) => c.id).sort() };
};

test('partner groups are programme and company groups, and nothing else', () => {
  assert.ok(isPartnerGroup('programme-resellers'));
  assert.ok(isPartnerGroup('company-acme'));
  assert.ok(!isPartnerGroup('partner'));
  assert.ok(!isPartnerGroup('company-'));
  assert.ok(!isPartnerGroup('marketing'));
  assert.deepEqual(partnerGroupsOf(['marketing', 'programme-resellers', 'partner', 'company-acme']), ['programme-resellers', 'company-acme']);
});

test('a collection shared with a company reaches that company\'s people only', async () => {
  const admin = await login('admin@test');
  assert.equal((await json(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers' })).status, 201);
  assert.equal((await json(admin, 'PUT', '/api/v1/programmes/resellers/companies/acme', { name: 'Acme' })).status, 201);
  assert.equal((await json(admin, 'PUT', '/api/v1/programmes/resellers/companies/globex', { name: 'Globex' })).status, 201);
  await login('rita@acme.test');
  await login('gus@globex.test');
  const added = await json(admin, 'POST', '/api/v1/programmes/resellers/people', {
    rows: [{ email: 'rita@acme.test', company: 'acme' }, { email: 'gus@globex.test', company: 'globex' }], apply: true,
  });
  assert.equal(added.status, 200);

  const rita = await feed(await login('rita@acme.test'));
  assert.deepEqual(rita.assets, ['acme/price-list', 'acme/tokens']);
  assert.deepEqual(rita.collections, ['acme-kit']);
  const gus = await feed(await login('gus@globex.test'));
  assert.deepEqual(gus.assets, ['acme/globex-sheet', 'acme/tokens']);
  assert.deepEqual(gus.collections, ['globex-kit']);
});

test('an injectable for a company reaches its people and no other partner', () => {
  const rec = { state: 'live', groups: ['company-acme'] } as unknown as Parameters<typeof visibleTo>[0];
  assert.equal(visibleTo(rec, ['programme-resellers', 'company-acme', 'partner'], true), true);
  assert.equal(visibleTo(rec, ['programme-resellers', 'company-globex', 'partner'], true), false);
  const everyone = { state: 'live', groups: ['*'] } as unknown as Parameters<typeof visibleTo>[0];
  assert.equal(visibleTo(everyone, ['programme-resellers', 'company-acme', 'partner'], true), false, 'everyone still excludes partners');
});

test('someone who manages programmes publishes into a company without joining it', async () => {
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/submit?name=Acme%20promo&groups=company-acme`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' });
  assert.equal(res.status, 201);
});
