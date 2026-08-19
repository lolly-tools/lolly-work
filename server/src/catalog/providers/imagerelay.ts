/**
 * Image Relay driver (plans/27 §9, §10) - a legacy DAM whose job in this repo is
 * federate → materialize → cutover (the exit), not long-term residence. Public
 * v2 API (api.imagerelay.com/api/v2), OAuth2 bearer (oauth.ts - the operator's
 * own registered app; the sealed credential is captured with
 * `lw providers credential`, because no consent flow is registered for this
 * kind until its authorize endpoint is confirmed against a real tenant).
 *
 * Image Relay has NO native availability fields; a file's expiry (if modelled)
 * rides a custom-metadata field. So availability comes from the generic
 * `mapping.availabilityFields` (plans/27 §2): the driver reads the named custom
 * field off each record into the ProviderAssetRef window. A `deleted` flag
 * (DELETED_KEYS) is reported positively - a deleted file is dropped from
 * federation rather than inferred-missing. Driver etiquette the API requires: a mandatory `User-Agent`
 * and a 5 req/s cap, both enforced here.
 *
 * LIVE-VERIFY before ship (house rule, plans/27 §9): confirm the endpoint paths,
 * the file/folder field names marked below, the OAuth token endpoint, the token
 * EXCHANGE shape (this driver posts an RFC 6749 form body,
 * grant_type=refresh_token + client_id/client_secret - see getAccessToken in
 * providers/oauth.ts; a 400 there is the request shape, not the credential),
 * and the download/quick-link host against a real tenant. Fixture-tested with
 * injected fetch, exactly as the Brandfolder and Optimizely drivers were.
 *
 * READY FOR TENANT DAY (plans/33). Every guessed key is an exported constant
 * array below, read through firstKey/allStrings, so widening a wrong guess is a
 * one-line edit here and nowhere else. `sampleShape` reports what the tenant
 * actually returned (key names and types, never values) and diffs it against
 * those constants. Each failure that depends on a guess names the assumption,
 * the constant, and docs/providers/imagerelay-live-verify.md.
 */
import { getAccessToken, parseOAuthCredential } from './oauth.ts';
import {
  allStrings, buildDetailShapeReport, buildShapeReport, findRecordArray, firstId, firstKey,
  firstNumber, firstRecord, firstString, liveVerifyError, liveVerifyMessage, recordArray,
  type ProviderShapeReport, type ShapeExpectation,
} from './shape.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef, type ProviderMapping, type ProviderPage, type ResolvedBlob } from './types.ts';

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

// --- the LIVE-VERIFY key guesses, one exported constant per logical field ---
// These ARE the record documentation now: nothing below reads a key name
// literally, so a name that turns out wrong is corrected in exactly one place.

/** Which envelope key holds the file array. */
export const LIST_ENVELOPE_KEYS = ['files', 'data'] as const;
/** Where the next-page cursor rides (inside the envelope's meta object). */
export const META_KEYS = ['meta'] as const;
export const NEXT_PAGE_KEYS = ['next_page'] as const;
/** The file id. REQUIRED: a file without one cannot federate. */
export const RECORD_ID_KEYS = ['id'] as const;
/** The upstream filename - also ProviderFormatRef.filename. */
export const FILENAME_KEYS = ['filename'] as const;
/** A human title, used for the display name when it is there. */
export const DISPLAY_NAME_KEYS = ['name'] as const;
export const FORMAT_KEYS = ['extension', 'file_type'] as const;
export const SIZE_KEYS = ['size'] as const;
export const UPDATED_AT_KEYS = ['updated_at'] as const;
/** Folded, not fallen back through: a file's tags are every one of these. */
export const TAG_KEYS = ['keywords', 'tags'] as const;
/** Deletion is reported POSITIVELY - a deleted file is dropped, not inferred. */
export const DELETED_KEYS = ['deleted'] as const;
export const FOLDER_KEYS = ['folder'] as const;
export const FOLDER_NAME_KEYS = ['name'] as const;
/** The custom-metadata bag the availability window is read out of. */
export const CUSTOM_FIELD_BAG_KEYS = ['custom_fields'] as const;
/** The signed link resolveBlob streams from, re-read per request. */
export const DOWNLOAD_URL_KEYS = ['download_url'] as const;
/** Where the single-file detail call wraps its record, when it wraps it. */
export const DETAIL_WRAPPER_KEYS = ['file', 'data'] as const;

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
  { keys: TAG_KEYS, constant: 'TAG_KEYS' },
  { keys: DELETED_KEYS, constant: 'DELETED_KEYS' },
  { keys: FOLDER_KEYS, constant: 'FOLDER_KEYS' },
  { keys: CUSTOM_FIELD_BAG_KEYS, constant: 'CUSTOM_FIELD_BAG_KEYS' },
];
/** What the DETAIL report diffs: the byte path's own guesses, which no list
 *  page can confirm (the wrapper rides the envelope side, see detailShape). */
