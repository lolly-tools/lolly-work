/**
 * S3 BlobStore driver (plans/27) - instance-owned catalog bytes on any
 * S3-compatible store (AWS, MinIO, Ceph RGW): the media-sized-estate and air-gap
 * story, a `blobs.driver: 's3'` config flip rather than an architecture change.
 * Zero-dep, reusing the hand-rolled SigV4 core from the S3 catalog *provider*
 * (`providers/s3.ts`) grown to signed writes - no AWS SDK.
 *
 * A blob's key is `<prefix>/<blobId>`; objects are private and every request is
 * freshly signed. `put` streams: it holds one part at a time, sends a body that
 * fits in one part as a single PUT and a larger one as a multipart upload. A
 * multipart upload that fails or is refused is aborted, and the object already
 * under the key stays until a CompleteMultipartUpload replaces it. Every request
 * signs the sha256 of its own body as the payload hash, so the store refuses a
 * part changed in transit, and the whole-body sha256 is computed as parts go out.
 *
 * That sha256 is recorded on the object as `x-amz-meta-sha256` whenever it is
 * known before the object is created: for every single PUT and in-memory body,
 * and for a streamed multipart body when the caller declares it (checked before
 * the upload completes). `head`/`get` report it as the checksum. An object
 * without it reports its ETag, which is not a content digest.
 */
import { createHash } from 'node:crypto';
import { blobChunks, BlobMismatchError, checkDeclared, type BlobBody, type BlobStat, type BlobStore } from './types.ts';
import { signS3Request, sha256hex, type S3Options } from '../catalog/providers/s3.ts';

export interface S3BlobConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
}

/** The multipart part size, which is also the most of a streamed body held in
 *  memory at once. A body of known length gets larger parts when it needs more
 *  than S3's 10,000. */
export const S3_BLOB_PART_BYTES = 8 * 1024 * 1024;
/** S3 refuses a part under 5 MiB unless it is the last one. */
const S3_MIN_PART_BYTES = 5 * 1024 * 1024;
const S3_MAX_PARTS = 10_000;
/** A part is retried after a network error or a 5xx, with the same bytes. */
const PART_ATTEMPTS = 3;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MIB = 1024 * 1024;

const asBuffer = (bytes: Uint8Array): Buffer => Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const xmlText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Cut a body into parts of exactly `partBytes`, the last one shorter (or
 *  empty for an empty body), each flagged when nothing follows it. An
 *  in-memory body is sliced without copying. A streamed one is copied into one
 *  part buffer at a time, and a full part is handed on only once the next byte
 *  arrives, so a body that ends on a part boundary still flags its last part. */
async function* partsOf(body: BlobBody, partBytes: number, limit: number): AsyncGenerator<{ bytes: Buffer; last: boolean }> {
  if (body instanceof Uint8Array) {
    const all = asBuffer(body);
    for (let offset = 0; ; offset += partBytes) {
      const end = Math.min(offset + partBytes, all.length);
      yield { bytes: all.subarray(offset, end), last: end === all.length };
      if (end === all.length) return;
    }
  }
  let part: Buffer | null = null, full: Buffer | null = null, used = 0, total = 0;
  for await (const chunk of blobChunks(body)) {
    total += chunk.byteLength;
    if (total > limit) throw new BlobMismatchError('size');
    for (let offset = 0; offset < chunk.byteLength;) {
      if (full) { yield { bytes: full, last: false }; full = null; }
      part ??= Buffer.allocUnsafe(partBytes);
      const count = Math.min(partBytes - used, chunk.byteLength - offset);
      part.set(chunk.subarray(offset, offset + count), used); used += count; offset += count;
      if (used === partBytes) { full = part; part = null; used = 0; }
    }
  }
  yield { bytes: full ?? (part ?? Buffer.alloc(0)).subarray(0, used), last: true };
}

