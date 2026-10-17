// SPDX-License-Identifier: MPL-2.0
/**
 * Byte ranges on /catalog/ext (plan 294): a viewer reads a large federated PDF
 * in parts. Covers the range helpers, dam-http's checked acceptance of a 206,
 * and the route over real HTTP with an Orange Logic source behind a fake
 * upstream. Every ranged read is its own request, so access, provider state,
 * lifecycle and the upstream's own scope are checked again for each part.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { checkPartialReply, exactLength, parseByteRange, RangeNotSatisfiableError, satisfyByteRange, sliceStream } from '../server/src/catalog/byte-range.ts';
import { createDamHttp, DamHttpError } from '../server/src/catalog/providers/dam-http.ts';
import { createOrangeLogicProvider } from '../server/src/catalog/providers/orange-logic.ts';

const streamOf = (...chunks: Uint8Array[]): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
});
const readAll = async (body: ReadableStream<Uint8Array>): Promise<Buffer> => Buffer.from(await new Response(body).arrayBuffer());

// ── helpers ────────────────────────────────────────────────────────────────

test('Range headers parse to one range or are refused', () => {
  assert.equal(parseByteRange(undefined), null);
  assert.deepEqual(parseByteRange('bytes=0-99'), { start: 0, end: 99 });
  assert.deepEqual(parseByteRange('bytes=100-'), { start: 100 });
  assert.deepEqual(parseByteRange('bytes=-500'), { suffix: 500 });
  for (const bad of ['bytes=5-2', 'bytes=-', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-1', 'bytes= 0-1', 'bytes=99999999999999999999-']) {
    assert.equal(parseByteRange(bad), false, bad);
  }
  assert.deepEqual(satisfyByteRange({ start: 10, end: 1_000 }, 100), { start: 10, end: 99, size: 100 });
  assert.deepEqual(satisfyByteRange({ suffix: 1_000 }, 100), { start: 0, end: 99, size: 100 });
  assert.equal(satisfyByteRange({ start: 100 }, 100), false);
  assert.equal(satisfyByteRange({ start: 0 }, 0), false);
});

test('a partial reply must match the request and its own length', () => {
  assert.deepEqual(checkPartialReply({ start: 0, end: 9 }, 'bytes 0-9/50', '10'), { start: 0, end: 9, size: 50 });
  assert.deepEqual(checkPartialReply({ start: 45, end: 99 }, 'bytes 45-49/50', null), { start: 45, end: 49, size: 50 });
  assert.deepEqual(checkPartialReply({ suffix: 5 }, 'bytes 45-49/50', '5'), { start: 45, end: 49, size: 50 });
  assert.equal(checkPartialReply({ start: 0, end: 9 }, 'bytes 10-19/50', '10'), null, 'a different part');
  assert.equal(checkPartialReply({ start: 0, end: 9 }, 'bytes 0-19/50', '20'), null, 'a wider part');
  assert.equal(checkPartialReply({ start: 0, end: 9 }, 'bytes 0-9/*', '10'), null, 'unknown complete length');
  assert.equal(checkPartialReply({ start: 0, end: 9 }, 'bytes 0-9/50', '11'), null, 'length disagrees');
  assert.equal(checkPartialReply({ start: 0, end: 9 }, null, '10'), null, 'no Content-Range');
});

test('stream helpers slice whole files and refuse bodies of the wrong length', async () => {
  const chunks = [Buffer.from('abcd'), Buffer.from('efgh'), Buffer.from('ijkl')];
  assert.equal((await readAll(sliceStream(streamOf(...chunks), 3, 9))).toString(), 'defghij');
  assert.equal((await readAll(sliceStream(streamOf(...chunks), 0, 0))).toString(), 'a');
  assert.equal((await readAll(sliceStream(streamOf(...chunks), 8, 11))).toString(), 'ijkl');
  await assert.rejects(readAll(sliceStream(streamOf(...chunks), 10, 20)), /ended before/);
  assert.equal((await readAll(exactLength(streamOf(...chunks), 12))).toString(), 'abcdefghijkl');
  await assert.rejects(readAll(exactLength(streamOf(...chunks), 11)), /longer/);
  await assert.rejects(readAll(exactLength(streamOf(...chunks), 13)), /shorter/);
});

// ── dam-http ───────────────────────────────────────────────────────────────

test('dam-http sends a range on GET, accepts only a matching 206 and keeps refusing unasked partial replies', async () => {
  const seen: Array<{ method: string; range: string | null }> = [];
  let reply: () => Response = () => new Response('x');
  const http = createDamHttp('test-dam', async (_url, init) => {
    seen.push({ method: init?.method ?? 'GET', range: new Headers(init?.headers).get('range') });
    return reply();
  }, 0);

  reply = () => new Response('0123456789', { status: 206, headers: { 'content-range': 'bytes 10-19/40', 'content-length': '10', 'content-type': 'application/pdf' } });
  const part = await http.stream('https://dam.example/file.pdf', undefined, { start: 10, end: 19 });
  assert.equal(seen.at(-1)!.range, 'bytes=10-19');
  assert.ok(part.kind === 'stream');
  assert.deepEqual(part.range, { start: 10, end: 19, size: 40 });
  assert.equal(part.size, 10);
  assert.equal((await readAll(part.body)).toString(), '0123456789');

  reply = () => new Response('0123456789', { status: 206, headers: { 'content-range': 'bytes 0-9/40' } });
  await assert.rejects(http.stream('https://dam.example/file.pdf', undefined, { start: 10, end: 19 }), /does not match the requested range/);

  reply = () => new Response('01234', { status: 206, headers: { 'content-range': 'bytes 10-19/40' } });
  const short = await http.stream('https://dam.example/file.pdf', undefined, { start: 10, end: 19 });
  assert.ok(short.kind === 'stream');
  await assert.rejects(readAll(short.body), /shorter/, 'a short part fails instead of looking complete');

  reply = () => new Response('whole file', { status: 200, headers: { 'content-length': '10' } });
  const whole = await http.stream('https://dam.example/file.pdf', undefined, { start: 10, end: 19 });
  assert.ok(whole.kind === 'stream');
  assert.equal(whole.range, undefined, 'an upstream that ignores Range returns the whole file');
  assert.equal(whole.size, 10);

  reply = () => new Response(null, { status: 416, headers: { 'content-range': 'bytes */40' } });
  await assert.rejects(http.stream('https://dam.example/file.pdf', undefined, { start: 99 }),
    (error: unknown) => error instanceof RangeNotSatisfiableError && error.size === 40);

  reply = () => new Response('0123456789', { status: 206, headers: { 'content-range': 'bytes 0-9/40' } });
  await assert.rejects(http.stream('https://dam.example/file.pdf'), (error: unknown) => error instanceof DamHttpError && error.status === 206, 'no range asked');
  await assert.rejects(http.json('https://dam.example/api'), (error: unknown) => error instanceof DamHttpError && error.status === 206);
  reply = () => new Response(null, { status: 416 });
  await assert.rejects(http.stream('https://dam.example/file.pdf'), (error: unknown) => error instanceof DamHttpError && error.status === 416);

  reply = () => new Response('whole file');
  await http.stream('https://dam.example/download', { method: 'POST', body: 'a=1' }, { start: 0, end: 9 });
  assert.deepEqual(seen.at(-1), { method: 'POST', range: null }, 'Range has no meaning on POST, so it is not sent');
});

