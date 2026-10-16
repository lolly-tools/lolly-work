// SPDX-License-Identifier: MPL-2.0
/** Reviewed text uses the same exposure gates as browse and stops matching changed sources. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';
import { mockCalls } from '../server/src/catalog/providers/mock.ts';
import { textIndexFiles, textIndexRevision, textIndexView } from '../server/src/catalog/text-index.ts';
import { extractedHaystack } from '../server/src/catalog/asset-meta.ts';

const store = createMemoryStore();
let base: string, pack: string, owner: string, reader: string, outsider: string, server: Server;
const assetId = 'ext/dam/art';
const initial: ProviderRecord = { id: 'dam', kind: 'mock', label: 'Library', enabled: true, managedBy: 'db',
  options: { assets: [{ remoteId: 'art', name: 'Artwork', nativeType: 'generic', tags: [], sections: [], approved: false,
    updatedAt: '2026-10-15T00:00:00Z', originalsAvailable: false,
    formats: [{ format: 'svg', remoteRef: 'preview', filename: 'preview.svg', role: 'rendition' }] }] },
  mapping: {}, exposure: { groups: ['design'] }, sync: { ttlSeconds: 3600 }, createdAt: '2026-10-15', updatedAt: '2026-10-15', state: { assetCount: 0 } };
const read = (path: string, cookie = owner) => fetch(base + path, { headers: { cookie } });
const put = (path: string, body: unknown, cookie = owner) => fetch(base + path, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const detail = async () => (await read(`/api/v1/catalog/assets/${assetId}`)).json() as Promise<Record<string, any>>;
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-reviewed-text-'));
  await mkdir(join(pack, 'catalog/assets'), { recursive: true }); await writeFile(join(pack, 'catalog/assets/index.json'), '{"assets":[]}');
  await store.putProvider(initial);
  await store.putCatalogField({ id: 'campaign', kind: 'text', label: 'Campaign' });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Text', baseUrl: 'http://localhost', pack }, policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner', 'design'] }, { email: 'reader@test', groups: ['viewer', 'design'] }, { email: 'outside@test', groups: ['viewer'] }] } }));
  const app = buildApp({ config, store, secrets: { session: 'text-test-session', link: 'text-test-link' } });
  server = createServer((req, res) => void app(req, res)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  owner = await login('owner@test'); reader = await login('reader@test'); outsider = await login('outside@test');
  await read('/catalog/assets/index.json');
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(pack, { recursive: true, force: true }); });

test('inspection preserves mapped approval and rendition facts without starting a byte read', async () => {
  const value = await detail();
  assert.equal(value.canEdit, true); assert.equal(value.meta.providerApproved, false);
  assert.equal(value.meta.providerOriginalsAvailable, false); assert.equal(value.textIndex.status, 'none');
  assert.equal(value.textIndexFiles[0].role, 'rendition');
  assert.equal((await (await read(`/api/v1/catalog/assets/${assetId}`, reader)).json() as any).canEdit, false);
  assert.equal((await read(`/api/v1/catalog/assets/${assetId}`, outsider)).status, 404);
  assert.equal(mockCalls.get('dam')?.blob ?? 0, 0);
});

test('review is permissioned, bounded, source-bound and searchable without putting words on feeds or audit', async () => {
  const value = await detail();
  const body = { text: '  unusual  zephyr\nlaunch  ', sourceRevision: value.textIndex.revision, fileId: value.textIndexFiles[0].id, method: 'ocr' };
  assert.equal((await put(`/api/v1/catalog/text-index/${assetId}`, body, reader)).status, 403);
  assert.equal((await put(`/api/v1/catalog/text-index/${assetId}`, body, '')).status, 401);
  assert.equal((await put(`/api/v1/catalog/text-index/${assetId}`, { ...body, fileId: 'bad' })).status, 400);
  assert.equal((await put(`/api/v1/catalog/text-index/${assetId}`, { ...body, text: 'x'.repeat(8193) })).status, 400);
  assert.equal((await put(`/api/v1/catalog/text-index/${assetId}`, { ...body, method: 'guessed' })).status, 400);
  assert.equal((await put(`/api/v1/catalog/text-index/${assetId}`, body)).status, 200);
  const meta = await store.getAssetMeta(assetId); assert.equal(meta?.extractedText, 'unusual zephyr launch');
  assert.equal(meta?.extractedTextSource?.method, 'ocr'); assert.equal(meta?.extractedTextSource?.fileId, body.fileId);
  assert.equal((await detail()).textIndex.status, 'current');
  const indexed = await (await read('/api/v1/catalog/assets?scope=shared&q=zephyr')).json() as any;
  assert.equal(indexed.total, 1); assert.doesNotMatch(JSON.stringify(indexed), /unusual zephyr launch/);
  const live = await (await read('/api/v1/catalog/search?q=zephyr&scope=shared')).json() as any; assert.equal(live.results.length, 1);
  assert.equal((await (await read('/api/v1/catalog/assets?q=zephyr', outsider)).json() as any).total, 0);
  assert.doesNotMatch(JSON.stringify(await detail()), /unusual zephyr launch/);
  assert.doesNotMatch(JSON.stringify(await store.listAudit()), /unusual zephyr launch/);
  assert.equal((await put(`/api/v1/catalog/assets/${assetId}/meta`, { fields: { campaign: 'Launch' } })).status, 200);
  assert.deepEqual((await store.getAssetMeta(assetId))?.extractedTextSource, meta?.extractedTextSource);
});

test('a changed indexed source excludes old words and refuses a stale review; clearing preserves organisation fields', async () => {
  const old = await detail();
  const provider = await store.getProvider('dam'); assert.ok(provider);
  await store.putProvider({ ...provider, options: { assets: [{ ...(initial.options.assets as any[])[0], updatedAt: '2026-10-16T00:00:00Z' }] } });
  const synced = await fetch(base + '/api/v1/catalog/providers/dam/sync', { method: 'POST', headers: { cookie: owner } }); assert.equal(synced.status, 200);
  assert.equal((await detail()).textIndex.status, 'stale');
  assert.equal((await (await read('/api/v1/catalog/assets?scope=shared&q=zephyr')).json() as any).total, 0);
  assert.equal((await (await read('/api/v1/catalog/search?q=zephyr&scope=shared')).json() as any).results.length, 0);
  const stale = await put(`/api/v1/catalog/text-index/${assetId}`, { text: 'old words', method: 'ocr', fileId: old.textIndexFiles[0].id, sourceRevision: old.textIndex.revision });
  assert.equal(stale.status, 409);
  const current = await detail();
  assert.equal((await put(`/api/v1/catalog/text-index/${assetId}`, { text: null, sourceRevision: current.textIndex.revision })).status, 200);
  const meta = await store.getAssetMeta(assetId); assert.equal(meta?.extractedText, undefined); assert.equal(meta?.extractedTextSource, undefined);
  assert.equal(meta?.fields.campaign, 'Launch'); assert.equal((await detail()).textIndex.status, 'none');
});

test('file changes invalidate bound text, while legacy unbound records remain explicitly unverified', () => {
  const entry = { id: 'inst/demo', version: 1, formats: [{ format: 'svg', url: '/catalog/inst/demo/svg', checksum: 'abc' }] };
  const file = textIndexFiles(entry)[0]!;
  assert.equal(file.checksum, 'abc');
  const source = { revision: textIndexRevision(entry), fileId: file.id, method: 'digital' as const, reviewedBy: 'user:test', reviewedAt: '2026-10-16' };
  const meta = { assetId: entry.id, fields: {}, extractedText: 'needle', extractedTextSource: source, updatedBy: 'user:test', updatedAt: 'today' };
  assert.deepEqual(extractedHaystack(meta, entry), ['needle']);
  assert.deepEqual(extractedHaystack(meta, { ...entry, version: 2 }), []);
  assert.deepEqual(extractedHaystack(meta), []);
  const { extractedTextSource: _source, ...legacy } = meta;
  assert.equal(textIndexView(entry, legacy).status, 'unverified'); assert.deepEqual(extractedHaystack(legacy, entry), ['needle']);
});

test('withdrawing source exposure between inspection and review prevents both save and discovery', async () => {
  const inspected = await detail(), provider = await store.getProvider('dam'); assert.ok(provider);
  await store.putProvider({ ...provider, exposure: { groups: ['private'] } });
  assert.equal((await put(`/api/v1/catalog/text-index/${assetId}`, { text: 'hidden phrase', method: 'digital', sourceRevision: inspected.textIndex.revision, fileId: inspected.textIndexFiles[0].id })).status, 404);
  assert.equal((await read(`/api/v1/catalog/assets/${assetId}`)).status, 404);
  assert.equal((await (await read('/api/v1/catalog/assets?scope=shared&q=artwork')).json() as any).total, 0);
});
