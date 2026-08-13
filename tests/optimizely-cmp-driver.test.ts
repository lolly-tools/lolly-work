/**
 * Optimizely CMP DAM driver (plans/27 §9, §10) against a modelled v3 API shape.
 * Injected fetch, no network: OAuth refresh → bearer on every call, mapping
 * (title→name, folder+labels→sections, is_public&!is_archived→approved,
 * expires_at→availableUntil, file→formats), offset pagination, per-request
 * fresh signed download URL, and the host allowlist that keeps /catalog/ext/*
 * from becoming an open proxy.
 *
 * The exact CMP field/endpoint names carry a LIVE-VERIFY caveat in the driver;
 * these fixtures pin the SHAPE the driver maps, exactly as the Brandfolder
 * driver test pins recorded v4 shapes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOptimizelyCmpProvider } from '../server/src/catalog/providers/optimizely-cmp.ts';

const CRED = (rt: string) => JSON.stringify({ clientId: 'cid', clientSecret: 'sec', refreshToken: rt });

const ASSET_PUBLIC = {
  id: 'a100', title: 'Summit Hero', type: 'image',
  folder: { id: 'f1', name: 'Web Heroes' }, labels: ['approved', 'campaign-2026'],
  expires_at: '2027-01-01T00:00:00.000Z', is_public: true, is_archived: false,
  updated_at: '2026-06-01T00:00:00.000Z',
  file: { name: 'summit-hero.jpg', size: 20480, extension: 'jpg', mime_type: 'image/jpeg' },
};
const ASSET_ARCHIVED = {
  id: 'a200', title: 'Old Draft', type: 'image', is_public: true, is_archived: true,
  file: { name: 'draft.png', extension: 'png' },
};
const LIST = { data: [ASSET_PUBLIC, ASSET_ARCHIVED], meta: { total: 2 } };
const ASSET_DL = { data: { ...ASSET_PUBLIC, download_url: 'https://assets.welcomecdn.com/a100/original/summit-hero.jpg?sig=x' } };

interface Call { url: string; method: string; auth: string }
function fakeFetch(routes: Array<{ match: (url: string, method: string) => boolean; body?: unknown; bytes?: string; status?: number }>): typeof fetch {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, auth: (init?.headers as Record<string, string>)?.authorization ?? '' });
    const route = routes.find((r) => r.match(url, method));
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes !== undefined) return new Response(route.bytes, { status: route.status ?? 200, headers: { 'content-type': 'image/jpeg' } });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (impl as unknown as { calls: Call[] }).calls = calls;
  return impl;
}

const tokenRoute = { match: (u: string, m: string) => m === 'POST' && u.includes('/o/oauth2/'), body: { access_token: 'tok-123', expires_in: 3600 } };

test('listAssets maps the modelled shape and refreshes a bearer token first', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/v3/assets') && !u.includes('/v3/assets/'), body: LIST }]);
  const cmp = createOptimizelyCmpProvider('opti', {}, CRED('rt-list'), fetchImpl);
  const page = await cmp.listAssets();

  const pub = page.assets.find((a) => a.remoteId === 'a100');
  assert.equal(pub?.name, 'Summit Hero');
  assert.equal(pub?.nativeType, 'image');
  assert.deepEqual(pub?.sections, ['Web Heroes', 'approved', 'campaign-2026'], 'folder + labels both scope-able');
  assert.equal(pub?.approved, true, 'public and not archived → approved');
  assert.equal(pub?.availableUntil, '2027-01-01T00:00:00.000Z', 'expires_at → availableUntil (Wave 1)');
  assert.deepEqual(pub?.formats, [{ format: 'jpg', remoteRef: 'content', size: 20480, filename: 'summit-hero.jpg' }]);

  const archived = page.assets.find((a) => a.remoteId === 'a200');
  assert.equal(archived?.approved, false, 'archived → not approved even though is_public');

  const calls = (fetchImpl as unknown as { calls: Call[] }).calls;
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/o/oauth2/')), 'refresh-token exchange happened');
  assert.ok(calls.some((c) => c.url.includes('/v3/assets') && c.auth === 'Bearer tok-123'), 'bearer rides the api call');
});

test('offset pagination: the cursor drives the offset query param; a short page yields no cursor', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/v3/assets'), body: LIST }]);
  const cmp = createOptimizelyCmpProvider('opti2', {}, CRED('rt-page'), fetchImpl);
  const first = await cmp.listAssets();
  assert.equal(first.next, undefined, '2 assets < page size → no next');
  await cmp.listAssets('100');
  const calls = (fetchImpl as unknown as { calls: Call[] }).calls;
  assert.ok(calls.some((c) => c.url.includes('offset=100')), 'cursor becomes the offset');
});

test('resolveBlob re-fetches a fresh signed URL per request and streams from CMP/CDN hosts only', async () => {
  const fetchImpl = fakeFetch([
    tokenRoute,
    { match: (u) => u.includes('/v3/assets/a100'), body: ASSET_DL },
    { match: (u) => u.startsWith('https://assets.welcomecdn.com/'), bytes: 'JPEGBYTES' },
  ]);
  const cmp = createOptimizelyCmpProvider('opti3', {}, CRED('rt-blob'), fetchImpl);
  const blob = await cmp.resolveBlob('a100', 'content');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') {
    assert.equal(blob.contentType, 'image/jpeg');
    assert.equal(blob.size, 20480);
    assert.equal(await new Response(blob.body).text(), 'JPEGBYTES');
  }
});

test('a download URL outside CMP-owned hosts is refused (no open proxy)', async () => {
  const evil = { data: { ...ASSET_PUBLIC, download_url: 'https://welcomecdn.com.evil.example/steal' } };
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/v3/assets/a100'), body: evil }]);
  const cmp = createOptimizelyCmpProvider('opti4', {}, CRED('rt-evil'), fetchImpl);
  await assert.rejects(() => cmp.resolveBlob('a100', 'content'), /outside allowed hosts/);
});

test('publishAsset (plans/27 §10) rides CMP ingestion: upload-url → PUT → create asset', async () => {
  const fetchImpl = fakeFetch([
    tokenRoute,
    { match: (u, m) => m === 'GET' && u.includes('/v3/upload-url'), body: { upload_url: 'https://assets.welcomecdn.com/upload/xyz?sig=1', id: 'up1' } },
    { match: (u, m) => m === 'PUT' && u.startsWith('https://assets.welcomecdn.com/upload/'), bytes: '' },
    { match: (u, m) => m === 'POST' && u.endsWith('/v3/assets'), body: { id: 'newasset1', public_url: 'https://cmp.optimizely.com/a/newasset1' } },
  ]);
  const cmp = createOptimizelyCmpProvider('optip', { publish: true }, CRED('rt-pub'), fetchImpl);
  assert.equal(cmp.capabilities.publish, true, 'declares the publish capability when opted in');
  const out = await cmp.publishAsset!({ bytes: new Uint8Array([1, 2, 3]), name: 'summit-badge', format: 'png', contentType: 'image/png' });
  assert.equal(out.remoteId, 'newasset1');
  assert.equal(out.url, 'https://cmp.optimizely.com/a/newasset1');

  const calls = (fetchImpl as unknown as { calls: Call[] }).calls;
  assert.ok(calls.some((c) => c.method === 'PUT' && c.url.startsWith('https://assets.welcomecdn.com/upload/')), 'bytes PUT to the signed upload URL');
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v3/assets')), 'asset created referencing the upload');
});

test('publish is off by default — a read-only source declares no publish capability (the route gate)', () => {
  const cmp = createOptimizelyCmpProvider('optiro', {}, CRED('rt-ro'), fakeFetch([]));
  assert.equal(cmp.capabilities.publish, false, 'the publish route refuses a provider whose capability is off');
});

test('healthCheck: ok on 200; a missing credential fails closed', async () => {
  const ok = createOptimizelyCmpProvider('optih', {}, CRED('rt-health'), fakeFetch([tokenRoute, { match: (u) => u.includes('/v3/assets'), body: LIST }]));
  assert.equal((await ok.healthCheck()).ok, true);

  const keyless = createOptimizelyCmpProvider('optik', {}, undefined, fakeFetch([]));
  const h = await keyless.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail ?? '', /credential/);
});