const DETAIL_EXPECTED: ShapeExpectation[] = [
  { keys: DOWNLOAD_URL_KEYS, constant: 'DOWNLOAD_URL_KEYS' },
  { keys: SIZE_KEYS, constant: 'SIZE_KEYS' },
];

type IrFile = Record<string, unknown>;
const asRecord = (v: unknown): IrFile | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as IrFile) : undefined);

export function createImageRelayProvider(
  id: string,
  options: ImageRelayOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
  availabilityFields?: ProviderMapping['availabilityFields'],
): CatalogProvider {
  const base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const tokenUrl = options.tokenUrl ?? `${new URL(base).origin}/oauth/token`;
  const hostOk = (url: string): boolean => ALLOWED_HOSTS.test(new URL(url).hostname);

  // The sealed credential rides the token POST and the access token rides every
  // API call, so both hosts are pinned exactly like the download host: a
  // baseUrl/tokenUrl override may move the endpoint within the Image Relay
  // family and nowhere else.
  const token = (): Promise<string> => {
    if (!hostOk(tokenUrl)) throw new Error('imagerelay url outside allowed hosts');
    return getAccessToken({ providerId: id, cred: parseOAuthCredential(secret), tokenUrl, fetchImpl });
  };

  const api = async <T>(path: string): Promise<T> => {
    if (!hostOk(base)) throw new Error('imagerelay url outside allowed hosts');
    await rateLimit(id);
    const res = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${await token()}`, accept: 'application/json', 'user-agent': USER_AGENT } });
    if (!res.ok) throw new Error(`imagerelay api ${res.status} for ${path}`);
    return (await res.json()) as T;
  };

  const upstream = async (url: string, notFound?: () => Error): Promise<Response> => {
    if (!hostOk(url)) throw new Error('imagerelay url outside allowed hosts');
    await rateLimit(id);
    const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT } });
    if (res.status === 404 && notFound) throw notFound();
    if (!res.ok || !res.body) throw new Error(`imagerelay blob fetch ${res.status}`);
    return res;
  };

  const readWindow = (file: IrFile): { availableFrom?: string; availableUntil?: string } => {
    const cf = firstRecord(file, CUSTOM_FIELD_BAG_KEYS);
    const from = availabilityFields?.from ? firstString(cf, [availabilityFields.from]) : undefined;
    const until = availabilityFields?.until ? firstString(cf, [availabilityFields.until]) : undefined;
    return { ...(from ? { availableFrom: from } : {}), ...(until ? { availableUntil: until } : {}) };
  };

  /** null = deliberately dropped (deleted); the id miss throws instead, because
   *  silently losing an asset is worse than an error (plans/33 §5). */
  const toAsset = (raw: unknown): ProviderAssetRef | null => {
    const file = asRecord(raw);
    if (!file) return null;
    // Report deletions positively - drop, do not infer.
    const deleted = firstKey(file, DELETED_KEYS);
    if (deleted === true || deleted === 'true') return null;
    const rid = firstId(file, RECORD_ID_KEYS);
    if (rid === undefined) {
      throw liveVerifyError({
        kind: 'imagerelay', constant: 'RECORD_ID_KEYS', tried: RECORD_ID_KEYS,
        problem: 'a file in the list carried no id',
        assumption: 'the file id field name (required - a file without one cannot federate)',
      });
    }
    const upstreamFile = firstString(file, FILENAME_KEYS);
    const title = firstString(file, DISPLAY_NAME_KEYS);
    const fileName = upstreamFile ?? title ?? rid;
    const format = firstString(file, FORMAT_KEYS) ?? extOf(fileName);
    const size = firstNumber(file, SIZE_KEYS);
    const updatedAt = firstString(file, UPDATED_AT_KEYS);
    const formats: ProviderFormatRef[] = [{
      format, remoteRef: 'download',
      ...(size !== undefined ? { size } : {}),
      ...(upstreamFile ? { filename: upstreamFile } : {}),
    }];
    return {
      remoteId: rid,
      name: stripExt(title ?? fileName),
      nativeType: format,
      sections: allStrings(firstRecord(file, FOLDER_KEYS), FOLDER_NAME_KEYS),
      tags: allStrings(file, TAG_KEYS),
      // A missing optional never throws: the file federates without it.
      ...(updatedAt ? { updatedAt } : {}),
      ...readWindow(file),
      formats,
    };
  };

  /**
   * Map one page, and say out loud what it could not map (plans/33 §5). A page
   * of files that all mapped to nothing is the record-field guess breaking;
   * deliberate drops (deleted files) are counted, not fatal.
   */
  const mapPage = (doc: unknown, endpoint: string): ProviderPage => {
    const files = recordArray(doc, 'imagerelay', LIST_ENVELOPE_KEYS, 'LIST_ENVELOPE_KEYS').records;
    const assets: ProviderAssetRef[] = [];
    let skipped = 0;
    for (const f of files) {
      const a = toAsset(f);
      if (a) assets.push(a); else skipped++;
    }
    if (files.length > 0 && assets.length === 0 && skipped < files.length) {
      throw liveVerifyError({
        kind: 'imagerelay', constant: 'RECORD_ID_KEYS / FILENAME_KEYS', tried: [...RECORD_ID_KEYS, ...FILENAME_KEYS],
        problem: `mapped none of the ${files.length} file(s) ${endpoint} returned`,
        assumption: 'the file field names',
      });
    }
    const notes: string[] = [];
    if ((availabilityFields?.from || availabilityFields?.until) && assets.length > 0
      && assets.every((a) => a.availableFrom === undefined && a.availableUntil === undefined)) {
      notes.push(liveVerifyMessage({
        kind: 'imagerelay', constant: 'CUSTOM_FIELD_BAG_KEYS (or mapping.availabilityFields)',
        tried: CUSTOM_FIELD_BAG_KEYS,
        problem: 'read no availability window from any file, though mapping.availabilityFields is set',
        assumption: 'the custom-metadata bag key, or the field names inside it',
      }));
    }
    const next = firstKey(firstRecord(asRecord(doc), META_KEYS), NEXT_PAGE_KEYS);
    return {
      assets,
      ...(next ? { next: String(next) } : {}),
      ...(skipped ? { skipped } : {}),
      ...(notes.length ? { notes } : {}),
    };
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
      const path = listPath(page);
      return mapPage(await api<unknown>(path), `GET ${path}`);
    },

    async searchAssets(query, limit) {
      const path = `/files?per_page=${limit}&page=1&query=${encodeURIComponent(query)}`;
      const doc = await api<unknown>(path);
      return mapPage(doc, `GET ${path}`).assets.slice(0, limit);
    },

    /** One page, reported as key names and TYPES only - never a value (§3). */
    async sampleShape(): Promise<ProviderShapeReport> {
      const path = listPath(1);
      const doc = await api<unknown>(path);
      const found = findRecordArray(doc, LIST_ENVELOPE_KEYS);
      return buildShapeReport({
        kind: 'imagerelay',
        endpoint: `GET ${new URL(base).pathname}${path}`,
        doc,
        records: found?.records ?? [],
        recordsKey: found?.key ?? null,
        envelopeExpected: ENVELOPE_EXPECTED,
        recordExpected: RECORD_EXPECTED,
        notes: [`the binary path is not listed here: resolveBlob re-reads each file and streams ${DOWNLOAD_URL_KEYS.join(' or ')} (DOWNLOAD_URL_KEYS), which a list record need not carry. Run the same command with --remote-id <file id> for that call's own report.`],
      });
    },

    /** The DETAIL call resolveBlob makes, reported the same way (§3). This is
     *  where the byte-path guesses live - the wrapper and the download link -
     *  and a list page cannot answer either of them. */
    async detailShape(remoteId): Promise<ProviderShapeReport> {
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad imagerelay file id');
      const path = `/files/${remoteId}`;
      return buildDetailShapeReport({
        kind: 'imagerelay',
        endpoint: `GET ${new URL(base).pathname}${path}`,
        doc: await api<unknown>(path),
        wrapperKeys: DETAIL_WRAPPER_KEYS,
        wrapperConstant: 'DETAIL_WRAPPER_KEYS',
        recordExpected: DETAIL_EXPECTED,
        notes: ['whether the link is the ORIGINAL or a rendition is not a key name and is not in this report - only the step 3 checksum answers that.'],
      });
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'download') throw new Error('imagerelay assets have a single download format');
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad imagerelay file id');
      // Re-fetch the file for a FRESH signed download link every request.
      const path = `/files/${remoteId}`;
      const doc = await api<unknown>(path);
      const record = firstRecord(asRecord(doc), DETAIL_WRAPPER_KEYS) ?? asRecord(doc);
      const url = firstString(record, DOWNLOAD_URL_KEYS);
      if (!url) {
        throw liveVerifyError({
          kind: 'imagerelay', constant: 'DOWNLOAD_URL_KEYS / DETAIL_WRAPPER_KEYS',
          tried: [...DOWNLOAD_URL_KEYS, ...DETAIL_WRAPPER_KEYS.map((k) => `${k}.*`)],
          problem: `file has no download url in the response to GET ${path}`,
          assumption: 'the download-link field name, or the wrapper the detail call puts the record in',
        });
      }
      const res = await upstream(url, () => liveVerifyError({
        kind: 'imagerelay', constant: 'DOWNLOAD_URL_KEYS', tried: DOWNLOAD_URL_KEYS,
        problem: 'blob fetch 404 for the signed download link',
        assumption: 'the download-link field (the link was read but the host would not serve it; it may be a rendition link, or expire on read)',
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
