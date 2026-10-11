// SPDX-License-Identifier: MPL-2.0
/** Byte-preserving delivery after a route has performed its access checks. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzipSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const INERT_BYTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
});

/** Weak comparison is correct for GET/HEAD revalidation, never for If-Range. */
export function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const bare = (value: string) => value.trim().replace(/^W\//, '');
  return String(header ?? '').split(',').some(value => value.trim() === '*' || bare(value) === bare(etag));
}

export function appendVary(value: string | number | readonly string[] | undefined, name: string): string {
  const names = String(value ?? '').split(',').map(part => part.trim()).filter(Boolean);
  if (!names.some(part => part.toLowerCase() === name.toLowerCase())) names.push(name);
  return names.join(', ');
}

/** Honor explicit q=0 even when a wildcard allows another encoding. */
export function preferredEncoding(header: string | string[] | undefined): 'br' | 'gzip' | null {
  const entries = new Map<string, number>();
  for (const entry of String(header ?? '').split(',')) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    if (!name) continue;
    const parameter = parameters.find(part => part.trim().startsWith('q='));
    const raw = parameter ? parameter.trim().slice(2) : '1';
    entries.set(name, /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0);
  }
  const q = (name: string) => entries.get(name) ?? entries.get('*') ?? 0;
  return q('br') > 0 && q('br') >= q('gzip') ? 'br' : q('gzip') > 0 ? 'gzip' : null;
}

const projectionRoots = new Map<string, string[]>();
/** Only the server's source resolver can add roots for its own projection trees. */
export async function registerProjectionRoots(root: string, sources: string[]): Promise<void> {
  const resolved = await Promise.all(sources.map(source => realpath(source).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  })));
  projectionRoots.set(await realpath(root), resolved.filter((source): source is string => source !== null));
}

const fileValidators = new Map<string, { version: string; etag: string; length: number; encoding?: 'br' | 'gzip' }>();
const VALIDATOR_LIMIT = 8192;

const isText = (type: string) => /^(?:text\/|application\/(?:[a-z0-9.+-]*json|javascript|xml|wasm)|image\/svg\+xml)/i.test(type);

/** Origin compression never rewrites stored bytes or their signed digests. */
export function encodeText(req: IncomingMessage, bytes: Buffer, type: string): { bytes: Buffer; encoding?: 'br' | 'gzip' } {
  if (bytes.length <= 1024 || !isText(type) || req.headers.range) return { bytes };
  const encoding = preferredEncoding(req.headers['accept-encoding']);
  if (!encoding) return { bytes };
  const encoded = encoding === 'br' ? brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }) : gzipSync(bytes);
  return encoded.length < bytes.length ? { bytes: encoded, encoding } : { bytes };
}

/** A single byte range; malformed, multiple and unsatisfiable ranges are refused. */
export function byteRange(header: string | string[] | undefined, size: number): { start: number; end: number } | null | false {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header));
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const suffix = !match[1];
  const start = suffix ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = suffix || !match[2] ? size - 1 : Math.min(size - 1, Number(match[2]));
  if (![start, end].every(Number.isSafeInteger) || start >= size || end < start || (suffix && Number(match[2]) <= 0)) return false;
  return { start, end };
}

export interface ByteDelivery {
  contentType: string;
  headers?: Record<string, string>;
  /** Digest of unencoded bytes, checked by the caller or derived here. */
  sha256?: string;
  modified?: Date;
  compression?: boolean;
  ranges?: boolean;
  /** A precompressed sibling with the same decoded bytes, selected by the file helper. */
  encoded?: { bytes: Buffer; encoding: 'br' | 'gzip' };
}

export function sendBytes(req: IncomingMessage, res: ServerResponse, bytes: Buffer, options: ByteDelivery): void {
  const hash = options.sha256 ?? createHash('sha256').update(bytes).digest('hex');
  const encoded = options.encoded ?? (options.compression !== false ? encodeText(req, bytes, options.contentType) : { bytes });
  const etag = `"${encoded.encoding ? `${createHash('sha256').update(encoded.bytes).digest('hex')}-${encoded.encoding}` : hash}"`;
  const headers: Record<string, string> = { 'content-type': options.contentType, etag, 'referrer-policy': 'no-referrer', ...options.headers };
  if (options.modified) headers['last-modified'] = options.modified.toUTCString();
  if (options.compression !== false && isText(options.contentType)) headers.vary = appendVary(res.getHeader('vary') ?? headers.vary, 'Accept-Encoding');
  if (encoded.encoding) headers['content-encoding'] = encoded.encoding;
  if (options.ranges) headers['accept-ranges'] = 'bytes';
  if (matchesEtag(req.headers['if-none-match'], etag) || (!req.headers['if-none-match'] && options.modified && req.headers['if-modified-since']
    && Number.isFinite(Date.parse(String(req.headers['if-modified-since']))) && Math.floor(options.modified.getTime() / 1000) <= Date.parse(String(req.headers['if-modified-since'])) / 1000)) {
    res.writeHead(304, headers); res.end(); return;
  }
  let body = encoded.bytes, status = 200;
  if (options.ranges && req.headers.range) {
    const ifRange = req.headers['if-range'];
    const valid = !ifRange || ifRange === etag || (options.modified && Number.isFinite(Date.parse(String(ifRange))) && Math.floor(options.modified.getTime() / 1000) <= Date.parse(String(ifRange)) / 1000);
    const range = valid ? byteRange(req.headers.range, bytes.length) : null;
    if (range === false) { res.writeHead(416, { ...headers, 'content-range': `bytes */${bytes.length}`, 'cache-control': 'private, no-store, max-age=0' }); res.end(); return; }
    if (range) { status = 206; body = bytes.subarray(range.start, range.end + 1); headers['content-range'] = `bytes ${range.start}-${range.end}/${bytes.length}`; }
  }
  headers['content-length'] = String(body.length);
  res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : body);
}

