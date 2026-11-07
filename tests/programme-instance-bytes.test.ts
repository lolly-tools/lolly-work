/**
 * A partner programme member reads instance asset bytes only for what their own feed
 * holds (plans/82 M1, closed in M6). An internal asset the workspace published to
 * everyone (`*`) is not a partner's unless their programme includes it, the same rule
 * their federated bytes, links and asset records already follow. Staff are unchanged.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { instanceAssetEntry } from '../server/src/catalog/instance-assets.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-inst-bytes-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'fonts'), { recursive: true });
  await mkdir(join(pack, 'tools', 'qr-code'), { recursive: true });
  await writeFile(join(pack, 'tools', 'qr-code', 'tool.json'), JSON.stringify({ id: 'qr-code', inputs: [] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'qr-code' }] }));
  await writeFile(join(pack, 'catalog', 'fonts', 'sans.woff2'), 'font');
  await writeFile(join(pack, 'catalog', 'fonts', 'OFL.txt'), 'SIL Open Font License');
  await writeFile(join(pack, 'catalog', 'delivery-manifest.json'), JSON.stringify({ version: 1, files: [{ path: 'catalog/secret-roadmap.png' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [
    { id: 'acme/font', name: 'Acme Sans', type: 'font', formats: [{ format: 'woff2', url: '/catalog/fonts/sans.woff2' }], meta: { licenseUrl: '/catalog/fonts/OFL.txt' } },
  ] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Bytes Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@reseller.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  for (const [id, groups] of [['inst/internal', '*'], ['inst/kit', ['marketing']], ['inst/sub1', '*']] as const) {
    const stat = await blobs.put(`${id}/png`, Buffer.from(`png:${id}`), 'image/png');
    await store.putInstanceAsset({
      id, entry: instanceAssetEntry(id, { name: id, type: 'image' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]),
      blobs: { png: `${id}/png` }, groups: groups as never, createdAt: new Date().toISOString(),
      ...(id === 'inst/sub1' ? { submission: { state: 'live', by: 'user:someone', at: new Date().toISOString(), checksum: stat.checksum, size: stat.size, contentType: 'image/png' } } : {}),
    } as never);
  }
  await store.putCollection({ id: 'emea-kit', name: 'EMEA kit', members: ['inst/kit'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs, secrets: { session: 'sb', link: 'lb' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  await fetch(`${base}/api/v1/programmes/resellers`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Resellers', tools: [], collections: ['emea-kit'] }) });
  await login('rita@reseller.test');
  const ritaId = (await store.getUserBySub('dev:rita@reseller.test'))!.id;
  await fetch(`${base}/api/v1/users/${ritaId}/local-groups`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ groups: ['programme-resellers'] }) });
  // A partner trusted to edit catalog metadata, and staff who may too.
  await store.putGrant({ principal: 'group:programme-resellers', action: 'catalog.edit', resource: '*', effect: 'allow' } as never);
  await store.putGrant({ principal: 'group:marketing', action: 'catalog.edit', resource: '*', effect: 'allow' } as never);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const bytes = (cookie: string, id: string, query = '') => fetch(`${base}/catalog/${id}/png${query}`, { headers: { cookie } });

test('a partner gets the bytes their programme includes and never an internal asset shared with everyone', async () => {
  const rita = await login('rita@reseller.test');
  assert.equal((await bytes(rita, 'inst/kit')).status, 200, 'their programme includes the kit');
  assert.equal((await bytes(rita, 'inst/internal')).status, 403, 'published to everyone, but not to their programme');
  assert.equal((await bytes(rita, 'inst/internal', '?v=1')).status, 403, 'nor a prior version of it');
});

test('staff are unchanged: everyone means everyone inside the workspace', async () => {
  const staff = await login('staff@test');
  assert.equal((await bytes(staff, 'inst/internal')).status, 200);
  assert.equal((await bytes(staff, 'inst/kit')).status, 200);
});

test('a live internal submission shared with everyone is not a partner\'s to download', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/submissions/sub1/bytes`, { headers: { cookie: rita } })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/catalog/submissions/sub1/bytes`, { headers: { cookie: staff } })).status, 200);
});

test('a partner allowed to edit catalog metadata still sees only the records their feed holds', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/inst/internal`, { headers: { cookie: rita } })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/inst/kit`, { headers: { cookie: rita } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/inst/internal`, { headers: { cookie: staff } })).status, 200);
});

test('a pack file no asset owns answers a partner only when their own feed names it', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  assert.equal((await fetch(`${base}/catalog/delivery-manifest.json`, { headers: { cookie: rita } })).status, 404, 'the release inventory is not a partner\'s');
  assert.equal((await fetch(`${base}/catalog/fonts/OFL.txt`, { headers: { cookie: rita } })).status, 200, 'the licence text an essential font names');
  assert.equal((await fetch(`${base}/catalog/delivery-manifest.json`, { headers: { cookie: staff } })).status, 200, 'staff unchanged');
});

test('answers that depend on who asks vary on the cookie, so a shared browser cache keeps people apart', async () => {
  const staff = await login('staff@test');
  for (const path of ['/catalog/inst/internal/png', '/catalog/fonts/sans.woff2', '/tools/qr-code/tool.json']) {
    const res = await fetch(`${base}${path}`, { headers: { cookie: staff } });
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('vary') ?? '', /cookie/i, path);
  }
});
