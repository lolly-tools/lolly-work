/**
 * Brandfolder driver (plans/17 §12) - the reference provider. Public v4 API
 * only (https://brandfolder.com/api/v4, JSON:API shape), bearer-token auth.
 *
 * Brandfolder's storage/thumbnail URLs are SIGNED AND EXPIRING, so this driver
 * declares expiringUrls and resolveBlob re-fetches a fresh URL per request and
 * streams the bytes - no upstream URL is ever persisted or handed to clients.
 * Upstream fetches are pinned to Brandfolder-owned hosts (no open proxy).
 */
import type { CatalogProvider, ProviderAssetRef, ProviderFormatRef, ResolvedBlob } from './types.ts';
import { extOf } from './types.ts';

export interface BrandfolderOptions {
  brandfolderId: string;
  baseUrl?: string; // tests point this at a fixture server
}

const DEFAULT_BASE = 'https://brandfolder.com/api/v4';
const ALLOWED_HOSTS = /(^|\.)(brandfolder\.com|bfldr\.com)$/;
const PAGE_SIZE = 100;
const ASSET_FIELDS = 'fields=cdn_url,thumbnail_url,extension,updated_at,approved,availability,availability_start,availability_end';
/** Some attachment extensions carry preview context after the actual suffix. */
function attachmentFormat(extension: unknown, filename: unknown): string {
  const suffix = typeof extension === 'string' ? extension.trim().replace(/^\./, '').toLowerCase() : '';
  if (/^[a-z0-9]{1,16}$/.test(suffix)) return suffix;
  const fromName = typeof filename === 'string' ? extOf(filename) : 'bin';
  if (/^[a-z0-9]{1,16}$/.test(fromName) && fromName !== 'bin') return fromName;
  const first = suffix.split(/\s+/)[0] ?? '';
  return /^[a-z0-9]{1,16}$/.test(first) ? first : 'bin';
}
// Attachment filename/size ride the default include payload (verified live);
// original_filename maps into ProviderFormatRef.filename for provenance.
// availability_start/availability_end are the v4 asset-availability window
// (plans/27 §2) - mapped into the ProviderAssetRef availability window below.
// One live confirmation against the SUSE tenant before ship (same discipline as
// the filename note above): confirm the field names and capture what the bare
// `availability` enum returns alongside the dates.

interface JsonApiResource {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  relationships?: Record<string, { data: Array<{ id: string; type: string }> | { id: string; type: string } | null }>;
}
interface JsonApiDoc {
  data: JsonApiResource[] | JsonApiResource;
  included?: JsonApiResource[];
  meta?: { next_page?: number | null };
}

