// SPDX-License-Identifier: MPL-2.0
/**
 * Route conformance over the real app router (plan 80 E0a). Every GET and HEAD
 * route has a delivery class, and the reviewed tables below say which routes
 * leave the person-private default. One sample per route, anonymous and signed
 * in, is then compared with cachePolicy for the class the response was served
 * under, and every public answer is asked again with each kind of credential.
 * A second app, open to anonymous readers, hosts the connect pack. Every
 * per-response class in the table has to be reached by some sample.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cachePolicy, type CachePolicyOptions, type DeliveryClass } from '@lolly-tools/core/delivery-v1';
import { parseConfig } from '../server/src/config/instance.ts';
import { appRouteDescriptions, buildApp } from '../server/src/api/app.ts';
import { deliveryClassOf, deliveryOptionsOf, SERVICE_WORKER_CACHE_CONTROL, type RouteDescription } from '../server/src/api/router.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';

const CLASSES: DeliveryClass[] = ['public-immutable', 'public-revalidate', 'public-bounded', 'link', 'instance-private', 'person-private'];
const PRIVATE = cachePolicy('person-private').cacheControl;

/** Every GET and HEAD route whose router class is not person-private. A new
 *  public or shared route, or a changed class, is a reviewed edit here. */
const ROUTE_CLASSES: Record<string, DeliveryClass> = {
  'GET /': 'public-revalidate',
  'GET /*': 'public-revalidate',
  'HEAD /*': 'public-revalidate',
  'GET /api/brand': 'public-revalidate',
  'GET /api/brand/auth.css': 'public-revalidate',
  'GET /api/brand/font/:file': 'public-revalidate',
  'GET /api/brand/logo/:variant': 'public-revalidate',
  'GET /api/brand/r/:revision/font/:file': 'public-immutable',
  'GET /api/brand/r/:revision/logo/:variant': 'public-immutable',
  'HEAD /api/brand': 'public-revalidate',
  'HEAD /api/brand/auth.css': 'public-revalidate',
  'HEAD /api/brand/font/:file': 'public-revalidate',
  'HEAD /api/brand/logo/:variant': 'public-revalidate',
  'HEAD /api/brand/r/:revision/font/:file': 'public-immutable',
  'HEAD /api/brand/r/:revision/logo/:variant': 'public-immutable',
  'GET /catalog/*': 'instance-private',
  'HEAD /catalog/*': 'instance-private',
  'HEAD /catalog/fonts/*': 'instance-private',
  'GET /connect/:file': 'instance-private',
  'HEAD /connect/:file': 'instance-private',
  'GET /connect/pack.lolly': 'instance-private',
  'HEAD /connect/pack.lolly': 'instance-private',
  'GET /render/:spec': 'instance-private',
  'GET /tools/*': 'instance-private',
  'HEAD /tools/*': 'instance-private',
};

/** Classes a handler may choose for one response with setDeliveryClass, by
 *  route. Person-private is always allowed, because nothing is stricter. */
const RESPONSE_CLASSES: Record<string, DeliveryClass[]> = {
  'GET /*': ['public-immutable'],
  'HEAD /*': ['public-immutable'],
  'GET /catalog/*': ['public-bounded'],
  'HEAD /catalog/*': ['public-bounded'],
  'GET /connect/:file': ['public-immutable'],
  'HEAD /connect/:file': ['public-immutable'],
  'GET /l/:id': ['link'],
  // The bare /tools is the shell's gallery page, which this route hands to the shell.
  'GET /tools/*': ['public-revalidate'],
  'HEAD /tools/*': ['public-revalidate'],
};

/** Routes that still take the person-private default instead of naming a
 *  class. The list only shrinks: a new GET or HEAD route names its class. */
