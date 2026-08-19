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
 *
 * READY FOR TENANT DAY (plans/33). Every guessed key is an exported constant
 * array below, read through firstKey, so widening a wrong guess is a one-line
 * edit here and nowhere else. `sampleShape` reports what the tenant actually
 * returned (key names and types, never values) and diffs it against those
 * constants. Each failure that depends on a guess names the assumption, the
 * constant, and docs/providers/intelligencebank-live-verify.md.
 */
import { sha256Hex } from '../../lib/crypto.ts';
import {
  allStrings, buildDetailShapeReport, buildShapeReport, findRecordArray, firstId, firstKey,
  firstNumber, firstRecord, firstString, liveVerifyError, liveVerifyMessage, recordArray,
  type ProviderShapeReport, type ShapeExpectation,
} from './shape.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef, type ProviderPage, type ResolvedBlob } from './types.ts';

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

// --- the LIVE-VERIFY key guesses, one exported constant per logical field ---
// These ARE the record documentation now: nothing below reads a key name
// literally, so a name that turns out wrong is corrected in exactly one place.

/** The login handshake's own fields - the exchange that yields the v3 base URL. */
export const SESSION_ID_KEYS = ['sid', 'session'] as const;
export const API_BASE_KEYS = ['apiV3url'] as const;
export const CLIENT_ID_KEYS = ['clientid'] as const;
export const SESSION_TTL_KEYS = ['expires_in'] as const;
/** Which envelope key holds the resource array. */
export const LIST_ENVELOPE_KEYS = ['resources', 'response'] as const;
export const META_KEYS = ['meta'] as const;
export const NEXT_PAGE_KEYS = ['next_page'] as const;
/** The resource id. REQUIRED: a resource without one cannot federate. */
export const RECORD_ID_KEYS = ['resourceid', 'id'] as const;
/** The upstream filename - also ProviderFormatRef.filename. */
export const FILENAME_KEYS = ['filename'] as const;
export const DISPLAY_NAME_KEYS = ['name'] as const;
export const FORMAT_KEYS = ['extension'] as const;
export const SIZE_KEYS = ['size'] as const;
export const UPDATED_AT_KEYS = ['updated', 'updated_date'] as const;
/** Workflow STATE, not a boolean (plans/27 §9) - tenant-defined values. */
export const WORKFLOW_STATE_KEYS = ['workflow_state', 'status'] as const;
/** Native availability (plans/27 §2). */
export const AVAILABLE_FROM_KEYS = ['publish_date'] as const;
export const AVAILABLE_UNTIL_KEYS = ['expiry_date', 'review_date'] as const;
export const FOLDER_KEYS = ['folder'] as const;
export const FOLDER_NAME_KEYS = ['name'] as const;
export const CATEGORY_KEYS = ['category'] as const;
/** The signed link resolveBlob streams from, re-read per request. */
export const DOWNLOAD_URL_KEYS = ['download_url'] as const;
/** Where the single-resource call wraps its record, when it wraps it. */
export const DETAIL_WRAPPER_KEYS = ['resource'] as const;

/** What `--shape` diffs the tenant's response against. */
const ENVELOPE_EXPECTED: ShapeExpectation[] = [
  { keys: LIST_ENVELOPE_KEYS, constant: 'LIST_ENVELOPE_KEYS' },
  { keys: META_KEYS, constant: 'META_KEYS' },
];
const RECORD_EXPECTED: ShapeExpectation[] = [
  { keys: RECORD_ID_KEYS, constant: 'RECORD_ID_KEYS' },
  { keys: [...FILENAME_KEYS, ...DISPLAY_NAME_KEYS], constant: 'FILENAME_KEYS / DISPLAY_NAME_KEYS' },
  { keys: FORMAT_KEYS, constant: 'FORMAT_KEYS' },
  { keys: SIZE_KEYS, constant: 'SIZE_KEYS' },
  { keys: UPDATED_AT_KEYS, constant: 'UPDATED_AT_KEYS' },
  { keys: WORKFLOW_STATE_KEYS, constant: 'WORKFLOW_STATE_KEYS' },
  { keys: AVAILABLE_FROM_KEYS, constant: 'AVAILABLE_FROM_KEYS' },
  { keys: AVAILABLE_UNTIL_KEYS, constant: 'AVAILABLE_UNTIL_KEYS' },
  { keys: FOLDER_KEYS, constant: 'FOLDER_KEYS' },
  { keys: CATEGORY_KEYS, constant: 'CATEGORY_KEYS' },
];
/** What the DETAIL report diffs: the byte path's own guesses, which no list
 *  page can confirm (the wrapper rides the envelope side, see detailShape). */
