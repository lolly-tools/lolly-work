// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCloudinaryProvider } from '../server/src/catalog/providers/cloudinary.ts';
import { createOrangeLogicProvider } from '../server/src/catalog/providers/orange-logic.ts';
import { createProvider } from '../server/src/catalog/providers/registry.ts';
import { buildFragment, composeFederated, mapProviderAsset, passesExposure } from '../server/src/catalog/federation.ts';
import { cutoverProvider } from '../server/src/catalog/materialize.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { MaterializeDeps } from '../server/src/catalog/materialize.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';
import { damDate, damOrigin } from '../server/src/catalog/providers/dam-http.ts';

const cloudSecret = JSON.stringify({ apiKey: 'owned-key', apiSecret: 'owned-secret' });
const cloud = { cloudName: 'owned-cloud', assetFolder: 'Brand/Approved', minGapMs: 0 };
const orange = { baseUrl: 'https://dam.example', query: 'ParentFolderIdentifier:APPROVED', minGapMs: 0 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const cloudAsset = (extra: Record<string, unknown> = {}) => ({ asset_id: 'asset_1', public_id: 'brand/photo', version: 123,
  resource_type: 'image', type: 'authenticated', format: 'jpg', original_filename: 'photo', asset_folder: 'Brand/Approved', bytes: 5,
  tags: ['approved', 'campaign'], context: { custom: { caption: 'A test photo', from: '2020-01-01', until: '2099-12-31' } }, created_at: '2026-10-01T00:00:00Z', ...extra });
const orangeAsset = (extra: Record<string, unknown> = {}) => ({ SystemIdentifier: 'OL1', Title: 'Campaign photo', MediaType: 'Image',
  CaptionLong: 'A test photo', Directory: 'Brand/Approved', ParentFolderIdentifier: 'APPROVED', ParentFolderTitle: 'Approved',
  Keywords: [{ Label: 'campaign', KeywordType: 'Common' }], EditDate: '2026-10-01T00:00:00Z', FileMD5: 'owned-digest',
  path_TR1: { URI: 'https://dam.example/Assets/photo.jpg?access=owned-link', Width: 1200, Height: 800 }, ...extra });
const orangeDoc = (items: unknown[], total?: number) => ({ APIRequestInfo: { IsLoggedIn: true }, APIResponse: { Items: items, ...(total !== undefined ? { GlobalInfo: { TotalCount: total } } : {}) } });
type Call = { url: URL; method: string; headers: Headers; body: string };
function fixture(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = { url: new URL(String(input)), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: String(init?.body ?? '') };
    assert.equal(init?.redirect, 'error'); calls.push(call); return reply(call);
  };
  return { fetchImpl, calls };
}
const record = (kind: ProviderRecord['kind'], options: Record<string, unknown>): ProviderRecord => ({ id: 'source', kind, label: 'Shared source', managedBy: 'db', enabled: true,
  options, mapping: {}, exposure: { groups: ['design'] }, sync: {}, state: { assetCount: 0 }, createdAt: '2026-10-15', updatedAt: '2026-10-15' });

test('Cloudinary cursor listing uses stable identity and exposes only Work file URLs', async () => {
  const f = fixture(call => {
    assert.equal(call.url.href, 'https://api.cloudinary.com/v1_1/owned-cloud/resources/search');
    const body = JSON.parse(call.body);
    assert.deepEqual(body.with_field, ['tags', 'context']);
    assert.equal(body.expression, 'asset_folder="Brand/Approved"');
    return json({ resources: [cloudAsset()], ...(body.next_cursor ? {} : { next_cursor: 'page-2' }) });
  });
  const provider = createCloudinaryProvider('source', cloud, cloudSecret, f.fetchImpl);
  const first = await provider.listAssets(), second = await provider.listAssets(first.next);
  assert.equal(first.next, 'page-2'); assert.equal(second.next, undefined);
  assert.equal(first.assets[0]!.remoteId, 'asset_1');
  assert.equal(first.assets[0]!.approved, undefined);
  assert.deepEqual(first.assets[0]!.formats, [{ format: 'jpg', remoteRef: 'original-123', role: 'original', filename: 'photo.jpg', size: 5 }]);
  assert.equal(first.assets[0]!.originalsAvailable, true);
  const entry = mapProviderAsset(record('cloudinary', cloud), first.assets[0]!);
  const meta = entry.meta as Record<string, unknown>;
  assert.equal(meta.providerOriginalsAvailable, true);
  assert.equal((meta.assetFiles as Array<{ role: string }>)[0]!.role, 'original');
  assert.ok(!JSON.stringify(entry).includes('owned-secret'));
  assert.ok(entry.formats!.every(format => format.url?.startsWith('/catalog/ext/source/asset_1/')));
});

