// SPDX-License-Identifier: MPL-2.0
/**
 * The console's static files and the sandbox landing page over real HTTP. The
 * page revalidates and stays out of shared caches. An entry the page requests
 * with `?v=` is immutable only while the files on disk hash to that revision,
 * and only with the exact bytes that were hashed: a swapped entry, bytes that
 * change behind an unchanged stat, a `?v=` on any other file and a stale
 * index.html after a restart are all served as revalidate. Immutable answers
 * are shared only when the request carries no credential. Every other file
 * revalidates against a strong ETag for its coding, text is Brotli or gzip by
 * Accept-Encoding, and API answers keep `private, no-store` beside them.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { cachePolicy } from '@lolly-tools/core/delivery-v1';
import { createRouter, guardDelivery, type EdgeDelivery } from '../server/src/api/router.ts';
import { CONSOLE_PRIVATE_IMMUTABLE, consoleEntries, createConsoleDelivery } from '../server/src/api/console-delivery.ts';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildConsoleAssets, CONSOLE_DIR, consoleAssetPlan } from '../scripts/console-assets.ts';

const IMMUTABLE = cachePolicy('public-immutable').cacheControl;
const REVALIDATE = cachePolicy('public-revalidate').cacheControl;
const PAGE = cachePolicy('instance-private').cacheControl;
const NO_STORE = cachePolicy('person-private').cacheControl;
const EDGE: EdgeDelivery = { tagHeaders: [], publicOnlyHosts: new Set(['assets.example.eu']) };
/** A fixed modification time, so a test can change bytes behind an unchanged stat. */
const STAMP = new Date('2026-11-01T00:00:00Z');
const PAGE_SOURCE = `<!doctype html><title>Console</title><script>document.documentElement.dataset.boot='1'</script>
<link rel="stylesheet" href="/admin/styles.css"><script type="module" src="/admin/app.js"></script>${'<!-- padding -->'.repeat(80)}`;
const script = Buffer.from('export const boot = () => document.body.append("console");\n'.repeat(60));
const sameLength = Buffer.from(script.toString().replace('console', 'CONSOLE'));
const font = Buffer.alloc(4096, 7);
const types = (path: string) => path.endsWith('.html') ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8'
  : path.endsWith('.css') ? 'text/css; charset=utf-8' : path.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';

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
async function close({ server }: { server: Server }): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

/** A console tree console:build accepts, with fixed modification times. */
async function consoleTree(): Promise<{ dir: string; revision: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'lw-console-delivery-'));
  await mkdir(join(dir, 'fonts'));
  await writeFile(join(dir, 'index.html'), PAGE_SOURCE);
  await writeFile(join(dir, 'app.js'), script);
  await writeFile(join(dir, 'styles.css'), '@import url("./theme.css");\n' + 'body { color: black; }\n'.repeat(80));
  await writeFile(join(dir, 'theme.css'), '@font-face { font-family: Face; src: url("./fonts/Face.woff2"); }\n'.repeat(30));
  await writeFile(join(dir, 'fonts', 'Face.woff2'), font);
  const revision = buildConsoleAssets(dir);
  for (const file of ['app.js', 'styles.css']) await utimes(join(dir, file), STAMP, STAMP);
  return { dir, revision };
}
/** Write a console file and give it the fixed modification time. */
async function put(dir: string, rel: string, bytes: Buffer | string): Promise<void> {
  await writeFile(join(dir, rel), bytes); await utimes(join(dir, rel), STAMP, STAMP);
}
/** The router the app registers, over one console directory, behind the edge guard. */
function consoleServer(dir: string) {
  const router = createRouter(), files = createConsoleDelivery(dir, types);
  router.add('GET', '/admin', (req, res, ctx) => files.serve(req, res, 'index.html', ctx.url), { delivery: 'instance-private' });
  router.add('GET', '/admin/*', (req, res, ctx) => files.serve(req, res, ctx.params['*'] || 'index.html', ctx.url), { delivery: 'public-revalidate' });
  return listen((req, res) => { guardDelivery(req, res, EDGE); void router.dispatch(req, res); });
}

