/**
 * Image Relay driver (plans/27 §9, §10) - a legacy DAM whose job in this repo is
 * federate → materialize → cutover (the exit), not long-term residence. Public
 * v2 API (api.imagerelay.com/api/v2), OAuth2 bearer (oauth.ts - the operator's
 * own registered app, PKCE via `lw providers auth`).
 *
 * Image Relay has NO native availability fields; a file's expiry (if modelled)
 * rides a custom-metadata field. So availability comes from the generic
 * `mapping.availabilityFields` (plans/27 §2): the driver reads the named custom
 * field off each record into the ProviderAssetRef window. `deleted`/`deletion_date`
 * are reported positively - a deleted file is dropped from federation rather than
 * inferred-missing. Driver etiquette the API requires: a mandatory `User-Agent`
 * and a 5 req/s cap, both enforced here.
 *
 * LIVE-VERIFY before ship (house rule, plans/27 §9): confirm the endpoint paths,
 * the file/folder field names marked below, the OAuth token endpoint, and the
 * download/quick-link host against a real tenant. Fixture-tested with injected
 * fetch, exactly as the Brandfolder and Optimizely drivers were.
 */
import { getAccessToken, parseOAuthCredential } from './oauth.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef, type ProviderMapping, type ResolvedBlob } from './types.ts';

export interface ImageRelayOptions {
  baseUrl?: string; // default api.imagerelay.com/api/v2
  tokenUrl?: string; // default the base host's /oauth/token
  /** Federate only this folder (and, with `recursive`, its descendants). */
  folderId?: string;
  recursive?: boolean;
}

const DEFAULT_BASE = 'https://api.imagerelay.com/api/v2';
const ALLOWED_HOSTS = /(^|\.)imagerelay\.com$/;
const PAGE_SIZE = 100;
const USER_AGENT = 'lolly-work/1 (+catalog-provider)'; // Image Relay requires a UA
const MIN_GAP_MS = 200; // 5 req/s

// Module-level per-provider rate limiter: reserve the next slot before awaiting
// so concurrent callers queue rather than race (mirrors the oauth token cache
// living module-level because driver instances are created per request).
const nextSlotAt = new Map<string, number>();
async function rateLimit(id: string): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, (nextSlotAt.get(id) ?? 0) + MIN_GAP_MS);
  nextSlotAt.set(id, at);
  const wait = at - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// Image Relay record shapes (LIVE-VERIFY field names).
interface IrFile {
  id: string | number;
  name?: string;
  filename?: string;
  extension?: string;
  file_type?: string;
  size?: number;
  updated_at?: string;
  keywords?: string[];
  tags?: string[];
  deleted?: boolean;
  deletion_date?: string | null;
  folder?: { id?: string | number; name?: string } | null;
  download_url?: string;
  /** Custom metadata ("terms" etc.) - availability rides here, if configured. */
  custom_fields?: Record<string, string>;
}
interface IrListDoc {
  files?: IrFile[];
  data?: IrFile[];
  meta?: { next_page?: number | null };
}

export function createImageRelayProvider(
  id: string,
  options: ImageRelayOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
  availabilityFields?: ProviderMapping['availabilityFields'],
): CatalogProvider {
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const tokenUrl = options.tokenUrl ?? `${new URL(base).origin}/oauth/token`;
  const token = (): Promise<string> => getAccessToken({ providerId: id, cred: parseOAuthCredential(secret), tokenUrl, fetchImpl });

  const api = async <T>(path: string): Promise<T> => {
    await rateLimit(id);
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`imagerelay api ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  const upstream = async (url: string): Promise<Response> => {
    if (!ALLOWED_HOSTS.test(new URL(url).hostname)) throw new Error('imagerelay url outside allowed hosts');
    await rateLimit(id);
    const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } });
    if (!res.ok || !res.body) throw new Error(`imagerelay blob fetch ${res.status}`);
    return res;
  };

  const readWindow = (file: IrFile): { availableFrom?: string; availableUntil?: string } => {
    const cf = file.custom_fields ?? {};
    const from = availabilityFields?.from ? cf[availabilityFields.from] : undefined;
    const until = availabilityFields?.until ? cf[availabilityFields.until] : undefined;
    return { ...(from ? { availableFrom: from } : {}), ...(until ? { availableUntil: until } : {}) };
  };

  const toAsset = (file: IrFile): ProviderAssetRef | null => {
    if (file.deleted) return null; // report deletions positively - drop, don't infer
    const fileName = file.filename ?? file.name ?? String(file.id);
    const format = file.extension ?? file.file_type ?? extOf(fileName);
    const formats: ProviderFormatRef[] = [{
      format, remoteRef: 'download',
      ...(file.size !== undefined ? { size: file.size } : {}),
      ...(file.filename ? { filename: file.filename } : {}),
    }];
    return {
      remoteId: String(file.id),
      name: file.name ? stripExt(file.name) : stripExt(fileName),
      nativeType: format,
      sections: file.folder?.name ? [file.folder.name] : [],
      tags: [...(file.keywords ?? []), ...(file.tags ?? [])],
      ...(file.updated_at ? { updatedAt: file.updated_at } : {}),
      ...readWindow(file),
      formats,
    };
  };

  const mapPage = (doc: IrListDoc): { assets: ProviderAssetRef[]; next?: string } => {
    const files = doc.files ?? doc.data ?? [];
    const assets = files.map(toAsset).filter((a): a is ProviderAssetRef => a !== null);
    const next = doc.meta?.next_page;
    return { assets, ...(next ? { next: String(next) } : {}) };
  };

  const listPath = (page: number): string => {
    const scope = options.folderId ? `/folders/${encodeURIComponent(options.folderId)}/files` : '/files';
    const recursive = options.folderId && options.recursive ? '&recursive=true' : '';
    return `${scope}?per_page=${PAGE_SIZE}&page=${page}${recursive}`;
  };

  return {
    id,
    kind: 'imagerelay',
    capabilities: { search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      const page = cursor ? Number(cursor) : 1;
      return mapPage(await api<IrListDoc>(listPath(page)));
    },

    async searchAssets(query, limit) {
      const doc = await api<IrListDoc>(`/files?per_page=${limit}&page=1&query=${encodeURIComponent(query)}`);
      return mapPage(doc).assets.slice(0, limit);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'download') throw new Error('imagerelay assets have a single download format');
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad imagerelay file id');
      // Re-fetch the file for a FRESH signed download link every request.
      const file = await api<{ file: IrFile } | IrFile>(`/files/${remoteId}`);
      const record = 'file' in file ? file.file : file;
      const url = record?.download_url;
      if (!url) throw new Error('imagerelay file has no download url');
      const res = await upstream(url);
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        ...(record.size !== undefined ? { size: record.size } : {}),
      };
    },

    async healthCheck() {
      try {
        await api(listPath(1));
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
