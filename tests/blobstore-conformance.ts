/**
 * Shared BlobStore conformance - run by the memory driver, by the S3 driver
 * against an in-process S3 double, and (when LW_TEST_DATABASE_URL is set) by the
 * PG driver, all in tests/blobstore.test.ts and tests/s3-blobstore.test.ts, so
 * each proves identical semantics: checksum on write, idempotent overwrite,
 * stream round-trip, declared size and sha256 refused without touching the
 * stored blob, null on unknown, idempotent delete.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BlobMismatchError, type BlobStore } from '../server/src/blobs/types.ts';

async function drain(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer());
}

async function* pieces(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

export async function blobStoreConformance(store: BlobStore): Promise<void> {
  const bytes = Buffer.from('the quick brown fox');
  const sha = createHash('sha256').update(bytes).digest('hex');

  assert.equal(await store.head('nope'), null, 'unknown blob heads null');
  assert.equal(await store.get('nope'), null, 'unknown blob gets null');

  const stat = await store.put('b1', bytes, 'text/plain');
  assert.equal(stat.size, bytes.length);
  assert.equal(stat.checksum, sha, 'checksum is sha256 of the content');
  assert.equal(stat.contentType, 'text/plain');

  const head = await store.head('b1');
  assert.deepEqual(head, stat, 'head matches the put stat');

  const got = await store.get('b1');
  assert.ok(got);
  assert.deepEqual(got.stat, stat);
  assert.equal((await drain(got.body)).toString('utf8'), 'the quick brown fox', 'bytes round-trip verbatim');

  // put accepts a web ReadableStream too (the shape resolveBlob hands back).
  const streamed = await store.put('b2', new Response('streamed bytes').body as ReadableStream<Uint8Array>, 'application/octet-stream');
  assert.equal(streamed.checksum, createHash('sha256').update('streamed bytes').digest('hex'));
  // ...and any async iterable of chunks.
  const iterated = await store.put('b3', pieces('streamed ', 'in ', 'pieces'), 'text/plain', { size: 18 });
  assert.deepEqual(iterated, { blobId: 'b3', size: 18, checksum: createHash('sha256').update('streamed in pieces').digest('hex'), contentType: 'text/plain' });

  // A declared size and sha256 that match are accepted as they stand.
  assert.deepEqual(await store.put('b1', bytes, 'text/plain', { size: bytes.length, sha256: sha.toUpperCase() }), stat);
  // Bytes that disagree with the declaration are refused, and the blob already
  // stored under that id is untouched.
  await assert.rejects(store.put('b1', Buffer.from('tampered'), 'text/plain', { sha256: sha }),
    (error: unknown) => error instanceof BlobMismatchError && error.field === 'sha256');
  await assert.rejects(store.put('b1', pieces('far too ', 'long'), 'text/plain', { size: 7 }),
    (error: unknown) => error instanceof BlobMismatchError && error.field === 'size');
  await assert.rejects(store.put('b1', pieces('short'), 'text/plain', { size: 9 }),
    (error: unknown) => error instanceof BlobMismatchError && error.field === 'size');
  assert.deepEqual(await store.head('b1'), stat, 'a refused put leaves the stored blob in place');
  assert.equal((await drain((await store.get('b1'))!.body)).toString('utf8'), 'the quick brown fox');

  // idempotent overwrite: same id, new content → new stat, old bytes gone.
  const over = await store.put('b1', Buffer.from('replaced'), 'text/plain');
  assert.notEqual(over.checksum, sha);
  assert.equal((await drain((await store.get('b1'))!.body)).toString('utf8'), 'replaced');

  await store.delete('b1');
  assert.equal(await store.get('b1'), null, 'deleted blob is gone');
  await store.delete('b1'); // idempotent - no throw
}
