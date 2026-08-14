/**
 * IntelligenceBank driver (plans/27 §9) against a modelled v3 API shape. Injected
 * fetch, no network: the login handshake (discovers the per-tenant apiV3url +
 * sid), sid on every v3 call, mapping (folder/category → sections, workflow state
 * → approved via approvedStates, native publish/expiry → the availability
 * window), per-request fresh download URL, and host-pinning of BOTH the
 * discovered apiV3url and downloads to the intelligencebank.com family. Field/
 * endpoint names carry a LIVE-VERIFY caveat in the driver.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntelligenceBankProvider } from '../server/src/catalog/providers/intelligencebank.ts';

const PLATFORM = 'https://acme.intelligencebank.com';
const LOGIN = { sid: 'sid-123', apiV3url: 'https://api.intelligencebank.com/v3', clientid: 'cl1', expires_in: 3600 };
const RES_A = {
  resourceid: 'r1', filename: 'brand-hero.png', extension: 'png', size: 4096, updated: '2026-06-01T00:00:00.000Z',
  folder: { id: 'f1', name: 'Brand' }, category: 'Heroes', workflow_state: 'Approved',
  publish_date: '2026-01-01T00:00:00.000Z', expiry_date: '2027-01-01T00:00:00.000Z',
};
const RES_DRAFT = { resourceid: 'r2', filename: 'draft.png', extension: 'png', workflow_state: 'Draft', folder: null };
const LIST = { resources: [RES_A, RES_DRAFT], meta: { next_page: null } };
const RES_DL = { resource: { ...RES_A, download_url: 'https://cdn.intelligencebank.com/d/r1?sig=x' } };

interface Call { url: string; method: string; sid: string }
function fakeFetch(routes: Array<{ match: (url: string, method: string) => boolean; body?: unknown; bytes?: string; status?: number }>): typeof fetch {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = (init?.headers as Record<string, string>) ?? {};
    calls.push({ url, method: init?.method ?? 'GET', sid: h.sid ?? '' });
    const route = routes.find((r) => r.match(url, init?.method ?? 'GET'));
    if (!route) return new Response('not found', { status: 404 });
    if (route.bytes !== undefined) return new Response(route.bytes, { status: route.status ?? 200, headers: { 'content-type': 'image/png' } });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  (impl as unknown as { calls: Call[] }).calls = calls;
  return impl;
}
const loginRoute = { match: (u: string, m: string) => m === 'POST' && u.includes('/authenticate'), body: LOGIN };

test('login handshake discovers apiV3url; the sid rides v3 calls; native governance maps', async () => {
  const fetchImpl = fakeFetch([loginRoute, { match: (u) => u.includes('/v3/resources'), body: LIST }]);
  const ib = createIntelligenceBankProvider('ib1', { platformUrl: PLATFORM, approvedStates: ['Approved', 'Published'] }, 'apikey', fetchImpl);
  const page = await ib.listAssets();

  const a = page.assets.find((x) => x.remoteId === 'r1');
  assert.equal(a?.name, 'brand-hero');
  assert.deepEqual(a?.sections, ['Brand', 'Heroes'], 'folder + category → sections');
  assert.equal(a?.approved, true, "workflow state 'Approved' ∈ approvedStates");
  assert.equal(a?.availableFrom, '2026-01-01T00:00:00.000Z', 'publish_date → availableFrom (native)');
  assert.equal(a?.availableUntil, '2027-01-01T00:00:00.000Z', 'expiry_date → availableUntil (native)');
  assert.deepEqual(a?.formats, [{ format: 'png', remoteRef: 'download', size: 4096, filename: 'brand-hero.png' }]);
  assert.equal(page.assets.find((x) => x.remoteId === 'r2')?.approved, false, "'Draft' is not an approved state");

  const calls = (fetchImpl as unknown as { calls: Call[] }).calls;
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.includes('/authenticate')), 'login handshake happened');
  const v3 = calls.find((c) => c.url.includes('/v3/resources'));
  assert.ok(v3?.url.startsWith('https://api.intelligencebank.com/v3'), 'v3 call goes to the DISCOVERED apiV3url');
  assert.equal(v3?.sid, 'sid-123', 'the discovered sid authorises the v3 call');
});

test('with no approvedStates, approval is unfiltered', async () => {
  const fetchImpl = fakeFetch([loginRoute, { match: (u) => u.includes('/v3/resources'), body: LIST }]);
  const ib = createIntelligenceBankProvider('ib2', { platformUrl: PLATFORM }, 'apikey', fetchImpl);
  const page = await ib.listAssets();
  assert.equal(page.assets.find((x) => x.remoteId === 'r2')?.approved, true, 'draft passes when no approved-state set is configured');
});

test('resolveBlob re-fetches a fresh download URL and streams from intelligencebank hosts only', async () => {
  const fetchImpl = fakeFetch([
    loginRoute,
    { match: (u) => u.includes('/v3/resource/r1'), body: RES_DL },
    { match: (u) => u.startsWith('https://cdn.intelligencebank.com/'), bytes: 'PNGBYTES' },
  ]);
  const ib = createIntelligenceBankProvider('ib3', { platformUrl: PLATFORM }, 'apikey', fetchImpl);
  const blob = await ib.resolveBlob('r1', 'download');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') assert.equal(await new Response(blob.body).text(), 'PNGBYTES');
});

test('a login response pointing apiV3url off intelligencebank.com is refused (no redirect hijack)', async () => {
  const evilLogin = { sid: 'x', apiV3url: 'https://intelligencebank.com.evil.example/v3' };
  const fetchImpl = fakeFetch([{ match: (u, m) => m === 'POST' && u.includes('/authenticate'), body: evilLogin }]);
  const ib = createIntelligenceBankProvider('ib4', { platformUrl: PLATFORM }, 'apikey', fetchImpl);
  await assert.rejects(() => ib.listAssets(), /outside intelligencebank\.com/);
});

test('a download URL outside intelligencebank hosts is refused (no open proxy)', async () => {
  const evil = { resource: { ...RES_A, download_url: 'https://intelligencebank.com.evil.example/steal' } };
  const fetchImpl = fakeFetch([loginRoute, { match: (u) => u.includes('/v3/resource/r1'), body: evil }]);
  const ib = createIntelligenceBankProvider('ib5', { platformUrl: PLATFORM }, 'apikey', fetchImpl);
  await assert.rejects(() => ib.resolveBlob('r1', 'download'), /outside allowed hosts/);
});

test('healthCheck: ok on 200; a missing credential fails closed', async () => {
  const ok = createIntelligenceBankProvider('ib6', { platformUrl: PLATFORM }, 'apikey', fakeFetch([loginRoute, { match: (u) => u.includes('/v3/resources'), body: LIST }]));
  assert.equal((await ok.healthCheck()).ok, true);
  const keyless = createIntelligenceBankProvider('ib7', { platformUrl: PLATFORM }, undefined, fakeFetch([]));
  assert.equal((await keyless.healthCheck()).ok, false);
});
