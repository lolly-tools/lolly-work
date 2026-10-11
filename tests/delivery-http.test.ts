// SPDX-License-Identifier: MPL-2.0
/** Byte delivery uses real HTTP: validators describe the selected coding and grants never become public. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { cachePolicy, publicStaticDeliveryClass } from '@lolly-tools/core/delivery-v1';
import { createRouter, sendJson } from '../server/src/api/router.ts';
import { sendFile, safeFile, preferredEncoding } from '../server/src/api/file-delivery.ts';

let root: string, outside: string, server: Server, port: number;
const source = Buffer.from('signed source bytes '.repeat(400));
async function read(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
}
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'lw-delivery-')); outside = await mkdtemp(join(tmpdir(), 'lw-outside-'));
  await mkdir(join(root, '_app')); await writeFile(join(root, '_app/chunk.1234567890abcdef.js'), source);
  await writeFile(join(root, '_app/chunk.1234567890abcdef.js.gz'), gzipSync(source));
  await writeFile(join(outside, 'secret.txt'), 'outside'); await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
  const router = createRouter();
  router.add('GET', '/unclassified', (_req, res) => { res.writeHead(200, { 'cache-control': 'public, max-age=3600' }); res.end('private default'); });
  for (const method of ['GET', 'HEAD']) router.add(method, '/static', async (req, res) => {
    res.setHeader('vary', 'Origin'); await sendFile(req, res, root, '_app/chunk.1234567890abcdef.js', { contentType: 'text/javascript', ranges: true, headers: { 'cache-control': cachePolicy('public-immutable').cacheControl } });
  }, { delivery: 'public-immutable' });
  router.add('GET', '/json', (_req, res) => sendJson(res, 200, { source: source.toString() }, { 'cache-control': cachePolicy('public-revalidate').cacheControl }), { delivery: 'public-revalidate' });
  router.add('GET', '/error', (_req, res) => { res.writeHead(404, { 'cache-control': 'public, max-age=31536000' }); res.end(); }, { delivery: 'public-immutable' });
  router.add('GET', '/cookie', (_req, res) => { res.writeHead(200, { 'cache-control': 'public, max-age=300', 'set-cookie': 'fixture=1' }); res.end(); }, { delivery: 'public-bounded' });
  assert.equal(router.descriptions().find(route => route.path === '/unclassified')?.delivery, 'person-private');
  assert.ok(router.descriptions().every(route => ['public-immutable', 'public-revalidate', 'public-bounded', 'link', 'instance-private', 'person-private'].includes(route.delivery)));
  server = createServer((req, res) => void router.dispatch(req, res)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); port = address.port;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]); });

test('default, error, cookie, and credential-bearing responses refuse every shared cache', async () => {
  for (const path of ['/unclassified', '/error', '/cookie']) {
    const res = await read(path); assert.match(String(res.headers['cache-control']), /private, no-store/);
    assert.equal(res.headers['cdn-cache-control'], 'no-store'); assert.equal(res.headers['surrogate-control'], undefined);
  }
  for (const headers of [{ cookie: '' }, { authorization: 'Bearer fixture' }, { 'x-lw-render-read': 'fixture' }, { 'x-lw-device': 'fixture' }, { 'x-lolly-client': 'fixture' }] as Array<Record<string, string>>) {
    const res = await read('/static', headers); assert.doesNotMatch(String(res.headers['cache-control']), /public/);
    assert.equal(res.headers['cdn-cache-control'], 'no-store'); assert.equal(res.headers['referrer-policy'], 'no-referrer');
  }
  const anonymous = await read('/static'); assert.equal(anonymous.headers['cache-control'], cachePolicy('public-immutable').cacheControl);
  assert.equal(anonymous.headers['cdn-cache-control'], cachePolicy('public-immutable').cdnCacheControl);
});

test('compression, coding-specific strong validators, HEAD, and 304 keep the decoded bytes intact', async () => {
  const identity = await read('/static', { 'accept-encoding': 'identity' });
  const gzip = await read('/static', { 'accept-encoding': 'gzip' }); assert.equal(gzip.headers['content-encoding'], 'gzip'); assert.deepEqual(gunzipSync(gzip.bytes), source);
  const br = await read('/static', { 'accept-encoding': 'br' }); assert.deepEqual(brotliDecompressSync(br.bytes), source);
  assert.notEqual(gzip.headers.etag, identity.headers.etag); assert.notEqual(br.headers.etag, gzip.headers.etag);
  assert.equal(gzip.headers.vary, 'Origin, Accept-Encoding'); assert.ok(gzip.headers['last-modified']);
  const head = await read('/static', { 'accept-encoding': 'gzip' }, 'HEAD'); assert.equal(head.headers.etag, gzip.headers.etag);
  assert.equal(Number(head.headers['content-length']), gzip.bytes.length); assert.equal(head.bytes.length, 0);
  const fresh = await read('/static', { 'accept-encoding': 'gzip', 'if-none-match': String(gzip.headers.etag) }); assert.equal(fresh.status, 304); assert.equal(fresh.bytes.length, 0);
  assert.equal((await read('/static', { 'accept-encoding': 'br', 'if-none-match': String(gzip.headers.etag) })).status, 200);
  const json = await read('/json', { 'accept-encoding': 'gzip' }); assert.equal(json.headers['content-encoding'], 'gzip'); assert.equal(JSON.parse(gunzipSync(json.bytes).toString()).source, source.toString());
});

test('ranges use identity bytes, strong If-Range, and private error responses', async () => {
  const identity = await read('/static', { 'accept-encoding': 'identity' });
  const range = await read('/static', { range: 'bytes=2-9', 'accept-encoding': 'br', 'if-range': String(identity.headers.etag) });
  assert.equal(range.status, 206); assert.equal(range.headers['content-encoding'], undefined); assert.deepEqual(range.bytes, source.subarray(2, 10));
  assert.equal(range.headers['content-range'], `bytes 2-9/${source.length}`);
  assert.equal((await read('/static', { range: 'bytes=2-9', 'if-range': 'W/' + identity.headers.etag })).status, 200);
  const unsatisfiable = await read('/static', { range: 'bytes=999999-' }); assert.equal(unsatisfiable.status, 416); assert.equal(unsatisfiable.headers['cdn-cache-control'], 'no-store');
  const multiple = await read('/static', { range: 'bytes=1-2,4-5' }); assert.equal(multiple.status, 416);
});

test('q=0, stale precompressed siblings and unsafe paths are handled safely', async () => {
  assert.equal(preferredEncoding('br;q=0, gzip;q=0, *;q=1'), null);
  const identity = await read('/static', { 'accept-encoding': 'br;q=0, gzip;q=0, *;q=1' }); assert.equal(identity.headers['content-encoding'], undefined); assert.deepEqual(identity.bytes, source);
  await writeFile(join(root, '_app/chunk.1234567890abcdef.js.gz'), gzipSync(Buffer.from('wrong bytes')));
  const result = await read('/static', { 'accept-encoding': 'gzip' }); assert.deepEqual(gunzipSync(result.bytes), source);
  assert.equal(await safeFile(root, 'escape.txt'), null); assert.equal(await safeFile(root, '../outside/secret'), null);
  assert.equal(publicStaticDeliveryClass('/_app/chunk.1234567890abcdef.js'), 'public-immutable');
  for (const path of ['/sw.js', '/precache.json', '/manifest.webmanifest', '/index.html', '/catalog/tools/index.sig.json']) assert.equal(publicStaticDeliveryClass(path), 'public-revalidate');
});