const UNDECLARED = [
  'GET /activate',
  'GET /admin',
  'GET /admin/*',
  'GET /api/auth/callback',
  'GET /api/auth/config',
  'GET /api/auth/dev',
  'GET /api/auth/link',
  'GET /api/auth/login',
  'GET /api/auth/logout-provider',
  'GET /api/auth/passkeys/client.js',
  'GET /api/auth/passkeys/login',
  'GET /api/auth/password/set',
  'GET /api/auth/provider-oauth/callback',
  'GET /api/auth/proxy',
  'GET /api/auth/security',
  'GET /api/auth/session',
  'GET /api/v1/access-requests',
  'GET /api/v1/access-requests/mine',
  'GET /api/v1/activity',
  'GET /api/v1/agents/activity',
  'GET /api/v1/approvals',
  'GET /api/v1/approvals/approvers',
  'GET /api/v1/audit',
  'GET /api/v1/audit/head',
  'GET /api/v1/auth/device/pending',
  'GET /api/v1/brand/profiles',
  'GET /api/v1/brand/rules',
  'GET /api/v1/catalog/assets',
  'GET /api/v1/catalog/assets/*',
  'GET /api/v1/catalog/collections',
  'GET /api/v1/catalog/collections/:id',
  'GET /api/v1/catalog/fields',
  'GET /api/v1/catalog/lifecycle',
  'GET /api/v1/catalog/providers',
  'GET /api/v1/catalog/providers/:id',
  'GET /api/v1/catalog/providers/:id/drift',
  'GET /api/v1/catalog/providers/:id/health',
  'GET /api/v1/catalog/providers/setup',
  'GET /api/v1/catalog/search',
  'GET /api/v1/catalog/sources',
  'GET /api/v1/catalog/submissions',
  'GET /api/v1/catalog/submissions/:id/bytes',
  'GET /api/v1/catalog/tags',
  'GET /api/v1/chains',
  'GET /api/v1/collab/invitees',
  'GET /api/v1/collab/nearby',
  'GET /api/v1/collab/rooms',
  'GET /api/v1/config/export',
  'GET /api/v1/deliveries',
  'GET /api/v1/deliveries/:id',
  'GET /api/v1/destinations',
  'GET /api/v1/docs',
  'GET /api/v1/docs/:slug',
  'GET /api/v1/docs/img/:file',
  'GET /api/v1/docs/shots/:file',
  'GET /api/v1/docs/shots/:file/cred',
  'GET /api/v1/fleet',
  'GET /api/v1/fleet/installs',
  'GET /api/v1/grants',
  'GET /api/v1/groups',
  'GET /api/v1/inbox',
  'GET /api/v1/injectables',
  'GET /api/v1/instance',
  'GET /api/v1/instance-pack',
  'GET /api/v1/invitations',
  'GET /api/v1/jobs',
  'GET /api/v1/jobs/:id',
  'GET /api/v1/jobs/:id/result',
  'GET /api/v1/links',
  'GET /api/v1/me/identities',
  'GET /api/v1/messages',
  'GET /api/v1/org-config',
  'GET /api/v1/org-config/preview',
  'GET /api/v1/policy/ai',
  'GET /api/v1/policy/flags',
  'GET /api/v1/policy/tools',
  'GET /api/v1/projects',
  'GET /api/v1/projects/:id/agents',
  'GET /api/v1/projects/:id/files',
  'GET /api/v1/projects/:id/files/:fileId',
  'GET /api/v1/projects/:id/folders',
  'GET /api/v1/projects/:id/invite-links',
  'GET /api/v1/projects/:id/members',
  'GET /api/v1/projects/:id/presence',
  'GET /api/v1/projects/:id/sessions',
  'GET /api/v1/projects/:id/sharing',
  'GET /api/v1/projects/:id/transfer-inventory',
  'GET /api/v1/render-batches',
  'GET /api/v1/render-batches/:id',
  'GET /api/v1/render-batches/:id/manifest',
  'GET /api/v1/renders',
  'GET /api/v1/renders/:id',
  'GET /api/v1/renders/:id/evidence',
  'GET /api/v1/renders/:id/output/:name',
  'GET /api/v1/schema/:toolId',
  'GET /api/v1/scim/tokens',
  'GET /api/v1/sessions/:id',
  'GET /api/v1/sessions/:id/agents',
  'GET /api/v1/sessions/:id/comment-people',
  'GET /api/v1/sessions/:id/comments',
  'GET /api/v1/sessions/:id/comments/:threadId',
  'GET /api/v1/sessions/:id/revisions',
  'GET /api/v1/sessions/:id/versions',
  'GET /api/v1/sessions/:id/versions/:versionId',
  'GET /api/v1/share-groups',
  'GET /api/v1/share-groups/:id',
  'GET /api/v1/share-groups/people',
  'GET /api/v1/stats/overview',
  'GET /api/v1/stats/series',
  'GET /api/v1/system/migrations',
  'GET /api/v1/system/setup',
  'GET /api/v1/system/setup/configuration',
  'GET /api/v1/system/setup/tools/:id',
  'GET /api/v1/telemetry/summary',
  'GET /api/v1/tokens',
  'GET /api/v1/users',
  'GET /api/v1/users/:id',
  'GET /api/v1/users/:id/erasure-preview',
  'GET /api/v1/users/:id/identities',
  'GET /api/v1/users/:id/offboarding-preview',
  'GET /api/v1/users/:id/subject-export',
  'GET /api/workspace/mcp',
  'GET /healthz',
  'GET /info/media/agent-collaboration-review.mp4',
  'GET /l/:id',
  'GET /l/invite/:token',
  'GET /l/join/:id',
  'GET /metrics',
  'GET /readyz',
  'GET /scim/v2/Groups',
  'GET /scim/v2/Groups/:name',
  'GET /scim/v2/ServiceProviderConfig',
  'GET /scim/v2/Users',
  'GET /scim/v2/Users/:id',
];

