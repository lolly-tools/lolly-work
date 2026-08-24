/**
 * Optimizely CMP (Content Marketing Platform) DAM driver (plans/27 §9, §10) - 
 * the web DAM SUSE keeps and federates read-only, NOT a source it exits. Public
 * CMP DAM API v3 (api.cmp.optimizely.com; legacy tenants: api.welcomesoftware.com),
 * OAuth2 with a refreshable token (oauth.ts - the operator's own registered CMP
 * app, BYOT). This driver proves two of §9's generalizations concretely:
 *   - native availability → Wave 1: `expires_at` maps straight to
 *     `availableUntil` (CMP models expiry but no release date);
 *   - approval-is-not-a-boolean → `is_public` (and not-`is_archived`) is the
 *     servable-state signal, mapped onto `ProviderAssetRef.approved`, so an
 *     exposure `requireApproved` slice federates only public, live assets.
 * Folder name and labels both fold into `sections`, so a `includeSections`
 * exposure slice can scope by folder OR label (plans/27 §10 "folder/label slices").
 *
 * Download URLs are signed + short-lived, so this declares expiringUrls and
 * resolveBlob re-fetches a fresh URL per request and streams the bytes - no
 * upstream URL is ever persisted. Upstream fetches are host-pinned.
 *
 * LIVE-VERIFY before ship (the doc site is a JS app; the house rule from
 * plans/27 §9): confirm the exact endpoint paths, the asset field names marked
 * below, the OAuth token endpoint, and the CDN host the download URL resolves to
 * against a real CMP tenant. Everything is fixture-tested here with injected
 * fetch, exactly like the Brandfolder driver was built from recorded shapes.
 */
import { getAccessToken, parseOAuthCredential } from './oauth.ts';
import { extOf, type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef, type PublishInput, type ResolvedBlob } from './types.ts';

export interface OptimizelyCmpOptions {
  /** CMP DAM API base. Default api.cmp.optimizely.com; legacy tenants set
   *  api.welcomesoftware.com. Tests point this at a fixture server. */
  baseUrl?: string;
  /** OAuth token endpoint. Defaults to the base host's /o/oauth2/v1/token. */
  tokenUrl?: string;
  /** Opt in to the publish-out arm (plans/27 §10): this provider may receive
   *  lolly-generated exports. Off by default - a source is read-only unless the
   *  operator explicitly turns publishing on. */
  publish?: boolean;
}

const DEFAULT_BASE = 'https://api.cmp.optimizely.com';
// Download URLs resolve to a CMP/Welcome CDN - pin to the DAM's own hosts so
// /catalog/ext/* never becomes an open proxy. LIVE-VERIFY the CDN host.
const ALLOWED_HOSTS = /(^|\.)(cmp\.optimizely\.com|optimizely\.com|welcomesoftware\.com|welcomecdn\.com)$/;
const PAGE_SIZE = 100;

// CMP asset shape (LIVE-VERIFY field names against a real tenant).
interface CmpAsset {
  id: string;
  title?: string;
  name?: string;
  type?: string; // image | video | raw_file | structured_content | …
  asset_type?: string;
  folder?: { id?: string; name?: string } | null;
  labels?: string[];
  expires_at?: string | null;
  is_public?: boolean;
  is_archived?: boolean;
  updated_at?: string;
  file?: { name?: string; size?: number; extension?: string; mime_type?: string };
  download_url?: string;
}
interface CmpListDoc {
  data: CmpAsset[];
  meta?: { total?: number };
}