test('Cloudinary search escapes member syntax and keeps source scope', async () => {
  let expression = '';
  const f = fixture(call => { expression = JSON.parse(call.body).expression; return json({ resources: [] }); });
  const provider = createCloudinaryProvider('source', cloud, cloudSecret, f.fetchImpl);
  await provider.searchAssets!('photo" OR asset_folder:*', 20);
  assert.ok(expression.startsWith('(asset_folder="Brand/Approved") AND ('));
  assert.ok(expression.includes('filename:"photo\\" OR asset_folder:*"'));
  await assert.rejects(provider.searchAssets!('photo', 501), /limit/);
});

test('Cloudinary original download is signed by immutable ID without transforming or exposing credentials', async () => {
  const f = fixture(call => {
    if (call.url.pathname.includes('/resources/')) return json(cloudAsset({ public_id: 'renamed/photo' }));
    assert.equal(call.url.href, 'https://api.cloudinary.com/v1_1/owned-cloud/asset/download');
    assert.equal(call.method, 'POST'); assert.equal(call.headers.get('authorization'), null);
    const body = new URLSearchParams(call.body);
    const signed = ['asset_id', 'expires_at', 'timestamp'].map(key => `${key}=${body.get(key)}`).join('&');
    assert.equal(body.get('signature'), createHash('sha256').update(signed + 'owned-secret').digest('hex'));
    assert.equal(body.get('asset_id'), 'asset_1'); assert.equal(Number(body.get('expires_at')) - Number(body.get('timestamp')), 60);
    assert.equal(body.get('transformation'), null); assert.equal(body.get('format'), null);
    return new Response('photo', { headers: { 'content-type': 'image/jpeg', 'content-length': '5' } });
  });
  const provider = createCloudinaryProvider('source', { ...cloud, region: 'us' }, cloudSecret, f.fetchImpl);
  const blob = await provider.resolveBlob('asset_1', 'original-123');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'photo');
  assert.equal(f.calls.length, 2);
});

test('Cloudinary checks folder, identity, version and fresh policy before reading bytes', async () => {
  for (const [changed, expected] of [
    [{ asset_folder: 'Private' }, /unavailable/], [{ asset_id: 'other' }, /different asset/], [{ version: 124 }, /version changed/],
    [{ tags: [] }, /source policy/], [{ context: { custom: { until: '2020-01-01' } } }, /source policy/],
  ] as const) {
    const f = fixture(() => json(cloudAsset(changed)));
    const provider = createCloudinaryProvider('source', { ...cloud, approvedTag: 'approved' }, cloudSecret, f.fetchImpl, { until: 'until' }, { requireApproved: true });
    await assert.rejects(provider.resolveBlob('asset_1', 'original-123'), expected); assert.equal(f.calls.length, 1);
  }
});

test('Cloudinary supports raw documents and maps only explicit approval and dates', async () => {
  const f = fixture(() => json({ resources: [cloudAsset({ resource_type: 'raw', public_id: 'docs/deck.pptx', format: undefined, original_filename: 'deck.pptx' })] }));
  const provider = createCloudinaryProvider('source', { ...cloud, approvedTag: 'approved' }, cloudSecret, f.fetchImpl, { from: 'from', until: 'until' });
  const a = (await provider.listAssets()).assets[0]!;
  assert.equal(a.formats[0]!.format, 'pptx'); assert.equal(a.formats[0]!.filename, 'deck.pptx'); assert.equal(a.hasThumbnail, false);
  assert.equal(a.approved, true); assert.equal(a.availableUntil, '2099-12-31T00:00:00.000Z');
  assert.throws(() => createCloudinaryProvider('source', cloud, cloudSecret, f.fetchImpl, { until: 'metadata.expiry' }), /includeMetadata/);
});

