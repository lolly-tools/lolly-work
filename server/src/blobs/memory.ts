/**
 * In-memory BlobStore driver - tests and `npm run demo`. Holds each blob's
 * bytes in a Map; mirrors the PG driver's semantics (idempotent put, checksum
 * on write, null on unknown) so the conformance suite runs both.
 */
import { createHash } from 'node:crypto';
import { bufferToStream, readBlobBody, type BlobStat, type BlobStore } from './types.ts';

export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, { content: Buffer; stat: BlobStat }>();
  return {
    async put(blobId, body, contentType) {
      const content = await readBlobBody(body);
      const stat: BlobStat = { blobId, size: content.length, checksum: createHash('sha256').update(content).digest('hex'), contentType };
      blobs.set(blobId, { content, stat });
      return stat;
    },
    async head(blobId) {
      return blobs.get(blobId)?.stat ?? null;
    },
    async get(blobId) {
      const hit = blobs.get(blobId);
      return hit ? { body: bufferToStream(hit.content), stat: hit.stat } : null;
    },
    async delete(blobId) {
      blobs.delete(blobId);
    },
  };
}