/** One request of each credential kind the anonymous rule names. */
const CREDENTIALS: Array<Record<string, string>> = [
  { cookie: 'unrelated=1' }, { authorization: 'Bearer lwa_conformance' }, { 'x-lw-render-read': 'conformance' },
  { 'x-lw-device': 'conformance' }, { 'x-lolly-client': 'web/1.0.0 install/conformance' },
];

interface Sample { status: number; headers: IncomingHttpHeaders; served: { delivery: DeliveryClass; options: CachePolicyOptions } }
type Expected = [key: string, path: string, headers: Record<string, string>, delivery: DeliveryClass, status: number];
let pack: string, shell: string, seed: string, server: Server, port: number, openServer: Server, openPort: number;
let owner: string, revision: string, shareLink: string, packChecksum: string;
let routes: RouteDescription[] = [];
let served: ServerResponse | undefined;
/** Each route and the class a sample of it was served under, as 'GET /path public-immutable'. */
const reached = new Set<string>();

function routeOf(key: string): RouteDescription {
  const route = routes.find(candidate => `${candidate.method} ${candidate.path}` === key);
  assert.ok(route, `${key} is not registered`);
  return route;
}

/** Requests run one at a time, so the last response a server saw is this one. */
function sample(route: RouteDescription, path: string, headers: Record<string, string> = {}, at = port): Promise<Sample> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: at, path, method: route.method, headers: { 'accept-encoding': 'identity', ...headers } }, res => {
      res.resume();
      res.on('end', () => {
        // Refusals are always private, so only an answer below 400 shows a class in use.
        const delivery = deliveryClassOf(served!);
        if (res.statusCode! < 400) reached.add(`${route.method} ${route.path} ${delivery}`);
        resolve({ status: res.statusCode!, headers: res.headers, served: { delivery, options: deliveryOptionsOf(served!) } });
      });
    });
    req.on('error', reject); req.end();
  });
}

