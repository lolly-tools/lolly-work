// SPDX-License-Identifier: MPL-2.0
/**
 * The edge layer inside the real app: owner-only routes that never echo a
 * credential, a sealed credential checked against the zone before it is kept,
 * operator purges, purges queued when a tool's visibility changes, tags on the
 * public brand answers only, and a public-only hostname that refuses private
 * routes and writes. Provider APIs are a mocked fetch.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { openSecret } from '../server/src/lib/crypto.ts';
import { edgeCredentialContext } from '../server/src/edge/registry.ts';

const BUNNY_KEY = 'fake-bunny-access-key-0001';
const CF_TOKEN = 'fake-cloudflare-token-0002';
const MASTER = 'test-credential-master-secret';
let pack: string, server: Server, base: string, owner: string;
const store = createMemoryStore();
const calls: Array<{ url: string; method: string; body?: unknown }> = [];

const edgeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
  const auth = (init?.headers as Record<string, string>)?.authorization;
  if (url.startsWith('https://api.bunny.net/pullzone/42') && !url.includes('purgeCache')) {
    return Response.json({ OptimizerEnabled: false, EnableSmartCache: false, EnableGeoZoneEU: true, EnableGeoZoneUS: false, EnableGeoZoneASIA: false, EnableGeoZoneSA: false, EnableGeoZoneAF: false,
      CacheControlMaxAgeOverride: -1, CacheErrorResponses: false, EnableCookieVary: false, PermaCacheStorageZoneId: 0, Hostnames: [{ Value: 'work.example.eu' }],
      LogForwardingEnabled: false, LoggingSaveToStorage: false, LoggingIPAnonymizationEnabled: true, ZoneSecurityKey: 'zone-key-never-shown' });
  }
  if (url.startsWith('https://api.bunny.net/')) return new Response(null, { status: 204 });
  if (url.startsWith('https://api.cloudflare.com/client/v4/zones/')) {
    if (auth !== `Bearer ${CF_TOKEN}`) return Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 });
    if (url.endsWith('/purge_cache')) return Response.json({ success: true, result: { id: 'cfpurge1' } });
    if (url.includes('/settings/')) return Response.json({ success: true, result: { value: 'off' } });
    if (url.includes('/rulesets/')) return Response.json({ success: false }, { status: 404 });
    return Response.json({ success: true, result: { name: 'example.eu' } });
  }
  throw new Error(`unexpected request ${url}`);
}) as typeof fetch;

/** node:http rather than fetch, because fetch does not send a custom Host header. */
function call(path: string, init: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<{ status: number; headers: Headers; text: string; json: unknown }> {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: target.hostname, port: target.port, path, method: init.method ?? 'GET',
      headers: { ...(init.host ? { host: init.host } : {}), ...init.headers } }, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        let json: unknown = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode!, headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-edge-app-'));
  const tool = { id: 'swatch', name: 'Swatch', version: '1.0.0', engineVersion: '^1.0.0', status: 'official', render: { width: 10, height: 10, formats: ['svg'] }, inputs: [] };
  await mkdir(join(pack, 'tools', 'swatch'), { recursive: true });
  await writeFile(join(pack, 'tools', 'swatch', 'tool.json'), JSON.stringify(tool));
  await writeFile(join(pack, 'tools', 'swatch', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  for (const dir of ['assets', 'tools', 'og', 'fonts/webfonts']) await mkdir(join(pack, 'catalog', dir), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [tool] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [
    { id: 'fixture/tokens/brand', name: 'Fixture tokens', type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/tokens.json' }] },
  ] }));
  await writeFile(join(pack, 'catalog', 'assets', 'tokens.json'), JSON.stringify({ color: { primary: { $type: 'color', $value: '#123456' } } }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Edge', baseUrl: 'https://work.example.eu', pack },
    rateLimit: { enabled: false }, dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'member@test', groups: [] }] },
    edge: { providers: [
      { id: 'eu-cdn', kind: 'bunny', hostnames: ['work.example.eu'], credentialRef: 'LW_TEST_EDGE_BUNNY_KEY', options: { pullZoneId: 42, regions: ['europe'] }, jurisdiction: { logs: 'eu' } },
      { id: 'cf', kind: 'cloudflare', hostnames: ['assets.example.eu'], publicOnly: true, options: { zoneId: '0123456789abcdef0123456789abcdef', plan: 'pro' } },
    ] },
  }));
  const app = buildApp({ config, store, secrets: { session: 'edge-session', link: 'edge-link', credential: MASTER },
    edgeSecrets: new Map([['eu-cdn', BUNNY_KEY]]), edgeFetch,
    fetchImpl: async () => { throw new Error('no other outbound requests'); } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  owner = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(pack, { recursive: true, force: true }); });

test('edge routes are for owners, and no answer names a credential or its variable', async () => {
  assert.equal((await call('/api/v1/edge')).status, 401);
  const member = (await fetch(`${base}/api/auth/dev?email=member@test`, { redirect: 'manual' })).headers.getSetCookie()[0]!.split(';')[0]!;
  assert.equal((await call('/api/v1/edge', { headers: { cookie: member } })).status, 403);
  const status = await call('/api/v1/edge', { headers: { cookie: owner } });
  assert.equal(status.status, 200);
  assert.match(String(status.headers.get('cache-control')), /private, no-store/);
  const body = status.json as { jurisdiction: string; tagHeaders: string[]; instanceTag: string; providers: Array<{ id: string; credential: { source: string; present: boolean } }> };
  assert.equal(body.jurisdiction, 'eu-only');
  assert.deepEqual(body.tagHeaders, ['cdn-tag', 'cache-tag']);
  assert.match(body.instanceTag, /^o_[0-9a-f]{16}$/);
  assert.deepEqual(body.providers.map(p => [p.id, p.credential.source, p.credential.present]), [['eu-cdn', 'environment', true], ['cf', 'sealed', false]]);
  assert.doesNotMatch(status.text, /LW_TEST_EDGE_BUNNY_KEY|fake-bunny|fake-cloudflare/);
  const verify = await call('/api/v1/edge/providers/eu-cdn/verify', { headers: { cookie: owner } });
  assert.equal(verify.status, 200);
  assert.equal((verify.json as { ok: boolean }).ok, true, verify.text);
  assert.doesNotMatch(verify.text, /zone-key-never-shown|fake-bunny/);
  assert.equal((await call('/api/v1/edge/providers/cf/verify', { headers: { cookie: owner } })).status, 409, 'no credential stored yet');
});