const DETAIL_EXPECTED: ShapeExpectation[] = [
  { keys: DOWNLOAD_URL_KEYS, constant: 'DOWNLOAD_URL_KEYS' },
  { keys: SIZE_KEYS, constant: 'SIZE_KEYS' },
];

type IbResource = Record<string, unknown>;
const asRecord = (v: unknown): IbResource | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as IbResource) : undefined);

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
    const doc = asRecord(await res.json());
    const sid = firstString(doc, SESSION_ID_KEYS);
    const apiV3url = firstString(doc, API_BASE_KEYS);
    if (!sid || !apiV3url) {
      throw liveVerifyError({
        kind: 'intelligencebank', constant: 'SESSION_ID_KEYS / API_BASE_KEYS',
        tried: [...SESSION_ID_KEYS, ...API_BASE_KEYS],
        problem: 'login returned no sid/apiV3url',
        assumption: 'the login response field names (the call succeeded, so the credential is fine and only the names are in doubt)',
      });
    }
    if (!hostOk(apiV3url)) throw new Error('intelligencebank apiV3url outside intelligencebank.com');
    const clientid = firstString(doc, CLIENT_ID_KEYS);
    const ttl = firstNumber(doc, SESSION_TTL_KEYS);
    const sess: IbSession = {
      sid, apiV3url: apiV3url.replace(/\/$/, ''), ...(clientid ? { clientid } : {}),
      expiresAt: Date.now() + (ttl !== undefined ? ttl * 1000 : SESSION_TTL_MS),
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

  const upstream = async (url: string, notFound?: () => Error): Promise<Response> => {
    if (!hostOk(url)) throw new Error('intelligencebank url outside allowed hosts');
    const res = await fetchImpl(url);
    if (res.status === 404 && notFound) throw notFound();
    if (!res.ok || !res.body) throw new Error(`intelligencebank blob fetch ${res.status}`);
    return res;
  };

  /** The id miss throws rather than dropping: silently losing a resource is
   *  worse than an error (plans/33 §5). Every other field is optional and a
   *  missing one federates the resource without it. */
  const toAsset = (raw: unknown): ProviderAssetRef => {
    const r = asRecord(raw) ?? {};
    const rid = firstId(r, RECORD_ID_KEYS);
    if (rid === undefined) {
      throw liveVerifyError({
        kind: 'intelligencebank', constant: 'RECORD_ID_KEYS', tried: RECORD_ID_KEYS,
        problem: 'a resource in the list carried no id',
        assumption: 'the resource id field name (required - a resource without one cannot federate)',
      });
    }
    const upstreamFile = firstString(r, FILENAME_KEYS);
    const fileName = upstreamFile ?? firstString(r, DISPLAY_NAME_KEYS) ?? rid;
    const format = firstString(r, FORMAT_KEYS) ?? extOf(fileName);
    const state = firstString(r, WORKFLOW_STATE_KEYS);
    const size = firstNumber(r, SIZE_KEYS);
    const updatedAt = firstString(r, UPDATED_AT_KEYS);
    const availableFrom = firstString(r, AVAILABLE_FROM_KEYS);
    const availableUntil = firstString(r, AVAILABLE_UNTIL_KEYS);
    const formats: ProviderFormatRef[] = [{
      format, remoteRef: 'download',
      ...(size !== undefined ? { size } : {}),
      ...(upstreamFile ? { filename: upstreamFile } : {}),
    }];
    return {
      remoteId: rid,
      name: stripExt(fileName),
      nativeType: format,
      sections: [...allStrings(firstRecord(r, FOLDER_KEYS), FOLDER_NAME_KEYS), ...allStrings(r, CATEGORY_KEYS)],
      tags: [],
      // workflow state → approved (§9): unfiltered when no approved-state set is configured.
      approved: approvedStates ? (state !== undefined && approvedStates.includes(state)) : true,
      ...(updatedAt ? { updatedAt } : {}),
      // Native availability (§2): publish → from, expiry/review → until.
      ...(availableFrom ? { availableFrom } : {}),
      ...(availableUntil ? { availableUntil } : {}),
      formats,
    };
  };

  /** Map one page, and say out loud what did not match (plans/33 §5). */
  const mapPage = (doc: unknown): ProviderPage => {
    const items = recordArray(doc, 'intelligencebank', LIST_ENVELOPE_KEYS, 'LIST_ENVELOPE_KEYS').records;
    const assets = items.map(toAsset);
    const notes: string[] = [];
    if (approvedStates && assets.length > 0 && assets.every((a) => a.approved === false)) {
      notes.push(liveVerifyMessage({
        kind: 'intelligencebank', constant: 'WORKFLOW_STATE_KEYS and options.approvedStates',
        tried: approvedStates,
        problem: `treated all ${assets.length} resource(s) on this page as not approved`,
        assumption: 'the workflow-state VALUES, which are tenant-defined (the key was read, no value matched the approved set)',
      }));
    }
    const next = firstKey(firstRecord(asRecord(doc), META_KEYS), NEXT_PAGE_KEYS);
    return { assets, ...(next ? { next: String(next) } : {}), ...(notes.length ? { notes } : {}) };
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
      return mapPage(await api<unknown>(listPath(page)));
    },

    async searchAssets(query, limit) {
      const doc = await api<unknown>(`/resources?per_page=${limit}&page=1&query=${encodeURIComponent(query)}`);
      return mapPage(doc).assets.slice(0, limit);
    },

    /** One page, reported as key names and TYPES only - never a value (§3). */
    async sampleShape(): Promise<ProviderShapeReport> {
      const path = listPath(1);
      const doc = await api<unknown>(path);
      const found = findRecordArray(doc, LIST_ENVELOPE_KEYS);
      return buildShapeReport({
        kind: 'intelligencebank',
        endpoint: `GET <apiV3url>${path}`,
        doc,
        records: found?.records ?? [],
        recordsKey: found?.key ?? null,
        envelopeExpected: ENVELOPE_EXPECTED,
        recordExpected: RECORD_EXPECTED,
        notes: [
          'the v3 base this call went to was discovered by the login handshake, not configured, so a wrong apiV3url shows up as a login failure rather than here.',
          `resolveBlob re-reads each resource and streams ${DOWNLOAD_URL_KEYS.join(' or ')} (DOWNLOAD_URL_KEYS), which a list record need not carry. Run the same command with --remote-id <resource id> for that call's own report.`,
        ],
      });
    },

    /** The DETAIL call resolveBlob makes, reported the same way (§3). This is
     *  where the byte-path guesses live - the wrapper and the download link -
     *  and a list page cannot answer either of them. */
    async detailShape(remoteId): Promise<ProviderShapeReport> {
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad intelligencebank resource id');
      const path = `/resource/${remoteId}`;
      return buildDetailShapeReport({
        kind: 'intelligencebank',
        endpoint: `GET <apiV3url>${path}`,
        doc: await api<unknown>(path),
        wrapperKeys: DETAIL_WRAPPER_KEYS,
        wrapperConstant: 'DETAIL_WRAPPER_KEYS',
        recordExpected: DETAIL_EXPECTED,
        notes: ['whether the link is the ORIGINAL or a rendition is not a key name and is not in this report - only the step 3 checksum answers that.'],
      });
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'download') throw new Error('intelligencebank assets have a single download format');
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad intelligencebank resource id');
      // Re-fetch the resource for a FRESH signed download URL every request.
      const path = `/resource/${remoteId}`;
      const raw = asRecord(await api<unknown>(path));
      const record = firstRecord(raw, DETAIL_WRAPPER_KEYS) ?? raw;
      const url = firstString(record, DOWNLOAD_URL_KEYS);
      if (!url) {
        throw liveVerifyError({
          kind: 'intelligencebank', constant: 'DOWNLOAD_URL_KEYS / DETAIL_WRAPPER_KEYS',
          tried: [...DOWNLOAD_URL_KEYS, ...DETAIL_WRAPPER_KEYS.map((k) => `${k}.*`)],
          problem: `resource has no download url in the response to GET ${path}`,
          assumption: 'the download-link field name, or the wrapper the detail call puts the record in',
        });
      }
      const res = await upstream(url, () => liveVerifyError({
        kind: 'intelligencebank', constant: 'DOWNLOAD_URL_KEYS', tried: DOWNLOAD_URL_KEYS,
        problem: 'blob fetch 404 for the signed download link',
        assumption: 'the download-link field (the link was read but the CDN would not serve it; it may be a rendition link, or expire on read)',
      }));
      const size = firstNumber(record, SIZE_KEYS);
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        ...(size !== undefined ? { size } : {}),
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