test('Orange Logic re-reads the record and its scope before every ranged rendition read', async () => {
  const calls: string[] = [];
  let inScope = true;
  const asset = { SystemIdentifier: 'OL1', Title: 'Guide', MediaType: 'Document', Directory: 'Brand/Approved', ParentFolderIdentifier: 'APPROVED',
    ParentFolderTitle: 'Approved', EditDate: '2026-10-01T00:00:00Z', FileMD5: 'digest', Path_TR1: { URI: 'https://dam.example/Assets/guide.pdf' } };
  const provider = createOrangeLogicProvider('source', { baseUrl: 'https://dam.example', query: 'ParentFolderIdentifier:APPROVED', minGapMs: 0 }, 'owned-bearer',
    async (input, init) => {
      const url = new URL(String(input));
      const range = new Headers(init?.headers).get('range');
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}${range ? ` ${range}` : ''}`);
      if (url.pathname.startsWith('/API/')) return Response.json({ APIResponse: { Items: inScope ? [asset] : [] } });
      assert.equal(new Headers(init?.headers).get('authorization'), null, 'the rendition read carries no API bearer');
      return new Response('%PDF-', { status: 206, headers: { 'content-range': 'bytes 0-4/900', 'content-type': 'application/pdf' } });
    });
  assert.equal(provider.capabilities.ranges, true);
  const ref = (await provider.listAssets()).assets[0]!.formats[0]!.remoteRef;
  const part = await provider.resolveBlob('OL1', ref, { range: { start: 0, end: 4 } });
  assert.ok(part.kind === 'stream');
  assert.deepEqual(part.range, { start: 0, end: 4, size: 900 });
  assert.deepEqual(calls.slice(-2), ['POST /API/search/v4.0/search', 'GET /Assets/guide.pdf bytes=0-4']);
  inScope = false;
  calls.length = 0;
  await assert.rejects(provider.resolveBlob('OL1', ref, { range: { start: 5, end: 9 } }), /unavailable/);
  assert.deepEqual(calls, ['POST /API/search/v4.0/search'], 'no rendition byte is requested once the record leaves the source scope');
});

// ── the route over real HTTP ───────────────────────────────────────────────

const BIG = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
const SMALL = Buffer.from('small rendition bytes');
const PIN_TEXT = 'pinned local copy of the guide';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const upstream = {
  calls: [] as Array<{ kind: 'search' | 'detail' | 'file'; path?: string; range?: string | null }>,
  revoked: new Set<string>(),
  ignoreRange: false,
  shiftedPart: false,
  shortPart: false,
};
const olRecord = (id: string, file: string) => ({ SystemIdentifier: id, Title: `Doc ${id}`, MediaType: 'Document', Directory: 'Brand/Approved',
  ParentFolderIdentifier: 'APPROVED', ParentFolderTitle: 'Approved', Keywords: [], EditDate: '2026-10-01T00:00:00Z', FileMD5: `md5-${id}`,
  Path_TR1: { URI: `https://dam.example/Assets/${file}` } });
const OL_RECORDS = [olRecord('OL1', 'guide.pdf'), olRecord('OL2', 'card.pdf')];
const FILES: Record<string, Buffer> = { '/Assets/guide.pdf': BIG, '/Assets/card.pdf': SMALL };

const fakeUpstream: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.pathname === '/API/search/v4.0/search') {
    const query = new URLSearchParams(String(init?.body ?? '')).get('query') ?? '';
    const wanted = /SystemIdentifier:"([^"]+)"/.exec(query)?.[1];
    upstream.calls.push({ kind: wanted ? 'detail' : 'search' });
    const items = OL_RECORDS.filter(r => !upstream.revoked.has(r.SystemIdentifier) && (!wanted || r.SystemIdentifier === wanted));
    return Response.json({ APIRequestInfo: { IsLoggedIn: true }, APIResponse: { Items: items } });
  }
  const bytes = FILES[url.pathname];
  if (!bytes) return new Response('missing', { status: 404 });
  const range = headers.get('range');
  upstream.calls.push({ kind: 'file', path: url.pathname, range });
  const match = range && !upstream.ignoreRange ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (!match) return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } });
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
  if (start >= bytes.length) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
  const shift = upstream.shiftedPart ? 1 : 0;
  const body = bytes.subarray(start, upstream.shortPart ? end : end + 1);
  return new Response(body, { status: 206, headers: { 'content-type': 'application/pdf',
    'content-range': `bytes ${start + shift}-${end + shift}/${bytes.length}`, ...(upstream.shortPart ? {} : { 'content-length': String(end - start + 1) }) } });
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-ext-ranges-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  process.env.LW_TEST_EXT_RANGES_OL = 'owned-bearer';
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Ranges Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'designer@test', groups: ['design'] },
      { email: 'seller@test', groups: ['sales'] },
    ] },
    // Small whole files are cached; the large guide never is.
    catalogServing: { maxProviderAssets: 1000, pagedProviderThreshold: 1000, extCache: { maxBytes: 4096, maxItemBytes: 64 } },
    catalogProviders: [
      { id: 'ol', kind: 'orange-logic', label: 'Renditions', enabled: true, credentialRef: 'LW_TEST_EXT_RANGES_OL',
        options: { baseUrl: 'https://dam.example', query: 'ParentFolderIdentifier:APPROVED', minGapMs: 0 }, exposure: { groups: ['design'] } },
      { id: 'pin', kind: 'mock', label: 'Pinned DAM', enabled: true, exposure: { groups: ['design'] },
        options: { blobText: { p1: PIN_TEXT }, assets: [{ remoteId: 'p1', name: 'Guide', nativeType: 'file', sections: [], tags: [], formats: [{ format: 'pdf', remoteRef: 'f1' }] }] } },
    ],
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's9', link: 'l9', credential: 'a-32-byte-or-longer-master-secret!' },
    fetchImpl: fakeUpstream, providerResolver: async () => ['93.184.216.34'] });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => {
  server.close();
  delete process.env.LW_TEST_EXT_RANGES_OL;
});

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}
const fileUrl = async (cookie: string, id: string): Promise<string> => {
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } })).json() as { assets: Array<{ id: string; formats: Array<{ url: string }> }> };
  const url = feed.assets.find(a => a.id === id)?.formats[0]?.url;
  assert.ok(url, `${id} is in the feed`);
  return url;
};
const ranged = (cookie: string, url: string, range: string, extra: Record<string, string> = {}) =>
  fetch(`${base}${url}`, { headers: { cookie, range, ...extra } });
