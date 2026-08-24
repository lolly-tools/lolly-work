/**
 * Canto driver (plans/32 §3, §4) - a legacy DAM whose job in this repo is
 * federate → materialize → cutover (the exit), not long-term residence. Canto
 * acquired Image Relay in September 2024 and is moving that customer base onto
 * its own platform, so this kind serves two populations: native Canto tenants
 * leaving at contract end, and Image Relay tenants the vendor migration has
 * already carried across. Which driver an Image Relay customer exits through is
 * the fork matrix in docs/offboarding.md.
 *
 * Strict BYOT, no exceptions (decision of record, plans/32 §9): the tenant owner
 * requests the App ID + Secret from Canto support under their OWN contract. Lolly
 * holds no Canto account, registers no app, and signs no Canto EULA, so the
 * connector terms fall to the tenant owner (the standing rule for every DAM
 * connector here, first set for IntelligenceBank). Credential is the standard
 * sealed OAuth JSON via oauth.ts, captured with `lw providers credential`.
 *
 * Canto lists by SCHEME rather than one assets endpoint, so listing walks the
 * scheme set in fixed order behind a composite cursor "<schemeIndex>:<start>"
 * (cursors are opaque strings to every caller, so the composite stays
 * driver-internal), and remoteId carries the scheme as "<scheme>:<id>" because
 * the detail and binary endpoints are scheme-scoped. Canto has no documented
 * native availability field, so the window comes from the generic
 * `mapping.availabilityFields` (plans/27 §2) read off the record's custom-field
 * bag. Read-only: no `publish`, because Canto is a source being exited, never a
 * publish destination.
 *
 * LIVE-VERIFY before ship (house rule, plans/27 §9; Canto's API doc site is a JS
 * app, so nothing below is confirmed against a tenant). The pass runs only on a
 * volunteering customer's own tenant under their contract (plans/32 §5):
 *  - the REST base path /api/v1 and the OAuth token endpoint used here;
 *  - the token EXCHANGE itself: this driver posts an RFC 6749 form body
 *    (grant_type=refresh_token + client_id/client_secret, see getAccessToken
 *    in providers/oauth.ts). Whether Canto's token endpoint wants that shape,
 *    or an Authorization header, or a different grant, is as much a guess as
 *    the URL - a 400 there is the request shape, not the credential;
 *  - the exact scheme list and the limit/start pagination params;
 *  - the album-scoped listing path and the /search keyword param;
 *  - the list envelope keys (results / assets / data) and the id charset - a
 *    record whose scheme is unknown, or whose id falls outside that charset, is
 *    dropped rather than federated under an id resolveBlob would refuse, so an
 *    unexpected charset shows up as a visible gap and not as broken bytes;
 *  - whether search hits and album-scoped records carry their own scheme. They
 *    are dropped without one, because the scheme picks the binary path and both
 *    of those listings span schemes, so there is nothing to fall back to;
 *  - the record field names: name, displayName, scheme, size, tag, keyword,
 *    album, folder, lastModified, lastUploaded, time, approvalStatus;
 *  - the approval-state strings (approved / pending / restricted);
 *  - the custom-field bag name (`additional`, falling back to `customFields`),
 *    AND whether Canto exposes its scheduled approval expiry natively. If it
 *    does, a follow-up maps that field straight onto availableUntil (the
 *    Brandfolder arm) and `availabilityFields` becomes the fallback, not the
 *    only route;
 *  - the api_binary path, and that it returns the true original bytes per
 *    scheme rather than a rendition (plans/32 §5);
 *  - whether previews or downloads ever ride a CDN host outside the canto
 *    family. If so, that host joins the pin list explicitly, never wildcarded;
 *  - whether listings can carry trashed records with a positive marker (then
 *    drop them positively, the Image Relay precedent) and Canto's rate limit,
 *    which is unpublished - hence the deliberately conservative default gap.
 * Fixture-tested with injected fetch; neither building nor testing touches a
 * live tenant.
 *
 * READY FOR TENANT DAY (plans/33). Every guessed key above is an exported
 * constant array below, read through firstKey/allStrings, so widening a wrong
 * guess is a one-line edit here and nowhere else. `sampleShape` reports what
 * the tenant actually returned (key names and types, never values) and diffs it
 * against those constants. Each failure that depends on a guess names the
 * assumption, the constant, and docs/providers/canto-live-verify.md.
 */
