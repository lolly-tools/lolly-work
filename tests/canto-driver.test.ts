/**
 * Canto driver (plans/32 §3, §4, §7) against a modelled v1 API. Injected fetch, no
 * network and no tenant: OAuth refresh → bearer + mandatory User-Agent on every
 * call, the scheme walk behind the composite cursor (page boundary, then scheme
 * boundary), search, the scheme-carrying remoteId and its guard, approval-state
 * mapping (default set and an override), the custom-field availability window,
 * records dropped rather than federated under a guessed scheme or an id the
 * resolve guard would refuse, host pinning on the API, token and binary hosts,
 * and the self-imposed rate gap. Endpoint and
 * field names carry a LIVE-VERIFY caveat in the driver; these fixtures pin what it
 * maps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCantoProvider } from '../server/src/catalog/providers/canto.ts';

const CRED = (rt: string) => JSON.stringify({ clientId: 'cid', clientSecret: 'sec', refreshToken: rt });
const TENANT = { tenant: 'acme', minGapMs: 0 } as const;

const IMG_A = {
  id: 'AB12', scheme: 'image', name: 'Summit Banner.png', size: 2048,
  lastModified: '2026-06-01T00:00:00.000Z', tag: ['event'], keyword: ['2026'],
  album: 'Campaigns', approvalStatus: 'approved',
  additional: { 'Expiry Date': '2027-01-01T00:00:00.000Z' },
};
const IMG_PENDING = { id: 'CD34', scheme: 'image', name: 'Draft.png', approvalStatus: 'pending' };
const VID_A = { id: 'EF56', scheme: 'video', displayName: 'Keynote', folder: ['Events', 'Keynotes'], time: '2026-05-02T00:00:00.000Z' };

interface Call { url: string; method: string; auth: string; ua: string }
function fakeFetch(routes: Array<{ match: (url: string, method: string) => boolean; body?: unknown; bytes?: string; status?: number }>): typeof fetch {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers as Record<string, string>) ?? {};
    calls.push({ url, method: init?.method ?? 'GET', auth: h.authorization ?? '', ua: h['user-agent'] ?? '' });
    const route = routes.find((r) => r.match(url, init?.method ?? 'GET'));
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes !== undefined) {
      return new Response(route.bytes, { status: route.status ?? 200, headers: { 'content-type': 'image/png', 'content-length': String(route.bytes.length) } });
    }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (impl as unknown as { calls: Call[] }).calls = calls;
  return impl;
}
const callsOf = (f: typeof fetch): Call[] => (f as unknown as { calls: Call[] }).calls;
const tokenRoute = { match: (u: string, m: string) => m === 'POST' && u.includes('/oauth2/token'), body: { access_token: 'tok-canto', expires_in: 3600 } };
/** A full page (limit=100) of one scheme, so the driver keeps walking that scheme. */
const fullPage = (scheme: string, from: number) =>
  Array.from({ length: 100 }, (_, i) => ({ id: `${scheme}-${from + i}`, scheme, name: `f${from + i}.png` }));

test('listAssets maps a Canto record: scheme-carrying remoteId, album sections, tag + keyword, one download format', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [IMG_A] } }]);
  const canto = createCantoProvider('c1', TENANT, CRED('rt-list'), fetchImpl, { until: 'Expiry Date' });
  const page = await canto.listAssets();

  const a = page.assets[0];
  assert.equal(a?.remoteId, 'image:AB12', 'the scheme travels with the id');
  assert.equal(a?.name, 'Summit Banner');
  assert.equal(a?.nativeType, 'image');
  assert.deepEqual(a?.sections, ['Campaigns']);
  assert.deepEqual(a?.tags, ['event', '2026'], 'tag + keyword fold into tags');
  assert.equal(a?.updatedAt, '2026-06-01T00:00:00.000Z');
  assert.equal(a?.approved, true);
  assert.equal(a?.availableUntil, '2027-01-01T00:00:00.000Z', 'custom field → availability window (mapping.availabilityFields)');
  assert.deepEqual(a?.formats, [{ format: 'png', remoteRef: 'download', size: 2048, filename: 'Summit Banner.png' }]);

  const apiCall = callsOf(fetchImpl).find((c) => c.url.includes('/api/v1/image?'));
  assert.equal(apiCall?.url, 'https://acme.canto.com/api/v1/image?limit=100&start=0');
  assert.equal(apiCall?.auth, 'Bearer tok-canto', 'bearer rides the call');
  assert.match(apiCall?.ua ?? '', /lolly-work/, 'mandatory User-Agent is sent');
});