/** Fills each parameter with a value that reaches a real answer where the fixture has one. */
function samplePath(route: RouteDescription): string {
  const wildcard: Record<string, string> = { '/tools/*': 'swatch/tool.json', '/catalog/*': 'tools/index.json', '/catalog/fonts/*': 'webfonts/Brand.woff2' };
  return route.path.split('/').map(segment => {
    if (segment === '*') return wildcard[route.path] ?? 'sample';
    if (!segment.startsWith(':')) return segment;
    const name = segment.slice(1);
    if (name === 'variant') return 'light';
    if (name === 'revision') return revision;
    if (name === 'spec') return 'swatch.svg';
    if (name === 'toolId' || route.path === '/api/v1/system/setup/tools/:id') return 'swatch';
    if (name === 'file' && route.path.includes('/font/')) return 'Brand.woff2';
    return 'sample';
  }).join('/');
}

function conforms(where: string, route: RouteDescription, path: string, res: Sample, credentialed: boolean): void {
  const key = `${route.method} ${route.path}`, { delivery, options } = res.served;
  const label = `${where} ${route.method} ${path} via ${route.path} (${res.status}, served as ${delivery})`;
  if (delivery !== route.delivery) assert.ok(delivery === 'person-private' || RESPONSE_CLASSES[key]?.includes(delivery), `${label}: not a reviewed class for this route`);
  const control = String(res.headers['cache-control'] ?? ''), cdn = res.headers['cdn-cache-control'], surrogate = res.headers['surrogate-control'];
  const policy = cachePolicy(delivery, { ...options, status: res.status }), shared = /^public\b/.test(control);
  assert.match(control, /\bno-transform\b/, `${label}: Cache-Control lacks no-transform`);
  assert.doesNotMatch(String(res.headers.vary ?? ''), /\bcookie\b/i, `${label}: varies on Cookie`);
  if (!shared) {
    assert.equal(cdn, 'no-store', `${label}: a private answer must tell every CDN layer no-store`);
    assert.equal(surrogate, undefined, `${label}: a private answer must not carry Surrogate-Control`);
  }
  if (res.status >= 400 || delivery === 'person-private' || res.headers['set-cookie']) {
    assert.equal(control, PRIVATE, `${label}: expected ${PRIVATE}`);
    return;
  }
  // The anonymous rule asks only that a credentialed answer stays out of shared caches.
  if (credentialed && delivery.startsWith('public-')) {
    assert.match(control, /^private\b/, `${label}: answered ${control}, expected a private answer`);
    return;
  }
  if (!delivery.startsWith('public-')) {
    assert.ok(!shared, `${label}: answered ${control} to a request its class keeps private`);
    assert.ok(control === policy.cacheControl || /^private, no-store\b/.test(control), `${label}: answered ${control}, expected ${policy.cacheControl}`);
    return;
  }
  // A redirect states its own age; the class policy covers stored representations.
  if (res.status >= 300 && res.status !== 304) return;
  if (path === '/sw.js') {
    assert.equal(control, SERVICE_WORKER_CACHE_CONTROL, `${label}: the service worker always revalidates`);
    return;
  }
  assert.deepEqual({ control, cdn, surrogate }, { control: policy.cacheControl, cdn: policy.cdnCacheControl, surrogate: policy.surrogateControl }, `${label}: differs from cachePolicy`);
}

/** Each sample answers its status and class, an anonymous public answer is
 *  shared, and the same request with any credential stays private. */
