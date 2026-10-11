// SPDX-License-Identifier: MPL-2.0
/** Real shell bytes retain validators while service-worker updates bypass shared caches. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createRouter } from '../server/src/api/router.ts';

const sw = Buffer.from("self.addEventListener('fetch', () => {});\n".repeat(100));
const publicPolicy = 'no-cache, s-maxage=0, no-transform';
const privatePolicy = 'private, no-store, max-age=0, no-transform';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'lw-sw-delivery-')), shell = join(root, 'shell'), pack = join(root, 'pack');
  await mkdir(join(pack, 'catalog/tools'), { recursive: true }); await mkdir(shell);
  await writeFile(join(pack, 'catalog/tools/index.json'), '{"version":1,"tools":[]}');
  await writeFile(join(shell, 'sw.js'), sw); await writeFile(join(shell, 'index.html'), '<!doctype html><title>Fixture</title>');
  await writeFile(join(shell, 'precache.json'), '{}');
  const config = parseConfig(JSON.stringify({ instance: { name: 'SW delivery', pack, shellDir: shell }, deployment: { mode: 'evaluation' }, idp: { additional: [{ id: 'email', kind: 'password' }] }, policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false } }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'fixture-session', link: 'fixture-link' }, backgroundPollMs: 0 });
  const server = createServer((req, res) => void app(req, res));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return (path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }> => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: address.port, path, method, headers }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
}

function publicHeaders(headers: IncomingHttpHeaders) {
  assert.equal(headers['cache-control'], publicPolicy); assert.equal(headers['cdn-cache-control'], 'no-store');
  assert.equal(headers['surrogate-control'], undefined);
}

test('GET, coding validators, HEAD, 304 and Range keep the exact service-worker bytes and policy', async t => {
  const get = await setup(t);
  const identity = await get('/sw.js?release=fixture', { 'accept-encoding': 'identity' });
  assert.equal(identity.status, 200); publicHeaders(identity.headers); assert.deepEqual(identity.bytes, sw);
  const digest = createHash('sha256').update(sw).digest('hex'); assert.ok(String(identity.headers.etag).includes(digest));
  const gzip = await get('/sw.js', { 'accept-encoding': 'gzip' });
  assert.equal(gzip.status, 200); publicHeaders(gzip.headers); assert.deepEqual(gunzipSync(gzip.bytes), sw); assert.notEqual(gzip.headers.etag, identity.headers.etag);
  const head = await get('/sw.js', { 'accept-encoding': 'gzip' }, 'HEAD');
  assert.equal(head.status, 200); publicHeaders(head.headers); assert.equal(head.headers.etag, gzip.headers.etag); assert.equal(head.bytes.length, 0);
  const fresh = await get('/sw.js', { 'accept-encoding': 'gzip', 'if-none-match': String(gzip.headers.etag) });
  assert.equal(fresh.status, 304); publicHeaders(fresh.headers); assert.equal(fresh.bytes.length, 0);
  const range = await get('/sw.js', { range: 'bytes=0-12', 'if-range': String(identity.headers.etag), 'accept-encoding': 'gzip' });
  assert.equal(range.status, 206); publicHeaders(range.headers); assert.deepEqual(range.bytes, sw.subarray(0, 13)); assert.equal(range.headers['content-encoding'], undefined);
  const index = await get('/index.html'); assert.equal(index.headers['cache-control'], 'public, max-age=0, s-maxage=0, must-revalidate, no-transform');
  assert.equal(index.headers['cdn-cache-control'], 'max-age=0, must-revalidate, no-transform');
});

test('credentials and failed ranges retain the private transport downgrade for the real service worker', async t => {
  const get = await setup(t);
  for (const headers of [{ cookie: '' }, { authorization: 'Bearer fixture' }, { 'x-lw-render-read': 'fixture' }, { 'x-lolly-client': 'fixture' }] as Array<Record<string, string>>) {
    const response = await get('/sw.js', headers); assert.equal(response.status, 200); assert.deepEqual(response.bytes, sw);
    assert.equal(response.headers['cache-control'], privatePolicy); assert.equal(response.headers['cdn-cache-control'], 'no-store'); assert.equal(response.headers['surrogate-control'], undefined);
  }
  const invalid = await get('/sw.js', { range: 'bytes=999999-' }); assert.equal(invalid.status, 416); assert.equal(invalid.headers['cache-control'], privatePolicy);
  const missing = await get('/missing/sw.js'); assert.equal(missing.status, 404); assert.equal(missing.headers['cache-control'], privatePolicy);
});

test('the SW transport exception cannot override explicit private, cookie or error responses', async t => {
  const router = createRouter(); let mode = 'private';
  router.add('GET', '/sw.js', (_req, res) => {
    res.writeHead(mode === 'error' ? 404 : 200, { 'cache-control': mode === 'private' ? privatePolicy : 'public, max-age=300', ...(mode === 'cookie' ? { 'set-cookie': 'fixture=1' } : {}) }); res.end('original body');
  }, { delivery: 'public-revalidate' });
  const server = createServer((req, res) => void router.dispatch(req, res));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  for (mode of ['private', 'cookie', 'error']) {
    const response = await fetch(`http://127.0.0.1:${address.port}/sw.js`);
    assert.equal(response.headers.get('cache-control'), privatePolicy); assert.equal(response.headers.get('cdn-cache-control'), 'no-store'); assert.equal(response.headers.get('surrogate-control'), null);
    assert.equal(await response.text(), 'original body');
  }
});
