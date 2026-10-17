/**
 * BlobStore - the memory driver against the shared conformance suite, and the
 * PG driver too when a disposable database is present. The S3 driver runs the
 * same suite against an S3 double in tests/s3-blobstore.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { BlobLimitError, BlobMismatchError, readPutBody } from '../server/src/blobs/types.ts';
import { blobStoreConformance } from './blobstore-conformance.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const pgUrl = process.env.LW_TEST_DATABASE_URL;

test('memory BlobStore passes the conformance suite', async () => {
  await blobStoreConformance(createMemoryBlobStore());
});

test('Postgres BlobStore passes the conformance suite', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl!, async () => {
    const { createPostgresBlobStore } = await import('../server/src/blobs/postgres.ts');
    const blobs = await createPostgresBlobStore(pgUrl!);
    try {
      await blobStoreConformance(blobs);
    } finally {
      await blobs.close();
    }
  });
});

test('a buffering driver stops at its ceiling, and a declared size stops it sooner', async () => {
  let pulled = 0;
  async function* endless(): AsyncGenerator<Uint8Array> {
    for (;;) { pulled += 4; yield new Uint8Array(4); }
  }
  // The Postgres driver's ceiling is a limit, not a mismatch: nothing was declared.
  await assert.rejects(readPutBody(endless(), undefined, 10), (error: unknown) => error instanceof BlobLimitError);
  assert.equal(pulled, 12, 'reading stops at the first chunk past the ceiling');
  // A declared size under the ceiling makes an over-long body a mismatch.
  await assert.rejects(readPutBody(endless(), { size: 6 }, 10), (error: unknown) => error instanceof BlobMismatchError && error.field === 'size');
  await assert.rejects(readPutBody(new Uint8Array(11), { size: 6 }, 10), (error: unknown) => error instanceof BlobMismatchError);
  await assert.rejects(readPutBody(new Uint8Array(11), undefined, 10), (error: unknown) => error instanceof BlobLimitError);
  const { content, checksum } = await readPutBody(new Uint8Array([1, 2, 3]), { size: 3 }, 10);
  assert.equal(content.length, 3);
  assert.match(checksum, /^[0-9a-f]{64}$/);
});
