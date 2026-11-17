// SPDX-License-Identifier: MPL-2.0
/**
 * The console's static files and the sandbox landing page over real HTTP. The
 * page revalidates and stays out of shared caches; a `?v=` entry naming the
 * revision the served index.html names is immutable, shared only when the
 * request carries no credential; every other file revalidates against a strong
 * ETag for its coding; text is Brotli or gzip by Accept-Encoding; and API
 * answers keep `private, no-store` beside them.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { cachePolicy } from '@lolly-tools/core/delivery-v1';
import { createRouter, guardDelivery, type EdgeDelivery } from '../server/src/api/router.ts';
import { CONSOLE_PRIVATE_IMMUTABLE, consoleFileClass, consoleRevisionOf, createConsoleDelivery } from '../server/src/api/console-delivery.ts';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { CONSOLE_DIR, consoleAssetPlan } from '../scripts/console-assets.ts';

const IMMUTABLE = cachePolicy('public-immutable').cacheControl;
const REVALIDATE = cachePolicy('public-revalidate').cacheControl;
const PAGE = cachePolicy('instance-private').cacheControl;
const NO_STORE = cachePolicy('person-private').cacheControl;
const A = 'a'.repeat(64), B = 'b'.repeat(64);
const EDGE: EdgeDelivery = { tagHeaders: [], publicOnlyHosts: new Set(['assets.example.eu']) };
const page = (v: string) => `<!doctype html><title>Console</title><script>document.documentElement.dataset.boot='1'</script>
<link rel="stylesheet" href="/admin/styles.css?v=${v}"><script type="module" src="/admin/app.js?v=${v}"></script>${'<!-- padding -->'.repeat(80)}`;
const script = Buffer.from('export const boot = () => document.body.append("console");\n'.repeat(60));
const font = Buffer.alloc(4096, 7);

interface Reply { status: number; headers: IncomingHttpHeaders; bytes: Buffer }
function read(port: number, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
}
const decoded = (reply: Reply): Buffer => reply.headers['content-encoding'] === 'br' ? brotliDecompressSync(reply.bytes)
  : reply.headers['content-encoding'] === 'gzip' ? gunzipSync(reply.bytes) : reply.bytes;
async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

let dir: string, fixture: { server: Server; port: number }, real: { server: Server; port: number }, owner: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lw-console-delivery-'));
  await mkdir(join(dir, 'fonts'));
  await writeFile(join(dir, 'index.html'), page(A));
  await writeFile(join(dir, 'app.js'), script);
  await writeFile(join(dir, 'styles.css'), 'body { color: black; }\n'.repeat(80));
  await writeFile(join(dir, 'fonts', 'Face.woff2'), font);
  const router = createRouter();
  const files = createConsoleDelivery(dir, path => path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8'
    : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
  router.add('GET', '/admin', (req, res, ctx) => files.serve(req, res, 'index.html', ctx.url), { delivery: 'instance-private' });
  router.add('GET', '/admin/*', (req, res, ctx) => files.serve(req, res, ctx.params['*'] || 'index.html', ctx.url), { delivery: 'public-revalidate' });
  fixture = await listen((req, res) => { guardDelivery(req, res, EDGE); void router.dispatch(req, res); });

  const config = parseConfig(JSON.stringify({ instance: { name: 'Console delivery', baseUrl: 'http://localhost', pack: 'packs/demo' },
    rateLimit: { enabled: false }, dev: { enabled: true, users: [{ email: 'owner@test', groups: ['admin'] }] } }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'console-delivery', link: 'console-delivery-link' } });
  real = await listen((req, res) => void app(req, res));
  const login = await fetch(`http://127.0.0.1:${real.port}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  owner = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
});
after(async () => {
  for (const { server } of [fixture, real]) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  await rm(dir, { recursive: true, force: true });
});

test('the revision is the one both entry URLs name, and only HTML is a page', () => {
  assert.equal(consoleRevisionOf(page(A)), A);
  assert.equal(consoleRevisionOf(page(A).replace(`styles.css?v=${A}`, `styles.css?v=${B}`)), null, 'entries that disagree name no revision');
  assert.equal(consoleRevisionOf('<script type="module" src="/admin/app.js"></script>'), null);
  assert.equal(consoleFileClass('index.html', A, A), 'instance-private');
  assert.equal(consoleFileClass('app.js', A, A), 'public-immutable');
  assert.equal(consoleFileClass('app.js', B, A), 'public-revalidate');
  assert.equal(consoleFileClass('app.js', null, A), 'public-revalidate');
  assert.equal(consoleFileClass('app.js', A, null), 'public-revalidate', 'no revision in the page, nothing is immutable');
});

test('a revision entry is immutable: shared when anonymous, private when signed in', async () => {
  for (const path of [`/admin/app.js?v=${A}`, `/admin/styles.css?v=${A}`]) {
    const anonymous = await read(fixture.port, path, { 'accept-encoding': 'br' });
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers['cache-control'], IMMUTABLE, path);
    assert.equal(anonymous.headers['cdn-cache-control'], cachePolicy('public-immutable').cdnCacheControl);
    assert.equal(anonymous.headers['content-encoding'], 'br');
    for (const credential of [{ cookie: 'lw_session=x' }, { authorization: 'Bearer lwa_x' }] as Array<Record<string, string>>) {
      const signedIn = await read(fixture.port, path, { 'accept-encoding': 'br', ...credential });
      assert.equal(signedIn.headers['cache-control'], CONSOLE_PRIVATE_IMMUTABLE, `${path} with ${Object.keys(credential)[0]}`);
      assert.equal(signedIn.headers['cdn-cache-control'], 'no-store');
      assert.equal(signedIn.headers['surrogate-control'], undefined);
      assert.equal(signedIn.headers.etag, anonymous.headers.etag, 'the bytes do not depend on who asks');
      assert.deepEqual(decoded(signedIn), decoded(anonymous));
    }
  }
  assert.deepEqual(decoded(await read(fixture.port, `/admin/app.js?v=${A}`, { 'accept-encoding': 'br' })), script);
  for (const path of [`/admin/app.js?v=${B}`, '/admin/app.js']) {
    assert.equal((await read(fixture.port, path)).headers['cache-control'], REVALIDATE, `${path} is not the current revision`);
    assert.equal((await read(fixture.port, path, { cookie: 'lw_session=x' })).headers['cache-control'], PAGE, `${path} signed in revalidates privately`);
  }
});

test('stable addresses revalidate against a strong validator for each coding', async () => {
  const identity = await read(fixture.port, '/admin/app.js');
  const br = await read(fixture.port, '/admin/app.js', { 'accept-encoding': 'gzip, br' });
  const gzip = await read(fixture.port, '/admin/app.js', { 'accept-encoding': 'gzip' });
  assert.equal(identity.headers['content-encoding'], undefined); assert.deepEqual(identity.bytes, script);
  assert.equal(br.headers['content-encoding'], 'br'); assert.deepEqual(decoded(br), script);
  assert.equal(gzip.headers['content-encoding'], 'gzip'); assert.deepEqual(decoded(gzip), script);
  assert.ok(br.bytes.length < script.length / 4, `Brotli ${br.bytes.length} of ${script.length} bytes`);
  const tags = [identity, br, gzip].map(reply => String(reply.headers.etag));
  assert.equal(new Set(tags).size, 3, 'each coding has its own ETag');
  for (const tag of tags) assert.match(tag, /^"[0-9a-f]{64}(?:-br|-gzip)?"$/, 'strong validators');
  for (const reply of [identity, br, gzip]) assert.equal(reply.headers.vary, 'Accept-Encoding');
  const fresh = await read(fixture.port, '/admin/app.js', { 'accept-encoding': 'gzip, br', 'if-none-match': String(br.headers.etag) });
  assert.equal(fresh.status, 304); assert.equal(fresh.bytes.length, 0);
  assert.equal(fresh.headers['cache-control'], REVALIDATE); assert.equal(fresh.headers.etag, br.headers.etag);
  const signedIn = await read(fixture.port, '/admin/app.js', { 'accept-encoding': 'gzip, br', 'if-none-match': String(br.headers.etag), cookie: 'lw_session=x' });
  assert.equal(signedIn.status, 304); assert.equal(signedIn.headers['cache-control'], PAGE);
  assert.equal((await read(fixture.port, '/admin/app.js', { 'accept-encoding': 'gzip', 'if-none-match': String(br.headers.etag) })).status, 200, 'a Brotli tag never validates gzip bytes');
  const face = await read(fixture.port, '/admin/fonts/Face.woff2', { 'accept-encoding': 'br' });
  assert.equal(face.status, 200); assert.equal(face.headers['content-encoding'], undefined, 'a font is not compressed again');
  assert.deepEqual(face.bytes, font); assert.equal(face.headers['cache-control'], REVALIDATE);
  assert.equal((await read(fixture.port, '/admin/fonts/Face.woff2', { 'if-none-match': String(face.headers.etag) })).status, 304);
  for (const path of ['/admin/missing.js', `/admin/missing.js?v=${A}`, '/admin/fonts']) {
    const missing = await read(fixture.port, path);
    assert.equal(missing.status, 404, path); assert.equal(missing.headers['cache-control'], NO_STORE);
  }
});

test('the console page is private, revalidates and keeps its script policy', async () => {
  for (const path of ['/admin', '/admin/', '/admin/index.html']) {
    const html = await read(fixture.port, path, { 'accept-encoding': 'br' });
    assert.equal(html.status, 200, path);
    assert.equal(html.headers['cache-control'], PAGE, path);
    assert.equal(html.headers['cdn-cache-control'], 'no-store');
    assert.equal(html.headers['content-encoding'], 'br');
    assert.equal(decoded(html).toString(), page(A));
    assert.match(String(html.headers['content-security-policy']), /script-src 'self' 'sha256-/);
    assert.equal(html.headers['x-frame-options'], 'DENY');
    const again = await read(fixture.port, path, { 'accept-encoding': 'br', 'if-none-match': String(html.headers.etag), cookie: 'lw_session=x' });
    assert.equal(again.status, 304, path); assert.equal(again.headers['cache-control'], PAGE);
  }
});

test('a rebuilt index.html retires the old revision on the next request', async () => {
  try {
    await writeFile(join(dir, 'index.html'), page(B) + '\n');
    assert.equal((await read(fixture.port, `/admin/app.js?v=${A}`)).headers['cache-control'], REVALIDATE);
    assert.equal((await read(fixture.port, `/admin/app.js?v=${B}`)).headers['cache-control'], IMMUTABLE);
  } finally { await writeFile(join(dir, 'index.html'), page(A)); }
  assert.equal((await read(fixture.port, `/admin/app.js?v=${A}`)).headers['cache-control'], IMMUTABLE);
});

test('a public-only hostname refuses the console page and serves its public files', async () => {
  const host = { host: 'assets.example.eu' };
  assert.equal((await read(fixture.port, '/admin', host)).status, 404);
  assert.equal((await read(fixture.port, '/admin/', host)).status, 404);
  const entry = await read(fixture.port, `/admin/app.js?v=${A}`, { ...host, cookie: 'lw_session=x' });
  assert.equal(entry.status, 200); assert.equal(entry.headers['cache-control'], IMMUTABLE, 'the hostname strips the cookie, so the answer is shared');
});

test('the real console names the revision scripts/console-assets.ts computes, and serves it compressed and immutable', async () => {
  const html = await read(real.port, '/admin', { 'accept-encoding': 'br' });
  assert.equal(html.headers['cache-control'], PAGE);
  const revision = consoleRevisionOf(decoded(html).toString());
  assert.equal(revision, consoleAssetPlan().revision);
  const source = await readFile(join(CONSOLE_DIR, 'app.js'));
  for (const [headers, control] of [[{}, IMMUTABLE], [{ cookie: owner }, CONSOLE_PRIVATE_IMMUTABLE]] as const) {
    const entry = await read(real.port, `/admin/app.js?v=${revision}`, { 'accept-encoding': 'gzip, deflate, br, zstd', ...headers });
    assert.equal(entry.status, 200);
    assert.equal(entry.headers['cache-control'], control);
    assert.equal(entry.headers['content-encoding'], 'br');
    assert.deepEqual(decoded(entry), source);
  }
  const imported = await read(real.port, '/admin/brand-theme.js', { 'accept-encoding': 'gzip', cookie: owner });
  assert.equal(imported.headers['cache-control'], PAGE); assert.equal(imported.headers['content-encoding'], 'gzip');
  assert.equal((await read(real.port, '/admin/brand-theme.js', { 'accept-encoding': 'gzip', cookie: owner, 'if-none-match': String(imported.headers.etag) })).status, 304);
});

test('the sandbox landing page revalidates privately, and API answers keep no-store', async () => {
  const landing = await read(real.port, '/', { 'accept-encoding': 'br' });
  assert.equal(landing.status, 200);
  assert.match(String(landing.headers['content-type']), /^text\/html/);
  assert.equal(landing.headers['cache-control'], PAGE);
  assert.equal(landing.headers['cdn-cache-control'], 'no-store');
  assert.equal(landing.headers['content-encoding'], 'br');
  assert.match(decoded(landing).toString(), /\/api\/auth\/dev\?email=owner%40test/);
  assert.equal((await read(real.port, '/', { 'accept-encoding': 'br', 'if-none-match': String(landing.headers.etag) })).status, 304);
  for (const [path, headers] of [['/api/auth/config', {}], ['/api/auth/session', { cookie: owner }], ['/api/v1/users', {}], ['/api/v1/users', { cookie: owner }]] as const) {
    const answer = await read(real.port, path, { 'accept-encoding': 'br', 'if-none-match': '*', ...headers });
    assert.notEqual(answer.status, 304, path);
    assert.equal(answer.headers['cache-control'], NO_STORE, `${path} keeps no-store`);
    assert.equal(answer.headers['cdn-cache-control'], 'no-store');
  }
});