import { getAccessToken, parseOAuthCredential } from './oauth.ts';
import {
  allStrings, buildShapeReport, firstId, firstNumber, firstRecord, firstString,
  liveVerifyError, liveVerifyMessage, recordArray, findRecordArray,
  type ProviderShapeReport, type ShapeExpectation,
} from './shape.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef, type ProviderMapping, type ProviderPage, type ResolvedBlob } from './types.ts';

export interface CantoOptions {
  /** Tenant subdomain, e.g. "acme" for acme.canto.com. */
  tenant: string;
  /** Regional Canto domain (default 'com'). */
  domain?: 'com' | 'global' | 'de';
  /** Override the REST base for oddball tenants (default the tenant's /api/v1). */
  baseUrl?: string;
  /** Override the regional OAuth token endpoint. */
  tokenUrl?: string;
  /** Federate only this album (mirrors Image Relay's folderId). */
  albumId?: string;
  /** Approval states that count as approved (plans/27 §9). Default ['approved']. */
  approvedStates?: string[];
  /** Minimum gap between calls to this provider (default 350ms, ~3 req/s). */
  minGapMs?: number;
}

/** Canto lists by scheme; the driver walks these in this fixed order. */
const SCHEMES = ['image', 'video', 'audio', 'document', 'presentation', 'other'] as const;
const REMOTE_ID = /^(image|video|audio|document|presentation|other):[A-Za-z0-9._-]+$/;
const ALLOWED_HOSTS = /(^|\.)canto\.(com|global|de)$/;
const PAGE_SIZE = 100;
const USER_AGENT = 'lolly-work/1 (+catalog-provider)'; // etiquette: identify every call
const DEFAULT_GAP_MS = 350; // ~3 req/s: Canto publishes no limit, so stay well under

// Module-level per-provider rate limiter: reserve the next slot before awaiting
// so concurrent callers queue rather than race (mirrors the oauth token cache
// living module-level because driver instances are created per request).
const nextSlotAt = new Map<string, number>();
async function rateLimit(id: string, gapMs: number): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, (nextSlotAt.get(id) ?? 0) + gapMs);
  nextSlotAt.set(id, at);
  const wait = at - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// --- the LIVE-VERIFY key guesses, one exported constant per logical field ---
// These ARE the record documentation now: nothing below reads a key name
// literally, so a name that turns out wrong is corrected in exactly one place.

/** Which envelope key holds the record array. */
export const LIST_ENVELOPE_KEYS = ['results', 'assets', 'data'] as const;
/** The record id. REQUIRED: a record without one cannot federate. */
export const RECORD_ID_KEYS = ['id'] as const;
/** The upstream filename, extension and all - also ProviderFormatRef.filename. */
export const FILENAME_KEYS = ['name'] as const;
/** A human title, used for the display name only when there is no filename. */
export const DISPLAY_NAME_KEYS = ['displayName'] as const;
/** The record's own scheme, which picks the binary path. */
export const SCHEME_KEYS = ['scheme'] as const;
export const SIZE_KEYS = ['size'] as const;
export const UPDATED_AT_KEYS = ['lastModified', 'lastUploaded', 'time'] as const;
export const APPROVAL_STATE_KEYS = ['approvalStatus'] as const;
/** Folded, not fallen back through: a record's tags are every one of these. */
export const TAG_KEYS = ['tag', 'keyword'] as const;
/** Album/folder membership, folded the same way; one name or several. */
export const SECTION_KEYS = ['album', 'folder'] as const;
/** The custom-field bag the availability window is read out of. */
export const CUSTOM_FIELD_BAG_KEYS = ['additional', 'customFields'] as const;
/** The original-bytes path, per scheme (the one guess a 404 points straight at). */
export const BINARY_PATH = '/api_binary/v1/<scheme>/<id>';

