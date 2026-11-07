// SPDX-License-Identifier: MPL-2.0
/**
 * The read routes behind the console's licence views (plans/82 M4, W-M4-6):
 * one file's licence for the asset page, a scope's coverage for the Provider
 * folders form, and each collection's travel count for the Collections card.
 * The console itself is plain DOM over these and the report.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { markScopesFor } from '../server/src/catalog/rights-routes.ts';

let server: Server;
let base = '';

const photo = (remoteId: string, folder: string) => ({
  remoteId, name: `${folder} ${remoteId}`, nativeType: 'file', sections: [], folder, tags: [], approved: true, formats: [{ format: 'jpg', remoteRef: 'f', size: 8 }],
});

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-console-licences-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  for (const f of ['open.jpg', 'mark.svg']) await writeFile(join(pack, 'catalog', 'assets', 'acme', f), 'x');
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [
    { id: 'acme/photo/open', name: 'Open photo', type: 'raster', license: 'CC-BY-4.0', formats: [{ format: 'jpg', url: '/catalog/assets/acme/open.jpg' }] },
    { id: 'acme/logo/mark', name: 'Acme mark', type: 'vector', formats: [{ format: 'svg', url: '/catalog/assets/acme/mark.svg' }] },
  ] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'SUSE', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'bruno@test', groups: ['admin'], name: 'Bruno Marsh' },
      { email: 'owner@test', groups: ['owner'] },
      { email: 'staff@test', groups: ['marketing'] },
    ] },
  }));
  const store = createMemoryStore();
  await store.putCollection({ id: 'launch-kit', name: 'Launch kit', members: ['acme/photo/open', 'acme/logo/mark', 'ext/dam/e1'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sc', link: 'lc', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('bruno@test');
  await call(admin, 'POST', '/api/v1/catalog/providers', { id: 'dam', kind: 'mock', label: 'Brandfolder', exposure: { groups: ['marketing'] }, options: { assets: [photo('e1', 'event-photos'), photo('e2', 'event-photos/day-2')] } });
  assert.equal((await call(await login('owner@test'), 'POST', '/api/v1/catalog/providers/dam/enable')).status, 200);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

test('the scopes a mark could take, narrowest first', () => {
  assert.deepEqual(markScopesFor({ id: 'ext/dam/e2', meta: { providerFolder: 'event-photos/day-2' } }), ['asset:ext/dam/e2', 'folder:dam/event-photos/day-2', 'provider:dam']);
  assert.deepEqual(markScopesFor({ id: 'acme/logo/mark' }), ['asset:acme/logo/mark', 'prefix:acme/logo/']);
  assert.deepEqual(markScopesFor({ id: 'inst/abc' }), ['asset:inst/abc']);
});

test('one file\'s licence, where the answer comes from, as the asset page shows it', async () => {
  const bruno = await login('bruno@test');
  const own = (await call(bruno, 'GET', '/api/v1/catalog/rights/asset?id=acme/photo/open')).body;
  assert.deepEqual([own.source, own.declared, own.reads.travels, own.reads.licence], ['own', 'CC-BY-4.0', true, 'CC BY 4.0']);
  const blank = (await call(bruno, 'GET', '/api/v1/catalog/rights/asset?id=ext/dam/e1')).body;
  assert.equal(blank.source, 'none');
  assert.equal(blank.reads.reason, 'licence not recorded');
  assert.deepEqual(blank.markScopes, ['asset:ext/dam/e1', 'folder:dam/event-photos', 'provider:dam']);

  const coverage = (await call(bruno, 'GET', '/api/v1/catalog/rights/coverage?scope=folder:dam/event-photos')).body;
  assert.deepEqual(coverage, { scope: 'folder:dam/event-photos', files: 2, unrecorded: 2 });
  const travel = (await call(bruno, 'GET', '/api/v1/catalog/rights/collections')).body.collections;
  assert.deepEqual(travel, [{ id: 'launch-kit', files: 3, travel: 1, held: 2 }]);

  assert.equal((await call(bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'folder:dam/event-photos' })).status, 201);
  const marked = (await call(bruno, 'GET', '/api/v1/catalog/rights/asset?id=ext/dam/e1')).body;
  assert.equal(marked.source, 'mark');
  assert.equal(marked.reads.licence, 'Owner-published, not an open licence');
  assert.match(marked.mark.statement, /^Recorded as SUSE's own statement by Bruno Marsh on .+\. Lolly does not check ownership\.$/);
  assert.equal((await call(bruno, 'GET', '/api/v1/catalog/rights/coverage?scope=folder:dam/event-photos')).body.marked, true);
  assert.deepEqual((await call(bruno, 'GET', '/api/v1/catalog/rights/collections')).body.collections[0], { id: 'launch-kit', files: 3, travel: 2, held: 1 });

  assert.equal((await call(bruno, 'PUT', '/api/v1/catalog/rights/licences', { assetId: 'acme/logo/mark', declaration: 'CC-BY-NC-4.0' })).status, 201);
  const recorded = (await call(bruno, 'GET', '/api/v1/catalog/rights/asset?id=acme/logo/mark')).body;
  assert.equal(recorded.source, 'licence-record');
  assert.deepEqual(recorded.reads.conditions, ['Attribution', 'NonCommercial']);
  assert.match(recorded.licence.statement, /own record of the licence\. Lolly does not check the licence\.$/);
});

test('who may read them', async () => {
  const staff = await login('staff@test');
  assert.equal((await call(staff, 'GET', '/api/v1/catalog/rights/asset?id=ext/dam/e1')).status, 403);
  assert.equal((await call(staff, 'GET', '/api/v1/catalog/rights/coverage?scope=provider:dam')).status, 403);
  assert.equal((await call(staff, 'GET', '/api/v1/catalog/rights/collections')).status, 403);
  assert.equal((await call(await login('bruno@test'), 'GET', '/api/v1/catalog/rights/coverage?scope=nope')).status, 400);
});

test('the console says a record is the admin\'s own and never claims a clearance', async () => {
  const source = await readFile(new URL('../console/app.js', import.meta.url), 'utf8');
  assert.match(source, /Lolly does not check ownership/);
  assert.match(source, /Lolly keeps your text and reads it with the same rules as everywhere else/);
  assert.doesNotMatch(source, /rights cleared|legally safe|fully cleared|copyright verified/i);
});