async function expectSamples(samples: Expected[], at = port): Promise<void> {
  for (const [key, path, headers, delivery, status] of samples) {
    const route = routeOf(key), res = await sample(route, path, headers, at);
    assert.equal(res.status, status, `${key} ${path}`);
    assert.equal(res.served.delivery, delivery, `${key} ${path} served as ${res.served.delivery}`);
    conforms('anonymous', route, path, res, false);
    if (delivery.startsWith('public-') && path !== '/sw.js') assert.match(String(res.headers['cache-control']), /^public\b/, `${key} ${path} is not shared`);
    for (const credential of [...CREDENTIALS, { cookie: owner }]) {
      const again = await sample(route, path, { ...headers, ...credential }, at);
      conforms(`with ${Object.keys(credential)[0]}`, route, path, again, true);
    }
  }
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-route-conformance-pack-')); shell = await mkdtemp(join(tmpdir(), 'lw-route-conformance-shell-'));
  const tool = { id: 'swatch', name: 'Swatch', version: '1.0.0', engineVersion: '^1.0.0', status: 'official', render: { width: 10, height: 10, formats: ['svg'] }, inputs: [] };
  await mkdir(join(pack, 'tools', 'swatch'), { recursive: true });
  await writeFile(join(pack, 'tools', 'swatch', 'tool.json'), JSON.stringify(tool));
  await writeFile(join(pack, 'tools', 'swatch', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#123456"/></svg>');
  for (const dir of ['assets', 'tools', 'og', 'fonts/webfonts']) await mkdir(join(pack, 'catalog', dir), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [tool] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [
    { id: 'fixture/tokens/brand', name: 'Fixture tokens', type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/tokens.json' }] },
    ...['light', 'dark'].map(theme => ({ id: `fixture/logo/${theme}`, type: 'vector', tags: ['logo', 'horizontal', `on-${theme}`], formats: [{ format: 'svg', url: `/catalog/assets/${theme}.svg` }] })),
  ] }));
  const tokens = JSON.stringify({ color: { primary: { $type: 'color', $value: '#123456' } } });
  await writeFile(join(pack, 'catalog', 'assets', 'tokens.json'), tokens);
  for (const theme of ['light', 'dark']) await writeFile(join(pack, 'catalog', 'assets', `${theme}.svg`), `<svg xmlns="http://www.w3.org/2000/svg"><title>${theme}</title></svg>`);
  await writeFile(join(pack, 'catalog', 'fonts', 'webfonts', 'Brand.woff2'), 'font bytes');
  await writeFile(join(pack, 'catalog', 'og', 'swatch.png'), 'card bytes');
  await mkdir(join(shell, '_app'));
  for (const [name, body] of [['index.html', '<!doctype html><title>Shell</title>'], ['sw.js', 'self.addEventListener("fetch", () => {});'],
    ['precache.json', '[]'], ['manifest.webmanifest', '{}'], ['_app/chunk.0123456789abcdef.js', 'export {};']]) await writeFile(join(shell, name!), body!);
  const config = parseConfig(JSON.stringify({ instance: { name: 'Conformance', baseUrl: 'http://localhost', pack, shellDir: shell },
    rateLimit: { enabled: false }, dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] } }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'conformance-session', link: 'conformance-link' },
    fetchImpl: async () => { throw new Error('the conformance test makes no outbound requests'); } });
  routes = appRouteDescriptions(app).filter(route => route.method === 'GET' || route.method === 'HEAD');
  server = createServer((req, res) => { served = res; void app(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); port = address.port;
  const login = await fetch(`http://127.0.0.1:${port}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  owner = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  const brand = await (await fetch(`http://127.0.0.1:${port}/api/brand`)).json() as { fontsBase: string };
  revision = /^\/api\/brand\/r\/([0-9a-f]{64})\/font\/$/.exec(brand.fontsBase)![1]!;
  const minted = await fetch(`http://127.0.0.1:${port}/api/v1/links`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'share', target: { toolId: 'swatch', format: 'svg' } }) });
  assert.equal(minted.status, 201);
  const url = new URL((await minted.json() as { url: string }).url);
  shareLink = url.pathname + url.search;

  // An open instance seeds its connect pack from a file, so the hashed pack URL answers anonymously.
  seed = await mkdtemp(join(tmpdir(), 'lw-route-conformance-seed-'));
  const zip = new ZipBuilder(new Date('2026-10-16T00:00:00Z'));
  const entries = { 'manifest.json': JSON.stringify({ format: 'lolly-brand', formatVersion: 3 }),
    'instance.json': JSON.stringify({ kind: 'instance', name: 'Conformance', instance: 'http://localhost' }), 'tokens.json': tokens, 'pack.sig': 'sig-bytes' };
  const packed = Buffer.concat([...Object.entries(entries).map(([name, body]) => zip.add(name, Buffer.from(body))), zip.end()]);
  packChecksum = createHash('sha256').update(packed).digest('hex');
  await writeFile(join(seed, 'connect.lolly'), packed);
  const openConfig = parseConfig(JSON.stringify({ instance: { name: 'Conformance', baseUrl: 'http://localhost', pack, connectPack: join(seed, 'connect.lolly') },
    rateLimit: { enabled: false }, policy: { defaultAccessMode: 'open' }, dev: { enabled: true } }));
  const openApp = buildApp({ config: openConfig, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 'conformance-open', link: 'conformance-open-link' },
    fetchImpl: async () => { throw new Error('the conformance test makes no outbound requests'); } });
  openServer = createServer((req, res) => { served = res; void openApp(req, res); });
  await new Promise<void>(resolve => openServer.listen(0, '127.0.0.1', resolve));
  const openAddress = openServer.address(); assert.ok(openAddress && typeof openAddress === 'object'); openPort = openAddress.port;
});
after(async () => {
  await Promise.all([server, openServer].map(listening => new Promise<void>(resolve => listening.close(() => resolve()))));
  await Promise.all([pack, shell, seed].map(dir => rm(dir, { recursive: true, force: true })));
});

