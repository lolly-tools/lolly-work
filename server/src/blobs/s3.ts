/**
 * S3 BlobStore driver (plans/27 §5) - instance-owned catalog bytes on any
 * S3-compatible store (AWS, MinIO, Ceph RGW): the media-sized-estate and air-gap
 * story, a `blobs.driver: 's3'` config flip rather than an architecture change.
 * Zero-dep, reusing the hand-rolled SigV4 core from the S3 catalog *provider*
 * (`providers/s3.ts`) grown to signed PUT/DELETE - no AWS SDK.
 *
 * A blob's key is `<prefix>/<blobId>`; objects are private and every request is
 * freshly signed. `size`/`checksum`/`content_type` cannot ride on the object
 * itself without a metadata round-trip, so `put` returns them from the buffered
 * body it just hashed, and `head`/`get` recompute from the object (HEAD gives
 * size; the checksum is re-derived on read - instance assets already persist the
 * checksum on their format entry, so a serve does not depend on it).
 */
import { readBlobBody, type BlobStat, type BlobStore } from './types.ts';
import { signS3Request, sha256hex, type S3Options } from '../catalog/providers/s3.ts';
import { createHash } from 'node:crypto';

export interface S3BlobConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
}

export function createS3BlobStore(config: S3BlobConfig, secret: string | undefined, fetchImpl: typeof fetch = fetch): BlobStore {
  const creds = (): { accessKeyId: string; secretAccessKey: string } => {
    const sep = secret?.indexOf(':') ?? -1;
    if (!secret || sep <= 0) throw new Error('s3 blob credential must be "<accessKeyId>:<secretAccessKey>" (LW_BLOBS_S3_CREDENTIAL)');
    return { accessKeyId: secret.slice(0, sep), secretAccessKey: secret.slice(sep + 1) };
  };
  const options: S3Options = { bucket: config.bucket, ...(config.region ? { region: config.region } : {}), ...(config.endpoint ? { endpoint: config.endpoint } : {}) };
  const prefix = config.prefix ? config.prefix.replace(/\/+$/, '') + '/' : '';
  const keyOf = (blobId: string): string => `${prefix}${blobId}`;

  return {
    async put(blobId, body, contentType) {
      const content = await readBlobBody(body);
      const checksum = createHash('sha256').update(content).digest('hex');
      const signed = signS3Request({ options, ...creds(), key: keyOf(blobId), method: 'PUT', payloadHash: sha256hex(content) });
      const res = await fetchImpl(signed.url, { method: 'PUT', headers: { ...signed.headers, 'content-type': contentType }, body: content });
      if (!res.ok) throw new Error(`s3 blob put ${res.status}`);
      return { blobId, size: content.length, checksum, contentType };
    },
    async head(blobId) {
      const signed = signS3Request({ options, ...creds(), key: keyOf(blobId), method: 'HEAD' });
      const res = await fetchImpl(signed.url, { method: 'HEAD', headers: signed.headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`s3 blob head ${res.status}`);
      const size = Number(res.headers.get('content-length') ?? 0);
      return { blobId, size, checksum: (res.headers.get('etag') ?? '').replace(/"/g, ''), contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
    },
    async get(blobId) {
      const signed = signS3Request({ options, ...creds(), key: keyOf(blobId) });
      const res = await fetchImpl(signed.url, { headers: signed.headers });
      if (res.status === 404) return null;
      if (!res.ok || !res.body) throw new Error(`s3 blob get ${res.status}`);
      const size = Number(res.headers.get('content-length') ?? 0);
      return {
        body: res.body as ReadableStream<Uint8Array>,
        stat: { blobId, size, checksum: (res.headers.get('etag') ?? '').replace(/"/g, ''), contentType: res.headers.get('content-type') ?? 'application/octet-stream' },
      };
    },
    async delete(blobId) {
      const signed = signS3Request({ options, ...creds(), key: keyOf(blobId), method: 'DELETE' });
      const res = await fetchImpl(signed.url, { method: 'DELETE', headers: signed.headers });
      // S3 DELETE is idempotent (204 whether or not the key existed); 404 is fine too.
      if (!res.ok && res.status !== 404) throw new Error(`s3 blob delete ${res.status}`);
    },
  };
}
