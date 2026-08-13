/**
 * Shared BlobStore conformance — run by the memory driver here and (when
 * LW_TEST_DATABASE_URL is set) by the PG driver in tests/store-postgres.test.ts,
 * so both prove identical semantics: checksum on write, idempotent overwrite,
 * stream round-trip, null on unknown, idempotent delete.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { BlobStore } from '../server/src/blobs/types.ts';

async function drain(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(body).arrayBuffer());
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

  // idempotent overwrite: same id, new content → new stat, old bytes gone.
  const over = await store.put('b1', Buffer.from('replaced'), 'text/plain');
  assert.notEqual(over.checksum, sha);
  assert.equal((await drain((await store.get('b1'))!.body)).toString('utf8'), 'replaced');

  await store.delete('b1');
  assert.equal(await store.get('b1'), null, 'deleted blob is gone');
  await store.delete('b1'); // idempotent — no throw
}