test('every GET and HEAD route has a reviewed delivery class, brand chrome included', () => {
  const keys = routes.map(route => `${route.method} ${route.path}`);
  assert.equal(new Set(keys).size, keys.length, 'a GET or HEAD pattern is registered twice');
  for (const route of routes) assert.ok(CLASSES.includes(route.delivery), `${route.method} ${route.path} has unknown class ${route.delivery}`);
  const classified = Object.fromEntries(routes.filter(route => route.delivery !== 'person-private').map(route => [`${route.method} ${route.path}`, route.delivery]));
  assert.deepEqual(classified, ROUTE_CLASSES, 'the routes that leave person-private changed; review the class and update ROUTE_CLASSES');
  const added = routes.filter(route => !route.declared).map(route => `${route.method} ${route.path}`).filter(key => !UNDECLARED.includes(key));
  assert.deepEqual(added, [], 'name a delivery class for each new GET or HEAD route: router.add(method, path, handler, { delivery })');
  const settled = UNDECLARED.filter(key => !routes.some(route => !route.declared && `${route.method} ${route.path}` === key));
  assert.deepEqual(settled, [], 'these routes now name a class or are gone; remove them from UNDECLARED');
  for (const route of routes) {
    const pair = routes.find(other => other.path === route.path && other.method !== route.method);
    if (pair) assert.equal(route.delivery, pair.delivery, `GET and HEAD ${route.path} disagree`);
  }
});

test('one sample per route, anonymous and signed in, answers cachePolicy for its class', async () => {
  // Signing out could end the owner's session, so that route runs last.
  const ordered = [...routes].sort((a, b) => Number(a.path.includes('logout')) - Number(b.path.includes('logout')));
  const statuses = new Set<number>();
  for (const route of ordered) {
    const path = samplePath(route), anonymous = await sample(route, path);
    conforms('anonymous', route, path, anonymous, false);
    const member = await sample(route, path, { cookie: owner });
    conforms('signed-in', route, path, member, true);
    statuses.add(anonymous.status).add(member.status);
  }
  // The samples reach real answers, not only refusals.
  assert.ok([200, 401, 404].every(status => statuses.has(status)), `statuses seen: ${[...statuses].sort().join(', ')}`);
});