test('a record with no filename extension falls back to the scheme for format and nativeType', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { assets: [VID_A] } }]);
  const canto = createCantoProvider('c2', TENANT, CRED('rt-ext'), fetchImpl);
  const a = (await canto.listAssets()).assets[0];
  assert.equal(a?.remoteId, 'video:EF56', "the record's own scheme wins over the one being walked");
  assert.equal(a?.name, 'Keynote');
  assert.deepEqual(a?.sections, ['Events', 'Keynotes'], 'a folder array maps to several sections');
  assert.deepEqual(a?.formats, [{ format: 'video', remoteRef: 'download' }]);
});

test('the composite cursor walks a full page within a scheme, then crosses to the next scheme, then stops', async () => {
  const fetchImpl = fakeFetch([
    tokenRoute,
    { match: (u) => u.includes('/image?limit=100&start=0'), body: { results: fullPage('image', 0) } },
    { match: (u) => u.includes('/image?limit=100&start=100'), body: { results: [IMG_A] } },
    { match: (u) => u.includes('/video?limit=100&start=0'), body: { results: [VID_A] } },
    { match: (u) => u.includes('/other?limit=100&start=0'), body: { results: [] } },
    { match: (u) => /\/(audio|document|presentation)\?/.test(u), body: { results: [] } },
  ]);
  const canto = createCantoProvider('c3', TENANT, CRED('rt-walk'), fetchImpl);

  const p1 = await canto.listAssets();
  assert.equal(p1.assets.length, 100);
  assert.equal(p1.next, '0:100', 'a full page advances start within the same scheme');

  const p2 = await canto.listAssets(p1.next);
  assert.equal(p2.assets.length, 1);
  assert.equal(p2.next, '1:0', 'a short page moves to the next scheme at start 0');

  const p3 = await canto.listAssets(p2.next);
  assert.equal(p3.assets[0]?.remoteId, 'video:EF56');
  assert.equal(p3.next, '2:0');

  // Walk the tail: audio, document, presentation, then the last scheme ends it.
  let cursor: string | undefined = p3.next;
  for (let i = 0; i < 3; i++) cursor = (await canto.listAssets(cursor)).next;
  assert.equal(cursor, '5:0', 'presentation hands over to the last scheme');
  assert.equal((await canto.listAssets(cursor)).next, undefined, 'the last scheme exhausted ends the walk');

  await assert.rejects(() => canto.listAssets('nonsense'), /bad canto cursor/);
  await assert.rejects(() => canto.listAssets('9:0'), /bad canto cursor/);
});

test('albumId scopes listing to one album and walks only the start dimension', async () => {
  const fetchImpl = fakeFetch([
    tokenRoute,
    { match: (u) => u.includes('/album/AL%201?limit=100&start=0'), body: { results: fullPage('image', 0) } },
    { match: (u) => u.includes('/album/AL%201?limit=100&start=100'), body: { results: [VID_A] } },
  ]);
  const canto = createCantoProvider('c4', { ...TENANT, albumId: 'AL 1' }, CRED('rt-album'), fetchImpl);
  const p1 = await canto.listAssets();
  assert.equal(p1.next, '0:100');
  const p2 = await canto.listAssets(p1.next);
  assert.equal(p2.next, undefined, 'the album arm never crosses into a second scheme');
  assert.equal(p2.assets[0]?.remoteId, 'video:EF56');
});

test('approval: the default set is ["approved"], an explicit approvedStates overrides it, a stateless record passes', async () => {
  const body = { results: [IMG_A, IMG_PENDING, { id: 'GH78', scheme: 'image', name: 'Legacy.png' }] };
  const route = { match: (u: string) => u.includes('/api/v1/image?'), body };

  const dflt = createCantoProvider('c5', TENANT, CRED('rt-appr'), fakeFetch([tokenRoute, route]));
  const a = (await dflt.listAssets()).assets;
  assert.deepEqual(a.map((x) => x.approved), [true, false, true], 'pending is not approved; a record with no state is');

  const wider = createCantoProvider('c6', { ...TENANT, approvedStates: ['approved', 'pending'] }, CRED('rt-appr2'), fakeFetch([tokenRoute, route]));
  const b = (await wider.listAssets()).assets;
  assert.deepEqual(b.map((x) => x.approved), [true, true, true], 'the override widens the approved set');
});