test('Cloudinary refuses bad configuration, malformed paging and unsafe IDs without requesting bytes', async () => {
  const f = fixture(() => json({ resources: [], next_cursor: 'repeat' }));
  for (const bad of [{ cloudName: '../other' }, { ...cloud, region: 'other' }, { ...cloud, pageSize: 0 }]) assert.throws(() => createCloudinaryProvider('s', bad as typeof cloud, cloudSecret, f.fetchImpl));
  const provider = createCloudinaryProvider('source', cloud, cloudSecret, f.fetchImpl);
  await assert.rejects(provider.listAssets('repeat'), /repeated/);
  const before = f.calls.length;
  await assert.rejects(provider.resolveBlob('../asset', 'original-123'), /invalid asset id/); assert.equal(f.calls.length, before);
  assert.equal((await createCloudinaryProvider('s', cloud, 'invalid-json', f.fetchImpl).healthCheck()).ok, false);
});

test('Orange Logic pages without privileged totals and never persists public rendition URLs', async () => {
  const f = fixture(call => {
    assert.equal(call.url.href, 'https://dam.example/API/search/v4.0/search');
    const body = new URLSearchParams(call.body);
    assert.equal(body.get('generateformatifnotexists'), 'false'); assert.equal(body.get('getpermanentassetspaths'), 'false'); assert.equal(body.get('format'), 'JSON');
    assert.equal(call.headers.get('authorization'), 'Bearer owned-bearer');
    assert.equal(body.get('query'), '(ParentFolderIdentifier:APPROVED)');
    return json(orangeDoc(body.get('pagenumber') === '1' ? [orangeAsset()] : []));
  });
  const provider = createOrangeLogicProvider('source', { ...orange, pageSize: 1 }, 'owned-bearer', f.fetchImpl);
  const page = await provider.listAssets(); assert.equal(page.next, '2'); assert.equal((await provider.listAssets(page.next)).next, undefined);
  const a = page.assets[0]!;
  assert.equal(provider.capabilities.originals, false); assert.equal(a.originalsAvailable, false); assert.equal(a.approved, undefined);
  assert.equal(a.formats[0]!.role, 'rendition'); assert.match(a.formats[0]!.filename!, /TR1 rendition/);
  const entry = mapProviderAsset(record('orange-logic', orange), a);
  assert.equal((entry.meta as Record<string, unknown>).providerOriginalsAvailable, false);
  assert.ok(!JSON.stringify(entry).includes('access=owned-link')); assert.ok(!JSON.stringify(entry).includes('https://dam.example'));
});

test('Orange Logic exchanges client credentials once and refreshes a rejected token once', async () => {
  let auth = 0, searches = 0;
  const f = fixture(call => {
    if (call.url.pathname.includes('/authenticate_')) { auth++; assert.deepEqual(JSON.parse(call.body), { client_id: 'owned-client', client_secret: 'owned-secret' }); return json({ access_token: `owned-token-${auth}`, expires_in: 7200 }); }
    searches++;
    if (searches === 1) return json({}, 401);
    assert.equal(call.headers.get('authorization'), 'Bearer owned-token-2'); return json(orangeDoc([]));
  });
  const provider = createOrangeLogicProvider('source', orange, JSON.stringify({ clientId: 'owned-client', clientSecret: 'owned-secret' }), f.fetchImpl);
  await provider.listAssets(); await provider.listAssets(); assert.equal(auth, 2); assert.equal(searches, 3);
});

test('Orange Logic search and single-record lookup retain scope and escape member text', async () => {
  const queries: string[] = [];
  const f = fixture(call => { queries.push(new URLSearchParams(call.body).get('query')!); return json(orangeDoc([orangeAsset()])); });
  const provider = createOrangeLogicProvider('source', orange, 'owned-bearer', f.fetchImpl);
  await provider.searchAssets!('photo" OR text:*', 10); await provider.getAsset!('OL1');
  assert.equal(queries[0], '(ParentFolderIdentifier:APPROVED) AND (text:"photo\\" OR text:*")');
  assert.equal(queries[1], '(ParentFolderIdentifier:APPROVED) AND (SystemIdentifier:"OL1")');
});

