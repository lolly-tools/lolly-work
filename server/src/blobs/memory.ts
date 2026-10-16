/**
 * In-memory BlobStore driver - tests and `pnpm run demo`. Holds each blob's
 * bytes in a Map; mirrors the PG driver's semantics (idempotent put, checksum
 * on write, null on unknown) so the conformance suite runs both.
 */
import { bufferToStream, readPutBody, type BlobStat, type BlobStore } from './types.ts';

export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, { content: Buffer; stat: BlobStat }>();
  return {
    async put(blobId, body, contentType, declared) {
      const { content, checksum } = await readPutBody(body, declared);
      const stat: BlobStat = { blobId, size: content.length, checksum, contentType };
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