const setLifecycle = async (id: string, validUntil: string) => {
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/lifecycle/${id}`, { method: 'PUT',
    headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ validUntil }) });
  assert.equal(res.status, 200);
};

test('a whole read advertises ranges and a ranged read returns exactly that part', async () => {
  const designer = await login('designer@test');
  const url = await fileUrl(designer, 'ext/ol/OL1');
  upstream.calls.length = 0;
  const whole = await fetch(`${base}${url}`, { headers: { cookie: designer } });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(whole.headers.get('content-length'), '5000');
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(BIG));
  assert.equal(upstream.calls.find(c => c.kind === 'file')?.range, null, 'a whole read asks the upstream for the whole file');
  const etag = whole.headers.get('etag')!;

  for (const [range, start, end] of [['bytes=100-199', 100, 199], ['bytes=4990-', 4990, 4999], ['bytes=-10', 4990, 4999], ['bytes=4000-9999', 4000, 4999]] as const) {
    upstream.calls.length = 0;
    const part = await ranged(designer, url, range);
    assert.equal(part.status, 206, range);
    assert.equal(part.headers.get('content-range'), `bytes ${start}-${end}/5000`);
    assert.equal(part.headers.get('content-length'), String(end - start + 1));
    assert.equal(part.headers.get('etag'), etag, 'parts share the whole file validator');
    assert.equal(part.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.from(await part.arrayBuffer()).equals(BIG.subarray(start, end + 1)));
    assert.deepEqual(upstream.calls.map(c => c.kind), ['detail', 'file'], 'each part looks the record up again before reading bytes');
    assert.equal(upstream.calls[1]!.range, range);
  }
});

test('If-Range, unsatisfiable and malformed ranges follow HTTP', async () => {
  const designer = await login('designer@test');
  const url = await fileUrl(designer, 'ext/ol/OL1');
  const etag = (await fetch(`${base}${url}`, { headers: { cookie: designer } })).headers.get('etag')!;
  assert.equal((await ranged(designer, url, 'bytes=0-9', { 'if-range': etag })).status, 206);
  const stale = await ranged(designer, url, 'bytes=0-9', { 'if-range': '"x-old-version"' });
  assert.equal(stale.status, 200, 'a stale validator gets the whole current file');
  assert.equal(Buffer.from(await stale.arrayBuffer()).length, 5000);

  const outside = await ranged(designer, url, 'bytes=6000-');
  assert.equal(outside.status, 416);
  assert.equal(outside.headers.get('content-range'), 'bytes */5000');
  upstream.calls.length = 0;
  assert.equal((await ranged(designer, url, 'bytes=9-2')).status, 416);
  assert.equal((await ranged(designer, url, 'bytes=0-1,5-6')).status, 416);
  assert.ok(!upstream.calls.some(c => c.kind === 'file'), 'an unusable range never reaches the upstream');
});

test('an upstream part that does not match, or ends short, is never served as complete', async () => {
  const designer = await login('designer@test');
  const url = await fileUrl(designer, 'ext/ol/OL1');
  try {
    upstream.shiftedPart = true;
    assert.equal((await ranged(designer, url, 'bytes=0-99')).status, 502);
    upstream.shiftedPart = false;
    upstream.shortPart = true;
    const short = await ranged(designer, url, 'bytes=0-99');
    assert.equal(short.status, 206);
    await assert.rejects(short.arrayBuffer(), 'the connection fails rather than ending a short part cleanly');
  } finally {
    upstream.shiftedPart = false;
    upstream.shortPart = false;
  }
  upstream.ignoreRange = true;
  try {
    const whole = await ranged(designer, url, 'bytes=0-99');
    assert.equal(whole.status, 200, 'an upstream that ignores Range yields the whole file');
    assert.equal(Buffer.from(await whole.arrayBuffer()).length, 5000);
  } finally { upstream.ignoreRange = false; }
});

test('a small cached file serves parts from memory, still behind the gates', async () => {
  const designer = await login('designer@test');
  const url = await fileUrl(designer, 'ext/ol/OL2');
  const whole = await fetch(`${base}${url}`, { headers: { cookie: designer } });
  assert.equal(whole.status, 200);
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(SMALL));
  upstream.calls.length = 0;
  const part = await ranged(designer, url, 'bytes=6-14');
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 6-14/${SMALL.length}`);
  assert.equal(await part.text(), 'rendition');
  assert.equal(upstream.calls.length, 0, 'served from the byte cache');
  const head = await fetch(`${base}${url}`, { method: 'HEAD', headers: { cookie: designer, range: 'bytes=6-14' } });
  assert.equal(head.status, 200, 'HTTP defines ranges for GET only');
  assert.equal(head.headers.get('content-range'), null);
  assert.equal(head.headers.get('content-length'), String(SMALL.length));
  const outside = await ranged(designer, url, 'bytes=500-');
  assert.equal(outside.status, 416);
  assert.equal(outside.headers.get('content-range'), `bytes */${SMALL.length}`);
  assert.equal((await ranged(await login('seller@test'), url, 'bytes=0-4')).status, 403, 'the cache never decides access');
});

