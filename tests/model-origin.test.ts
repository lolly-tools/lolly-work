// SPDX-License-Identifier: MPL-2.0
/**
 * The served shell's models and its extension-less files (a user report on lolly.ing,
 * 2026-10-19: every model download failed with 404, and "Download the app" failed on
 * 11 files the server answered with its app page).
 *
 * Pinned:
 *  - `/models/*` that the shell dist does not carry goes to instance.modelOrigin, same
 *    origin for the browser: the bytes, the type, a ranged resume (Range and If-Range
 *    forwarded, 206 and Content-Range back) and HEAD;
 *  - a content-addressed model path is immutable, a plain one revalidates;
 *  - a model the dist does carry is answered from disk, without asking the host;
 *  - an unknown model is a 404, a host that does not answer is a 502, a bad path never
 *    reaches the host, and `modelOrigin: null` keeps every request on this server;
 *  - a real file without an extension (pdf.js's LICENSE) is served as a file, while a
 *    route that is not a file still answers the app page;
 *  - the setting defaults to https://lolli.li and takes only an exact origin.
 *
 * Run directly:  node --test tests/model-origin.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_MODEL_ORIGIN, parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';

const HASHED = 'models/ai-detect@30f9e0352083d430/e5-small-ai-detector/config.json';
const BODY = '{"architectures":["Detector"],"hidden_size":384}';
const ETAG = '"cfg-1"';

let pack: string;
let shell: string;
const servers: Server[] = [];
const seen: Array<{ url: string; method: string; range?: string; ifRange?: string; encoding?: string }> = [];
let host = '';

const listen = async (server: Server): Promise<string> => {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
};

async function boot(modelOrigin: string | null | undefined): Promise<string> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Models', baseUrl: 'http://localhost', pack, shellDir: shell, ...(modelOrigin === undefined ? {} : { modelOrigin }) },
    rateLimit: { enabled: false },
    policy: { defaultAccessMode: 'open' },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 'models-session', link: 'models-link' } });
  return listen(createServer((req, res) => void app(req, res)));
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-model-pack-'));
  for (const dir of ['assets', 'tools']) await mkdir(join(pack, 'catalog', dir), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [] }));
  shell = await mkdtemp(join(tmpdir(), 'lw-model-shell-'));
  await writeFile(join(shell, 'index.html'), '<!doctype html><title>Lolly</title><script type="module" src="/_app/org-config.js"></script>');
  await mkdir(join(shell, 'lib', 'pdfjs', 'cmaps'), { recursive: true });
  await writeFile(join(shell, 'lib', 'pdfjs', 'cmaps', 'LICENSE'), 'Copyright 1990-2009 Adobe Systems Incorporated.');
  await mkdir(join(shell, 'models', 'bundled'), { recursive: true });
  await writeFile(join(shell, 'models', 'bundled', 'tiny.json'), '{"local":true}');
  // The model host: one file, with ranges and a validator, and a record of each request.
  host = await listen(createServer((req: IncomingMessage, res) => {
    seen.push({ url: req.url ?? '', method: req.method ?? '', range: req.headers.range, ifRange: req.headers['if-range'] as string | undefined, encoding: req.headers['accept-encoding'] as string | undefined });
    if (req.url !== `/${HASHED}`) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('missing'); return; }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (range && req.headers['if-range'] === ETAG) {
      const start = Number(range[1]);
      res.writeHead(206, { 'content-type': 'application/json', etag: ETAG, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`, 'content-length': String(BODY.length - start) });
      res.end(req.method === 'HEAD' ? undefined : BODY.slice(start));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag: ETAG, 'accept-ranges': 'bytes', 'content-length': String(BODY.length) });
    res.end(req.method === 'HEAD' ? undefined : BODY);
  }));
});

after(async () => {
  for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(pack, { recursive: true, force: true });
  await rm(shell, { recursive: true, force: true });
});

test('a model the dist does not carry comes from the model host, same origin', async () => {
  const base = await boot(host);
  seen.length = 0;
  const res = await fetch(`${base}/${HASHED}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(await res.text(), BODY);
  assert.match(String(res.headers.get('cache-control')), /immutable/, 'a content-addressed path never changes under its name');
  assert.equal(res.headers.get('etag'), ETAG);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.encoding, 'identity', 'the host is asked for its own bytes, so lengths and ranges stay true');

  // An interrupted download resumes: the range and its validator reach the host.
  const resumed = await fetch(`${base}/${HASHED}`, { headers: { range: 'bytes=10-', 'if-range': ETAG } });
  assert.equal(resumed.status, 206);
  assert.equal(resumed.headers.get('content-range'), `bytes 10-${BODY.length - 1}/${BODY.length}`);
  assert.equal(await resumed.text(), BODY.slice(10));
  assert.deepEqual([seen[1]!.range, seen[1]!.ifRange], ['bytes=10-', ETAG]);

  const head = await fetch(`${base}/${HASHED}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(BODY.length));
  assert.equal(seen[2]!.method, 'HEAD');
});

test('the dist answers the models it carries, and refuses what is not a model path', async () => {
  const base = await boot(host);
  seen.length = 0;
  const local = await fetch(`${base}/models/bundled/tiny.json`);
  assert.equal(local.status, 200);
  assert.equal(await local.text(), '{"local":true}');
  assert.match(String(local.headers.get('cache-control')), /no-cache|must-revalidate|max-age=0/, 'a plain path revalidates');
  assert.equal(seen.length, 0, 'the host is not asked for a file the dist has');

  const missing = await fetch(`${base}/models/ai-detect@30f9e0352083d430/nope.onnx`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('content-type'), 'application/json; charset=utf-8');

  for (const path of ['/models/', '/models/only-a-family', '/models/x/%2e%2e/secret']) {
    const refused = await fetch(`${base}${path}`);
    assert.equal(refused.status, 404, path);
  }
  assert.ok(seen.every(r => !r.url.includes('..') && r.url !== '/models/' && r.url !== '/models/only-a-family'), 'a bad path never reaches the host');
});

test('modelOrigin null keeps every model request here, and a silent host is a 502', async () => {
  const offline = await boot(null);
  seen.length = 0;
  assert.equal((await fetch(`${offline}/${HASHED}`)).status, 404);
  assert.equal(seen.length, 0);
  assert.equal((await fetch(`${offline}/models/bundled/tiny.json`)).status, 200, 'the dist still answers its own');

  const dead = await boot('http://127.0.0.1:9');
  const res = await fetch(`${dead}/${HASHED}`);
  assert.equal(res.status, 502);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'MODEL_HOST_UNREACHABLE');
});

test('a real file without an extension is a file; a route that is not a file is the app page', async () => {
  const base = await boot(host);
  const licence = await fetch(`${base}/lib/pdfjs/cmaps/LICENSE`);
  assert.equal(licence.status, 200);
  assert.doesNotMatch(String(licence.headers.get('content-type')), /text\/html/, 'the shell refuses an app page in place of a file');
  assert.equal(await licence.text(), 'Copyright 1990-2009 Adobe Systems Incorporated.');
  const route = await fetch(`${base}/projects`);
  assert.equal(route.status, 200);
  assert.match(String(route.headers.get('content-type')), /text\/html/);
  assert.match(await route.text(), /<title>Lolly<\/title>/);
});

test('modelOrigin defaults to the release host and takes only an exact origin', () => {
  const parse = (modelOrigin: unknown) => parseConfig(JSON.stringify({
    instance: { name: 'x', baseUrl: 'http://localhost', pack: '/tmp/none', ...(modelOrigin === undefined ? {} : { modelOrigin }) },
    policy: { defaultAccessMode: 'open' },
  })).instance.modelOrigin;
  assert.equal(DEFAULT_MODEL_ORIGIN, 'https://lolli.li');
  assert.equal(parse(undefined), 'https://lolli.li');
  assert.equal(parse(null), null);
  assert.equal(parse('https://models.example.com/'), 'https://models.example.com');
  for (const bad of ['https://lolli.li/models', 'http://lolli.li', 'ftp://lolli.li', 'lolli.li', 42]) {
    assert.throws(() => parse(bad), /instance\.modelOrigin/, String(bad));
  }
});