/** What `--shape` diffs the tenant's response against. */
const ENVELOPE_EXPECTED: ShapeExpectation[] = [{ keys: LIST_ENVELOPE_KEYS, constant: 'LIST_ENVELOPE_KEYS' }];
const RECORD_EXPECTED: ShapeExpectation[] = [
  { keys: RECORD_ID_KEYS, constant: 'RECORD_ID_KEYS' },
  { keys: [...FILENAME_KEYS, ...DISPLAY_NAME_KEYS], constant: 'FILENAME_KEYS / DISPLAY_NAME_KEYS' },
  { keys: SCHEME_KEYS, constant: 'SCHEME_KEYS' },
  { keys: SIZE_KEYS, constant: 'SIZE_KEYS' },
  { keys: UPDATED_AT_KEYS, constant: 'UPDATED_AT_KEYS' },
  { keys: APPROVAL_STATE_KEYS, constant: 'APPROVAL_STATE_KEYS' },
  { keys: TAG_KEYS, constant: 'TAG_KEYS' },
  { keys: SECTION_KEYS, constant: 'SECTION_KEYS' },
  { keys: CUSTOM_FIELD_BAG_KEYS, constant: 'CUSTOM_FIELD_BAG_KEYS' },
];

type CantoRecord = Record<string, unknown>;
const asRecord = (v: unknown): CantoRecord | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as CantoRecord) : undefined);