test('every ranged read re-checks access and revocation', async () => {
  const designer = await login('designer@test');
  const seller = await login('seller@test');
  const big = await fileUrl(designer, 'ext/ol/OL1');
  const small = await fileUrl(designer, 'ext/ol/OL2');
  assert.equal((await ranged(designer, big, 'bytes=0-99')).status, 206);
  assert.equal((await ranged(seller, big, 'bytes=0-99')).status, 403, 'a caller outside the exposure groups gets no part');

  // Exposure narrowed between two parts of the same read.
  const rec = (await store.getProvider('ol'))!;
  await store.putProvider({ ...rec, exposure: { ...rec.exposure, groups: ['finance'] } });
  assert.equal((await ranged(designer, big, 'bytes=100-199')).status, 403);
  assert.equal((await ranged(designer, small, 'bytes=0-4')).status, 403);
  await store.putProvider(rec);
  assert.equal((await ranged(designer, big, 'bytes=100-199')).status, 206);

  // Source disabled.
  await store.putProvider({ ...rec, enabled: false });
  assert.equal((await ranged(designer, big, 'bytes=200-299')).status, 410);
  await store.putProvider(rec);

  // Asset expired locally: both the upstream part and the cached part stop.
  await setLifecycle('ext/ol/OL1', '2020-01-01T00:00:00.000Z');
  await setLifecycle('ext/ol/OL2', '2020-01-01T00:00:00.000Z');
  assert.equal((await ranged(designer, big, 'bytes=300-399')).status, 410);
  assert.equal((await ranged(designer, small, 'bytes=0-4')).status, 410);
  await setLifecycle('ext/ol/OL1', '2099-01-01T00:00:00.000Z');
  await setLifecycle('ext/ol/OL2', '2099-01-01T00:00:00.000Z');
  assert.equal((await ranged(designer, big, 'bytes=300-399')).status, 206);

  // Removed from the upstream's approved scope: the fresh lookup refuses before any byte read.
  upstream.revoked.add('OL1');
  try {
    upstream.calls.length = 0;
    assert.equal((await ranged(designer, big, 'bytes=400-499')).status, 502);
    assert.deepEqual(upstream.calls.map(c => c.kind), ['detail']);
  } finally { upstream.revoked.delete('OL1'); }
  assert.equal((await ranged(designer, big, 'bytes=400-499')).status, 206);
});

