/**
 * BlobStore - a deliberately small byte-storage seam BESIDE `Store` (plans/26:
 * records and blobs have different drivers and different lifetimes). Records live
 * in the SQL store; opaque byte content - instance-owned catalog assets
 * materialized out of a DAM (plans/27), and later plans/26's collab staging -
 * lives here, addressed by a caller-chosen `blobId`.
 *
 * Drivers: `memory` (tests), `postgres` (the zero-moving-parts default - PG works
 * everywhere the plane runs, the easy-deploy goal), and `s3` (any
 * S3-compatible store: AWS, MinIO, Ceph RGW - the media-sized-estate + air-gap
 * story, a config flip, not an architecture change). The memory and Postgres
 * drivers hold a blob whole to hash and store it, so Postgres caps its size
 * (postgres.ts). The S3 driver streams: it holds one part at a time and sends a
 * larger body as a multipart upload (s3.ts). Every driver hashes the bytes it
 * writes, and a put that declares a size or sha256 stores nothing when the body
 * disagrees, leaving any earlier blob under that id in place.
 */
import { createHash } from 'node:crypto';

export interface BlobStat {
  blobId: string;
  size: number;
  /** sha256 hex of the stored content - stamped onto served inst/* format
   *  entries so the OSS shell can verify integrity + price offline pins.
   *  An S3 object stored without its sha256 (one written before the driver
   *  recorded it, or a multipart stream with no declared sha256) reports its
   *  ETag here instead, which is not a content digest. */
  checksum: string;
  contentType: string;
}

/** What a caller already knows about the bytes it stores. */
export interface BlobPutOptions {
  /** Exact byte length. Reading stops one byte past it. */
  size?: number;
  /** sha256 hex of the whole body. The S3 driver also records it on the
   *  object before a multipart upload starts. */
  sha256?: string;
}

export interface BlobStore {
  /** Store `body` under `blobId` (caller-chosen, unique), computing checksum +
   *  size. Idempotent overwrite - re-materializing the same asset is safe. A
   *  failed or refused put leaves the previous blob in place. */
  put(blobId: string, body: BlobBody, contentType: string, declared?: BlobPutOptions): Promise<BlobStat>;
  head(blobId: string): Promise<BlobStat | null>;
  /** Stream bytes out with their stat, or null when the blob is unknown. */
  get(blobId: string): Promise<{ body: ReadableStream<Uint8Array>; stat: BlobStat } | null>;
  /** Idempotent - deleting an unknown blob is a no-op. */
  delete(blobId: string): Promise<void>;
}

export type BlobBody = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array;

/** A body that ran past a byte limit. The message is the one callers have
 *  always seen from `readBlobBody`. */
export class BlobLimitError extends Error {
  constructor(message = 'blob exceeds the byte limit') { super(message); this.name = 'BlobLimitError'; }
}

/** A put whose body disagreed with its declared size or sha256. */
export class BlobMismatchError extends Error {
  readonly code = 'BLOB_MISMATCH';
  readonly field: 'size' | 'sha256';
  constructor(field: 'size' | 'sha256') {
    super(`blob ${field} does not match the declared value`);
    this.name = 'BlobMismatchError';
    this.field = field;
  }
}

/** Refuse bytes whose size or sha256 differs from what the caller declared. */
export function checkDeclared(size: number, sha256: string, declared: BlobPutOptions | undefined): void {
  if (declared?.size !== undefined && declared.size !== size) throw new BlobMismatchError('size');
  if (declared?.sha256 !== undefined && declared.sha256.toLowerCase() !== sha256) throw new BlobMismatchError('sha256');
}

/** The non-empty chunks of a streamed body, in order. Stopping early cancels
 *  a ReadableStream so its source is released. */
export async function* blobChunks(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (typeof (body as ReadableStream<Uint8Array>).getReader !== 'function') {
    for await (const chunk of body as AsyncIterable<Uint8Array>) if (chunk.byteLength) yield chunk;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { done = true; return; }
      if (next.value?.byteLength) yield next.value;
    }
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Drain any supported body shape into one Buffer (see the buffering note above).
 * `maxBytes` lets request-driven callers stop a streaming response before it can
 * become an unbounded allocation; trusted internal blob reads omit it. */
export async function readBlobBody(body: BlobBody, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new BlobLimitError();
    return Buffer.from(body);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let page = new Uint8Array(64 * 1024), used = 0;
  for await (const chunk of blobChunks(body)) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new BlobLimitError();
    for (let offset = 0; offset < chunk.byteLength;) {
      const count = Math.min(page.length - used, chunk.byteLength - offset);
      page.set(chunk.subarray(offset, offset + count), used); used += count; offset += count;
      if (used === page.length) { chunks.push(page); page = new Uint8Array(64 * 1024); used = 0; }
    }
  }
  if (used) chunks.push(page.subarray(0, used));
  return Buffer.concat(chunks, total);
}

/** Read a put body whole for a driver that buffers it (memory, Postgres): no
 *  further than the declared size or the driver's `ceiling`, and checked
 *  against the declared size and sha256 before the caller stores anything. */
export async function readPutBody(
  body: BlobBody, declared: BlobPutOptions | undefined, ceiling = Number.POSITIVE_INFINITY,
): Promise<{ content: Buffer; checksum: string }> {
  const limit = Math.min(ceiling, declared?.size ?? Number.POSITIVE_INFINITY);
  let content: Buffer;
  try {
    content = await readBlobBody(body, limit);
  } catch (error) {
    if (error instanceof BlobLimitError && limit < ceiling) throw new BlobMismatchError('size');
    throw error;
  }
  const checksum = createHash('sha256').update(content).digest('hex');
  checkDeclared(content.length, checksum, declared);
  return { content, checksum };
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