test('Orange Logic streams a freshly resolved allowed rendition without the API bearer', async () => {
  const f = fixture(call => {
    if (call.url.pathname.startsWith('/API/')) return json(orangeDoc([orangeAsset()]));
    assert.equal(call.headers.get('authorization'), null); return new Response('proxy', { headers: { 'content-type': 'image/jpeg' } });
  });
  const provider = createOrangeLogicProvider('source', orange, 'owned-bearer', f.fetchImpl);
  const a = await provider.getAsset!('OL1');
  const blob = await provider.resolveBlob('OL1', a!.formats[0]!.remoteRef);
  assert.equal(blob.kind, 'stream'); if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'proxy');
  const before = f.calls.length;
  await assert.rejects(provider.resolveBlob('OL1', 'original'), /protected originals/); assert.equal(f.calls.length, before);
});

test('Orange Logic rejects stale, substituted and cross-origin renditions', async () => {
  let raw = orangeAsset();
  const f = fixture(() => json(orangeDoc([raw])));
  const provider = createOrangeLogicProvider('source', orange, 'owned-bearer', f.fetchImpl);
  const ref = (await provider.listAssets()).assets[0]!.formats[0]!.remoteRef;
  raw = orangeAsset({ FileMD5: 'new-source' }); await assert.rejects(provider.resolveBlob('OL1', ref), /changed/);
  raw = orangeAsset({ path_TR1: { URI: 'https://dam.example/watermarked.jpg', SubstituteFormat: 'TR1_WATERMARKED' } });
  assert.equal((await provider.listAssets()).assets[0]!.formats.length, 0); await assert.rejects(provider.resolveBlob('OL1', 'thumb'), /substituted/);
  for (const uri of ['https://evil.example/a.jpg', 'http://dam.example/a.jpg', 'https://user:password@dam.example/a.jpg']) {
    raw = orangeAsset({ path_TR1: { URI: uri } }); await assert.rejects(provider.listAssets(), /reviewed storage origins/);
  }
  assert.ok(f.calls.every(call => call.url.hostname === 'dam.example'));
});

test('Orange Logic metadata-only records, explicit approval, expiry and reviewed storage origins', async () => {
  const raw = orangeAsset({ path_TR1: undefined, 'Marketing.Status': 'Published', 'Marketing.Expiry': '2099-12-31' });
  const f = fixture(() => json(orangeDoc([raw], 1)));
  const provider = createOrangeLogicProvider('source', { ...orange, approvalField: 'Marketing.Status', approvedValues: ['Published'] }, 'owned-bearer', f.fetchImpl, { until: 'Marketing.Expiry' });
  const page = await provider.listAssets(); const a = page.assets[0]!;
  assert.equal(page.next, undefined); assert.deepEqual(a.formats, []); assert.equal(a.hasThumbnail, false); assert.equal(a.approved, true);
  assert.equal(a.availableUntil, '2099-12-31T00:00:00.000Z'); assert.ok(page.notes!.some(note => note.includes('no available')));
  const remote = fixture(call => call.url.hostname === 'dam.example' ? json(orangeDoc([orangeAsset({ path_TR1: { URI: 'https://storage.example/a.jpg' } })])) : new Response('proxy'));
  const allowed = createOrangeLogicProvider('source', { ...orange, storageOrigins: ['https://storage.example'] }, 'owned-bearer', remote.fetchImpl);
  const file = (await allowed.listAssets()).assets[0]!.formats[0]!;
  const blob = await allowed.resolveBlob('OL1', file.remoteRef); if (blob.kind === 'stream') await blob.body.cancel();
  assert.equal(remote.calls.at(-1)!.url.origin, 'https://storage.example'); assert.equal(remote.calls.at(-1)!.headers.get('authorization'), null);
});