test('a pinned local copy serves parts under the same gates, whatever the driver supports', async () => {
  const admin = await login('admin@test');
  const designer = await login('designer@test');
  const url = await fileUrl(designer, 'ext/pin/p1');
  const pinned = await fetch(`${base}/api/v1/catalog/providers/pin/materialize`, { method: 'POST', headers: { cookie: admin } });
  assert.equal(pinned.status, 200);
  assert.equal((await pinned.json() as { materialized: number }).materialized, 1);

  const whole = await fetch(`${base}${url}`, { headers: { cookie: designer } });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(await whole.text(), PIN_TEXT);
  const part = await ranged(designer, url, 'bytes=7-11');
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 7-11/${PIN_TEXT.length}`);
  assert.equal(part.headers.get('etag'), whole.headers.get('etag'));
  assert.equal(await part.text(), 'local');
  const outside = await ranged(designer, url, 'bytes=999-');
  assert.equal(outside.status, 416);
  assert.equal(outside.headers.get('content-range'), `bytes */${PIN_TEXT.length}`);

  assert.equal((await ranged(await login('seller@test'), url, 'bytes=7-11')).status, 403);
  await setLifecycle('ext/pin/p1', '2020-01-01T00:00:00.000Z');
  assert.equal((await ranged(designer, url, 'bytes=7-11')).status, 410, 'an expired pin serves no part');
  await setLifecycle('ext/pin/p1', '2099-01-01T00:00:00.000Z');
});