test('a sealed credential is checked against the zone, kept sealed, and shown by fingerprint only', async () => {
  const put = (id: string, secret: string) => call(`/api/v1/edge/providers/${id}/credential`, { method: 'PUT', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ secret }) });
  assert.equal((await put('eu-cdn', 'another-key-123456')).status, 409, 'a credentialRef provider is managed in the environment');
  const wrong = await put('cf', 'wrong-token-1234567');
  assert.equal(wrong.status, 409);
  assert.match(wrong.text, /EDGE_CREDENTIAL_REJECTED/);
  assert.equal(await store.getEdgeCredential('cf'), null, 'a refused credential is not kept');
  const stored = await put('cf', CF_TOKEN);
  assert.equal(stored.status, 200, stored.text);
  assert.doesNotMatch(stored.text, new RegExp(CF_TOKEN));
  const row = await store.getEdgeCredential('cf');
  assert.ok(row);
  assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from(CF_TOKEN)), false, 'stored sealed, not in clear');
  assert.equal(openSecret(row.ciphertext, MASTER, edgeCredentialContext('cf')), CF_TOKEN);
  assert.throws(() => openSecret(row.ciphertext, MASTER, edgeCredentialContext('eu-cdn')), 'a sealed value cannot be replayed into another provider');
  const status = await call('/api/v1/edge', { headers: { cookie: owner } });
  assert.match(status.text, new RegExp(`"fingerprint":"${row.fingerprint}"`));
  assert.doesNotMatch(status.text, new RegExp(CF_TOKEN));
  const audit = JSON.stringify(await store.listAudit());
  assert.match(audit, /edge\.provider\.credential/);
  assert.doesNotMatch(audit, new RegExp(`${CF_TOKEN}|${BUNNY_KEY}`));
});

test('an operator purge and a visibility change queue purges on every provider', async () => {
  const purge = await call('/api/v1/edge/purge', { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify({ tags: ['t_swatch', 'Not A Tag'], urls: ['https://assets.example.eu/api/brand'] }) });
  assert.equal(purge.status, 202, purge.text);
  const queued = purge.json as { queued: Array<{ provider: string; kind: string; items: number }>; refused: string[] };
  assert.deepEqual(queued.queued.map(q => [q.provider, q.kind, q.items]), [['eu-cdn', 'tags', 1], ['cf', 'tags', 1], ['cf', 'urls', 1]]);
  assert.equal(queued.refused.length, 1);
  assert.equal((await call('/api/v1/edge/purge', { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ tags: ['Bad'] }) })).status, 400);

  const overlay = await call('/api/v1/policy/overlays/swatch', { method: 'PUT', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ visibility: { groups: ['brand'] } }) });
  assert.equal(overlay.status, 200, overlay.text);
  await new Promise(resolve => setTimeout(resolve, 50));
  const rows = (await store.listEdgePurges(20)).filter(r => r.reason === 'policy.overlay.edit');
  assert.deepEqual(rows.map(r => [r.providerId, r.kind, r.items]).sort(), [
    ['cf', 'tags', ['t_swatch']], ['cf', 'urls', ['https://assets.example.eu/catalog/og/swatch.png']],
    ['eu-cdn', 'tags', ['t_swatch']], ['eu-cdn', 'urls', ['https://work.example.eu/catalog/og/swatch.png']],
  ]);
});

test('public brand answers carry the tags; a credentialed answer does not', async () => {
  const anonymous = await call('/api/brand');
  assert.equal(anonymous.status, 200, anonymous.text);
  const tags = String(anonymous.headers.get('cdn-tag'));
  assert.match(tags, /^b_[0-9a-f]{16},x_public-revalidate,o_[0-9a-f]{16}$/);
  assert.equal(anonymous.headers.get('cache-tag'), tags);
  assert.equal(anonymous.headers.get('surrogate-key'), null);
  const signedIn = await call('/api/brand', { headers: { cookie: owner } });
  assert.equal(signedIn.headers.get('cdn-tag'), null);
  assert.equal(signedIn.headers.get('cache-tag'), null);
  assert.match(String(signedIn.headers.get('cache-control')), /^private\b/);
});

test('a public-only hostname answers public reads and refuses private routes and writes', async () => {
  const host = 'assets.example.eu';
  const brand = await call('/api/brand', { host, headers: { cookie: owner } });
  assert.equal(brand.status, 200);
  assert.match(String(brand.headers.get('cache-control')), /^public\b/, 'the session cookie is ignored there');
  const session = await call('/api/auth/session', { host, headers: { cookie: owner } });
  assert.equal(session.status, 404);
  assert.match(session.text, /PUBLIC_HOST_ONLY/);
  const edge = await call('/api/v1/edge', { host, headers: { cookie: owner } });
  assert.equal(edge.status, 404, 'an owner route is unreachable through the public hostname, even with a session');
  const write = await call('/api/v1/edge/purge', { host, method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: '{"tags":["t_x"]}' });
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('allow'), 'GET, HEAD');
});