export function createCantoProvider(
  id: string,
  options: CantoOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
  availabilityFields?: ProviderMapping['availabilityFields'],
): CatalogProvider {
  const domain = options.domain ?? 'com';
  const base = (options.baseUrl ?? `https://${options.tenant}.canto.${domain}/api/v1`).replace(/\/$/, '');
  const tokenUrl = options.tokenUrl ?? `https://oauth.canto.${domain}/oauth/api/oauth2/token`;
  const gapMs = options.minGapMs ?? DEFAULT_GAP_MS;
  // Default approved-state set: unlike IntelligenceBank's tenant-defined workflow
  // states, Canto's are product-defined, so a sensible default exists (plans/32 §4).
  const approvedStates = options.approvedStates ?? ['approved'];
  const hostOk = (url: string): boolean => ALLOWED_HOSTS.test(new URL(url).hostname);

  // The sealed BYOT credential rides the token POST, so the token host is pinned
  // exactly like the API and binary hosts: an override may move the endpoint
  // within the Canto family and nowhere else.
  const token = (): Promise<string> => {
    if (!hostOk(tokenUrl)) throw new Error('canto url outside allowed hosts');
    return getAccessToken({ providerId: id, cred: parseOAuthCredential(secret), tokenUrl, fetchImpl });
  };

  const api = async <T>(path: string): Promise<T> => {
    if (!hostOk(base)) throw new Error('canto url outside allowed hosts');
    await rateLimit(id, gapMs);
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`canto api ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  const upstream = async (url: string, notFound?: () => Error): Promise<Response> => {
    if (!hostOk(url)) throw new Error('canto url outside allowed hosts');
    await rateLimit(id, gapMs);
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${await token()}`, 'user-agent': USER_AGENT } });
    if (res.status === 404 && notFound) throw notFound();
    if (!res.ok || !res.body) throw new Error(`canto blob fetch ${res.status}`);
    return res;
  };

  const readWindow = (r: CantoRecord): { availableFrom?: string; availableUntil?: string } => {
    // The custom-field arm (plans/27 §2). If live-verify finds a native expiry
    // field, a follow-up maps it directly onto availableUntil instead.
    const bag = firstRecord(r, CUSTOM_FIELD_BAG_KEYS);
    const from = availabilityFields?.from ? firstString(bag, [availabilityFields.from]) : undefined;
    const until = availabilityFields?.until ? firstString(bag, [availabilityFields.until]) : undefined;
    return { ...(from ? { availableFrom: from } : {}), ...(until ? { availableUntil: until } : {}) };
  };

  /** `walked` is the scheme this page came from, where the walk implies one; a
   *  record's own scheme wins when it is one of ours. Nothing is guessed: a
   *  record with no usable scheme, or one whose composed remoteId would not
   *  survive resolveBlob's guard, is dropped rather than federated as an asset
   *  whose bytes could never be pulled (the imagerelay deletion precedent). */
  const toAsset = (raw: unknown, walked?: string): ProviderAssetRef | null => {
    const r = asRecord(raw);
    if (!r) return null;
    const own = firstString(r, SCHEME_KEYS)?.trim().toLowerCase();
    const scheme = own && (SCHEMES as readonly string[]).includes(own) ? own : walked;
    if (scheme === undefined) return null;
    const rid = firstId(r, RECORD_ID_KEYS) ?? '';
    if (!REMOTE_ID.test(`${scheme}:${rid}`)) return null;
    // The filename is what carries an extension; the display name is only a
    // fallback for it, and never travels as ProviderFormatRef.filename.
    const upstreamFile = firstString(r, FILENAME_KEYS);
    const fileName = upstreamFile ?? firstString(r, DISPLAY_NAME_KEYS) ?? rid;
    const size = firstNumber(r, SIZE_KEYS);
    const updatedAt = firstString(r, UPDATED_AT_KEYS);
    const state = firstString(r, APPROVAL_STATE_KEYS);
    const formats: ProviderFormatRef[] = [{
      format: extOf(fileName, scheme), remoteRef: 'download',
      ...(size !== undefined ? { size } : {}),
      ...(upstreamFile ? { filename: upstreamFile } : {}),
    }];
    return {
      // The scheme travels with the id: detail and binary endpoints are
      // scheme-scoped, and a colon keeps '/' out of ext/<provider>/<remoteId>.
      remoteId: `${scheme}:${rid}`,
      name: stripExt(fileName),
      nativeType: scheme,
      sections: allStrings(r, SECTION_KEYS),
      tags: allStrings(r, TAG_KEYS),
      // Approval state → approved (plans/27 §9). A record with no state at all is
      // treated as approved: exposure.requireApproved is what actually gates.
      approved: state === undefined ? true : approvedStates.includes(state),
      // A missing optional never throws: the record federates without it.
      ...(updatedAt ? { updatedAt } : {}),
      ...readWindow(r),
      formats,
    };
  };

  /**
   * Map one page, and say out loud what it could not map (plans/33 §5). A page
   * with records but no assets is the record-field guess breaking: reporting it
   * as an empty federation would cost the whole afternoon, so it fails here
   * with the constants to check. Records dropped alongside ones that mapped are
   * counted instead, because that is the deliberate behaviour above (a record
   * whose id or scheme resolveBlob would refuse is never federated).
   */
  const mapPage = (list: readonly unknown[], walked: string | undefined, endpoint: string): ProviderPage => {
    const assets: ProviderAssetRef[] = [];
    let skipped = 0;
    for (const r of list) {
      const a = toAsset(r, walked);
      if (a) assets.push(a); else skipped++;
    }
    if (list.length > 0 && assets.length === 0) {
      throw liveVerifyError({
        kind: 'canto', constant: 'RECORD_ID_KEYS / SCHEME_KEYS',
        tried: [...RECORD_ID_KEYS, ...SCHEME_KEYS],
        problem: `mapped none of the ${list.length} record(s) ${endpoint} returned`,
        assumption: 'the record field names - a record needs a usable id and scheme to federate at all',
      });
    }
    const notes: string[] = [];
    if (assets.length > 0 && assets.every((a) => a.approved === false)) {
      notes.push(liveVerifyMessage({
        kind: 'canto', constant: 'APPROVAL_STATE_KEYS and options.approvedStates',
        tried: approvedStates,
        problem: `treated all ${assets.length} asset(s) on this page as not approved`,
        assumption: 'the approval-state VALUES (the key was read, no value matched the approved set)',
      }));
    }
    if ((availabilityFields?.from || availabilityFields?.until) && assets.length > 0
      && assets.every((a) => a.availableFrom === undefined && a.availableUntil === undefined)) {
      notes.push(liveVerifyMessage({
        kind: 'canto', constant: 'CUSTOM_FIELD_BAG_KEYS (or mapping.availabilityFields)',
        tried: CUSTOM_FIELD_BAG_KEYS,
        problem: 'read no availability window from any record, though mapping.availabilityFields is set',
        assumption: 'the custom-field bag key, or the field names inside it',
      }));
    }
    return { assets, ...(skipped ? { skipped } : {}), ...(notes.length ? { notes } : {}) };
  };

  const records = (doc: unknown): unknown[] => recordArray(doc, 'canto', LIST_ENVELOPE_KEYS, 'LIST_ENVELOPE_KEYS').records;

  // Album scoping walks ONE dimension: album membership already crosses schemes,
  // so only `start` advances and each record carries its own scheme.
  const listPath = (scheme: string, start: number): string => (options.albumId
    ? `/album/${encodeURIComponent(options.albumId)}?limit=${PAGE_SIZE}&start=${start}`
    : `/${scheme}?limit=${PAGE_SIZE}&start=${start}`);

  return {
    id,
    kind: 'canto',
    capabilities: { authKind: 'oauth', search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      const parsed = cursor ? /^(\d+):(\d+)$/.exec(cursor) : null;
      if (cursor && !parsed) throw new Error('bad canto cursor');
      const schemeIndex = parsed ? Number(parsed[1]) : 0;
      const start = parsed ? Number(parsed[2]) : 0;
      if (schemeIndex >= SCHEMES.length) throw new Error('bad canto cursor');
      const scheme = SCHEMES[schemeIndex] as string;

      const path = listPath(scheme, start);
      const page = records(await api<unknown>(path));
      // The album arm already crosses schemes, so the walked scheme says nothing
      // about a record there: an album record has to carry its own or be dropped.
      const walked = options.albumId ? undefined : scheme;
      const mapped = mapPage(page, walked, `GET ${path}`);

      // Pagination without knowing the total: a full page means there is more of
      // this dimension; a short page means this one is exhausted, so move to the
      // next scheme (or stop, when the album arm or the last scheme is done).
      if (page.length === PAGE_SIZE) return { ...mapped, next: `${schemeIndex}:${start + PAGE_SIZE}` };
      if (options.albumId || schemeIndex + 1 >= SCHEMES.length) return mapped;
      return { ...mapped, next: `${schemeIndex + 1}:0` };
    },

    async searchAssets(query, limit) {
      // Search spans every scheme, so a hit carries its own or it is not a hit
      // this driver can name: guessing one would mint a second remoteId for an
      // asset listAssets already federated under the right one.
      const doc = await api<unknown>(`/search?keyword=${encodeURIComponent(query)}&limit=${limit}`);
      return records(doc).map((r) => toAsset(r)).filter((a): a is ProviderAssetRef => a !== null).slice(0, limit);
    },

    /** One page, reported as key names and TYPES only - never a value (§3). */
    async sampleShape(): Promise<ProviderShapeReport> {
      const path = listPath(SCHEMES[0] as string, 0);
      const doc = await api<unknown>(path);
      const found = findRecordArray(doc, LIST_ENVELOPE_KEYS);
      return buildShapeReport({
        kind: 'canto',
        endpoint: `GET ${new URL(base).pathname}${path}`,
        doc,
        records: found?.records ?? [],
        recordsKey: found?.key ?? null,
        envelopeExpected: ENVELOPE_EXPECTED,
        recordExpected: RECORD_EXPECTED,
        notes: [`the binary path this driver would call for these records is ${BINARY_PATH} (BINARY_PATH).`],
      });
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'download') throw new Error('canto assets have a single download format');
      if (!REMOTE_ID.test(remoteId)) throw new Error('bad canto asset id');
      const [scheme, rid] = remoteId.split(':');
      // Resolved fresh per request, never persisted: api_binary streams the
      // original off the tenant host, which is the export capability the exit
      // needs (plans/27 §9). A 404 here is the binary-path guess breaking, not
      // a missing asset: listAssets federated this id moments ago.
      const path = `/api_binary/v1/${scheme}/${rid}`;
      const res = await upstream(`${new URL(base).origin}${path}`, () => liveVerifyError({
        kind: 'canto', constant: 'BINARY_PATH', tried: [BINARY_PATH],
        problem: `blob fetch 404 for ${path}`,
        assumption: 'the api_binary original path (the record listed, so the path or its scheme segment is wrong)',
      }));
      const size = Number(res.headers.get('content-length'));
      return {
        kind: 'stream',
        body: res.body as ReadableStream<Uint8Array>,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        ...(Number.isFinite(size) && size > 0 ? { size } : {}),
      };
    },

    async healthCheck() {
      try {
        await api(listPath(SCHEMES[0], 0));
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
