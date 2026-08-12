/**
 * S3 driver: hand-rolled SigV4 request shape, ListObjectsV2 XML mapping
 * (keys → slash-free remoteIds, prefix folders → sections, filenames for
 * provenance), pagination, blob streaming, and the credential format guard.
 * Injected fetch — no network, no AWS.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createS3Provider, signS3Request } from '../server/src/catalog/providers/s3.ts';

const LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>brand-assets</Name><Prefix>brand/</Prefix><KeyCount>3</KeyCount>
  <Contents><Key>brand/logos/summit 2026.svg</Key><Size>9025</Size><LastModified>2026-06-10T20:43:21.000Z</LastModified></Contents>
  <Contents><Key>brand/palettes/core.json</Key><Size>640</Size><LastModified>2026-01-02T00:00:00.000Z</LastModified></Contents>
  <Contents><Key>brand/logos/</Key><Size>0</Size></Contents>
  <NextContinuationToken>tok&amp;123</NextContinuationToken>
</ListBucketResult>`;

function capturingFetch(bodyFor: (url: string) => { body: string; type?: string } | null) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const hit = bodyFor(url);
    if (!hit) return new Response('nope', { status: 404 });
    return new Response(hit.body, { status: 200, headers: { 'content-type': hit.type ?? 'application/xml' } });
  }) as typeof fetch;
  return { impl, calls };
}

test('signS3Request: virtual-hosted URL, sorted canonical query, SigV4 authorization shape', () => {
  const signed = signS3Request({
    options: { bucket: 'brand-assets', region: 'eu-central-1' },
    accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretkey',
    query: { 'max-keys': '1', 'list-type': '2' },
    now: new Date('2026-07-22T10:00:00.000Z'),
  });
  assert.ok(signed.url.startsWith('https://brand-assets.s3.eu-central-1.amazonaws.com/?list-type=2&max-keys=1'), signed.url);
  assert.match(signed.headers['x-amz-date'] ?? '', /^20260722T100000Z$/);
  assert.match(signed.headers.authorization ?? '',
    /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260722\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  // Deterministic for a fixed instant — the signature is reproducible.
  const again = signS3Request({
    options: { bucket: 'brand-assets', region: 'eu-central-1' },
    accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secretkey',
    query: { 'list-type': '2', 'max-keys': '1' },
    now: new Date('2026-07-22T10:00:00.000Z'),
  });
  assert.equal(signed.headers.authorization, again.headers.authorization);
});

test('custom endpoint (MinIO) goes path-style under the endpoint host', () => {
  const signed = signS3Request({
    options: { bucket: 'assets', endpoint: 'https://minio.internal:9000' },
    accessKeyId: 'ak', secretAccessKey: 'sk',
  });
  assert.ok(signed.url.startsWith('https://minio.internal:9000/assets/'), signed.url);
});

test('listAssets maps XML: folder placeholders dropped, sections from prefix folders, filename carried, cursor returned', async () => {
  const { impl, calls } = capturingFetch((u) => (u.includes('list-type=2') ? { body: LIST_XML } : null));
  const s3 = createS3Provider('bucket1', { bucket: 'brand-assets', prefix: 'brand' }, 'AKIA:sk', impl);
  const page = await s3.listAssets();
  assert.equal(page.next, 'tok&123', 'XML-escaped continuation token unescaped');
  assert.equal(page.assets.length, 2, 'folder placeholder object dropped');
  const logo = page.assets[0];
  assert.equal(logo?.name, 'summit 2026');
  assert.deepEqual(logo?.sections, ['logos']);
  assert.deepEqual(logo?.formats, [{ format: 'svg', remoteRef: 'orig', filename: 'summit 2026.svg', size: 9025 }]);
  assert.equal(Buffer.from(logo?.remoteId ?? '', 'base64url').toString(), 'brand/logos/summit 2026.svg', 'remoteId is the b64url key');
  assert.ok(!logo?.remoteId.includes('/'), 'remoteId is slash-free for the ext/* path contract');
  assert.match(calls[0]?.headers.authorization ?? '', /^AWS4-HMAC-SHA256 /, 'list call is signed');
  assert.ok(calls[0]?.url.includes('prefix=brand%2F'));
});

test('resolveBlob signs a fresh GET, streams, and refuses keys outside the prefix', async () => {
  const { impl, calls } = capturingFetch((u) =>
    u.includes('/brand/logos/') ? { body: 'SVGBYTES', type: 'image/svg+xml' } : null);
  const s3 = createS3Provider('bucket1', { bucket: 'brand-assets', prefix: 'brand' }, 'AKIA:sk', impl);
  const remoteId = Buffer.from('brand/logos/summit 2026.svg').toString('base64url');
  const blob = await s3.resolveBlob(remoteId, 'orig');
  assert.equal(blob.kind, 'stream');
  if (blob.kind === 'stream') {
    assert.equal(blob.contentType, 'image/svg+xml');
    assert.equal(await new Response(blob.body).text(), 'SVGBYTES');
  }
  assert.match(calls[0]?.headers.authorization ?? '', /^AWS4-HMAC-SHA256 /);

  const outside = Buffer.from('secrets/passwords.txt').toString('base64url');
  await assert.rejects(() => s3.resolveBlob(outside, 'orig'), /outside the configured prefix/);
});

test('credential must be accessKeyId:secretAccessKey — anything else fails closed', async () => {
  const { impl } = capturingFetch(() => ({ body: LIST_XML }));
  const bad = createS3Provider('b', { bucket: 'x' }, 'no-separator', impl);
  const h = await bad.healthCheck();
  assert.equal(h.ok, false);
  assert.match(h.detail ?? '', /accessKeyId/);
  const none = createS3Provider('b', { bucket: 'x' }, undefined, impl);
  assert.equal((await none.healthCheck()).ok, false);
});
