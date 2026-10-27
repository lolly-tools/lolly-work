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
 *
 * Some S3-compatible stores drop object metadata: they serve every object as
 * application/octet-stream and lose x-amz-meta-* (Predastore before v1.21 is
 * one, found on Mulga's Spinifex in plan 324). The server's startup, or else
 * the first write in a process, probes the store once with an object it
 * writes, reads back and deletes. When the content type or the sha256 does
 * not survive, each blob gets a small JSON record of its own, under
 * `<prefix>/.lolly-meta/<blobId>`,
 * holding the size, sha256, content type and the object's ETag. A read uses
 * that record only when the object's own headers lack the sha256 and the ETag
 * still matches, so a record left by an earlier version of the blob is never
 * applied to newer bytes.
 *
 * Usage (plan 80 section 10): reads are counted as the bytes stream through,
 * in this process only. Stored bytes are not reported: totalling them means
 * listing the whole bucket, and the store's own metrics already show its size.
 */
import { createHash, randomUUID } from 'node:crypto';
import { blobChunks, BlobMismatchError, checkDeclared, createReadTally, usageMonth, type BlobBody, type BlobPutOptions, type BlobStat, type BlobStore } from './types.ts';
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
/** The content type the metadata probe stores and expects back. */
const PROBE_TYPE = 'image/svg+xml';
/** A metadata record is a few hundred bytes; anything larger is not one. */
const META_RECORD_MAX = 4096;

/** How the store treats object metadata: `native` keeps the content type and
 *  x-amz-meta-* as S3 does, `sidecar` drops them, so the driver records them
 *  beside each blob. */
export type S3MetadataMode = 'native' | 'sidecar';

interface MetaRecord { v: 1; size: number; sha256: string; contentType: string; etag?: string }

/** An ETag compared as S3 writes it in different places: quoted, unquoted or weak. */
const bareEtag = (etag: string | null | undefined): string => (etag ?? '').replace(/^W\//, '').replace(/"/g, '');
/** A media type without parameters, for comparing what a store kept. */
const mediaType = (value: string | null): string => (value ?? '').split(';')[0]!.trim().toLowerCase();

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

export interface S3BlobStore extends BlobStore {
  /** How this store treats object metadata, probed once and remembered. */
  metadata(): Promise<S3MetadataMode>;
}

export function createS3BlobStore(
  config: S3BlobConfig, secret: string | undefined, fetchImpl: typeof fetch = fetch,
  tuning: { partBytes?: number; metadata?: S3MetadataMode } = {},
): S3BlobStore {
  const creds = (): { accessKeyId: string; secretAccessKey: string } => {
    const sep = secret?.indexOf(':') ?? -1;
    if (!secret || sep <= 0) throw new Error('s3 blob credential must be "<accessKeyId>:<secretAccessKey>" (LW_BLOBS_S3_CREDENTIAL)');
    return { accessKeyId: secret.slice(0, sep), secretAccessKey: secret.slice(sep + 1) };
  };
  const options: S3Options = { bucket: config.bucket, ...(config.region ? { region: config.region } : {}), ...(config.endpoint ? { endpoint: config.endpoint } : {}) };
  const prefix = config.prefix ? config.prefix.replace(/\/+$/, '') + '/' : '';
  const keyOf = (blobId: string): string => `${prefix}${blobId}`;
  const metaKeyOf = (blobId: string): string => `${prefix}.lolly-meta/${blobId}`;
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

  const statOf = (blobId: string, headers: Headers, record: MetaRecord | null = null): BlobStat => {
    const recorded = headers.get('x-amz-meta-sha256')?.toLowerCase();
    if (record) return { blobId, size: record.size, checksum: record.sha256, contentType: record.contentType };
    return {
      blobId,
      size: Number(headers.get('content-length') ?? 0),
      checksum: recorded && SHA256_HEX.test(recorded) ? recorded : (headers.get('etag') ?? '').replace(/"/g, ''),
      contentType: headers.get('content-type') ?? 'application/octet-stream',
    };
  };

  /** Probe the store once: write an object with a content type and a sha256,
   *  read them back, delete it. A probe that cannot write fails the caller and
   *  is tried again next time. */
  let mode: Promise<S3MetadataMode> | undefined = tuning.metadata ? Promise.resolve(tuning.metadata) : undefined;
  let knownMode: S3MetadataMode | undefined = tuning.metadata;
  const probe = async (): Promise<S3MetadataMode> => {
    const key = `${prefix}.lolly-probe-${randomUUID()}`;
    const body = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    const sha = sha256hex(body);
    const put = await send('PUT', key, { body, bodySha256: sha, headers: { 'content-type': PROBE_TYPE, 'x-amz-meta-sha256': sha } });
    await put.body?.cancel().catch(() => {});
    if (!put.ok) throw new Error(`s3 blob metadata probe put ${put.status}`);
    try {
      const head = await send('HEAD', key);
      if (!head.ok) throw new Error(`s3 blob metadata probe head ${head.status}`);
      const kept = mediaType(head.headers.get('content-type')) === PROBE_TYPE && head.headers.get('x-amz-meta-sha256')?.toLowerCase() === sha;
      return kept ? 'native' : 'sidecar';
    } finally {
      await send('DELETE', key).then((res) => res.body?.cancel()).catch(() => {});
    }
  };
  const metadataMode = (): Promise<S3MetadataMode> => {
    mode ??= probe().then((found) => { knownMode = found; return found; }, (error: unknown) => { mode = undefined; throw error; });
    return mode;
  };

  /** The record beside a blob, when the object's own headers lack its sha256
   *  and the record still describes these bytes. Never needed on a store
   *  known to keep metadata. A missing, unreadable or stale record is null, so
   *  the read reports what the object's headers say. */
  const recordFor = async (blobId: string, headers: Headers): Promise<MetaRecord | null> => {
    if (knownMode === 'native' || SHA256_HEX.test(headers.get('x-amz-meta-sha256')?.toLowerCase() ?? '')) return null;
    const record = await readRecord(blobId);
    if (!record || record.size !== Number(headers.get('content-length') ?? -1)) return null;
    const etag = bareEtag(headers.get('etag'));
    return record.etag && etag && record.etag !== etag ? null : record;
  };
  const readRecord = async (blobId: string): Promise<MetaRecord | null> => {
    const res = await send('GET', metaKeyOf(blobId)).catch(() => null);
    if (!res?.ok) { await res?.body?.cancel().catch(() => {}); return null; }
    const text = await res.text().catch(() => '');
    if (text.length > META_RECORD_MAX) return null;
    try {
      const record = JSON.parse(text) as Partial<MetaRecord>;
      return record.v === 1 && Number.isSafeInteger(record.size) && typeof record.sha256 === 'string' && SHA256_HEX.test(record.sha256)
        && typeof record.contentType === 'string' && record.contentType
        ? { v: 1, size: record.size as number, sha256: record.sha256, contentType: record.contentType, ...(typeof record.etag === 'string' && record.etag ? { etag: record.etag } : {}) }
        : null;
    } catch {
      return null;
    }
  };
  const writeRecord = async (stat: BlobStat, etag: string): Promise<void> => {
    const record: MetaRecord = { v: 1, size: stat.size, sha256: stat.checksum, contentType: stat.contentType, ...(etag ? { etag } : {}) };
    const res = await send('PUT', metaKeyOf(stat.blobId), { body: Buffer.from(JSON.stringify(record)), headers: { 'content-type': 'application/json' } });
    await res.body?.cancel().catch(() => {});
    if (!res.ok) throw new Error(`s3 blob metadata record put ${res.status}`);
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

  const completeUpload = async (key: string, uploadId: string, etags: string[]): Promise<string> => {
    const parts = etags.map((etag, n) => `<Part><PartNumber>${n + 1}</PartNumber><ETag>${xmlText(etag)}</ETag></Part>`).join('');
    const res = await send('POST', key, { query: { uploadId }, body: Buffer.from(`<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`) });
    // S3 may answer 200 and still report a failure in the body.
    const text = await res.text();
    if (!res.ok || /<Error>/.test(text)) throw new Error(`s3 blob multipart complete ${res.status}`);
    return bareEtag(xmlUnescape(/<ETag>([^<]+)<\/ETag>/.exec(text)?.[1] ?? ''));
  };

  const reads = createReadTally();
  const counted = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { reads.add(chunk.byteLength); controller.enqueue(chunk); },
  }));

  /** Write the object itself, returning its stat and the ETag the store gave it. */
  const putObject = async (blobId: string, body: BlobBody, contentType: string, declared: BlobPutOptions | undefined): Promise<{ stat: BlobStat; etag: string }> => {
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
          return { stat: { blobId, size, checksum, contentType }, etag: bareEtag(res.headers.get('etag')) };
        }
        uploadId ??= await startUpload(key, { 'content-type': contentType, ...(known ? { 'x-amz-meta-sha256': known } : {}) });
        if (etags.length === S3_MAX_PARTS) throw new Error(`s3 blob put needs more than ${S3_MAX_PARTS} parts; declare its size`);
        etags.push(await uploadPart(key, uploadId, etags.length + 1, part.bytes));
      }
      const checksum = digest();
      checkDeclared(size, checksum, declared);
      const etag = await completeUpload(key, uploadId as string, etags);
      return { stat: { blobId, size, checksum, contentType }, etag };
    } catch (error) {
      // Best effort: an upload left behind is removed by the bucket's
      // lifecycle rule for incomplete multipart uploads (docs/configuration.md).
      if (uploadId) await send('DELETE', key, { query: { uploadId } }).then((res) => res.body?.cancel()).catch(() => {});
      throw error;
    }
  };

  return {
    driver: 's3',
    metadata: metadataMode,
    async put(blobId, body, contentType, declared) {
      creds(); // fail closed before reading anything
      const sidecar = await metadataMode() === 'sidecar';
      const { stat, etag } = await putObject(blobId, body, contentType, declared);
      // The record goes after the object: a failure here leaves a record
      // that names the old ETag, which no read applies to the new bytes.
      if (sidecar) await writeRecord(stat, etag);
      return stat;
    },
    async head(blobId) {
      const res = await send('HEAD', keyOf(blobId));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3 blob head ${res.status}`);
      return statOf(blobId, res.headers, await recordFor(blobId, res.headers));
    },
    async get(blobId) {
      const res = await send('GET', keyOf(blobId));
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw new Error(`s3 blob get ${res.status}`);
      const record = await recordFor(blobId, res.headers);
      return { body: counted(res.body as ReadableStream<Uint8Array>), stat: statOf(blobId, res.headers, record) };
    },
    async delete(blobId) {
      const res = await send('DELETE', keyOf(blobId));
      // S3 DELETE is idempotent (204 whether or not the key existed); 404 is fine too.
      if (!res.ok && res.status !== 404) throw new Error(`s3 blob delete ${res.status}`);
      if (knownMode === 'native') return;
      const meta = await send('DELETE', metaKeyOf(blobId));
      await meta.body?.cancel().catch(() => {});
      if (!meta.ok && meta.status !== 404) throw new Error(`s3 blob metadata record delete ${meta.status}`);
    },
    async usage() {
      const month = usageMonth();
      return { driver: 's3', storedBytes: null, readBytesTotal: reads.total(), month, monthReadBytes: reads.month(month) };
    },
    async claimUsageNotice(month, kind) {
      return reads.claim(month, kind);
    },
  };
}
