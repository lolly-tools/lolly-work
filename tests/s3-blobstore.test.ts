/**
 * S3 BlobStore driver (plans/27) with injected fetch, no network: put signs a
 * PUT with the body's payload hash and streams it; get/head/delete sign
 * GET/HEAD/DELETE; a 404 head is null; a missing credential fails closed. Proves
 * the hand-rolled SigV4 core grew to signed writes without an SDK.
 *
 * The multipart tests run against an in-process S3 double that makes the checks
 * S3 makes on every request: the body hashes to the signed payload hash, every
 * x-amz-* header is signed, and every part but the last is at least 5 MiB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createS3BlobStore } from '../server/src/blobs/s3.ts';
import { BlobMismatchError } from '../server/src/blobs/types.ts';
import { signS3Request } from '../server/src/catalog/providers/s3.ts';
import { blobStoreConformance } from './blobstore-conformance.ts';

interface Seen { url: string; method: string; headers: Record<string, string>; body?: unknown }

function recorder(handler: (s: Seen) => Response): { fetchImpl: typeof fetch; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const seen: Seen = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers as Record<string, string>) ?? {}, body: init?.body };
    calls.push(seen);
    return handler(seen);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const CONFIG = { bucket: 'lolly-assets', region: 'us-east-1', prefix: 'inst' };
const CRED = 'AKIAEXAMPLE:secretkey/example';
const MIB = 1024 * 1024;
const PART = 5 * MIB;
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const md5 = (bytes: Uint8Array): string => createHash('md5').update(bytes).digest('hex');

interface S3Request { method: string; key: string; query: URLSearchParams; headers: Record<string, string>; body: Buffer }
interface StoredObject { bytes: Buffer; contentType: string; etag: string; sha256?: string }

/** An in-process S3 for one bucket, path-style under https://s3.test. */
function s3Double(hooks: { onRequest?: (r: S3Request) => Response | undefined } = {}) {
  const objects = new Map<string, StoredObject>();
  const uploads = new Map<string, { key: string; contentType: string; sha256?: string; parts: Map<number, Buffer> }>();
  const requests: S3Request[] = [];
  let nextUpload = 0;
  const xml = (status: number, body: string): Response => new Response(body, { status, headers: { 'content-type': 'application/xml' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    const r: S3Request = { method: init?.method ?? 'GET', key: decodeURIComponent(url.pathname.replace(/^\/lolly-assets\//, '')), query: url.searchParams, headers, body };
    requests.push(r);
    if (headers['x-amz-content-sha256'] !== sha256(body)) return xml(400, '<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
    const signed = /SignedHeaders=([^,]+)/.exec(headers.authorization ?? '')?.[1]?.split(';') ?? [];
    const unsigned = Object.keys(headers).filter((h) => (h.startsWith('x-amz-') || h === 'content-type') && !signed.includes(h));
    if (unsigned.length) return xml(403, `<Error><Code>AccessDenied</Code><Message>unsigned ${unsigned.join(',')}</Message></Error>`);
    const hooked = hooks.onRequest?.(r);
    if (hooked) return hooked;

    const uploadId = url.searchParams.get('uploadId');
    if (r.method === 'POST' && url.searchParams.has('uploads')) {
      const id = `upload-${++nextUpload}&more`;
      uploads.set(id, { key: r.key, contentType: headers['content-type'] ?? 'binary/octet-stream', ...(headers['x-amz-meta-sha256'] ? { sha256: headers['x-amz-meta-sha256'] } : {}), parts: new Map() });
      return xml(200, `<InitiateMultipartUploadResult><Key>${r.key}</Key><UploadId>${id.replace('&', '&amp;')}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (uploadId !== null) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== r.key) return xml(404, '<Error><Code>NoSuchUpload</Code></Error>');
      if (r.method === 'PUT') {
        upload.parts.set(Number(url.searchParams.get('partNumber')), body);
        return new Response(null, { status: 200, headers: { etag: `"${md5(body)}"` } });
      }
      if (r.method === 'DELETE') { uploads.delete(uploadId); return new Response(null, { status: 204 }); }
      const listed = [...body.toString('utf8').matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag><\/Part>/g)];
      const parts = listed.map(([, n, etag]) => ({ n: Number(n), etag: etag!.replace(/&quot;/g, '"'), bytes: upload.parts.get(Number(n)) }));
      if (!parts.length || parts.some((p, i) => p.n !== i + 1 || !p.bytes || p.etag !== `"${md5(p.bytes)}"`)) return xml(400, '<Error><Code>InvalidPart</Code></Error>');
      if (parts.slice(0, -1).some((p) => p.bytes!.length < PART)) return xml(400, '<Error><Code>EntityTooSmall</Code></Error>');
      const bytes = Buffer.concat(parts.map((p) => p.bytes!));
      const etag = `"${md5(Buffer.concat(parts.map((p) => Buffer.from(md5(p.bytes!), 'hex'))))}-${parts.length}"`;
      objects.set(r.key, { bytes, contentType: upload.contentType, etag, ...(upload.sha256 ? { sha256: upload.sha256 } : {}) });
      uploads.delete(uploadId);
      return xml(200, `<CompleteMultipartUploadResult><Key>${r.key}</Key><ETag>${etag}</ETag></CompleteMultipartUploadResult>`);
    }
    if (r.method === 'PUT') {
      const etag = `"${md5(body)}"`;
      objects.set(r.key, { bytes: body, contentType: headers['content-type'] ?? 'binary/octet-stream', etag, ...(headers['x-amz-meta-sha256'] ? { sha256: headers['x-amz-meta-sha256'] } : {}) });
      return new Response(null, { status: 200, headers: { etag } });
    }
    if (r.method === 'DELETE') { objects.delete(r.key); return new Response(null, { status: 204 }); }
    const object = objects.get(r.key);
    if (!object) return new Response(null, { status: 404 });
    const meta = { 'content-length': String(object.bytes.length), 'content-type': object.contentType, etag: object.etag,
      ...(object.sha256 ? { 'x-amz-meta-sha256': object.sha256 } : {}) };
    return new Response(r.method === 'HEAD' ? null : object.bytes, { status: 200, headers: meta });
  }) as typeof fetch;
  const store = (partBytes = PART) => createS3BlobStore({ bucket: 'lolly-assets', endpoint: 'https://s3.test', prefix: 'inst' }, CRED, fetchImpl, { partBytes });
  const partPuts = () => requests.filter((r) => r.method === 'PUT' && r.query.has('partNumber'));
  return { fetchImpl, objects, uploads, requests, store, partPuts };
}

/** `total` deterministic bytes in `chunk`-sized pieces, counting what was pulled. */
function source(total: number, chunk = 64 * 1024) {
  const all = Buffer.alloc(total);
  for (let i = 0; i < total; i++) all[i] = (i * 31 + (i >> 13)) & 0xff;
  const state = { pulled: 0 };
  async function* body(): AsyncGenerator<Uint8Array> {
    for (let offset = 0; offset < total; offset += chunk) {
      const piece = all.subarray(offset, Math.min(offset + chunk, total));
      state.pulled += piece.length;
      yield piece;
    }
  }
  return { all, state, body };
}

test('put signs a PUT with the body payload hash and returns the checksum', async () => {
  const content = Buffer.from('materialized png bytes');
  const sha = createHash('sha256').update(content).digest('hex');
  const { fetchImpl, calls } = recorder(() => new Response('', { status: 200 }));
  const store = createS3BlobStore(CONFIG, CRED, fetchImpl);

  const stat = await store.put('inst/abc/png', content, 'image/png');
  assert.equal(stat.checksum, sha);
  assert.equal(stat.size, content.length);

  const put = calls[0]!;
  assert.equal(put.method, 'PUT');
  const u = new URL(put.url);
  assert.ok(u.hostname.startsWith('lolly-assets.'), 'virtual-hosted bucket');
  assert.equal(u.pathname, '/inst/inst/abc/png', 'key is <prefix>/<blobId>');
  assert.equal(put.headers['x-amz-content-sha256'], sha, 'the signed payload hash is the body hash, not empty');
  assert.match(put.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//, 'SigV4 signed');
});

test('a single PUT records its sha256 on the object and signs every header it sends', async () => {
  const content = Buffer.from('materialized png bytes');
  const { fetchImpl, calls } = recorder(() => new Response('', { status: 200 }));
  await createS3BlobStore(CONFIG, CRED, fetchImpl).put('inst/abc/png', content, 'image/png');
  const put = calls[0]!;
  assert.equal(put.headers['x-amz-meta-sha256'], sha256(content));
  assert.equal(put.headers['content-type'], 'image/png');
  assert.match(put.headers.authorization ?? '', /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256,/);
  assert.equal(calls.length, 1, 'a body within one part is one request');
});

test('signS3Request signs extra headers by lowercase name and leaves the default set alone', () => {
  const base = { options: { bucket: 'b', region: 'eu-central-1' }, accessKeyId: 'ak', secretAccessKey: 'sk', key: 'k', method: 'PUT', now: new Date('2026-10-16T10:00:00.000Z') };
  const plain = signS3Request(base);
  assert.match(plain.headers.authorization ?? '', /SignedHeaders=host;x-amz-content-sha256;x-amz-date,/);
  const extra = signS3Request({ ...base, headers: { 'Content-Type': ' image/png ', 'X-Amz-Meta-Sha256': 'abc' } });
  assert.match(extra.headers.authorization ?? '', /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256,/);
  assert.equal(extra.headers['content-type'], 'image/png');
  assert.equal(extra.headers['x-amz-meta-sha256'], 'abc');
  assert.notEqual(extra.headers.authorization, plain.headers.authorization);
  // Inner whitespace runs collapse to one space in the signed and sent value.
  const spaced = signS3Request({ ...base, headers: { 'Content-Type': 'text/plain;  charset=utf-8' } });
  const single = signS3Request({ ...base, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  assert.equal(spaced.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(spaced.headers.authorization, single.headers.authorization);
});

test('get streams the object back with its stat', async () => {
  const { fetchImpl } = recorder(() => new Response('the bytes', { status: 200, headers: { 'content-length': '9', 'content-type': 'image/png', etag: '"abc123"' } }));
  const store = createS3BlobStore(CONFIG, CRED, fetchImpl);
  const got = await store.get('inst/abc/png');
  assert.ok(got);
  assert.equal(got.stat.size, 9);
  assert.equal(got.stat.contentType, 'image/png');
  assert.equal(await new Response(got.body).text(), 'the bytes');
});

test('head reports the recorded sha256, and the ETag for an object without one', async () => {
  const sha = sha256('the bytes');
  const recorded = recorder(() => new Response(null, { status: 200, headers: { 'content-length': '9', etag: '"abc123"', 'x-amz-meta-sha256': sha } }));
  assert.equal((await createS3BlobStore(CONFIG, CRED, recorded.fetchImpl).head('inst/a'))?.checksum, sha);
  const older = recorder(() => new Response(null, { status: 200, headers: { 'content-length': '9', etag: '"abc123"' } }));
  assert.equal((await createS3BlobStore(CONFIG, CRED, older.fetchImpl).head('inst/a'))?.checksum, 'abc123');
});

test('head returns null on 404, delete tolerates a missing key', async () => {
  const notFound = recorder(() => new Response('', { status: 404 }));
  const store = createS3BlobStore(CONFIG, CRED, notFound.fetchImpl);
  assert.equal(await store.head('inst/gone'), null);
  await store.delete('inst/gone'); // no throw on 404
  assert.equal(notFound.calls.at(-1)?.method, 'DELETE');
});

test('a missing credential fails closed', async () => {
  const { fetchImpl } = recorder(() => new Response('', { status: 200 }));
  const store = createS3BlobStore(CONFIG, undefined, fetchImpl);
  await assert.rejects(() => store.put('inst/x/png', Buffer.from('x'), 'image/png'), /credential/);
});

test('the S3 driver passes the shared conformance suite against the S3 double', async () => {
  await blobStoreConformance(s3Double().store());
});

test('a streamed body larger than one part goes up in parts, holding one part at a time', async () => {
  const { all, state, body } = source(2 * PART + MIB + 123);
  const pulledAtPart: number[] = [];
  const watched = s3Double({ onRequest: (r) => { if (r.query.has('partNumber')) pulledAtPart.push(state.pulled); return undefined; } });
  const stat = await watched.store().put('video/mp4', body(), 'video/mp4');
  assert.deepEqual(stat, { blobId: 'video/mp4', size: all.length, checksum: sha256(all), contentType: 'video/mp4' });

  const parts = watched.partPuts();
  assert.deepEqual(parts.map((p) => p.body.length), [PART, PART, MIB + 123]);
  assert.deepEqual(parts.map((p) => p.query.get('partNumber')), ['1', '2', '3']);
  assert.ok(parts.every((p) => p.query.get('uploadId') === 'upload-1&more'), 'the upload id is unescaped from the XML and re-encoded in the query');
  // Part n goes out once its bytes are in, with at most one chunk read ahead:
  // a streamed body is never held whole.
  pulledAtPart.forEach((pulled, n) => assert.ok(pulled <= (n + 1) * PART + 64 * 1024, `part ${n + 1} sent after ${pulled} bytes pulled`));

  const start = watched.requests.find((r) => r.query.has('uploads'))!;
  assert.equal(start.headers['content-type'], 'video/mp4');
  assert.equal(start.headers['x-amz-meta-sha256'], undefined, 'an undeclared stream has no sha256 to record up front');
  const stored = watched.objects.get('inst/video/mp4')!;
  assert.deepEqual(stored.bytes, all, 'the parts reassemble to the exact bytes');
  assert.equal(watched.uploads.size, 0);
  const head = await watched.store().head('video/mp4');
  assert.equal(head?.size, all.length);
  assert.match(head?.checksum ?? '', /^[0-9a-f]{32}-3$/, 'without a recorded sha256 the ETag is reported');
});

test('a declared sha256 is recorded on a multipart object, and a body that disagrees is aborted', async () => {
  const s3 = s3Double();
  const store = s3.store();
  const first = source(PART + 10);
  const stat = await store.put('clip', first.body(), 'video/mp4', { size: first.all.length, sha256: sha256(first.all) });
  assert.equal(stat.checksum, sha256(first.all));
  assert.deepEqual(await store.head('clip'), stat, 'head reports the declared and verified sha256');

  const second = source(PART + 10);
  second.all[0] = second.all[0]! ^ 1; // the stream now differs from its declaration
  const before = s3.requests.length;
  await assert.rejects(store.put('clip', second.body(), 'video/mp4', { sha256: sha256(first.all) }),
    (error: unknown) => error instanceof BlobMismatchError && error.field === 'sha256');
  const tried = s3.requests.slice(before);
  assert.ok(tried.some((r) => r.method === 'DELETE' && r.query.has('uploadId')), 'the upload is aborted');
  assert.ok(!tried.some((r) => r.method === 'POST' && r.query.has('uploadId')), 'and never completed');
  assert.equal(s3.uploads.size, 0);
  assert.deepEqual(s3.objects.get('inst/clip')?.bytes, first.all, 'the earlier object is untouched');
});

test('an in-memory body over one part records its sha256 before the upload starts', async () => {
  const s3 = s3Double();
  const { all } = source(PART * 2);
  const stat = await s3.store().put('big', all, 'application/octet-stream');
  assert.equal(stat.checksum, sha256(all));
  assert.equal(s3.requests.find((r) => r.query.has('uploads'))?.headers['x-amz-meta-sha256'], sha256(all));
  assert.deepEqual(s3.partPuts().map((p) => p.body.length), [PART, PART], 'a body ending on a part boundary sends no empty part');
  assert.equal((await s3.store().head('big'))?.checksum, sha256(all));
});

test('a streamed body ending on a part boundary, and an empty one, still finish', async () => {
  const s3 = s3Double();
  const exact = source(PART * 2, 1000);
  assert.equal((await s3.store().put('exact', exact.body(), 'x/y')).checksum, sha256(exact.all));
  assert.deepEqual(s3.partPuts().map((p) => p.body.length), [PART, PART]);
  const empty = await s3.store().put('empty', (async function* () {})(), 'x/y');
  assert.deepEqual(empty, { blobId: 'empty', size: 0, checksum: sha256(''), contentType: 'x/y' });
  assert.equal(s3.objects.get('inst/empty')?.bytes.length, 0);
});

test('a part that fails with a 5xx is retried; a refused part aborts the upload', async () => {
  let failures = 1;
  const flaky = s3Double({ onRequest: (r) => (r.query.get('partNumber') === '2' && failures-- > 0 ? new Response('slow down', { status: 503 }) : undefined) });
  const { all, body } = source(2 * PART + 1);
  assert.equal((await flaky.store().put('retry', body(), 'x/y')).checksum, sha256(all));
  assert.deepEqual(flaky.partPuts().map((p) => p.query.get('partNumber')), ['1', '2', '2', '3']);

  const refused = s3Double({ onRequest: (r) => (r.query.get('partNumber') === '2' ? new Response('no', { status: 403 }) : undefined) });
  await assert.rejects(refused.store().put('refused', source(2 * PART + 1).body(), 'x/y'), /s3 blob part 2 403/);
  assert.equal(refused.partPuts().filter((p) => p.query.get('partNumber') === '2').length, 1, 'a 4xx is not retried');
  assert.ok(refused.requests.some((r) => r.method === 'DELETE' && r.query.has('uploadId')));
  assert.equal(refused.uploads.size, 0);
  assert.equal(refused.objects.has('inst/refused'), false);
});

test('a CompleteMultipartUpload answered 200 with an error body is a failure', async () => {
  const s3 = s3Double({ onRequest: (r) => (r.method === 'POST' && r.query.has('uploadId') ? new Response('<Error><Code>InternalError</Code></Error>', { status: 200 }) : undefined) });
  await assert.rejects(s3.store().put('late', source(PART + 1).body(), 'x/y'), /multipart complete 200/);
  assert.ok(s3.requests.some((r) => r.method === 'DELETE' && r.query.has('uploadId')));
  assert.equal(s3.objects.has('inst/late'), false);
});

test('parts are never smaller than S3 accepts, and a known length grows them to fit 10,000', async () => {
  const s3 = s3Double();
  const tiny = s3.store(1024); // a part size under 5 MiB is raised to 5 MiB
  await tiny.put('floor', source(PART + 1).all, 'x/y');
  assert.deepEqual(s3.partPuts().map((p) => p.body.length), [PART, 1]);

  // 70,000 MiB declared needs 7 MiB parts to fit in 10,000. The body is cut
  // short, so the upload is refused at the end and aborted.
  const grown = s3Double();
  await assert.rejects(grown.store().put('huge', source(7 * MIB + 1).body(), 'x/y', { size: 70_000 * MIB }),
    (error: unknown) => error instanceof BlobMismatchError && error.field === 'size');
  assert.deepEqual(grown.partPuts().map((p) => p.body.length), [7 * MIB, 1]);
  assert.equal(grown.uploads.size, 0);
});
