/**
 * Brandfolder driver (plans/17 §12) — the reference provider. Public v4 API
 * only (https://brandfolder.com/api/v4, JSON:API shape), bearer-token auth.
 *
 * Brandfolder's storage/thumbnail URLs are SIGNED AND EXPIRING, so this driver
 * declares expiringUrls and resolveBlob re-fetches a fresh URL per request and
 * streams the bytes — no upstream URL is ever persisted or handed to clients.
 * Upstream fetches are pinned to Brandfolder-owned hosts (no open proxy).
 */
import type { CatalogProvider, ProviderAssetRef, ProviderFormatRef, ResolvedBlob } from './types.ts';

export interface BrandfolderOptions {
  brandfolderId: string;
  baseUrl?: string; // tests point this at a fixture server
}

const DEFAULT_BASE = 'https://brandfolder.com/api/v4';
const ALLOWED_HOSTS = /(^|\.)(brandfolder\.com|bfldr\.com)$/;
const PAGE_SIZE = 100;
const ASSET_FIELDS = 'fields=cdn_url,thumbnail_url,extension,updated_at,approved';
// Attachment filename/size ride the default include payload (verified live);
// original_filename maps into ProviderFormatRef.filename for provenance.

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
    if (!ALLOWED_HOSTS.test(new URL(url).hostname)) throw new Error('brandfolder url outside allowed hosts');
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`brandfolder blob fetch ${res.status}`);
    return res;
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
        format: (a.attributes.extension as string) ?? 'bin',
        remoteRef: a.id,
        ...(typeof a.attributes.size === 'number' ? { size: a.attributes.size } : {}),
        ...(typeof a.attributes.filename === 'string' ? { filename: a.attributes.filename } : {}),
      }));
      const sectionRef = rel.section?.data;
      const section = sectionRef && !Array.isArray(sectionRef) ? included.get(`sections:${sectionRef.id}`) : undefined;
      const sectionName = section?.attributes.name as string | undefined;
      return {
        remoteId: asset.id,
        name: (asset.attributes.name as string) ?? asset.id,
        ...(asset.attributes.description ? { description: asset.attributes.description as string } : {}),
        nativeType: asset.type,
        sections: sectionName ? [sectionName] : [],
        tags: [],
        ...(typeof asset.attributes.approved === 'boolean' ? { approved: asset.attributes.approved } : {}),
        ...(asset.attributes.updated_at ? { updatedAt: asset.attributes.updated_at as string } : {}),
        formats,
        hasThumbnail: typeof asset.attributes.thumbnail_url === 'string',
      };
    });
  };

  return {
    id,
    kind: 'brandfolder',
    capabilities: { search: true, thumbnails: true, expiringUrls: true },

    async listAssets(cursor) {
      const page = cursor ? Number(cursor) : 1;
      const doc = await api(
        `/brandfolders/${options.brandfolderId}/assets?per=${PAGE_SIZE}&page=${page}&include=section,attachments&${ASSET_FIELDS}`,
      );
      const next = doc.meta?.next_page;
      return { assets: mapAssets(doc), ...(next ? { next: String(next) } : {}) };
    },

    async searchAssets(query, limit) {
      const doc = await api(
        `/brandfolders/${options.brandfolderId}/assets?search=${encodeURIComponent(query)}&per=${limit}&include=section,attachments&${ASSET_FIELDS}`,
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
      const doc = await api(`/attachments/${formatRef}?fields=url,mimetype,size`);
      const attrs = (Array.isArray(doc.data) ? doc.data[0] : doc.data)?.attributes ?? {};
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
