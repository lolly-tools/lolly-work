/**
 * BlobStore - the memory driver against the shared conformance suite. The PG
 * driver runs the same suite in the postgres test when a database is present.
 */
import { test } from 'node:test';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { blobStoreConformance } from './blobstore-conformance.ts';

test('memory BlobStore passes the conformance suite', async () => {
  await blobStoreConformance(createMemoryBlobStore());
});
