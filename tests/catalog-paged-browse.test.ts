// SPDX-License-Identifier: MPL-2.0
/** The actual browse/inspect routes over a large permission-filtered library, with AI unused. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { webcrypto } from 'node:crypto';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';
import { mockCalls } from '../server/src/catalog/providers/mock.ts';

const store = createMemoryStore(); let base: string, pack: string, cookie: string, outsider: string, server: Server;
const provider = (id: string, count: number, groups = ['design']): ProviderRecord => ({
  id, kind: 'mock', label: id, enabled: true, managedBy: 'db', options: { generate: { count }, pageSize: 500 },
  mapping: {}, exposure: { groups }, sync: { ttlSeconds: 3600 }, createdAt: '2026-10-15', updatedAt: '2026-10-15', state: { assetCount: 0 },
});
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-paged-'));
  await mkdir(join(pack, 'catalog/assets'), { recursive: true });
  await writeFile(join(pack, 'catalog/assets/index.json'), JSON.stringify({ assets: [{ id: 'brand/one', name: 'Brand', type: 'vector', formats: [{ format: 'svg', url: '/catalog/assets/one.svg' }] }] }));
  await store.putCatalogField({ id: 'region', label: 'Region', kind: 'select', options: ['EMEA', 'APAC'] });
  await store.putProvider(provider('large', 100_003)); await store.putProvider(provider('ten', 10_000)); await store.putProvider(provider('secret', 20, ['private']));
  await store.putProvider({ ...provider('files', 0), options: { assets: [{ remoteId: 'art', name: 'Two originals', nativeType: 'generic', tags: ['launch'], sections: ['Campaign'],
    taxonomy: [{ kind: 'folder', id: 'native-42', name: 'Launch folder' }], formats: [
      { format: 'svg', remoteRef: 'wide', filename: 'wide.svg', role: 'original' }, { format: 'svg', remoteRef: 'square', filename: 'square.svg', role: 'original' },
    ] }] } });
  await mkdir(join(pack, 'catalog/tools'), { recursive: true });
  await writeFile(join(pack, 'catalog/tools/index.json'), JSON.stringify({ tools: [] }));
  const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const catalogSigningKey = JSON.stringify(await webcrypto.subtle.exportKey('jwk', key.privateKey));
  const config = parseConfig(JSON.stringify({ instance: { name: 'Paged', baseUrl: 'http://localhost', pack }, policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false }, dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner', 'design'] }, { email: 'other@test', groups: ['other'] }] } }));
  const app = buildApp({ config, store, secrets: { session: 'fixture-session', link: 'fixture-link', catalogSigningKey } });
  server = createServer((req, res) => void app(req, res)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  cookie = await login('owner@test'); outsider = await login('other@test');
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(pack, { recursive: true, force: true }); });
const read = (path: string, auth = cookie) => fetch(base + path, { headers: { cookie: auth } });

test('100k indexed records cost one bounded first page, with explicit source truncation', async () => {
  const cold = await (await read('/api/v1/catalog/assets?scope=shared&source=large&limit=100')).json() as Record<string, any>;
  assert.equal(cold.complete, false);
  assert.ok(['pending', 'current'].includes(cold.sources[0].status));
  await read('/catalog/assets/index.json');
  const response = await read('/api/v1/catalog/assets?scope=shared&source=large&limit=100');
  assert.equal(response.status, 200); const raw = await response.text(); const page = JSON.parse(raw);
  console.log(JSON.stringify({ corpus: 100_000, firstPageRecords: page.assets.length, firstPageBytes: Buffer.byteLength(raw) }));
  assert.equal(page.assets.length, 100); assert.equal(page.total, 100_000); assert.ok(page.nextCursor);
  assert.equal(page.complete, false); assert.equal(page.countsScope, 'indexed');
  assert.equal(page.sources[0].truncated, true); assert.ok(raw.length < 250_000);
  assert.doesNotMatch(raw, /secret|credential|signature=/); assert.equal(mockCalls.get('large')?.blob ?? 0, 0);
  const next = await (await read(`/api/v1/catalog/assets?scope=shared&source=large&limit=100&cursor=${encodeURIComponent(page.nextCursor)}`)).json() as Record<string, any>;
  assert.equal(next.assets.length, 100); assert.ok(next.assets.every((entry: { id: string }) => !page.assets.some((first: { id: string }) => first.id === entry.id)));
  const bootstrap = await (await read('/catalog/assets/index.json?paged=1')).json() as Record<string, any>;
  assert.ok(bootstrap.assets.length < 50); assert.ok(bootstrap.pagedProviders.some((source: { id: string }) => source.id === 'large'));
});

test('source, exact type, tag and native taxonomy filters compose before paging and counts', async () => {
  const page = await (await read('/api/v1/catalog/assets?scope=shared&source=files&types=vector,raster&tag=launch&taxonomyKind=folder&taxonomyId=native-42')).json() as Record<string, any>;
  assert.equal(page.total, 1); assert.equal(page.assets[0].id, 'ext/files/art');
  assert.deepEqual(page.facets.taxonomy, [{ source: 'files', kind: 'folder', id: 'native-42', name: 'Launch folder', count: 1 }]);
  assert.deepEqual(page.facets.types, [{ name: 'vector', count: 1 }]);
  assert.equal((await read('/api/v1/catalog/assets?taxonomyKind=folder')).status, 400);
  assert.equal((await read('/api/v1/catalog/assets?types=vector,')).status, 400);
});

test('hidden sources expose no card, facet, count, inspect metadata or source status', async () => {
  const page = await (await read('/api/v1/catalog/assets?scope=shared', outsider)).json() as Record<string, any>;
  assert.equal(page.total, 0); assert.deepEqual(page.facets.sources, []); assert.deepEqual(page.sources, []);
  assert.equal((await read('/api/v1/catalog/assets/ext/files/art', outsider)).status, 404);
});

test('inspect retains both same-format originals, and file access rechecks current exposure', async () => {
  const asset = await (await read('/api/v1/catalog/assets/ext/files/art')).json() as Record<string, any>;
  assert.equal(asset.meta.assetFiles.length, 2); assert.notEqual(asset.meta.assetFiles[0].id, asset.meta.assetFiles[1].id);
  assert.equal(asset.meta.assetFiles[1].name, 'square.svg');
  const bytes = await read('/catalog/ext/files/art/square'); assert.equal(bytes.status, 200); assert.equal(await bytes.text(), 'mock:files:art:square');
  const record = await store.getProvider('files'); assert.ok(record);
  await store.putProvider({ ...record, exposure: { groups: ['private'] } });
  assert.equal((await read('/catalog/ext/files/art/square')).status, 403);
  assert.equal((await read('/api/v1/catalog/assets/ext/files/art')).status, 404);
  await store.putProvider(record);
});

test('live search refuses incompatible exact filters rather than dropping them', async () => {
  const unsupported = await read('/api/v1/catalog/search?q=art&tag=launch'); assert.equal(unsupported.status, 400);
  const page = await (await read('/api/v1/catalog/search?q=Two&source=files&scope=shared&limit=10')).json() as Record<string, any>;
  assert.equal(page.results.length, 1); assert.equal(page.complete, false); assert.equal(page.countsScope, 'candidates');
  assert.ok(page.results.every((entry: { provider: string }) => entry.provider === 'files'));
});

test('opt-in signed paging binds bounded bytes and refuses retained source summaries after withdrawal', async () => {
  const env = await (await read('/catalog/tools/index.sig.json?paged=1')).json() as Record<string, any>;
  assert.ok(env.assetIndexHash);
  const path = `/catalog/assets/index.${env.assetIndexHash.slice(0, 16)}.json?paged=1`;
  const response = await read(path); assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(sha256Hex(bytes), env.assetIndexHash);
  const index = JSON.parse(bytes.toString()); assert.ok(index.assets.length < 50); assert.ok(index.pagedProviders.some((row: { id: string }) => row.id === 'large'));
  const record = await store.getProvider('large'); assert.ok(record);
  await store.putProvider({ ...record, exposure: { groups: ['private'] } });
  assert.equal((await read(path)).status, 404, 'a retained descriptor cannot disclose a removed source');
  await store.putProvider(record);
});

test('a 10k-record source uses the same bounded request and truthful filtered count', async () => {
  const response = await read('/api/v1/catalog/assets?scope=shared&source=ten&limit=100');
  const raw = await response.text(), page = JSON.parse(raw);
  assert.equal(page.total, 10_000); assert.equal(page.assets.length, 100); assert.equal(page.complete, true);
  assert.ok(Buffer.byteLength(raw) < 250_000);
  console.log(JSON.stringify({ corpus: 10_000, firstPageRecords: page.assets.length, firstPageBytes: Buffer.byteLength(raw) }));
});

test('metadata curation changes the organisation overlay without changing upstream facts', async () => {
  const response = await fetch(base + '/api/v1/catalog/assets/ext/files/art/meta', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { region: 'EMEA' } }) });
  assert.equal(response.status, 200);
  const current = await (await read('/api/v1/catalog/assets/ext/files/art')).json() as Record<string, any>;
  assert.equal(current.fields.region, 'EMEA'); assert.equal(current.name, 'Two originals'); assert.ok(current.tags.includes('launch'));
  const denied = await fetch(base + '/api/v1/catalog/assets/ext/files/art/meta', { method: 'PUT', headers: { cookie: outsider, 'content-type': 'application/json' }, body: JSON.stringify({ fields: { region: 'APAC' } }) });
  assert.equal(denied.status, 403);
});

test('an upstream outage keeps the last listing but changes completeness and its validator', async () => {
  const before = await read('/api/v1/catalog/assets?source=large&limit=1');
  const record = await store.getProvider('large'); assert.ok(record);
  await store.putProvider({ ...record, options: { ...record.options, failWith: 'fixture source unavailable' } });
  assert.equal((await fetch(base + '/api/v1/catalog/providers/large/sync', { method: 'POST', headers: { cookie } })).status, 502);
  const response = await read('/api/v1/catalog/assets?source=large&limit=1');
  const page = await response.json() as Record<string, any>;
  assert.equal(page.total, 100_000); assert.equal(page.sources[0].status, 'stale'); assert.equal(page.complete, false);
  assert.notEqual(response.headers.get('etag'), before.headers.get('etag'));
});