export function createBrandfolderProvider(
  id: string,
  options: BrandfolderOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const base = options.baseUrl ?? DEFAULT_BASE;

  const api = async (path: string): Promise<JsonApiDoc> => {
    if (!secret) throw new Error('brandfolder provider has no credential');
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${secret}` } });
    if (!res.ok) throw new Error(`brandfolder api ${res.status} for ${path}`);
    return (await res.json()) as JsonApiDoc;
  };

  const upstream = async (url: string): Promise<Response> => {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password || !ALLOWED_HOSTS.test(target.hostname)) throw new Error('brandfolder url outside allowed hosts');
      const res = await fetchImpl(target.href, { redirect: 'manual' });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location'); await res.body?.cancel();
        if (!location || redirects === 3) throw new Error('brandfolder redirect refused');
        url = new URL(location, target).href; continue;
      }
      if (!res.ok || !res.body) throw new Error(`brandfolder blob fetch ${res.status}`);
      return res;
    }
    throw new Error('brandfolder redirect refused');
  };

  const mapAssets = (doc: JsonApiDoc): ProviderAssetRef[] => {
    const data = Array.isArray(doc.data) ? doc.data : [doc.data];
    const included = new Map((doc.included ?? []).map((r) => [`${r.type}:${r.id}`, r]));
    return data.map((asset) => {
      const rel = asset.relationships ?? {};
      const attachRefs = rel.attachments?.data;
      const attachments = (Array.isArray(attachRefs) ? attachRefs : [])
        .map((ref) => included.get(`attachments:${ref.id}`))
        .filter((a): a is JsonApiResource => !!a);
      const formats: ProviderFormatRef[] = attachments.map((a) => ({
        format: attachmentFormat(a.attributes.extension, a.attributes.filename),
        remoteRef: a.id,
        ...(typeof a.attributes.size === 'number' ? { size: a.attributes.size } : {}),
        ...(typeof a.attributes.filename === 'string' ? { filename: a.attributes.filename } : {}),
        ...(typeof a.attributes.width === 'number' && a.attributes.width > 0 ? { width: a.attributes.width } : {}),
        ...(typeof a.attributes.height === 'number' && a.attributes.height > 0 ? { height: a.attributes.height } : {}),
      }));
      const sectionRef = rel.section?.data;
      const section = sectionRef && !Array.isArray(sectionRef) ? included.get(`sections:${sectionRef.id}`) : undefined;
      const sectionName = typeof section?.attributes.name === 'string' ? section.attributes.name.trim() : '';
      const names = (relationship: string): string[] => {
        const refs = rel[relationship]?.data;
        return [...new Set((Array.isArray(refs) ? refs : []).flatMap(ref => {
          const name = included.get(`${ref.type}:${ref.id}`)?.attributes.name;
          return typeof name === 'string' && name.trim() ? [name.trim()] : [];
        }))];
      };
      return {
        remoteId: asset.id,
        name: (asset.attributes.name as string) ?? asset.id,
        ...(asset.attributes.description ? { description: asset.attributes.description as string } : {}),
        nativeType: asset.type,
        sections: sectionName ? [sectionName] : [],
        tags: names('tags'),
        collections: names('collections'),
        ...(typeof asset.attributes.approved === 'boolean' ? { approved: asset.attributes.approved } : {}),
        ...(asset.attributes.updated_at ? { updatedAt: asset.attributes.updated_at as string } : {}),
        ...(typeof asset.attributes.availability_start === 'string' ? { availableFrom: asset.attributes.availability_start } : {}),
        ...(typeof asset.attributes.availability_end === 'string' ? { availableUntil: asset.attributes.availability_end } : {}),
        formats,
        hasThumbnail: typeof asset.attributes.thumbnail_url === 'string',
      };
    });
  };

  // A URL segment is untrusted even when it resembles a mapped attachment id.
  const attachment = async (remoteId: string, formatRef: string, fields: string) => {
    const assetDoc = await api(`/assets/${encodeURIComponent(remoteId)}?include=attachments&fields=`);
    const asset = Array.isArray(assetDoc.data) ? assetDoc.data[0] : assetDoc.data;
    const refs = asset?.relationships?.attachments?.data;
    if (!Array.isArray(refs) || !refs.some(r => r.id === formatRef)) throw new Error('attachment does not belong to asset');
    const doc = await api(`/attachments/${encodeURIComponent(formatRef)}?fields=${fields}`);
    return (Array.isArray(doc.data) ? doc.data[0] : doc.data)?.attributes ?? {};
  };

  return {
    id,
    kind: 'brandfolder',
    capabilities: { authKind: 'credential', search: true, thumbnails: true, expiringUrls: true },

    async listAssets(cursor) {
      const page = cursor ? Number(cursor) : 1;
      const doc = await api(
        `/brandfolders/${options.brandfolderId}/assets?per=${PAGE_SIZE}&page=${page}&include=section,attachments,tags,collections&${ASSET_FIELDS}`,
      );
      const next = doc.meta?.next_page;
      return { assets: mapAssets(doc), ...(next ? { next: String(next) } : {}) };
    },

    async searchAssets(query, limit) {
      const doc = await api(
        `/brandfolders/${options.brandfolderId}/assets?search=${encodeURIComponent(query)}&per=${limit}&include=section,attachments,tags,collections&${ASSET_FIELDS}`,
      );
      return mapAssets(doc);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef === 'thumb') {
        const doc = await api(`/assets/${remoteId}?fields=thumbnail_url`);
        const url = (Array.isArray(doc.data) ? doc.data[0] : doc.data)?.attributes.thumbnail_url as string | undefined;
        if (!url) throw new Error('asset has no thumbnail');
        const res = await upstream(url);
        return { kind: 'stream', body: res.body as ReadableStream<Uint8Array>, contentType: res.headers.get('content-type') ?? 'image/png' };
      }
      // formatRef is an attachment id from our own index mapping; its `url`
      // attribute is a freshly signed storage URL on every fetch.
      const attrs = await attachment(remoteId, formatRef, 'url,mimetype,size');
      const url = attrs.url as string | undefined;
      if (!url) throw new Error('attachment has no url');
      const res = await upstream(url);
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: (attrs.mimetype as string) ?? res.headers.get('content-type') ?? 'application/octet-stream',
        ...(typeof attrs.size === 'number' ? { size: attrs.size } : {}),
      };
    },

    async resolveFilePreview(remoteId, formatRef) {
      const attrs = await attachment(remoteId, formatRef, 'thumbnail_url');
      const url = attrs.thumbnail_url;
      if (typeof url !== 'string' || !url) throw new Error('attachment has no preview');
      const res = await upstream(url);
      return { kind: 'stream', body: res.body as ReadableStream<Uint8Array>, contentType: res.headers.get('content-type') ?? 'image/png' };
    },

    async healthCheck() {
      try {
        await api(`/brandfolders/${options.brandfolderId}?fields=`);
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
