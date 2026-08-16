/**
 * IntelligenceBank driver (plans/27 §9) - the governance-rich enterprise DAM.
 * Targets the CURRENT v3 Graph API ONLY (decision of record): no work against the
 * deprecated v2 resource endpoints. The one v2-named call that remains is the
 * login handshake, because IntelligenceBank defines it as the auth mechanism FOR
 * v3 (documented, no planned termination) - it is used for auth only.
 *
 * Auth is a login-exchange: the documented login call (against the tenant's
 * `platformUrl`, with a single sealed credential) returns a session plus a
 * per-tenant `apiV3url` + `clientid`. Those discovered values are driver-internal
 * state (never the credential, never config the operator types). Every v3 call
 * goes to the discovered `apiV3url`, host-pinned to the intelligencebank.com
 * family so a poisoned login response can't redirect the driver.
 *
 * IntelligenceBank has NATIVE governance: expiry/review dates map to the
 * availability window (plans/27 §2), and workflow STATES (not a boolean) map onto
 * approved via a configured approved-state set (§9). Its role here is the same as
 * any legacy DAM: read-only federation + the exit (materialize → cutover).
 *
 * LIVE-VERIFY before ship (house rule, plans/27 §9; the doc site is a JS app):
 * confirm the login endpoint + response, the resource field names marked below,
 * the download href, and the CDN host against a real tenant. Fixture-tested with
 * injected fetch - neither building nor testing touches a live tenant.
 */
import { sha256Hex } from '../../lib/crypto.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef, type ResolvedBlob } from './types.ts';

export interface IntelligenceBankOptions {
  /** The tenant's IntelligenceBank platform URL, e.g. "https://acme.intelligencebank.com". */
  platformUrl: string;
  /** Federate only this folder (else the whole resource tree). */
  folderId?: string;
  /** Workflow states that count as approved (§9). Absent → approval unfiltered. */
  approvedStates?: string[];
}

const ALLOWED_HOSTS = /(^|\.)intelligencebank\.com$/;
const PAGE_SIZE = 100;
const SESSION_TTL_MS = 30 * 60_000; // re-login every 30 min unless the login states otherwise

interface IbSession { sid: string; apiV3url: string; clientid?: string; expiresAt: number }
const sessionCache = new Map<string, IbSession>();

// Login response (LIVE-VERIFY field names) - the exchange that yields the v3 base URL.
interface IbLoginDoc { sid?: string; session?: string; apiV3url?: string; clientid?: string; expires_in?: number }
// Resource shape (LIVE-VERIFY field names).
interface IbResource {
  id?: string;
  resourceid?: string;
  name?: string;
  filename?: string;
  extension?: string;
  size?: number;
  updated?: string;
  updated_date?: string;
  folder?: { id?: string; name?: string } | null;
  category?: string;
  workflow_state?: string;
  status?: string;
  publish_date?: string | null;
  review_date?: string | null;
  expiry_date?: string | null;
  download_url?: string;
}
interface IbListDoc { resources?: IbResource[]; response?: IbResource[]; meta?: { next_page?: number | null } }