export function createS3BlobStore(
  config: S3BlobConfig, secret: string | undefined, fetchImpl: typeof fetch = fetch,
  tuning: { partBytes?: number } = {},
): BlobStore {
  const creds = (): { accessKeyId: string; secretAccessKey: string } => {
    const sep = secret?.indexOf(':') ?? -1;
    if (!secret || sep <= 0) throw new Error('s3 blob credential must be "<accessKeyId>:<secretAccessKey>" (LW_BLOBS_S3_CREDENTIAL)');
    return { accessKeyId: secret.slice(0, sep), secretAccessKey: secret.slice(sep + 1) };
  };
  const options: S3Options = { bucket: config.bucket, ...(config.region ? { region: config.region } : {}), ...(config.endpoint ? { endpoint: config.endpoint } : {}) };
  const prefix = config.prefix ? config.prefix.replace(/\/+$/, '') + '/' : '';
  const keyOf = (blobId: string): string => `${prefix}${blobId}`;
  const basePartBytes = Math.max(S3_MIN_PART_BYTES, tuning.partBytes ?? S3_BLOB_PART_BYTES);
  /** Whole MiB parts, large enough for a known length to fit in 10,000. */
  const partBytesFor = (size: number | undefined): number =>
    size === undefined ? basePartBytes : Math.max(basePartBytes, Math.ceil(size / S3_MAX_PARTS / MIB) * MIB);

  const send = (
    method: string, key: string,
    request: { query?: Record<string, string>; body?: Buffer; bodySha256?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> => {
    const signed = signS3Request({
      options, ...creds(), key, method,
      ...(request.query ? { query: request.query } : {}),
      ...(request.body ? { payloadHash: request.bodySha256 ?? sha256hex(request.body) } : {}),
      ...(request.headers ? { headers: request.headers } : {}),
    });
    return fetchImpl(signed.url, { method, headers: signed.headers, ...(request.body ? { body: request.body } : {}) });
  };

  const statOf = (blobId: string, headers: Headers): BlobStat => {
    const recorded = headers.get('x-amz-meta-sha256')?.toLowerCase();
    return {
      blobId,
      size: Number(headers.get('content-length') ?? 0),
      checksum: recorded && SHA256_HEX.test(recorded) ? recorded : (headers.get('etag') ?? '').replace(/"/g, ''),
      contentType: headers.get('content-type') ?? 'application/octet-stream',
    };
  };

  const startUpload = async (key: string, headers: Record<string, string>): Promise<string> => {
    const res = await send('POST', key, { query: { uploads: '' }, headers });
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await res.text())?.[1];
    if (!res.ok || !uploadId) throw new Error(`s3 blob multipart start ${res.status}`);
    return xmlUnescape(uploadId);
  };

  const uploadPart = async (key: string, uploadId: string, partNumber: number, bytes: Buffer): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await send('PUT', key, { query: { partNumber: String(partNumber), uploadId }, body: bytes });
      } catch (error) {
        if (attempt === PART_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
        continue;
      }
      const etag = res.headers.get('etag');
      if (res.ok && etag) return etag;
      await res.body?.cancel().catch(() => {});
      if (res.status < 500 || attempt === PART_ATTEMPTS) throw new Error(`s3 blob part ${partNumber} ${res.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  };

  const completeUpload = async (key: string, uploadId: string, etags: string[]): Promise<void> => {
    const parts = etags.map((etag, n) => `<Part><PartNumber>${n + 1}</PartNumber><ETag>${xmlText(etag)}</ETag></Part>`).join('');
    const res = await send('POST', key, { query: { uploadId }, body: Buffer.from(`<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`) });
    // S3 may answer 200 and still report a failure in the body.
    const text = await res.text();
    if (!res.ok || /<Error>/.test(text)) throw new Error(`s3 blob multipart complete ${res.status}`);
  };

  return {
    async put(blobId, body, contentType, declared) {
      creds(); // fail closed before reading anything
      const key = keyOf(blobId);
      const inMemory = body instanceof Uint8Array ? asBuffer(body) : null;
      // An in-memory body is hashed before anything is sent, so even a
      // multipart upload of it records its sha256 on the object.
      const known = inMemory ? sha256hex(inMemory) : declared?.sha256?.toLowerCase();
      if (inMemory) checkDeclared(inMemory.length, known as string, declared);
      const whole = inMemory ? null : createHash('sha256');
      const digest = (): string => whole?.digest('hex') ?? known as string;
      const etags: string[] = [];
      let size = 0, uploadId: string | undefined;
      try {
        for await (const part of partsOf(body, partBytesFor(declared?.size ?? inMemory?.length), declared?.size ?? Number.POSITIVE_INFINITY)) {
          whole?.update(part.bytes); size += part.bytes.length;
          if (!uploadId && part.last) {
            const checksum = digest(); // the whole body, so also this request's payload hash
            checkDeclared(size, checksum, declared);
            const res = await send('PUT', key, { body: part.bytes, bodySha256: checksum, headers: { 'content-type': contentType, 'x-amz-meta-sha256': checksum } });
            if (!res.ok) throw new Error(`s3 blob put ${res.status}`);
            return { blobId, size, checksum, contentType };
          }
          uploadId ??= await startUpload(key, { 'content-type': contentType, ...(known ? { 'x-amz-meta-sha256': known } : {}) });
          if (etags.length === S3_MAX_PARTS) throw new Error(`s3 blob put needs more than ${S3_MAX_PARTS} parts; declare its size`);
          etags.push(await uploadPart(key, uploadId, etags.length + 1, part.bytes));
        }
        const checksum = digest();
        checkDeclared(size, checksum, declared);
        await completeUpload(key, uploadId as string, etags);
        return { blobId, size, checksum, contentType };
      } catch (error) {
        // Best effort: an upload left behind is removed by the bucket's
        // lifecycle rule for incomplete multipart uploads (docs/configuration.md).
        if (uploadId) await send('DELETE', key, { query: { uploadId } }).then((res) => res.body?.cancel()).catch(() => {});
        throw error;
      }
    },
    async head(blobId) {
      const res = await send('HEAD', keyOf(blobId));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3 blob head ${res.status}`);
      return statOf(blobId, res.headers);
    },
    async get(blobId) {
      const res = await send('GET', keyOf(blobId));
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw new Error(`s3 blob get ${res.status}`);
      return { body: res.body as ReadableStream<Uint8Array>, stat: statOf(blobId, res.headers) };
    },
    async delete(blobId) {
      const res = await send('DELETE', keyOf(blobId));
      // S3 DELETE is idempotent (204 whether or not the key existed); 404 is fine too.
      if (!res.ok && res.status !== 404) throw new Error(`s3 blob delete ${res.status}`);
    },
  };
}
