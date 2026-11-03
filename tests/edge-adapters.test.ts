// SPDX-License-Identifier: MPL-2.0
/**
 * Bunny and Cloudflare adapters against a mocked fetch: the exact requests
 * each API documents, batching, error handling with the credential scrubbed,
 * and the zone findings. No live provider is called and no real credential is
 * used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBunnyAdapter } from '../server/src/edge/bunny.ts';
import { createCloudflareAdapter } from '../server/src/edge/cloudflare.ts';
import { EdgeApiError } from '../server/src/edge/types.ts';

const SECRET = 'fake-edge-credential-0123456789';
interface Call { url: string; method: string; headers: Record<string, string>; body: unknown; redirect: string | undefined }

function mockFetch(answer: (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? 'GET', headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, redirect: init?.redirect };
    calls.push(call);
    const { status = 200, body, headers = {} } = answer(call);
    return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const bunny = (fetchImpl: typeof fetch, regions = true) => createBunnyAdapter({
  id: 'eu-cdn', hostnames: ['work.example.eu'], options: { pullZoneId: 42, ...(regions ? { regions: ['europe'] as ['europe'] } : {}) },
  jurisdiction: { company: 'eu', edgeLocations: regions ? 'eu' : 'global', logs: 'eu' }, credential: SECRET, fetchImpl });
const cloudflare = (fetchImpl: typeof fetch, publicOnly = true) => createCloudflareAdapter({
  id: 'cf', hostnames: ['assets.example.eu'], publicOnly, options: { zoneId: '0123456789abcdef0123456789abcdef' },
  jurisdiction: { company: 'us', edgeLocations: 'global', logs: 'unknown' }, credential: SECRET, fetchImpl });

test('Bunny purges one tag per request with the AccessKey header, and exact URLs', async () => {
  const { fetchImpl, calls } = mockFetch(call => ({ status: call.url.includes('/purgeCache') ? 204 : 200 }));
  const adapter = bunny(fetchImpl);
  assert.equal(adapter.tagHeader, 'CDN-Tag');
  const receipt = await adapter.purgeTags(['b_0123456789abcdef', 't_qr-code', 'b_0123456789abcdef']);
  assert.deepEqual(receipt, { provider: 'eu-cdn', kind: 'tags', items: 2, requests: 2, ids: [] });
  assert.deepEqual(calls.map(c => [c.method, c.url, c.headers.AccessKey, c.body, c.redirect]), [
    ['POST', 'https://api.bunny.net/pullzone/42/purgeCache', SECRET, { CacheTag: 'b_0123456789abcdef' }, 'error'],
    ['POST', 'https://api.bunny.net/pullzone/42/purgeCache', SECRET, { CacheTag: 't_qr-code' }, 'error'],
  ]);
  calls.length = 0;
  await adapter.purgeUrls(['https://work.example.eu/catalog/og/qr-code.png']);
  assert.equal(calls[0]!.url, `https://api.bunny.net/purge?url=${encodeURIComponent('https://work.example.eu/catalog/og/qr-code.png')}&async=false&exactPath=true`);
  assert.equal(calls[0]!.method, 'POST');
});

test('Bunny refuses a wildcard tag, a foreign host and a non-HTTPS URL before any request', async () => {
  const { fetchImpl, calls } = mockFetch(() => ({ status: 204 }));
  const adapter = bunny(fetchImpl);
  for (const attempt of [() => adapter.purgeTags(['b_*']), () => adapter.purgeTags(['Not A Tag']),
    () => adapter.purgeUrls(['https://elsewhere.example/x']), () => adapter.purgeUrls(['http://work.example.eu/x']), () => adapter.purgeUrls(['https://work.example.eu/*'])]) {
    await assert.rejects(attempt(), (error: unknown) => error instanceof EdgeApiError && error.permanent);
  }
  assert.equal(calls.length, 0);
});

test('a provider error carries the status and Retry-After, and never the credential', async () => {
  const { fetchImpl } = mockFetch(() => ({ status: 429, headers: { 'retry-after': '30' }, body: { success: false, errors: [{ code: 1015, message: `rate limited for key ${SECRET}` }] } }));
  await assert.rejects(cloudflare(fetchImpl).purgeTags(['t_qr-code']), (error: unknown) => {
    assert.ok(error instanceof EdgeApiError);
    assert.equal(error.status, 429); assert.equal(error.retryAfterMs, 30_000); assert.equal(error.permanent, false);
    assert.doesNotMatch(error.message, new RegExp(SECRET));
    assert.match(error.message, /1015 rate limited for key \[redacted\]/);
    return true;
  });
  const unreachable = (async () => { throw new Error(`connect ECONNREFUSED with ${SECRET}`); }) as typeof fetch;
  await assert.rejects(bunny(unreachable).purgeTags(['t_qr-code']), (error: unknown) => error instanceof EdgeApiError && !error.message.includes(SECRET) && error.status === null);
  const bad = mockFetch(() => ({ status: 400, body: { success: false, errors: [{ code: 1012, message: 'bad tag' }] } }));
  await assert.rejects(cloudflare(bad.fetchImpl).purgeTags(['t_qr-code']), (error: unknown) => error instanceof EdgeApiError && error.permanent);
});

test('Cloudflare purges tags, files, prefixes and hosts in batches of 100 with a bearer token', async () => {
  let n = 0;
  const { fetchImpl, calls } = mockFetch(() => ({ body: { success: true, errors: [], messages: [], result: { id: `purge${++n}` } } }));
  const adapter = cloudflare(fetchImpl);
  assert.equal(adapter.tagHeader, 'Cache-Tag');
  const tags = Array.from({ length: 150 }, (_, i) => `h_${i.toString(16).padStart(16, '0')}`);
  const receipt = await adapter.purgeTags(tags);
  assert.deepEqual(receipt, { provider: 'cf', kind: 'tags', items: 150, requests: 2, ids: ['purge1', 'purge2'] });
  assert.equal(calls[0]!.url, 'https://api.cloudflare.com/client/v4/zones/0123456789abcdef0123456789abcdef/purge_cache');
  assert.equal(calls[0]!.headers.authorization, `Bearer ${SECRET}`);
  assert.equal((calls[0]!.body as { tags: string[] }).tags.length, 100);
  assert.equal((calls[1]!.body as { tags: string[] }).tags.length, 50);
  calls.length = 0;
  await adapter.purgeUrls(['https://assets.example.eu/catalog/og/qr-code.png']);
  await adapter.purgePrefixes(['assets.example.eu/catalog/og/']);
  await adapter.purgeHosts(['assets.example.eu']);
  assert.deepEqual(calls.map(c => c.body), [
    { files: ['https://assets.example.eu/catalog/og/qr-code.png'] }, { prefixes: ['assets.example.eu/catalog/og/'] }, { hosts: ['assets.example.eu'] },
  ]);
  for (const attempt of [() => adapter.purgeUrls(['https://other.example/x']), () => adapter.purgePrefixes(['https://assets.example.eu/x']),
    () => adapter.purgePrefixes(['other.example/x']), () => adapter.purgeHosts(['other.example'])]) {
    await assert.rejects(attempt(), (error: unknown) => error instanceof EdgeApiError && error.permanent);
  }
  const unsuccessful = mockFetch(() => ({ status: 200, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }));
  await assert.rejects(cloudflare(unsuccessful.fetchImpl).purgeTags(['t_x']), /Authentication error/);
});

const GOOD_ZONE = {
  OptimizerEnabled: false, EnableSmartCache: false, EnableGeoZoneEU: true, EnableGeoZoneUS: false, EnableGeoZoneASIA: false, EnableGeoZoneSA: false, EnableGeoZoneAF: false,
  CacheControlMaxAgeOverride: -1, CacheErrorResponses: false, EnableCookieVary: false, CookieVaryParameters: [], PermaCacheStorageZoneId: 0,
  Hostnames: [{ Value: 'work.example.eu' }, { Value: 'eu-cdn.b-cdn.net', IsSystemHostname: true }],
  LogForwardingEnabled: false, LoggingSaveToStorage: false, LoggingIPAnonymizationEnabled: true, EnableOriginShield: false, EnableWebPVary: false, EnableAvifVary: false,
  ZoneSecurityKey: 'zone-token-key-must-never-appear',
};

test('Bunny verifyZone reads the pull zone and reports each rule, without the zone token key', async () => {
  const good = mockFetch(() => ({ body: GOOD_ZONE }));
  const findings = await bunny(good.fetchImpl).verifyZone();
  assert.equal(good.calls[0]!.url, 'https://api.bunny.net/pullzone/42');
  assert.equal(good.calls[0]!.method, 'GET');
  assert.deepEqual(findings.filter(f => f.status !== 'pass').map(f => f.id), [], JSON.stringify(findings));
  const bad = mockFetch(() => ({ body: { ...GOOD_ZONE, OptimizerEnabled: true, EnableSmartCache: true, EnableGeoZoneUS: true, CacheControlMaxAgeOverride: 86400,
    CacheErrorResponses: true, EnableCookieVary: true, PermaCacheStorageZoneId: 9, Hostnames: [], LogForwardingEnabled: true, EnableWebPVary: true, EnableOriginShield: true, OriginShieldZoneCode: 'IL' } }));
  const found = await bunny(bad.fetchImpl).verifyZone();
  const status = Object.fromEntries(found.map(f => [f.id, f.status]));
  assert.deepEqual(status, {
    'bunny.zone': 'pass', 'bunny.optimizer': 'fail', 'bunny.smart-cache': 'fail', 'bunny.regions': 'fail', 'bunny.cache-time': 'fail',
    'bunny.error-caching': 'fail', 'bunny.cookie-vary': 'warn', 'bunny.perma-cache': 'warn', 'bunny.hostnames': 'warn',
    'bunny.log-forwarding': 'warn', 'bunny.log-storage': 'pass', 'bunny.log-anonymised': 'pass', 'bunny.origin-shield': 'warn', 'bunny.format-vary': 'warn',
  });
  for (const list of [findings, found]) assert.doesNotMatch(JSON.stringify(list), /zone-token-key-must-never-appear|fake-edge-credential/);
  const unrestricted = await bunny(good.fetchImpl, false).verifyZone();
  assert.equal(unrestricted.find(f => f.id === 'bunny.regions')?.status, 'info');
  const missing = mockFetch(() => ({ status: 404, body: { Message: 'not found' } }));
  assert.deepEqual((await bunny(missing.fetchImpl).verifyZone()).map(f => [f.id, f.status]), [['bunny.zone', 'fail']]);
  const silent = mockFetch(() => ({ body: { ...GOOD_ZONE, OptimizerEnabled: undefined } }));
  assert.equal((await bunny(silent.fetchImpl).verifyZone()).find(f => f.id === 'bunny.optimizer')?.status, 'warn', 'an unreported setting is never a pass');
});

function cloudflareZone(settings: Record<string, unknown>, rules: { status: number; body?: unknown }, name = 'example.eu') {
  return mockFetch(call => {
    const path = call.url.replace('https://api.cloudflare.com/client/v4/zones/0123456789abcdef0123456789abcdef', '');
    if (path === '') return { body: { success: true, result: { name } } };
    const setting = /^\/settings\/([a-z_]+)$/.exec(path)?.[1];
    if (setting) return setting in settings ? { body: { success: true, result: { id: setting, value: settings[setting] } } } : { status: 404, body: { success: false, errors: [{ code: 1003, message: 'unknown setting' }] } };
    if (path === '/rulesets/phases/http_request_cache_settings/entrypoint') return rules;
    return { status: 500 };
  });
}
const OFF = { polish: 'off', mirage: 'off', rocket_loader: 'off', email_obfuscation: 'off', image_resizing: 'off', transformations: 'off', automatic_https_rewrites: 'off', always_online: 'off' };

test('Cloudflare verifyZone requires every rewriting feature off and no rule overriding origin cache times', async () => {
  const good = cloudflareZone(OFF, { status: 404, body: { success: false } });
  const findings = await cloudflare(good.fetchImpl).verifyZone();
  assert.deepEqual(findings.filter(f => f.status === 'fail' || f.status === 'warn'), []);
  assert.ok(good.calls.every(c => c.method === 'GET' && c.headers.authorization === `Bearer ${SECRET}` && c.redirect === 'error'), 'verifyZone only reads');
  assert.ok(findings.some(f => f.id === 'cloudflare.max-cacheable' && /512 MB/.test(f.message)));

  const { mirage: _gone, transformations: _unread, ...partial } = OFF;
  const bad = cloudflareZone({ ...partial, polish: 'lossy', rocket_loader: 'on', image_resizing: 'open', email_obfuscation: 'on' },
    { status: 200, body: { success: true, result: { rules: [
      { enabled: true, action: 'set_cache_settings', expression: 'true', action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 86400 } } },
      { enabled: false, action: 'set_cache_settings', expression: 'true', action_parameters: { edge_ttl: { mode: 'override_origin' } } },
      { enabled: true, action: 'set_cache_settings', expression: 'true', action_parameters: { browser_ttl: { mode: 'override_origin', default: 60 } } },
    ] } } }, 'other.example');
  const status = Object.fromEntries((await cloudflare(bad.fetchImpl, false).verifyZone()).map(f => [f.id, f.status]));
  assert.deepEqual(status, {
    'cloudflare.zone': 'warn', 'cloudflare.polish': 'fail', 'cloudflare.mirage': 'pass', 'cloudflare.rocket-loader': 'fail', 'cloudflare.email-obfuscation': 'fail',
    'cloudflare.image-resizing': 'fail', 'cloudflare.transformations': 'warn', 'cloudflare.automatic-https-rewrites': 'pass', 'cloudflare.always-online': 'pass',
    'cloudflare.cache-rules': 'fail', 'cloudflare.browser-ttl': 'warn', 'cloudflare.max-cacheable': 'info',
  });
  const publicOnly = Object.fromEntries((await cloudflare(bad.fetchImpl, true).verifyZone()).map(f => [f.id, f.status]));
  assert.equal(publicOnly['cloudflare.cache-rules'], 'warn', 'a public-only hostname answers private routes with a refusal, so an override is a warning there');
  const denied = mockFetch(() => ({ status: 403, body: { success: false, errors: [{ code: 9109, message: 'Unauthorized' }] } }));
  assert.deepEqual((await cloudflare(denied.fetchImpl).verifyZone()).map(f => [f.id, f.status]), [['cloudflare.zone', 'fail']]);
});