let dir: string, A: string, fixture: { server: Server; port: number }, real: { server: Server; port: number }, owner: string;
const control = async (path: string, headers: Record<string, string> = {}) => (await read(fixture.port, path, headers)).headers['cache-control'];
before(async () => {
  ({ dir, revision: A } = await consoleTree());
  fixture = await consoleServer(dir);
  const config = parseConfig(JSON.stringify({ instance: { name: 'Console delivery', baseUrl: 'http://localhost', pack: 'packs/demo' },
    rateLimit: { enabled: false }, dev: { enabled: true, users: [{ email: 'owner@test', groups: ['admin'] }] } }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'console-delivery', link: 'console-delivery-link' } });
  real = await listen((req, res) => void app(req, res));
  const login = await fetch(`http://127.0.0.1:${real.port}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  owner = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
});
after(async () => {
  for (const listening of [fixture, real]) await close(listening);
  await rm(dir, { recursive: true, force: true });
});

test('the entries are the files the page requests with one shared revision', async () => {
  const html = await readFile(join(dir, 'index.html'), 'utf8');
  assert.deepEqual(consoleEntries(html), { revision: A, files: ['styles.css', 'app.js'] });
  assert.equal(consoleEntries(html.replace(`styles.css?v=${A}`, `styles.css?v=${'b'.repeat(64)}`)), null, 'entries that disagree name no revision');
  assert.equal(consoleEntries(PAGE_SOURCE), null);
});

test('a correct tree serves its entries immutable: shared when anonymous, private when signed in', async () => {
  for (const path of [`/admin/app.js?v=${A}`, `/admin/styles.css?v=${A}`]) {
    const anonymous = await read(fixture.port, path, { 'accept-encoding': 'br' });
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.headers['cache-control'], IMMUTABLE, path);
    assert.equal(anonymous.headers['cdn-cache-control'], cachePolicy('public-immutable').cdnCacheControl);
    assert.equal(anonymous.headers['content-encoding'], 'br');
    assert.match(String(anonymous.headers.etag), /^"[0-9a-f]{64}-br"$/);
    assert.equal(anonymous.headers['last-modified'], STAMP.toUTCString());
    for (const credential of [{ cookie: 'lw_session=x' }, { authorization: 'Bearer lwa_x' }] as Array<Record<string, string>>) {
      const signedIn = await read(fixture.port, path, { 'accept-encoding': 'br', ...credential });
      assert.equal(signedIn.headers['cache-control'], CONSOLE_PRIVATE_IMMUTABLE, `${path} with ${Object.keys(credential)[0]}`);
      assert.equal(signedIn.headers['cdn-cache-control'], 'no-store');
      assert.equal(signedIn.headers['surrogate-control'], undefined);
      assert.equal(signedIn.headers.etag, anonymous.headers.etag, 'the bytes do not depend on who asks');
      assert.deepEqual(decoded(signedIn), decoded(anonymous));
    }
    const fresh = await read(fixture.port, path, { 'accept-encoding': 'br', 'if-none-match': String(anonymous.headers.etag) });
    assert.equal(fresh.status, 304); assert.equal(fresh.headers['cache-control'], IMMUTABLE);
  }
  assert.deepEqual(decoded(await read(fixture.port, `/admin/app.js?v=${A}`, { 'accept-encoding': 'br' })), script);
  for (const path of [`/admin/app.js?v=${'0'.repeat(64)}`, '/admin/app.js']) {
    assert.equal(await control(path), REVALIDATE, `${path} is not the current revision`);
    assert.equal(await control(path, { cookie: 'lw_session=x' }), PAGE, `${path} signed in revalidates privately`);
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
  assert.equal((await read(fixture.port, `/admin/app.js?v=${A}`, { 'accept-encoding': 'gzip, br' })).headers.etag, br.headers.etag, 'both classes name the same representation alike');
  const face = await read(fixture.port, '/admin/fonts/Face.woff2', { 'accept-encoding': 'br' });
  assert.equal(face.status, 200); assert.equal(face.headers['content-encoding'], undefined, 'a font is not compressed again');
  assert.deepEqual(face.bytes, font); assert.equal(face.headers['cache-control'], REVALIDATE);
  assert.equal((await read(fixture.port, '/admin/fonts/Face.woff2', { 'if-none-match': String(face.headers.etag) })).status, 304);
  for (const path of ['/admin/missing.js', `/admin/missing.js?v=${A}`, '/admin/fonts']) {
    const missing = await read(fixture.port, path);
    assert.equal(missing.status, 404, path); assert.equal(missing.headers['cache-control'], NO_STORE);
  }
});

test('a file replaced with bytes of the same length and its old modification time is not answered 304', async () => {
  // The validator cache was keyed on size and modification time alone. A copy that keeps
  // times (or a rebuild that restores them) then left the old ETag in force, and a browser
  // that revalidated kept the old bytes for as long as the server ran.
  const root = await mkdtemp(join(tmpdir(), 'lw-console-swap-'));
  const served = await consoleServer(root);
  try {
    const path = join(root, 'theme.css');
    const first = ':root { --ink: #111111; }\n'.repeat(60), second = ':root { --ink: #222222; }\n'.repeat(60);
    assert.equal(first.length, second.length);
    // A whole-second time, so the two stats compare exactly on every filesystem.
    const kept = new Date('2026-01-02T03:04:05.000Z');
    await writeFile(path, first);
    await utimes(path, kept, kept);
    const before = await stat(path);
    const one = await read(served.port, '/admin/theme.css', { 'accept-encoding': 'br' });
    assert.equal(one.status, 200);
    assert.equal((await read(served.port, '/admin/theme.css', { 'accept-encoding': 'br', 'if-none-match': String(one.headers.etag) })).status, 304, 'unchanged bytes revalidate');
    await new Promise(resolve => setTimeout(resolve, 20));
    await writeFile(path, second);
    await utimes(path, kept, kept);
    const after = await stat(path);
    assert.equal(after.mtime.getTime(), before.mtime.getTime(), 'the modification time is the old one');
    assert.equal(after.size, before.size);
    const two = await read(served.port, '/admin/theme.css', { 'accept-encoding': 'br', 'if-none-match': String(one.headers.etag) });
    assert.equal(two.status, 200, 'the old validator no longer matches');
    assert.notEqual(two.headers.etag, one.headers.etag);
    assert.equal(decoded(two).toString('utf8'), second);
  } finally {
    await close(served);
    await rm(root, { recursive: true, force: true });
  }
});

test('the console page is private, revalidates and keeps its script policy', async () => {
  const source = await readFile(join(dir, 'index.html'), 'utf8');
  for (const path of ['/admin', '/admin/', '/admin/index.html', `/admin/index.html?v=${A}`]) {
    const html = await read(fixture.port, path, { 'accept-encoding': 'br' });
    assert.equal(html.status, 200, path);
    assert.equal(html.headers['cache-control'], PAGE, path);
    assert.equal(html.headers['cdn-cache-control'], 'no-store');
    assert.equal(html.headers['content-encoding'], 'br');
    assert.equal(decoded(html).toString(), source);
    assert.match(String(html.headers['content-security-policy']), /script-src 'self' 'sha256-/);
    assert.equal(html.headers['x-frame-options'], 'DENY');
    const again = await read(fixture.port, path, { 'accept-encoding': 'br', 'if-none-match': String(html.headers.etag), cookie: 'lw_session=x' });
    assert.equal(again.status, 304, path); assert.equal(again.headers['cache-control'], PAGE);
  }
});

test('a ?v= on a file the page does not request is never immutable, even when the tree is current', async () => {
  for (const path of [`/admin/theme.css?v=${A}`, `/admin/fonts/Face.woff2?v=${A}`]) assert.equal(await control(path), REVALIDATE, path);
  try {
    await put(dir, 'extra.js', 'export const extra = 1;\n'.repeat(100));
    const B = buildConsoleAssets(dir);
    assert.notEqual(B, A);
    assert.equal(await control(`/admin/app.js?v=${B}`), IMMUTABLE, 'the rebuilt tree is current');
    assert.equal(await control(`/admin/extra.js?v=${B}`), REVALIDATE, 'a file no entry URL names');
    assert.equal(await control(`/admin/app.js?v=${A}`), REVALIDATE, 'the old revision is retired');
  } finally { await rm(join(dir, 'extra.js')); assert.equal(buildConsoleAssets(dir), A); }
  assert.equal(await control(`/admin/app.js?v=${A}`), IMMUTABLE);
});

test('an entry swapped under a running server stops being immutable at once', async () => {
  assert.equal(await control(`/admin/app.js?v=${A}`), IMMUTABLE);
  const swapped = Buffer.from('export const boot = () => {};\n'.repeat(90));
  try {
    await put(dir, 'app.js', swapped);
    const reply = await read(fixture.port, `/admin/app.js?v=${A}`);
    assert.equal(reply.headers['cache-control'], REVALIDATE, 'index.html still names the old revision');
    assert.deepEqual(reply.bytes, swapped, 'the new bytes, answered as revalidate');
    assert.equal(await control(`/admin/styles.css?v=${A}`), REVALIDATE, 'the tree is no longer the named revision');
  } finally { await put(dir, 'app.js', script); }
  assert.equal(await control(`/admin/app.js?v=${A}`), IMMUTABLE, 'the original bytes are the revision again');
});

test('bytes that change behind an unchanged stat are served as revalidate', async () => {
  assert.equal(await control(`/admin/app.js?v=${A}`), IMMUTABLE);
  assert.equal(sameLength.length, script.length);
  try {
    // Same size and modification time: the cached proof stands, so only the
    // check of the bytes just read can catch the change.
    await put(dir, 'app.js', sameLength);
    const reply = await read(fixture.port, `/admin/app.js?v=${A}`);
    assert.equal(reply.headers['cache-control'], REVALIDATE);
    assert.deepEqual(reply.bytes, sameLength);
    assert.equal(await control(`/admin/styles.css?v=${A}`), IMMUTABLE, 'the unchanged entry still has the hashed bytes');
  } finally { await put(dir, 'app.js', script); }
  assert.equal(await control(`/admin/app.js?v=${A}`), IMMUTABLE);
});

test('a restart with a stale index.html serves no entry as immutable', async () => {
  const stale = await consoleTree();
  try {
    await put(stale.dir, 'app.js', Buffer.from('export const boot = () => "changed";\n'.repeat(70)));
    const current = consoleAssetPlan(stale.dir).revision;
    assert.notEqual(current, stale.revision);
    const restarted = await consoleServer(stale.dir);
    try {
      for (const v of [stale.revision, current]) {
        for (const file of ['app.js', 'styles.css']) {
          const reply = await read(restarted.port, `/admin/${file}?v=${v}`);
          assert.equal(reply.status, 200);
          assert.equal(reply.headers['cache-control'], REVALIDATE, `${file}?v=${v.slice(0, 8)}`);
        }
      }
      buildConsoleAssets(stale.dir);
      assert.equal((await read(restarted.port, `/admin/app.js?v=${current}`)).headers['cache-control'], IMMUTABLE, 'console:build makes the tree current again');
    } finally { await close(restarted); }
  } finally { await rm(stale.dir, { recursive: true, force: true }); }
});

test('a tree console:build refuses has no immutable entries and still serves its files', async () => {
  // Adding or removing a file changes no entry's stat, so each step touches
  // index.html to make the server read the tree again.
  try {
    await put(dir, 'app-0123456789ab.js', 'obsolete copy');
    await utimes(join(dir, 'index.html'), STAMP, STAMP);
    const reply = await read(fixture.port, `/admin/app.js?v=${A}`);
    assert.equal(reply.status, 200); assert.equal(reply.headers['cache-control'], REVALIDATE);
    assert.deepEqual(reply.bytes, script);
  } finally {
    await rm(join(dir, 'app-0123456789ab.js'), { force: true });
    const later = new Date(STAMP.getTime() + 60_000);
    await utimes(join(dir, 'index.html'), later, later);
  }
  assert.equal(await control(`/admin/app.js?v=${A}`), IMMUTABLE);
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
  const entries = consoleEntries(decoded(html).toString());
  assert.deepEqual(entries, { revision: consoleAssetPlan().revision, files: ['styles.css', 'app.js'] });
  const source = await readFile(join(CONSOLE_DIR, 'app.js'));
  for (const [headers, expected] of [[{}, IMMUTABLE], [{ cookie: owner }, CONSOLE_PRIVATE_IMMUTABLE]] as const) {
    const entry = await read(real.port, `/admin/app.js?v=${entries!.revision}`, { 'accept-encoding': 'gzip, deflate, br, zstd', ...headers });
    assert.equal(entry.status, 200);
    assert.equal(entry.headers['cache-control'], expected);
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
