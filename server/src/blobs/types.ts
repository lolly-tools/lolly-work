/**
 * BlobStore - a deliberately small byte-storage seam BESIDE `Store` (plans/26 §2:
 * records and blobs have different drivers and different lifetimes). Records live
 * in the SQL store; opaque byte content - instance-owned catalog assets
 * materialized out of a DAM (plans/27 §5), and later plans/26's collab staging - 
 * lives here, addressed by a caller-chosen `blobId`.
 *
 * Drivers: `memory` (tests), `postgres` (the zero-moving-parts default - PG works
 * everywhere the plane runs, the easy-deploy goal), and `s3` (any
 * S3-compatible store: AWS, MinIO, Ceph RGW - the media-sized-estate + air-gap
 * story, a config flip, not an architecture change). The write path buffers the
 * blob to compute a sha256 checksum + size: materialization is admin-triggered,
 * one asset at a time, so a full buffer is acceptable (plans/26 makes the same
 * "a part is buffered, 4 MiB is fine" call for its chunked relay).
 */
export interface BlobStat {
  blobId: string;
  size: number;
  /** sha256 hex of the stored content - stamped onto served inst/* format
   *  entries so the OSS shell can verify integrity + price offline pins. */
  checksum: string;
  contentType: string;
}

export interface BlobStore {
  /** Store `body` under `blobId` (caller-chosen, unique), computing checksum +
   *  size. Idempotent overwrite - re-materializing the same asset is safe. */
  put(blobId: string, body: BlobBody, contentType: string): Promise<BlobStat>;
  head(blobId: string): Promise<BlobStat | null>;
  /** Stream bytes out with their stat, or null when the blob is unknown. */
  get(blobId: string): Promise<{ body: ReadableStream<Uint8Array>; stat: BlobStat } | null>;
  /** Idempotent - deleting an unknown blob is a no-op. */
  delete(blobId: string): Promise<void>;
}

export type BlobBody = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array;

/** Drain any supported body shape into one Buffer (see the buffering note above). */
export async function readBlobBody(body: BlobBody): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Uint8Array[] = [];
  if (typeof (body as ReadableStream<Uint8Array>).getReader === 'function') {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } else {
    for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** Wrap a buffer as a one-shot web ReadableStream (the read path for the
 *  in-memory + PG drivers, which hold the whole blob). */
export function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}
