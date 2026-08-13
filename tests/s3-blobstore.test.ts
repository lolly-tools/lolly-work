/**
 * S3 BlobStore driver (plans/27 §5) with injected fetch, no network: put signs a
 * PUT with the body's payload hash and streams it; get/head/delete sign
 * GET/HEAD/DELETE; a 404 head is null; a missing credential fails closed. Proves
 * the hand-rolled SigV4 core grew to signed writes without an SDK.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createS3BlobStore } from '../server/src/blobs/s3.ts';

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

test('get streams the object back with its stat', async () => {
  const { fetchImpl } = recorder(() => new Response('the bytes', { status: 200, headers: { 'content-length': '9', 'content-type': 'image/png', etag: '"abc123"' } }));
  const store = createS3BlobStore(CONFIG, CRED, fetchImpl);
  const got = await store.get('inst/abc/png');
  assert.ok(got);
  assert.equal(got.stat.size, 9);
  assert.equal(got.stat.contentType, 'image/png');
  assert.equal(await new Response(got.body).text(), 'the bytes');
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