test('public, link, dynamic and conditional samples match cachePolicy, and any credential keeps them private', async () => {
  const logo = `/api/brand/r/${revision}/logo/light`, fresh = await sample(routeOf('GET /api/brand/r/:revision/logo/:variant'), logo);
  assert.equal(fresh.status, 200);
  await expectSamples([
    ['GET /l/:id', shareLink, {}, 'link', 200],
    ['GET /api/brand', '/api/brand', {}, 'public-revalidate', 200],
    ['GET /api/brand/auth.css', '/api/brand/auth.css', {}, 'public-revalidate', 200],
    ['HEAD /api/brand/logo/:variant', '/api/brand/logo/dark', {}, 'public-revalidate', 200],
    ['GET /api/brand/font/:file', '/api/brand/font/Brand.woff2', {}, 'public-revalidate', 200],
    ['GET /api/brand/r/:revision/logo/:variant', logo, {}, 'public-immutable', 200],
    ['GET /api/brand/r/:revision/logo/:variant', logo, { 'if-none-match': String(fresh.headers.etag) }, 'public-immutable', 304],
    ['HEAD /api/brand/r/:revision/font/:file', `/api/brand/r/${revision}/font/Brand.woff2`, {}, 'public-immutable', 200],
    ['GET /', '/', {}, 'public-revalidate', 200],
    ['GET /*', '/tool/swatch', {}, 'public-revalidate', 200],
    ['GET /*', '/_app/chunk.0123456789abcdef.js', {}, 'public-immutable', 200],
    ['HEAD /*', '/_app/chunk.0123456789abcdef.js', {}, 'public-immutable', 200],
    ['HEAD /*', '/manifest.webmanifest', {}, 'public-revalidate', 200],
    ['GET /*', '/sw.js', {}, 'public-revalidate', 200],
    ['GET /tools/*', '/tools', {}, 'public-revalidate', 200],
    ['HEAD /tools/*', '/tools', {}, 'public-revalidate', 200],
    ['GET /catalog/*', '/catalog/og/swatch.png', {}, 'public-bounded', 200],
    ['HEAD /catalog/*', '/catalog/og/swatch.png', {}, 'public-bounded', 200],
  ]);
  // Refusals on public routes are private too, whatever the handler wrote.
  const refusals: Array<[string, string, Record<string, string>, number]> = [
    ['GET /api/brand/r/:revision/logo/:variant', `/api/brand/r/${'0'.repeat(64)}/logo/light`, {}, 404],
    ['GET /api/brand/font/:file', '/api/brand/font/Brand.woff2', { range: 'bytes=999999-' }, 416],
    ['GET /*', '/_app/missing.0123456789abcdef.js', {}, 404],
    ['GET /catalog/*', '/catalog/og/missing.png', {}, 404],
  ];
  for (const [key, path, headers, status] of refusals) {
    const res = await sample(routeOf(key), path, headers);
    assert.equal(res.status, status, `${key} ${path}`);
    conforms('refused', routeOf(key), path, res, false);
  }
});

test('on an open instance the hashed pack is public-immutable and the plain pack URL stays private', async () => {
  const hashed = `/connect/pack.${packChecksum.slice(0, 16)}.lolly`;
  await expectSamples([
    ['GET /connect/:file', hashed, {}, 'public-immutable', 200],
    ['HEAD /connect/:file', hashed, {}, 'public-immutable', 200],
    ['GET /connect/:file', hashed, { 'if-none-match': `"${packChecksum}"` }, 'public-immutable', 304],
    ['GET /connect/pack.lolly', '/connect/pack.lolly', {}, 'instance-private', 200],
    ['HEAD /connect/pack.lolly', '/connect/pack.lolly', {}, 'instance-private', 200],
  ], openPort);
});

test('a sample reaches every per-response class the table allows', () => {
  const missed = Object.entries(RESPONSE_CLASSES).flatMap(([key, classes]) => classes.filter(cls => !reached.has(`${key} ${cls}`)).map(cls => `${key} ${cls}`));
  assert.deepEqual(missed, [], 'no sample is served under these classes; add a sample or remove the allowance from RESPONSE_CLASSES');
});
