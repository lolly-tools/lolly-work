/**
 * In-memory BlobStore driver - tests and `pnpm run demo`. Holds each blob's
 * bytes in a Map; mirrors the PG driver's semantics (idempotent put, checksum
 * on write, null on unknown) so the conformance suite runs both.
 */
import { bufferToStream, createReadTally, readPutBody, usageMonth, type BlobStat, type BlobStore } from './types.ts';

export function createMemoryBlobStore(): BlobStore {
  const blobs = new Map<string, { content: Buffer; stat: BlobStat }>();
  const reads = createReadTally();
  return {
    driver: 'memory',
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
      if (!hit) return null;
      reads.add(hit.content.length);
      return { body: bufferToStream(hit.content), stat: hit.stat };
    },
    async delete(blobId) {
      blobs.delete(blobId);
    },
    async usage() {
      let storedBytes = 0;
      for (const { content } of blobs.values()) storedBytes += content.length;
      const month = usageMonth();
      return { driver: 'memory', storedBytes, readBytesTotal: reads.total(), month, monthReadBytes: reads.month(month) };
    },
    async claimUsageNotice(month, kind) {
      return reads.claim(month, kind);
    },
  };
}