test('New sources produce redacted shape reports and sanitized failures', async () => {
  for (const provider of [
    createCloudinaryProvider('s', cloud, cloudSecret, fixture(() => json({ resources: [cloudAsset({ context: { custom: { private_note: 'never-output-this' } } })] })).fetchImpl),
    createOrangeLogicProvider('s', orange, 'owned-bearer', fixture(() => json(orangeDoc([orangeAsset({ CaptionLong: 'never-output-this' })]))).fetchImpl),
  ]) {
    const report = JSON.stringify(await provider.sampleShape!());
    assert.ok(!report.includes('never-output-this')); assert.ok(!report.includes('owned-link')); assert.ok(!report.includes('owned-bearer'));
  }
  const failed: typeof fetch = async () => { throw new Error('https://example/?secret=never-output-this'); };
  const health = await createCloudinaryProvider('s', cloud, cloudSecret, failed).healthCheck();
  assert.equal(health.ok, false); assert.ok(!health.detail!.includes('never-output-this'));
  for (const status of [302, 401, 403, 429, 500]) {
    const provider = createCloudinaryProvider('s', cloud, cloudSecret, fixture(() => json({ error: 'never-output-this' }, status)).fetchImpl);
    const result = await provider.healthCheck(); assert.equal(result.ok, false); assert.match(result.detail!, new RegExp(String(status))); assert.ok(!result.detail!.includes('never-output-this'));
  }
});
test('Shape diagnostics survive a changed envelope without reporting upstream values', async () => {
  const providers = [
    createCloudinaryProvider('s', cloud, cloudSecret, fixture(() => json({ wrong: [{ private_value: 'never-output-this' }] })).fetchImpl),
    createOrangeLogicProvider('s', orange, 'owned-bearer', fixture(() => json({ APIResponse: { wrong: [{ private_value: 'never-output-this' }] } })).fetchImpl),
  ];
  for (const provider of providers) {
    await assert.rejects(provider.listAssets());
    const report = await provider.sampleShape!();
    assert.equal(report.recordCount, 0); assert.ok(report.absent.length > 0);
    assert.ok(!JSON.stringify(report).includes('never-output-this'));
  }
});

test('Registry and federation keep both sources behind the existing exposure boundary', async () => {
  for (const [kind, options, secret, doc] of [
    ['cloudinary', { ...cloud, approvedTag: 'approved' }, cloudSecret, { resources: [cloudAsset()] }],
    ['orange-logic', { ...orange, approvalField: 'Marketing.Status', approvedValues: ['Published'] }, 'owned-bearer', orangeDoc([orangeAsset({ 'Marketing.Status': 'Published' })], 1)],
  ] as const) {
    const rec = record(kind, options); rec.exposure.requireApproved = true;
    const provider = createProvider(rec, secret, { fetchImpl: fixture(() => json(doc)).fetchImpl });
    const fragment = await buildFragment(rec, provider, Date.now);
    assert.equal(fragment.assets.length, 1);
    assert.equal(composeFederated({ version: 1, assets: [] }, [{ rec, fragment, stale: false }], ['design']).assets!.length, 1);
    assert.equal(composeFederated({ version: 1, assets: [] }, [{ rec, fragment, stale: false }], ['sales']).assets!.length, 0);
    const a = (await provider.listAssets()).assets[0]!;
    assert.equal(passesExposure({ ...rec, exposure: { requireApproved: true } }, { ...a, approved: undefined }), false);
    assert.ok(!JSON.stringify(fragment).includes('owned-secret')); assert.ok(!JSON.stringify(fragment).includes('owned-link'));
  }
});

test('A rendition-only source cannot be cut over as a migrated DAM', async () => {
  const rec = record('orange-logic', orange);
  const store = createMemoryStore();
  const deps = { store, federation: { instantiate: () => createOrangeLogicProvider('source', orange, undefined) } } as unknown as MaterializeDeps;
  await assert.rejects(cutoverProvider(deps, rec), /originals/);
  assert.equal((await store.listAliases()).length, 0);
});
test('Source availability and origins fail visibly on ambiguous or malformed input', () => {
  for (const value of ['10/15/2026', '2026-02-31', '2026-10-15T12:00:00', 'not-a-date']) assert.throws(() => damDate(value, 'source'), /date/);
  assert.equal(damDate('2026-10-15T12:00:00+01:00', 'source'), '2026-10-15T11:00:00.000Z');
  for (const value of ['https://*.example', 'https://dam.example/path', 'https://user:secret@dam.example', 'http://dam.example', 'https://dam.example:0']) assert.throws(() => damOrigin(value, 'source'));
});
