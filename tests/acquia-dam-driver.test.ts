/**
 * Acquia DAM / Widen driver (plans/27 §9) against a modelled v2 API shape.
 * Injected fetch, no network: bearer auth, mapping (categories → sections,
 * status → approved via approvedStatuses, native release/expiration → the
 * availability window), offset pagination, per-request fresh embed URL, and the
 * host allowlist. Field/endpoint names carry a LIVE-VERIFY caveat in the driver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcquiaDamProvider } from '../server/src/catalog/providers/acquia-dam.ts';

const ASSET_A = {
  id: 'a1b2c3', filename: 'summit-hero.png', status: 'active',
  release_date: '2026-01-01T00:00:00.000Z', expiration_date: '2027-01-01T00:00:00.000Z',
  last_update_date: '2026-06-01T00:00:00.000Z',
  file_properties: { format: 'png', size_in_kbytes: 20 },
  categories: [{ name: 'Web Heroes' }, 'Campaigns'],
};
const ASSET_ARCHIVED = { id: 'z9', filename: 'old.png', status: 'archived', file_properties: { format: 'png' }, categories: [] };
const LIST = { total_count: 2, items: [ASSET_A, ASSET_ARCHIVED] };
const ASSET_DL = { ...ASSET_A, embeds: { original: { url: 'https://embed.widencdn.net/orig/a1b2c3?sig=1' } } };

function fakeFetch(routes: Array<{ match: (url: string) => boolean; body?: unknown; bytes?: string; status?: number }>): typeof fetch {
  const calls: Array<{ url: string; auth: string }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: (init?.headers as Record<string, string>)?.authorization ?? '' });
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes !== undefined) return new Response(route.bytes, { status: route.status ?? 200, headers: { 'content-type': 'image/png' } });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (impl as unknown as { calls: Array<{ url: string; auth: string }> }).calls = calls;
  return impl;
}

test('listAssets maps categories, native availability, status→approved; bearer rides the call', async () => {
  const fetchImpl = fakeFetch([{ match: (u) => u.includes('/assets?'), body: LIST }]);
  const wd = createAcquiaDamProvider('wd1', {}, 'tok', fetchImpl);
  const page = await wd.listAssets();

  const a = page.assets.find((x) => x.remoteId === 'a1b2c3');
  assert.equal(a?.name, 'summit-hero');
  assert.deepEqual(a?.sections, ['Web Heroes', 'Campaigns'], 'categories → sections');
  assert.equal(a?.approved, true, "status 'active' is in approvedStatuses");
  assert.equal(a?.availableFrom, '2026-01-01T00:00:00.000Z', 'release_date → availableFrom (native)');
  assert.equal(a?.availableUntil, '2027-01-01T00:00:00.000Z', 'expiration_date → availableUntil (native)');
  assert.deepEqual(a?.formats, [{ format: 'png', remoteRef: 'original', size: 20480, filename: 'summit-hero.png' }]);

  const archived = page.assets.find((x) => x.remoteId === 'z9');
  assert.equal(archived?.approved, false, "status 'archived' is not approved");

  const calls = (fetchImpl as unknown as { calls: Array<{ url: string; auth: string }> }).calls;
  assert.equal(calls[0]?.auth, 'Bearer tok');
});

test('a configured approvedStatuses set decides approval', async () => {
  const fetchImpl = fakeFetch([{ match: (u) => u.includes('/assets?'), body: LIST }]);
  const wd = createAcquiaDamProvider('wd2', { approvedStatuses: ['active', 'archived'] }, 'tok', fetchImpl);
  const page = await wd.listAssets();
  assert.equal(page.assets.find((x) => x.remoteId === 'z9')?.approved, true, 'archived now counts as approved');
});

test('resolveBlob re-fetches a fresh embed URL and streams from widen hosts only', async () => {
  const fetchImpl = fakeFetch([
    { match: (u) => u.includes('/assets/a1b2c3'), body: ASSET_DL },
    { match: (u) => u.startsWith('https://embed.widencdn.net/'), bytes: 'PNGBYTES' },
  ]);
  const wd = createAcquiaDamProvider('wd3', {}, 'tok', fetchImpl);
  const blob = await wd.resolveBlob('a1b2c3', 'original');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'PNGBYTES');
});

test('a download URL outside widen-owned hosts is refused (no open proxy)', async () => {
  const evil = { ...ASSET_A, embeds: { original: { url: 'https://widencdn.net.evil.example/steal' } } };
  const fetchImpl = fakeFetch([{ match: (u) => u.includes('/assets/a1b2c3'), body: evil }]);
  const wd = createAcquiaDamProvider('wd4', {}, 'tok', fetchImpl);
  await assert.rejects(() => wd.resolveBlob('a1b2c3', 'original'), /outside allowed hosts/);
});

test('healthCheck: ok on 200; a missing credential fails closed', async () => {
  const ok = createAcquiaDamProvider('wd5', {}, 'tok', fakeFetch([{ match: (u) => u.includes('/assets?'), body: LIST }]));
  assert.equal((await ok.healthCheck()).ok, true);
  const keyless = createAcquiaDamProvider('wd6', {}, undefined, fakeFetch([]));
  const h = await keyless.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail ?? '', /credential/);
});
