// SPDX-License-Identifier: MPL-2.0
/** S3-compatible fixed destination: exact-byte PUT under an immutable delivery key. */
import { signS3Request, type S3Options } from '../catalog/providers/s3.ts';
import type { DeliveryInput, DeliveryProvider } from './types.ts';

export interface S3DeliveryOptions extends S3Options {
  /** Optional public origin corresponding to the bucket root. Absent means private. */
  publicBaseUrl?: string;
}

function credentials(secret: string | undefined): { accessKeyId: string; secretAccessKey: string } {
  const sep = secret?.indexOf(':') ?? -1;
  if (!secret || sep <= 0 || sep === secret.length - 1) {
    throw new Error('s3 delivery credential must be "<accessKeyId>:<secretAccessKey>"');
  }
  return { accessKeyId: secret.slice(0, sep), secretAccessKey: secret.slice(sep + 1) };
}

function prefixOf(raw: string | undefined): string {
  if (!raw) return '';
  const clean = raw.replace(/^\/+|\/+$/g, '');
  if (!clean || clean.split('/').some((part) => part === '.' || part === '..')) throw new Error('s3 delivery prefix is invalid');
  return `${clean}/`;
}

export function deliveryFilename(name: string, format: string): string {
  const leaf = name.normalize('NFKC').split(/[\\/]/).pop()?.trim() ?? '';
  const normalizedFormat = format.toLowerCase();
  const fileFormat = ({
    apng: 'png',
    jpeg: 'jpg',
    'pdf-cmyk': 'pdf',
    'cmyk-tiff': 'tiff',
    'html-fragment': 'html',
  } as Record<string, string>)[normalizedFormat] ?? normalizedFormat;
  const ext = `.${fileFormat}`;
  const declaredExt = `.${normalizedFormat}`;
  const lower = leaf.toLowerCase();
  const stem = lower.endsWith(declaredExt)
    ? leaf.slice(0, -declaredExt.length)
    : lower.endsWith(ext) ? leaf.slice(0, -ext.length) : leaf;
  const safe = stem
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .slice(0, 160) || 'export';
  return `${safe}${ext}`;
}

function publicUrl(base: string, key: string): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return new URL(key.split('/').map(encodeURIComponent).join('/'), root).toString();
}

/** Deterministic for retry and exported for the live canary's guaranteed cleanup. */
export function s3DeliveryKey(options: S3DeliveryOptions, input: Pick<DeliveryInput, 'deliveryId' | 'sha256' | 'name' | 'format'>): string {
  if (!/^[a-z0-9_-]+$/i.test(input.deliveryId)) throw new Error('s3 delivery id is invalid');
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error('s3 delivery sha256 is invalid');
  return `${prefixOf(options.prefix)}${input.deliveryId}/${input.sha256.slice(0, 16)}-${deliveryFilename(input.name, input.format)}`;
}

export function createS3DeliveryProvider(
  options: S3DeliveryOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): DeliveryProvider {
  if (!options.bucket?.trim()) throw new Error('s3 delivery needs a bucket');
  const creds = credentials(secret);
  const prefix = prefixOf(options.prefix);
  const signedOptions: S3Options = {
    bucket: options.bucket,
    ...(options.region ? { region: options.region } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  };

  return {
    kind: 's3',

    async deliver(input) {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(input.format)) throw new Error('delivery format is invalid');
      // Same delivery + same immutable digest resolves to the same key. A retry
      // after a lost response writes the exact same bytes, never a new version.
      const key = s3DeliveryKey(options, input);
      const signed = signS3Request({
        options: signedOptions,
        ...creds,
        key,
        method: 'PUT',
        payloadHash: input.sha256,
      });
      const put = await fetchImpl(signed.url, {
        method: 'PUT',
        redirect: 'error',
        headers: { ...signed.headers, 'content-type': input.contentType },
        body: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
      });
      if (!put.ok) throw new Error(`s3 delivery put ${put.status}`);

      const check = signS3Request({ options: signedOptions, ...creds, key, method: 'HEAD' });
      const head = await fetchImpl(check.url, { method: 'HEAD', redirect: 'error', headers: check.headers });
      if (!head.ok) throw new Error(`s3 delivery head ${head.status}`);
      const deliveredSize = Number(head.headers.get('content-length') ?? NaN);
      if (!Number.isFinite(deliveredSize) || deliveredSize !== input.bytes.byteLength) {
        throw new Error(`s3 delivery size mismatch (${deliveredSize} != ${input.bytes.byteLength})`);
      }
      return {
        remoteId: key,
        ...(options.publicBaseUrl ? { url: publicUrl(options.publicBaseUrl, key) } : {}),
        deliveredSha256: input.sha256,
        transformation: 'none',
      };
    },

    async revoke(remoteId) {
      if (!remoteId || (prefix && !remoteId.startsWith(prefix))) throw new Error('s3 delivery object is outside the configured prefix');
      const signed = signS3Request({ options: signedOptions, ...creds, key: remoteId, method: 'DELETE' });
      const response = await fetchImpl(signed.url, { method: 'DELETE', redirect: 'error', headers: signed.headers });
      if (!response.ok && response.status !== 404) throw new Error(`s3 delivery delete ${response.status}`);
    },
  };
}
