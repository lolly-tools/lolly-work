/**
 * Acquia DAM / Widen driver (plans/27 §9) — the governance-rich enterprise DAM.
 * Public Widen v2 API (api.widencollective.com/v2), bearer-token auth. In this
 * repo its role is the same as any legacy DAM: read-only federation, and the
 * exit (federate → materialize → cutover).
 *
 * Unlike Image Relay, Widen has NATIVE availability + approval: `release_date`
 * and `expiration_date` map straight to the availability window (plans/27 §2),
 * and an asset `status` maps onto ProviderAssetRef.approved (the approval-is-not-
 * a-boolean generalization, §9 — a configured approved-status set). Categories
 * fold into sections for exposure scoping.
 *
 * LIVE-VERIFY before ship (house rule, plans/27 §9): confirm the endpoint paths,
 * the asset field names marked below (release_date/expiration_date/status/
 * categories), the download embed/href, and the CDN host against a real tenant.
 * Fixture-tested with injected fetch, as every driver here is.
 */
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef, type ResolvedBlob } from './types.ts';

export interface AcquiaDamOptions {
  baseUrl?: string; // default api.widencollective.com/v2
  /** Widen search query to scope what federates (else the whole collective). */
  query?: string;
  /** Asset statuses that count as approved (default ['active']); an asset whose
   *  status is absent is treated as approved (the availability window time-gates). */
  approvedStatuses?: string[];
}

const DEFAULT_BASE = 'https://api.widencollective.com/v2';
const ALLOWED_HOSTS = /(^|\.)(widencollective\.com|widencdn\.net)$/;
const PAGE_SIZE = 100;

// Widen v2 asset shape (LIVE-VERIFY field names).
interface WidenAsset {
  id: string;
  external_id?: string;
  filename?: string;
  status?: string;
  release_date?: string | null;
  expiration_date?: string | null;
  last_update_date?: string;
  file_properties?: { format?: string; format_type?: string; size_bytes?: number; size_in_kbytes?: number };
  categories?: Array<{ name?: string } | string>;
  embeds?: { original?: { url?: string } };
  _links?: { download?: { href?: string } };
}
interface WidenListDoc {
  total_count?: number;
  items?: WidenAsset[];
}

export function createAcquiaDamProvider(
  id: string,
  options: AcquiaDamOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const approvedStatuses = options.approvedStatuses ?? ['active'];

  const api = async <T>(path: string): Promise<T> => {
    if (!secret) throw new Error('acquia-dam provider has no credential');
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${secret}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`acquia-dam api ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  const upstream = async (url: string): Promise<Response> => {
    if (!ALLOWED_HOSTS.test(new URL(url).hostname)) throw new Error('acquia-dam url outside allowed hosts');
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`acquia-dam blob fetch ${res.status}`);
    return res;
  };

  const sectionsOf = (a: WidenAsset): string[] =>
    (a.categories ?? []).map((c) => (typeof c === 'string' ? c : c.name)).filter((n): n is string => !!n);

  const toAsset = (a: WidenAsset): ProviderAssetRef => {
    const fileName = a.filename ?? a.id;
    const format = a.file_properties?.format ?? extOf(fileName);
    const sizeBytes = a.file_properties?.size_bytes
      ?? (a.file_properties?.size_in_kbytes !== undefined ? Math.round(a.file_properties.size_in_kbytes * 1024) : undefined);
    const formats: ProviderFormatRef[] = [{
      format, remoteRef: 'original',
      ...(sizeBytes !== undefined ? { size: sizeBytes } : {}),
      ...(a.filename ? { filename: a.filename } : {}),
    }];
    return {
      remoteId: a.id,
      name: stripExt(fileName),
      nativeType: format,
      sections: sectionsOf(a),
      tags: [],
      // status → approved (§9): absent status is treated as approved; the window time-gates.
      approved: a.status === undefined ? true : approvedStatuses.includes(a.status),
      ...(a.last_update_date ? { updatedAt: a.last_update_date } : {}),
      // Native availability (§2): release/expiration map directly.
      ...(a.release_date ? { availableFrom: a.release_date } : {}),
      ...(a.expiration_date ? { availableUntil: a.expiration_date } : {}),
      formats,
    };
  };

  const mapPage = (doc: WidenListDoc): { assets: ProviderAssetRef[]; next?: string } => {
    const items = doc.items ?? [];
    return { assets: items.map(toAsset), ...(items.length === PAGE_SIZE ? { next: '' } : {}) };
  };

  const listPath = (offset: number): string => {
    const q = options.query ? `&search=${encodeURIComponent(options.query)}` : '';
    return `/assets?limit=${PAGE_SIZE}&offset=${offset}&expand=file_properties,embeds,thumbnails${q}`;
  };

  return {
    id,
    kind: 'acquia-dam',
    capabilities: { search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      const offset = cursor ? Number(cursor) : 0;
      const page = mapPage(await api<WidenListDoc>(listPath(offset)));
      return { assets: page.assets, ...(page.next !== undefined ? { next: String(offset + page.assets.length) } : {}) };
    },

    async searchAssets(query, limit) {
      const doc = await api<WidenListDoc>(`/assets?limit=${limit}&offset=0&expand=file_properties,embeds&search=${encodeURIComponent(query)}`);
      return (doc.items ?? []).map(toAsset).slice(0, limit);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'original') throw new Error('acquia-dam assets have a single original format');
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad acquia-dam asset id');
      // Re-fetch the asset for a FRESH signed embed/download URL every request.
      const a = await api<WidenAsset>(`/assets/${remoteId}?expand=embeds`);
      const url = a.embeds?.original?.url ?? a._links?.download?.href;
      if (!url) throw new Error('acquia-dam asset has no download url');
      const res = await upstream(url);
      const sizeBytes = a.file_properties?.size_bytes
        ?? (a.file_properties?.size_in_kbytes !== undefined ? Math.round(a.file_properties.size_in_kbytes * 1024) : undefined);
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        ...(sizeBytes !== undefined ? { size: sizeBytes } : {}),
      };
    },

    async healthCheck() {
      try {
        await api(listPath(0));
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
