/**
 * Image Relay driver (plans/27 §9, §10) against a modelled v2 API shape. Injected
 * fetch, no network: OAuth refresh → bearer + mandatory User-Agent on every call,
 * mapping (folder → section, keywords/tags, custom-field → availability window via
 * mapping.availabilityFields), deleted-file drop, per-request fresh download link,
 * and the host allowlist. Field/endpoint names carry a LIVE-VERIFY caveat in the
 * driver; these fixtures pin the SHAPE it maps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageRelayProvider } from '../server/src/catalog/providers/imagerelay.ts';

const CRED = (rt: string) => JSON.stringify({ clientId: 'cid', clientSecret: 'sec', refreshToken: rt });

const FILE_A = {
  id: 55, name: 'Summit Banner.png', filename: 'summit-banner.png', extension: 'png', size: 2048,
  updated_at: '2026-06-01T00:00:00.000Z', keywords: ['event', '2026'], tags: ['approved'],
  folder: { id: 9, name: 'Campaigns' }, custom_fields: { 'Expiry Date': '2027-01-01T00:00:00.000Z' },
};
// DELETED_KEYS reads `deleted` and nothing else, so the fixture carries nothing else.
const FILE_DEL = { id: 56, name: 'Retired.png', deleted: true };
const LIST = { files: [FILE_A, FILE_DEL], meta: { next_page: null } };
const FILE_DL = { file: { ...FILE_A, download_url: 'https://assets.imagerelay.com/f/55/download?sig=x' } };

interface Call { url: string; method: string; auth: string; ua: string }
function fakeFetch(routes: Array<{ match: (url: string, method: string) => boolean; body?: unknown; bytes?: string; status?: number }>): typeof fetch {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers as Record<string, string>) ?? {};
    calls.push({ url, method: init?.method ?? 'GET', auth: h.authorization ?? '', ua: h['user-agent'] ?? '' });
    const route = routes.find((r) => r.match(url, init?.method ?? 'GET'));
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes !== undefined) return new Response(route.bytes, { status: route.status ?? 200, headers: { 'content-type': 'image/png' } });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (impl as unknown as { calls: Call[] }).calls = calls;
  return impl;
}
const tokenRoute = { match: (u: string, m: string) => m === 'POST' && u.includes('/oauth/token'), body: { access_token: 'tok-ir', expires_in: 3600 } };

test('listAssets maps folder/keywords, imports the availability window from a custom field, drops deleted files', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/files') && !u.includes('/files/'), body: LIST }]);
  const ir = createImageRelayProvider('ir1', {}, CRED('rt-list'), fetchImpl, { until: 'Expiry Date' });
  const page = await ir.listAssets();

  assert.equal(page.assets.length, 1, 'the deleted file is dropped');
  const a = page.assets[0];
  assert.equal(a?.remoteId, '55');
  assert.equal(a?.name, 'Summit Banner');
  assert.deepEqual(a?.sections, ['Campaigns']);
  assert.deepEqual(a?.tags, ['event', '2026', 'approved'], 'keywords + tags fold into tags');
  assert.equal(a?.availableUntil, '2027-01-01T00:00:00.000Z', 'custom field -> availability window (mapping.availabilityFields)');
  assert.deepEqual(a?.formats, [{ format: 'png', remoteRef: 'download', size: 2048, filename: 'summit-banner.png' }]);

  const calls = (fetchImpl as unknown as { calls: Call[] }).calls;
  const apiCall = calls.find((c) => c.url.includes('/files'));
  assert.equal(apiCall?.auth, 'Bearer tok-ir', 'bearer rides the call');
  assert.match(apiCall?.ua ?? '', /lolly-work/, 'mandatory User-Agent is sent');
});

test('with no availabilityFields configured, the custom field is ignored (manual arm is the story)', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/files'), body: LIST }]);
  const ir = createImageRelayProvider('ir2', {}, CRED('rt-none'), fetchImpl);
  const a = (await ir.listAssets()).assets[0];
  assert.equal(a?.availableUntil, undefined);
});

test('resolveBlob re-fetches a fresh download link and streams from imagerelay hosts only', async () => {
  const fetchImpl = fakeFetch([
    tokenRoute,
    { match: (u) => u.includes('/files/55'), body: FILE_DL },
    { match: (u) => u.startsWith('https://assets.imagerelay.com/'), bytes: 'PNGBYTES' },
  ]);
  const ir = createImageRelayProvider('ir3', {}, CRED('rt-blob'), fetchImpl);
  const blob = await ir.resolveBlob('55', 'download');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'PNGBYTES');
});

test('a download URL outside imagerelay.com is refused (no open proxy)', async () => {
  const evil = { file: { ...FILE_A, download_url: 'https://imagerelay.com.evil.example/steal' } };
  const fetchImpl = fakeFetch([tokenRoute, { match: (u) => u.includes('/files/55'), body: evil }]);
  const ir = createImageRelayProvider('ir4', {}, CRED('rt-evil'), fetchImpl);
  await assert.rejects(() => ir.resolveBlob('55', 'download'), /outside allowed hosts/);
});

test('a baseUrl/tokenUrl override off imagerelay.com is refused before anything is sent', async () => {
  const fetchImpl = fakeFetch([tokenRoute, { match: () => true, body: LIST }]);
  const ir = createImageRelayProvider('ir4b', { baseUrl: 'https://imagerelay.com.evil.example/api/v2' }, CRED('rt-base'), fetchImpl);
  await assert.rejects(() => ir.listAssets(), /outside allowed hosts/);
  const tok = createImageRelayProvider('ir4c', { tokenUrl: 'https://evil.example/oauth/token' }, CRED('rt-tok'), fetchImpl);
  await assert.rejects(() => tok.listAssets(), /outside allowed hosts/);
  assert.equal((fetchImpl as unknown as { calls: Call[] }).calls.length, 0, 'neither the credential nor the access token left the process');
});

test('healthCheck: ok on 200; a missing credential fails closed', async () => {
  const ok = createImageRelayProvider('ir5', {}, CRED('rt-h'), fakeFetch([tokenRoute, { match: (u) => u.includes('/files'), body: LIST }]));
  assert.equal((await ok.healthCheck()).ok, true);
  const keyless = createImageRelayProvider('ir6', {}, undefined, fakeFetch([]));
  assert.equal((await keyless.healthCheck()).ok, false);
});