test('with no availabilityFields configured, the custom field is ignored (the manual arm is the story)', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [IMG_A] } }]);
  const canto = createCantoProvider('c7', TENANT, CRED('rt-nowin'), fetchImpl);
  const a = (await canto.listAssets()).assets[0];
  assert.equal(a?.availableUntil, undefined);
  assert.equal(a?.availableFrom, undefined);
});

test('the availability window also reads the customFields bag, both ends of it', async () => {
  const rec = { id: 'IJ90', scheme: 'image', name: 'Promo.png', customFields: { Start: '2026-01-01', End: '2026-12-31' } };
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { data: [rec] } }]);
  const canto = createCantoProvider('c8', TENANT, CRED('rt-win'), fetchImpl, { from: 'Start', until: 'End' });
  const a = (await canto.listAssets()).assets[0];
  assert.equal(a?.availableFrom, '2026-01-01');
  assert.equal(a?.availableUntil, '2026-12-31');
});

test('searchAssets hits the keyword endpoint and maps through the same record mapper', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/search?'), body: { results: [IMG_A] } }]);
  const canto = createCantoProvider('c9', TENANT, CRED('rt-search'), fetchImpl);
  const hits = await canto.searchAssets?.('summit banner', 5);
  assert.equal(hits?.[0]?.remoteId, 'image:AB12');
  const url = callsOf(fetchImpl).find((c) => c.url.includes('/search?'))?.url ?? '';
  assert.ok(url.endsWith('/api/v1/search?keyword=summit%20banner&limit=5'), url);
});

test('resolveBlob streams the original from api_binary and refuses anything but the download format', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/api_binary/v1/image/AB12'), bytes: 'PNGBYTES' }]);
  const canto = createCantoProvider('c10', TENANT, CRED('rt-blob'), fetchImpl);
  const blob = await canto.resolveBlob('image:AB12', 'download');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') {
    assert.equal(blob.contentType, 'image/png');
    assert.equal(blob.size, 8);
    assert.equal(await new Response(blob.body).text(), 'PNGBYTES');
  }
  const call = callsOf(fetchImpl).find((c) => c.url.includes('/api_binary/'));
  assert.equal(call?.url, 'https://acme.canto.com/api_binary/v1/image/AB12');
  assert.equal(call?.auth, 'Bearer tok-canto');
  assert.match(call?.ua ?? '', /lolly-work/);
  await assert.rejects(() => canto.resolveBlob('image:AB12', 'thumb'), /single download format/);
});

test('a remoteId without a valid scheme prefix is refused before any fetch', async () => {
  const canto = createCantoProvider('c11', TENANT, CRED('rt-guard'), fakeFetch([tokenRoute]));
  for (const bad of ['AB12', 'sketch:AB12', 'image:../../etc', 'image:AB 12', 'image:']) {
    await assert.rejects(() => canto.resolveBlob(bad, 'download'), /bad canto asset id/, bad);
  }
});

test('a tenant host outside the canto family is refused (no open proxy)', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: () => true, bytes: 'STOLEN' }]);
  const evil = createCantoProvider('c12', { ...TENANT, baseUrl: 'https://canto.com.evil.example/api/v1' }, CRED('rt-evil'), fetchImpl);
  await assert.rejects(() => evil.resolveBlob('image:AB12', 'download'), /outside allowed hosts/);
  await assert.rejects(() => evil.listAssets(), /outside allowed hosts/);
  assert.equal(callsOf(fetchImpl).length, 0, 'refused before the request leaves');
});