/** Stay within the mounted release even if an individual file is a symlink. */
async function safeNode(root: string, rel: string, directory: boolean): Promise<{ path: string; modified: Date; size: number } | null> {
  if (!rel || rel.split(/[\\/]/).some(part => part === '..' || part === '.') || rel.includes('\0')) return null;
  try {
    const base = await realpath(root), path = await realpath(resolve(base, rel));
    const trusted = [...projectionRoots].filter(([projection]) => base === projection || base.startsWith(projection + sep)).flatMap(([, sources]) => sources);
    if (![base, ...trusted].some(source => path.startsWith(source + sep))) return null;
    const metadata = await stat(path);
    return (directory ? metadata.isDirectory() : metadata.isFile()) ? { path, modified: metadata.mtime, size: metadata.size } : null;
  } catch { return null; }
}
export async function safeFile(root: string, rel: string): Promise<{ path: string; modified: Date; size: number } | null> {
  return safeNode(root, rel, false);
}
export async function safeDirectory(root: string, rel: string): Promise<boolean> { return !!await safeNode(root, rel, true); }

export async function sendFile(req: IncomingMessage, res: ServerResponse, root: string, rel: string, options: ByteDelivery): Promise<boolean> {
  const file = await safeFile(root, rel); if (!file) return false;
  const preference = !req.headers.range && options.compression !== false && isText(options.contentType) && file.size > 1024 ? preferredEncoding(req.headers['accept-encoding']) : null;
  const sibling = preference ? await safeFile(root, `${rel}.${preference === 'br' ? 'br' : 'gz'}`) : null;
  const key = `${file.path}/${preference ?? 'identity'}`, version = `${file.modified.getTime()}/${file.size}/${sibling?.modified.getTime() ?? ''}/${sibling?.size ?? ''}`;
  const previous = fileValidators.get(key);
  if (previous?.version === version && !req.headers.range && (req.method === 'HEAD' || matchesEtag(req.headers['if-none-match'], previous.etag))) {
    const headers: Record<string, string> = { 'content-type': options.contentType, etag: previous.etag,
      'last-modified': file.modified.toUTCString(), 'referrer-policy': 'no-referrer', ...options.headers };
    if (options.compression !== false && isText(options.contentType)) headers.vary = appendVary(res.getHeader('vary') ?? headers.vary, 'Accept-Encoding');
    if (previous.encoding) headers['content-encoding'] = previous.encoding;
    if (options.ranges) headers['accept-ranges'] = 'bytes';
    const notModified = matchesEtag(req.headers['if-none-match'], previous.etag) || (!req.headers['if-none-match'] && req.headers['if-modified-since'] && Math.floor(file.modified.getTime() / 1000) <= Date.parse(String(req.headers['if-modified-since'])) / 1000);
    if (!notModified) headers['content-length'] = String(previous.length);
    res.writeHead(notModified ? 304 : 200, headers); res.end(); return true;
  }
  const bytes = await readFile(file.path);
  let encoded: ByteDelivery['encoded'];
  if (preference) {
    if (sibling) {
      const compressed = await readFile(sibling.path);
      try {
        const decoded = preference === 'br' ? brotliDecompressSync(compressed, { maxOutputLength: bytes.length + 1 }) : gunzipSync(compressed, { maxOutputLength: bytes.length + 1 });
        if (decoded.equals(bytes)) encoded = { bytes: compressed, encoding: preference };
      } catch { /* A stale or corrupt sibling falls back to origin compression. */ }
    }
  }
  const representation = encoded ?? (options.compression !== false ? encodeText(req, bytes, options.contentType) : { bytes });
  const digest = createHash('sha256').update(representation.bytes).digest('hex');
  if (!req.headers.range) {
    if (fileValidators.size >= VALIDATOR_LIMIT) fileValidators.delete(fileValidators.keys().next().value!);
    fileValidators.set(key, { version, etag: `"${digest}${representation.encoding ? '-' + representation.encoding : ''}"`, length: representation.bytes.length, ...(representation.encoding ? { encoding: representation.encoding } : {}) });
  }
  sendBytes(req, res, bytes, { ...options, modified: file.modified, ...(representation.encoding ? { encoded: { bytes: representation.bytes, encoding: representation.encoding } } : {}) }); return true;
}

/** Sort transport keys while preserving the original packed z field spelling. */
export function canonicalRenderQuery(query: string): string {
  return query.split('&').filter(Boolean).map((raw, index) => {
    const pair = new URLSearchParams(raw), key = pair.keys().next().value ?? '';
    return { key, index, raw: key === 'z' ? raw : pair.toString() };
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index).map(pair => pair.raw).join('&');
}
