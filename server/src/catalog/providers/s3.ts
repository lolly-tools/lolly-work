/**
 * S3 driver (plans/17 §11 phase 2) - any S3-compatible store (AWS, MinIO,
 * Ceph RGW), which is also the air-gap story. Zero-dep: SigV4 is hand-rolled
 * on node:crypto (GET/HEAD only - no payloads to sign beyond the empty hash),
 * and ListObjectsV2's XML is parsed with a narrow, shape-pinned scan rather
 * than an XML dependency.
 *
 * The credential is one secret string: "<accessKeyId>:<secretAccessKey>".
 * Object keys contain slashes, but ext/* blob paths are single-segment per
 * part - so remoteId is the base64url of the key, decoded on resolve.
 *
 * Objects are private; every fetch is freshly signed (expiringUrls semantics),
 * streamed through /catalog/ext/* - presigned URLs are never minted into the
 * feed. Prefix "folders" map to sections for exposure scoping + tags.
 */
import { createHash, createHmac } from 'node:crypto';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ResolvedBlob } from './types.ts';

export interface S3Options {
  bucket: string;
  region?: string; // default us-east-1 (MinIO ignores it but SigV4 needs one)
  /** Custom endpoint for S3-compatibles, e.g. "https://minio.internal:9000".
   *  Absent → https://<bucket>.s3.<region>.amazonaws.com (virtual-hosted). */
  endpoint?: string;
  /** Only keys under this prefix federate. */
  prefix?: string;
}

const LIST_PAGE = 1000;

const MIME: Record<string, string> = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', pdf: 'application/pdf', json: 'application/json', woff2: 'font/woff2',
  mp4: 'video/mp4', webm: 'video/webm', zip: 'application/zip',
};

/** SigV4 payload/content hash - exported so the BlobStore S3 driver can sign
 *  the body of a PUT (plans/27 §5). */
export const sha256hex = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const hmacBuf = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const EMPTY_HASH = sha256hex('');

/** RFC 3986 encode (SigV4's flavour: '/' preserved only where asked). */
const enc = (s: string, keepSlash = false): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(keepSlash ? /%2F/g : /(?!)/g, '/');

export interface SignedRequest { url: string; headers: Record<string, string> }

/** Sign a request against the bucket. GET/HEAD by default (empty payload);
 *  `method` + `payloadHash` grow it to signed PUT/DELETE for the BlobStore
 *  driver (plans/27 §5) without an SDK. Exported for the driver tests. */
export function signS3Request(
  opts: {
    options: S3Options; accessKeyId: string; secretAccessKey: string; key?: string;
    query?: Record<string, string>; now?: Date; method?: string; payloadHash?: string;
  },
): SignedRequest {
  const region = opts.options.region ?? 'us-east-1';
  const method = opts.method ?? 'GET';
  const payloadHash = opts.payloadHash ?? EMPTY_HASH;
  const base = opts.options.endpoint
    ? `${opts.options.endpoint.replace(/\/+$/, '')}/${opts.options.bucket}`
    : `https://${opts.options.bucket}.s3.${region}.amazonaws.com`;
  const url = new URL(opts.key ? `${base}/${enc(opts.key, true)}` : base + '/');
  const query = opts.query ?? {};
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${enc(k)}=${enc(query[k] as string)}`).join('&');
  url.search = canonicalQuery;

  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('');
  const canonicalRequest = [method, url.pathname, canonicalQuery, canonicalHeaders, signedHeaderNames.join(';'), payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmacBuf(`AWS4${opts.secretAccessKey}`, day);
  const kRegion = hmacBuf(kDate, region);
  const kService = hmacBuf(kRegion, 's3');
  const kSigning = hmacBuf(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  const { host: _h, ...sendHeaders } = headers; // fetch sets Host itself
  return { url: url.toString(), headers: sendHeaders };
}

const keyToRemoteId = (key: string): string => Buffer.from(key, 'utf8').toString('base64url');
const remoteIdToKey = (remoteId: string): string => Buffer.from(remoteId, 'base64url').toString('utf8');

/** Pull <tag>…</tag> occurrences out of a ListObjectsV2 body scoped per <Contents> block. */
function listFromXml(xml: string): { keys: Array<{ key: string; size?: number; modified?: string }>; next?: string } {
  const keys: Array<{ key: string; size?: number; modified?: string }> = [];
  const unescape = (s: string): string =>
    s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&amp;/g, '&');
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] as string;
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (!key) continue;
    const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
    const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1];
    keys.push({ key: unescape(key), ...(size ? { size: Number(size) } : {}), ...(modified ? { modified } : {}) });
  }
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return { keys, ...(next ? { next: unescape(next) } : {}) };
}

export function createS3Provider(
  id: string,
  options: S3Options,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const creds = (): { accessKeyId: string; secretAccessKey: string } => {
    const sep = secret?.indexOf(':') ?? -1;
    if (!secret || sep <= 0) throw new Error('s3 credential must be "<accessKeyId>:<secretAccessKey>"');
    return { accessKeyId: secret.slice(0, sep), secretAccessKey: secret.slice(sep + 1) };
  };

  const list = async (query: Record<string, string>): Promise<string> => {
    const signed = signS3Request({ options, ...creds(), query });
    const res = await fetchImpl(signed.url, { headers: signed.headers });
    if (!res.ok) throw new Error(`s3 list ${res.status}`);
    return res.text();
  };

  const prefix = options.prefix ? options.prefix.replace(/\/+$/, '') + '/' : '';

  const toAsset = (obj: { key: string; size?: number; modified?: string }): ProviderAssetRef | null => {
    if (obj.key.endsWith('/')) return null; // folder placeholder objects
    const rel = obj.key.slice(prefix.length);
    const parts = rel.split('/');
    const filename = parts[parts.length - 1] as string;
    const ext = extOf(filename);
    return {
      remoteId: keyToRemoteId(obj.key),
      name: stripExt(filename),
      nativeType: ext,
      sections: parts.length > 1 ? [parts[0] as string] : [],
      tags: [],
      ...(obj.modified ? { updatedAt: obj.modified } : {}),
      formats: [{ format: ext, remoteRef: 'orig', filename, ...(obj.size !== undefined ? { size: obj.size } : {}) }],
    };
  };

  return {
    id,
    kind: 's3',
    capabilities: { authKind: 'credential', search: false, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      const query: Record<string, string> = { 'list-type': '2', 'max-keys': String(LIST_PAGE) };
      if (prefix) query.prefix = prefix;
      if (cursor) query['continuation-token'] = cursor;
      const parsed = listFromXml(await list(query));
      return {
        assets: parsed.keys.map(toAsset).filter((a): a is ProviderAssetRef => a !== null),
        ...(parsed.next ? { next: parsed.next } : {}),
      };
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'orig') throw new Error('s3 assets have a single original format');
      const key = remoteIdToKey(remoteId);
      if (prefix && !key.startsWith(prefix)) throw new Error('object outside the configured prefix');
      const signed = signS3Request({ options, ...creds(), key });
      const res = await fetchImpl(signed.url, { headers: signed.headers });
      if (!res.ok || !res.body) throw new Error(`s3 get ${res.status}`);
      const ext = extOf(key, '');
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type') ?? MIME[ext] ?? 'application/octet-stream',
        ...(res.headers.get('content-length') ? { size: Number(res.headers.get('content-length')) } : {}),
      };
    },

    async healthCheck() {
      try {
        await list({ 'list-type': '2', 'max-keys': '1', ...(prefix ? { prefix } : {}) });
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