test('a tokenUrl outside the canto family is refused before the sealed credential leaves', async () => {
  const fetchImpl = fakeFetch([{ match: () => true, body: { access_token: 'harvested', expires_in: 3600 } }]);
  const evil = createCantoProvider('c17', { ...TENANT, tokenUrl: 'https://evil.example/oauth2/token' }, CRED('rt-token'), fetchImpl);
  await assert.rejects(() => evil.listAssets(), /outside allowed hosts/);
  await assert.rejects(() => evil.resolveBlob('image:AB12', 'download'), /outside allowed hosts/);
  assert.equal(callsOf(fetchImpl).length, 0, 'clientId, clientSecret and refreshToken never leave for a non-canto host');
});

test('a record the driver could not resolve later is dropped, never federated under a guessed id', async () => {
  const mixed = [
    IMG_A,
    { id: 'X1', name: 'cased.png', scheme: 'Image' }, // odd casing normalises, it does not get dropped
    { id: 'a/b', scheme: 'image', name: 'slash.png' }, // outside the id charset resolveBlob accepts
    { id: 'a:b', scheme: 'image', name: 'colon.png' }, // would mis-split on the remoteId separator
    { id: '', scheme: 'image', name: 'idless.png' },
    { id: 'Y1', scheme: 'sketch', name: 'unknown-scheme.png' }, // falls back to the walked scheme
  ];
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: mixed } }]);
  const canto = createCantoProvider('c18', TENANT, CRED('rt-drop'), fetchImpl);
  const page = await canto.listAssets();
  assert.deepEqual(page.assets.map((a) => a.remoteId), ['image:AB12', 'image:X1', 'image:Y1'],
    'only ids resolveBlob would accept are federated');
  // Every id that federates reaches the binary path: the guard is never what stops it.
  for (const a of page.assets) {
    await assert.rejects(() => canto.resolveBlob(a.remoteId, 'download'), /canto blob fetch 404/, a.remoteId);
  }
});

test('a search hit with no scheme is skipped rather than mislabelled', async () => {
  const body = { results: [IMG_A, { id: 'X1', name: 'schemeless.png' }, { id: 'X2', scheme: 'Video', name: 'cased.mp4' }] };
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/search?'), body }]);
  const canto = createCantoProvider('c19', TENANT, CRED('rt-search2'), fetchImpl);
  const hits = await canto.searchAssets?.('x', 10);
  assert.deepEqual(hits?.map((h) => h.remoteId), ['image:AB12', 'video:X2'],
    'a scheme-less hit would name the wrong binary path and a second identity for an already-federated asset');
});

test('an album-scoped record without its own scheme is dropped: the album arm crosses schemes', async () => {
  const body = { results: [IMG_A, { id: 'X1', name: 'schemeless.png' }] };
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/album/AL1?'), body }]);
  const canto = createCantoProvider('c20', { ...TENANT, albumId: 'AL1' }, CRED('rt-album2'), fetchImpl);
  const page = await canto.listAssets();
  assert.deepEqual(page.assets.map((a) => a.remoteId), ['image:AB12']);
});

test('the module-level rate limiter spaces calls to one provider by minGapMs', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/'), body: { results: [] } }]);
  const canto = createCantoProvider('c13', { tenant: 'acme', minGapMs: 120 }, CRED('rt-gap'), fetchImpl);
  const t0 = Date.now();
  await canto.listAssets();
  await canto.listAssets();
  assert.ok(Date.now() - t0 >= 120, 'the second call waits out the gap');
});

test('healthCheck: ok on 200; a missing credential fails closed', async () => {
  const ok = createCantoProvider('c14', TENANT, CRED('rt-h'), fakeFetch([tokenRoute, { match: (u) => u.includes('/api/v1/image?'), body: { results: [] } }]));
  assert.equal((await ok.healthCheck()).ok, true);
  const keyless = createCantoProvider('c15', TENANT, undefined, fakeFetch([]));
  const h = await keyless.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail ?? '', /no credential/);
});

test('capabilities: search and expiring URLs, no thumbnails, and never publish', () => {
  const canto = createCantoProvider('c16', TENANT, CRED('rt-caps'), fakeFetch([]));
  assert.deepEqual(canto.capabilities, { search: true, thumbnails: false, expiringUrls: true });
  assert.equal(canto.capabilities.publish, undefined, 'Canto is a source being exited, never a publish destination');
  assert.equal(canto.publishAsset, undefined);
});
