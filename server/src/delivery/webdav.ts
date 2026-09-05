// SPDX-License-Identifier: MPL-2.0
/** RFC 4918 fixed destination. Works with Nextcloud, ownCloud and ordinary DAV. */
import { deliveryFilename } from './s3.ts';
import { readBlobBody } from '../blobs/types.ts';
import { sha256Hex } from '../lib/crypto.ts';
import type { DeliveryInput, DeliveryProvider } from './types.ts';

export interface WebdavDeliveryOptions {
  /** Existing writable collection. Delivery never creates or browses folders. */
  url: string;
  /** Optional existing subdirectory under the collection. */
  prefix?: string;
  /** Optional public origin mirroring the collection root. */
  publicBaseUrl?: string;
}

function collectionUrl(raw: string | undefined, label = 'url'): URL {
  let parsed: URL;
  try { parsed = new URL(raw ?? ''); }
  catch { throw new Error(`webdav delivery options.${label} must be an http(s) collection URL`); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`webdav delivery options.${label} must be an http(s) collection URL without credentials, query or fragment`);
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed;
}

function authHeader(secret: string | undefined): string {
  const hint = 'webdav delivery credential must be "<username>:<password>" or "bearer:<token>"';
  if (!secret) throw new Error(`${hint} - no credential is configured`);
  if (secret.toLowerCase().startsWith('bearer:')) {
    const token = secret.slice('bearer:'.length).trim();
    if (!token) throw new Error(`${hint} - the bearer token is empty`);
    return `Bearer ${token}`;
  }
  const separator = secret.indexOf(':');
  if (separator <= 0 || separator === secret.length - 1) throw new Error(hint);
  return `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`;
}

function prefixOf(raw: string | undefined): string {
  if (!raw) return '';
  const clean = raw.replace(/^\/+|\/+$/g, '');
  if (!clean || clean.includes('\\') || clean.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('webdav delivery prefix is invalid');
  }
  return `${clean}/`;
}

function resourceUrl(root: URL, relative: string): string {
  const url = new URL(root.toString());
  url.pathname += relative.split('/').map(encodeURIComponent).join('/');
  return url.toString();
}

function publicUrl(root: URL, relative: string): string {
  return resourceUrl(root, relative);
}

/** Flat deterministic name so the configured collection need only already exist. */
export function webdavDeliveryPath(
  options: WebdavDeliveryOptions,
  input: Pick<DeliveryInput, 'deliveryId' | 'sha256' | 'name' | 'format'>,
): string {
  if (!/^[a-z0-9_-]+$/i.test(input.deliveryId)) throw new Error('webdav delivery id is invalid');
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error('webdav delivery sha256 is invalid');
  return `${prefixOf(options.prefix)}${input.deliveryId}-${input.sha256.slice(0, 16)}-${deliveryFilename(input.name, input.format)}`;
}

function validOwnedPath(prefix: string, remoteId: string): boolean {
  if (prefix && !remoteId.startsWith(prefix)) return false;
  const tail = prefix ? remoteId.slice(prefix.length) : remoteId;
  return !tail.includes('/') && /^[a-z0-9_-]+-[a-f0-9]{16}-.+/i.test(tail);
}

export function createWebdavDeliveryProvider(
  options: WebdavDeliveryOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): DeliveryProvider {
  const root = collectionUrl(options?.url);
  const publicRoot = options.publicBaseUrl ? collectionUrl(options.publicBaseUrl, 'publicBaseUrl') : null;
  const prefix = prefixOf(options.prefix);
  const authorization = authHeader(secret);
  return {
    kind: 'webdav',
    async deliver(input) {
      const remoteId = webdavDeliveryPath(options, input);
      const url = resourceUrl(root, remoteId);
      const put = await fetchImpl(url, {
        method: 'PUT',
        redirect: 'error',
        headers: {
          authorization,
          'content-type': input.contentType,
          'content-length': String(input.bytes.byteLength),
        },
        body: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
      });
      if (!put.ok) throw new Error(`webdav delivery put ${put.status}`);
      const head = await fetchImpl(url, { method: 'HEAD', redirect: 'error', headers: { authorization } });
      if (!head.ok) throw new Error(`webdav delivery head ${head.status}`);
      const deliveredSize = Number(head.headers.get('content-length') ?? NaN);
      if (!Number.isFinite(deliveredSize) || deliveredSize !== input.bytes.byteLength) {
        throw new Error(`webdav delivery size mismatch (${deliveredSize} != ${input.bytes.byteLength})`);
      }
      // Unlike SigV4, Basic/Bearer auth does not bind the request payload hash.
      // Read the fixed resource back before claiming byte preservation in a
      // receipt; the cap prevents a dishonest server from streaming forever.
      const get = await fetchImpl(url, { method: 'GET', redirect: 'error', headers: { authorization } });
      if (!get.ok || !get.body) throw new Error(`webdav delivery verify ${get.status}`);
      const stored = new Uint8Array(await readBlobBody(get.body, input.bytes.byteLength + 1));
      const deliveredSha256 = sha256Hex(stored);
      if (stored.byteLength !== input.bytes.byteLength || deliveredSha256 !== input.sha256.toLowerCase()) {
        throw new Error('webdav delivery digest mismatch');
      }
      return {
        remoteId,
        ...(publicRoot ? { url: publicUrl(publicRoot, remoteId) } : {}),
        deliveredSha256,
        transformation: 'none',
      };
    },
    async revoke(remoteId) {
      if (!validOwnedPath(prefix, remoteId)) throw new Error('webdav delivery object is outside the configured prefix');
      const response = await fetchImpl(resourceUrl(root, remoteId), {
        method: 'DELETE', redirect: 'error', headers: { authorization },
      });
      if (!response.ok && response.status !== 404) throw new Error(`webdav delivery delete ${response.status}`);
    },
  };
}