export function createOptimizelyCmpProvider(
  id: string,
  options: OptimizelyCmpOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const tokenUrl = options.tokenUrl ?? `${new URL(base).origin}/o/oauth2/v1/token`;
  const token = (): Promise<string> => getAccessToken({ providerId: id, cred: parseOAuthCredential(secret), tokenUrl, fetchImpl });

  const api = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`optimizely-cmp api ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  const apiPost = async <T>(path: string, body: unknown, method = 'POST'): Promise<T> => {
    const res = await fetchImpl(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`optimizely-cmp ${method} ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  const upstream = async (url: string): Promise<Response> => {
    if (!ALLOWED_HOSTS.test(new URL(url).hostname)) throw new Error('optimizely-cmp url outside allowed hosts');
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`optimizely-cmp blob fetch ${res.status}`);
    return res;
  };

  const toAsset = (a: CmpAsset): ProviderAssetRef => {
    const fileName = a.file?.name ?? a.title ?? a.name ?? a.id;
    const format = a.file?.extension ?? extOf(fileName);
    // Folder name + labels both scope-able: fold both into sections.
    const sections = [...(a.folder?.name ? [a.folder.name] : []), ...(a.labels ?? [])];
    const formats: ProviderFormatRef[] = [{
      format,
      remoteRef: 'content',
      ...(a.file?.size !== undefined ? { size: a.file.size } : {}),
      ...(a.file?.name ? { filename: a.file.name } : {}),
    }];
    return {
      remoteId: a.id,
      name: a.title ?? a.name ?? a.id,
      nativeType: a.asset_type ?? a.type ?? 'file',
      sections,
      tags: [],
      // is_public AND not-is_archived is the servable-state signal (§9).
      approved: a.is_public === true && a.is_archived !== true,
      ...(a.updated_at ? { updatedAt: a.updated_at } : {}),
      // expires_at → availableUntil (Wave 1); CMP has no release date.
      ...(a.expires_at ? { availableUntil: a.expires_at } : {}),
      formats,
    };
  };

  const listPath = (extra: string): string => `/v3/assets?limit=${PAGE_SIZE}&${extra}`;

  return {
    id,
    kind: 'optimizely-cmp',
    capabilities: { authKind: 'oauth', search: true, thumbnails: false, expiringUrls: true, publish: options.publish === true },

    async listAssets(cursor) {
      const offset = cursor ? Number(cursor) : 0;
      const doc = await api<CmpListDoc>(listPath(`offset=${offset}`));
      const assets = (doc.data ?? []).map(toAsset);
      // Offset pagination: a full page implies there may be more.
      const next = assets.length === PAGE_SIZE ? String(offset + assets.length) : undefined;
      return { assets, ...(next ? { next } : {}) };
    },

    async searchAssets(query, limit) {
      const doc = await api<CmpListDoc>(listPath(`offset=0&query=${encodeURIComponent(query)}`));
      return (doc.data ?? []).map(toAsset).slice(0, limit);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'content') throw new Error('optimizely-cmp assets have a single content format');
      if (!/^[A-Za-z0-9_.-]+$/.test(remoteId)) throw new Error('bad optimizely-cmp asset id');
      // Re-fetch the asset for a FRESH signed download_url every request.
      const asset = await api<{ data: CmpAsset } | CmpAsset>(`/v3/assets/${remoteId}`);
      const record = 'data' in asset ? asset.data : asset;
      const url = record?.download_url;
      if (!url) throw new Error('optimizely-cmp asset has no download url');
      const res = await upstream(url);
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: record.file?.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream',
        ...(record.file?.size !== undefined ? { size: record.file.size } : {}),
      };
    },

    // Publish a lolly-generated export INTO CMP (plans/27 §10), riding CMP's
    // documented ingestion flow: get an upload URL, PUT the bytes, then create
    // the asset referencing the upload and set its title. LIVE-VERIFY the exact
    // request/response shapes against a real tenant (upload_url field name, the
    // create body's upload reference, the fields endpoint) - modelled here.
    async publishAsset(input: PublishInput): Promise<{ remoteId: string; url?: string }> {
      const up = await api<{ upload_url: string; id?: string }>('/v3/upload-url');
      if (!ALLOWED_HOSTS.test(new URL(up.upload_url).hostname)) throw new Error('optimizely-cmp upload url outside allowed hosts');
      const put = await fetchImpl(up.upload_url, { method: 'PUT', headers: { 'content-type': input.contentType }, body: Buffer.from(input.bytes) });
      if (!put.ok) throw new Error(`optimizely-cmp upload PUT ${put.status}`);
      const created = await apiPost<{ id: string; public_url?: string }>('/v3/assets', {
        title: input.name,
        ...(up.id ? { upload_id: up.id } : { upload_url: up.upload_url }),
        file_name: `${input.name}.${input.format}`,
      });
      return { remoteId: created.id, ...(created.public_url ? { url: created.public_url } : {}) };
    },

    async healthCheck() {
      try {
        await api(listPath('offset=0'));
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