export function createIntelligenceBankProvider(
  id: string,
  options: IntelligenceBankOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
): CatalogProvider {
  const approvedStates = options.approvedStates;

  const hostOk = (url: string): boolean => ALLOWED_HOSTS.test(new URL(url).hostname);

  // The login handshake - cached per (provider, credential) like the OAuth token
  // cache, because driver instances are created per request.
  const session = async (): Promise<IbSession> => {
    if (!secret) throw new Error('intelligencebank provider has no credential');
    if (!options.platformUrl) throw new Error('intelligencebank provider needs options.platformUrl');
    const key = `${id}:${sha256Hex(secret).slice(0, 16)}`;
    const hit = sessionCache.get(key);
    if (hit && hit.expiresAt - 60_000 > Date.now()) return hit;
    const platform = options.platformUrl.replace(/\/$/, '');
    if (!hostOk(platform)) throw new Error('intelligencebank platformUrl outside intelligencebank.com');
    // LIVE-VERIFY: exact login path + body (v2-named handshake that authorises v3).
    const res = await fetchImpl(`${platform}/webapp/1.0/api/authenticate`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ apikey: secret }),
    });
    if (!res.ok) throw new Error(`intelligencebank login ${res.status}`);
    const doc = (await res.json()) as IbLoginDoc;
    const sid = doc.sid ?? doc.session;
    if (!sid || !doc.apiV3url) throw new Error('intelligencebank login returned no sid/apiV3url');
    if (!hostOk(doc.apiV3url)) throw new Error('intelligencebank apiV3url outside intelligencebank.com');
    const sess: IbSession = {
      sid, apiV3url: doc.apiV3url.replace(/\/$/, ''), ...(doc.clientid ? { clientid: doc.clientid } : {}),
      expiresAt: Date.now() + (typeof doc.expires_in === 'number' ? doc.expires_in * 1000 : SESSION_TTL_MS),
    };
    sessionCache.set(key, sess);
    return sess;
  };

  const api = async <T>(path: string): Promise<T> => {
    const s = await session();
    const res = await fetchImpl(`${s.apiV3url}${path}`, { headers: { sid: s.sid, accept: 'application/json', ...(s.clientid ? { clientid: s.clientid } : {}) } });
    if (!res.ok) throw new Error(`intelligencebank api ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  const upstream = async (url: string): Promise<Response> => {
    if (!hostOk(url)) throw new Error('intelligencebank url outside allowed hosts');
    const res = await fetchImpl(url);
    if (!res.ok || !res.body) throw new Error(`intelligencebank blob fetch ${res.status}`);
    return res;
  };

  const toAsset = (r: IbResource): ProviderAssetRef => {
    const rid = r.resourceid ?? r.id ?? '';
    const fileName = r.filename ?? r.name ?? rid;
    const format = r.extension ?? extOf(fileName);
    const state = r.workflow_state ?? r.status;
    const formats: ProviderFormatRef[] = [{
      format, remoteRef: 'download',
      ...(r.size !== undefined ? { size: r.size } : {}),
      ...(r.filename ? { filename: r.filename } : {}),
    }];
    return {
      remoteId: rid,
      name: stripExt(fileName),
      nativeType: format,
      sections: [...(r.folder?.name ? [r.folder.name] : []), ...(r.category ? [r.category] : [])],
      tags: [],
      // workflow state → approved (§9): unfiltered when no approved-state set is configured.
      approved: approvedStates ? (state !== undefined && approvedStates.includes(state)) : true,
      ...(r.updated ?? r.updated_date ? { updatedAt: (r.updated ?? r.updated_date) as string } : {}),
      // Native availability (§2): publish/review → from, expiry → until.
      ...(r.publish_date ? { availableFrom: r.publish_date } : {}),
      ...(r.expiry_date ?? r.review_date ? { availableUntil: (r.expiry_date ?? r.review_date) as string } : {}),
      formats,
    };
  };

  const mapPage = (doc: IbListDoc): { assets: ProviderAssetRef[]; next?: string } => {
    const items = doc.resources ?? doc.response ?? [];
    const next = doc.meta?.next_page;
    return { assets: items.map(toAsset), ...(next ? { next: String(next) } : {}) };
  };

  const listPath = (page: number): string => {
    const folder = options.folderId ? `&folderid=${encodeURIComponent(options.folderId)}` : '';
    return `/resources?per_page=${PAGE_SIZE}&page=${page}${folder}`;
  };

  return {
    id,
    kind: 'intelligencebank',
    capabilities: { search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      const page = cursor ? Number(cursor) : 1;
      return mapPage(await api<IbListDoc>(listPath(page)));
    },

    async searchAssets(query, limit) {
      const doc = await api<IbListDoc>(`/resources?per_page=${limit}&page=1&query=${encodeURIComponent(query)}`);
      return mapPage(doc).assets.slice(0, limit);
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'download') throw new Error('intelligencebank assets have a single download format');
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad intelligencebank resource id');
      // Re-fetch the resource for a FRESH signed download URL every request.
      const raw = await api<IbResource & { resource?: IbResource }>(`/resource/${remoteId}`);
      const record: IbResource = raw.resource ?? raw;
      const url = record.download_url;
      if (!url) throw new Error('intelligencebank resource has no download url');
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
