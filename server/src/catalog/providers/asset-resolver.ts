// SPDX-License-Identifier: MPL-2.0
/** Hosted provider-ref resolver: governed fetch, immutable optimization stages,
 * and content-addressed reuse. Provider credentials stay inside the injected
 * CMS driver; callers only supply logical refs. */
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { AssetRef } from '../../render/contract.ts';

export interface HostedProviderRef { raw: string; provider: string; scope: string; path: string; query: Readonly<Record<string, string>> }
export interface HostedAssetResult { asset: AssetRef; cacheKey: string; stages: string[]; sourceBytes: number; outputBytes: number }
export interface HostedAssetResolverOptions {
  allowedOrigins: string[];
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  cms?: (ref: HostedProviderRef) => Promise<{ bytes: Uint8Array; mime: string; id?: string } | null>;
  optimize?: (bytes: Uint8Array, request: { width?: number; height?: number; format?: string; sourceMime: string }) => Promise<{ bytes: Uint8Array; mime: string; stages: string[] }>;
}

/** Parse the same provider-ref grammar the pinned engine defines without
 * importing engine source into the control plane's narrow TS build. */
export function parseHostedProviderRef(value: unknown): HostedProviderRef | null {
  if (typeof value !== 'string') return null;
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/i.exec(value);
  if (!match) return null;
  try {
    return {
      raw: value,
      provider: match[1]!.toLowerCase(),
      scope: decodeURIComponent(match[2]!),
      path: (match[3] ?? '').split('/').filter(Boolean).map(decodeURIComponent).join('/'),
      query: Object.fromEntries(new URLSearchParams(match[4] ?? '')),
    };
  } catch { return null; }
}

export function createHostedAssetResolver(options: HostedAssetResolverOptions) {
  const cache = new Map<string, HostedAssetResult>();
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const origins = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));
  return async (ref: HostedProviderRef): Promise<HostedAssetResult | null> => {
    const request = { width: positive(ref.query.width), height: positive(ref.query.height), format: ref.query.format };
    let loaded: { bytes: Uint8Array; mime: string; id?: string } | null = null;
    if (ref.provider === 'cms') loaded = await options.cms?.(ref) ?? null;
    else if (ref.provider === 'net') {
      const target = netTarget(ref);
      if (!target || !origins.has(target.origin)) throw new Error('asset provider egress is not allowed for this origin');
      const response = await fetchImpl(target, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`asset provider fetch failed (${response.status})`);
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new Error('asset provider response exceeds the byte limit');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBytes) throw new Error('asset provider response exceeds the byte limit');
      loaded = { bytes, mime: response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream', id: target.href };
    } else return null;
    if (!loaded) throw new Error(`asset provider could not resolve ${ref.raw}`);
    const contentHash = createHash('sha256').update(loaded.bytes).digest('hex');
    const cacheKey = createHash('sha256').update(JSON.stringify({ provider: ref.provider, scope: ref.scope, path: ref.path, request, contentHash })).digest('hex');
    const hit = cache.get(cacheKey); if (hit) return hit;
    const transformed = options.optimize ? await options.optimize(loaded.bytes, { ...request, sourceMime: loaded.mime }) : { bytes: loaded.bytes, mime: loaded.mime, stages: [] };
    const format = request.format ?? formatOf(transformed.mime);
    const outputHash = createHash('sha256').update(transformed.bytes).digest('hex');
    const result: HostedAssetResult = {
      cacheKey, stages: transformed.stages, sourceBytes: loaded.bytes.byteLength, outputBytes: transformed.bytes.byteLength,
      asset: { source: 'remote', id: ref.raw, type: transformed.mime === 'image/svg+xml' ? 'vector' : 'raster', format, url: `data:${transformed.mime};base64,${Buffer.from(transformed.bytes).toString('base64')}`, checksum: `sha256-${Buffer.from(outputHash, 'hex').toString('base64')}`, meta: { provider: ref.provider, source: loaded.id ?? ref.raw, sourceChecksum: `sha256-${Buffer.from(contentHash, 'hex').toString('base64')}`, stages: transformed.stages } },
    };
    cache.set(cacheKey, result);
    return result;
  };
}

/** The hosted immutable image stages. Sharp strips metadata unless explicitly
 * told to retain it, so the returned names describe the operations actually
 * performed. Non-image data bindings pass through byte-for-byte. */
export async function optimizeHostedAsset(
  bytes: Uint8Array,
  request: { width?: number; height?: number; format?: string; sourceMime: string },
): Promise<{ bytes: Uint8Array; mime: string; stages: string[] }> {
  if (!request.sourceMime.toLowerCase().startsWith('image/')) return { bytes, mime: request.sourceMime, stages: [] };
  const sourceFormat = formatOf(request.sourceMime);
  const targetFormat = normalizeFormat(request.format ?? sourceFormat);
  if (targetFormat === 'svg') {
    if (sourceFormat !== 'svg') throw new Error('raster assets cannot be converted to SVG');
    let text = new TextDecoder().decode(bytes)
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, '');
    const stages = ['strip-metadata'];
    if (request.width || request.height) {
      text = text.replace(/<svg\b([^>]*)>/i, (_whole, attrs: string) => {
        let next = attrs.replace(/\s(?:width|height)=(['"])[^'"]*\1/gi, '');
        if (request.width) next += ` width="${request.width}"`;
        if (request.height) next += ` height="${request.height}"`;
        return `<svg${next}>`;
      });
      stages.unshift('resize');
    }
    return { bytes: new TextEncoder().encode(text), mime: 'image/svg+xml', stages };
  }
  if (!['png', 'jpg', 'webp', 'avif', 'gif', 'tiff'].includes(targetFormat)) {
    throw new Error(`unsupported hosted asset format: ${targetFormat}`);
  }
  let image = sharp(bytes, { animated: true, limitInputPixels: 100_000_000 }).rotate();
  const stages: string[] = [];
  if (request.width || request.height) {
    image = image.resize({ width: request.width, height: request.height, fit: 'inside', withoutEnlargement: true });
    stages.push('resize');
  }
  if (targetFormat !== sourceFormat) stages.push('format-convert');
  if (targetFormat === 'jpg') image = image.jpeg();
  else if (targetFormat === 'png') image = image.png();
  else if (targetFormat === 'webp') image = image.webp();
  else if (targetFormat === 'avif') image = image.avif();
  else if (targetFormat === 'gif') image = image.gif();
  else image = image.tiff();
  stages.push('strip-metadata');
  return { bytes: new Uint8Array(await image.toBuffer()), mime: mimeOf(targetFormat), stages };
}

const positive = (value: string | undefined): number | undefined => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : undefined; };
const normalizeFormat = (format: string): string => format.toLowerCase().replace('jpeg', 'jpg');
const formatOf = (mime: string): string => mime === 'image/svg+xml' ? 'svg' : normalizeFormat(mime.replace(/^image\//, ''));
const mimeOf = (format: string): string => format === 'jpg' ? 'image/jpeg' : `image/${format}`;
function netTarget(ref: HostedProviderRef): URL | null {
  try {
    const decoded = decodeURIComponent([ref.scope, ref.path].filter(Boolean).join('/'));
    return new URL(/^https?:\/\//i.test(decoded) ? decoded : `https://${decoded}`);
  } catch { return null; }
}
