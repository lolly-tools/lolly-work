/**
 * Acquia DAM / Widen driver (plans/27 §9) - the governance-rich enterprise DAM.
 * Public Widen v2 API (api.widencollective.com/v2), bearer-token auth. In this
 * repo its role is the same as any legacy DAM: read-only federation, and the
 * exit (federate → materialize → cutover).
 *
 * Unlike Image Relay, Widen has NATIVE availability + approval: `release_date`
 * and `expiration_date` map straight to the availability window (plans/27 §2),
 * and an asset `status` maps onto ProviderAssetRef.approved (the approval-is-not-
 * a-boolean generalization, §9 - a configured approved-status set). Categories
 * fold into sections for exposure scoping.
 *
 * LIVE-VERIFY before ship (house rule, plans/27 §9): confirm the endpoint paths,
 * the asset field names marked below (release_date/expiration_date/status/
 * categories), the download embed/href, and the CDN host against a real tenant.
 * Fixture-tested with injected fetch, as every driver here is.
 *
 * READY FOR TENANT DAY (plans/33). Every guessed key is an exported constant
 * array below, read through firstKey, so widening a wrong guess is a one-line
 * edit here and nowhere else. `sampleShape` reports what the tenant actually
 * returned (key names and types, never values) and diffs it against those
 * constants. Each failure that depends on a guess names the assumption, the
 * constant, and docs/providers/acquia-dam-live-verify.md.
 */
import {
  buildDetailShapeReport, buildShapeReport, findRecordArray, firstArray, firstId, firstNumber,
  firstRecord, firstString, liveVerifyError, liveVerifyMessage, recordArray,
  type ProviderShapeReport, type ShapeExpectation,
} from './shape.ts';
import { extOf, stripExt, type CatalogProvider, type ProviderAssetRef, type ProviderFormatRef, type ProviderPage, type ResolvedBlob } from './types.ts';

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

// --- the LIVE-VERIFY key guesses, one exported constant per logical field ---
// These ARE the asset documentation now: nothing below reads a key name
// literally, so a name that turns out wrong is corrected in exactly one place.

/** Which envelope key holds the asset array. */
export const LIST_ENVELOPE_KEYS = ['items'] as const;
export const TOTAL_COUNT_KEYS = ['total_count'] as const;
/** The asset id. REQUIRED: an asset without one cannot federate. */
export const RECORD_ID_KEYS = ['id', 'external_id'] as const;
export const FILENAME_KEYS = ['filename'] as const;
/** Asset status, mapped onto approved through options.approvedStatuses (§9). */
export const STATUS_KEYS = ['status'] as const;
/** Native availability (plans/27 §2). */
export const AVAILABLE_FROM_KEYS = ['release_date'] as const;
export const AVAILABLE_UNTIL_KEYS = ['expiration_date'] as const;
export const UPDATED_AT_KEYS = ['last_update_date'] as const;
/** The nested bag the format and size ride in (the ?expand=file_properties arm). */
export const FILE_PROPERTIES_KEYS = ['file_properties'] as const;
export const FORMAT_KEYS = ['format', 'format_type'] as const;
export const SIZE_BYTES_KEYS = ['size_bytes'] as const;
export const SIZE_KBYTES_KEYS = ['size_in_kbytes'] as const;
/** Categories fold into sections; an entry is a name or an object carrying one. */
export const CATEGORY_KEYS = ['categories'] as const;
export const CATEGORY_NAME_KEYS = ['name'] as const;
/** The original-bytes link, nested: embeds.original.url, then _links.download.href. */
export const EMBED_KEYS = ['embeds'] as const;
export const EMBED_ORIGINAL_KEYS = ['original'] as const;
export const LINKS_KEYS = ['_links'] as const;
export const LINK_DOWNLOAD_KEYS = ['download'] as const;
export const DOWNLOAD_URL_KEYS = ['url', 'href'] as const;

/** What `--shape` diffs the tenant's response against. */
const ENVELOPE_EXPECTED: ShapeExpectation[] = [
  { keys: LIST_ENVELOPE_KEYS, constant: 'LIST_ENVELOPE_KEYS' },
  { keys: TOTAL_COUNT_KEYS, constant: 'TOTAL_COUNT_KEYS' },
];
const RECORD_EXPECTED: ShapeExpectation[] = [
  { keys: RECORD_ID_KEYS, constant: 'RECORD_ID_KEYS' },
  { keys: FILENAME_KEYS, constant: 'FILENAME_KEYS' },
  { keys: STATUS_KEYS, constant: 'STATUS_KEYS' },
  { keys: AVAILABLE_FROM_KEYS, constant: 'AVAILABLE_FROM_KEYS' },
  { keys: AVAILABLE_UNTIL_KEYS, constant: 'AVAILABLE_UNTIL_KEYS' },
  { keys: UPDATED_AT_KEYS, constant: 'UPDATED_AT_KEYS' },
  { keys: FILE_PROPERTIES_KEYS, constant: 'FILE_PROPERTIES_KEYS' },
  { keys: CATEGORY_KEYS, constant: 'CATEGORY_KEYS' },
  { keys: [...EMBED_KEYS, ...LINKS_KEYS], constant: 'EMBED_KEYS / LINKS_KEYS' },
];
/** What the DETAIL report diffs: the byte path's own guesses. The link is
 *  nested (embeds.original.url, _links.download.href), so that report descends
 *  two levels rather than one - key names and types only, as ever. */
const DETAIL_EXPECTED: ShapeExpectation[] = [
  { keys: [...EMBED_KEYS, ...LINKS_KEYS], constant: 'EMBED_KEYS / LINKS_KEYS' },
  { keys: FILE_PROPERTIES_KEYS, constant: 'FILE_PROPERTIES_KEYS' },
];

type WidenAsset = Record<string, unknown>;
const asRecord = (v: unknown): WidenAsset | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as WidenAsset) : undefined);

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

  const upstream = async (url: string, notFound?: () => Error): Promise<Response> => {
    if (!ALLOWED_HOSTS.test(new URL(url).hostname)) throw new Error('acquia-dam url outside allowed hosts');
    const res = await fetchImpl(url);
    if (res.status === 404 && notFound) throw notFound();
    if (!res.ok || !res.body) throw new Error(`acquia-dam blob fetch ${res.status}`);
    return res;
  };

  const sectionsOf = (a: WidenAsset): string[] =>
    (firstArray(a, CATEGORY_KEYS) ?? [])
      .map((c) => (typeof c === 'string' ? c : firstString(asRecord(c), CATEGORY_NAME_KEYS)))
      .filter((n): n is string => !!n);

  const sizeOf = (a: WidenAsset): number | undefined => {
    const props = firstRecord(a, FILE_PROPERTIES_KEYS);
    const bytes = firstNumber(props, SIZE_BYTES_KEYS);
    if (bytes !== undefined) return bytes;
    const kbytes = firstNumber(props, SIZE_KBYTES_KEYS);
    return kbytes === undefined ? undefined : Math.round(kbytes * 1024);
  };

  /** The signed link for the ORIGINAL bytes: the embed first, the download link
   *  second. Both are nested, so both paths are read through constants. */
  const downloadUrlOf = (a: WidenAsset): string | undefined =>
    firstString(firstRecord(firstRecord(a, EMBED_KEYS), EMBED_ORIGINAL_KEYS), DOWNLOAD_URL_KEYS)
    ?? firstString(firstRecord(firstRecord(a, LINKS_KEYS), LINK_DOWNLOAD_KEYS), DOWNLOAD_URL_KEYS);

  /** The id miss throws rather than dropping: silently losing an asset is worse
   *  than an error (plans/33 §5). Every other field is optional. */
  const toAsset = (raw: unknown): ProviderAssetRef => {
    const a = asRecord(raw) ?? {};
    const rid = firstId(a, RECORD_ID_KEYS);
    if (rid === undefined) {
      throw liveVerifyError({
        kind: 'acquia-dam', constant: 'RECORD_ID_KEYS', tried: RECORD_ID_KEYS,
        problem: 'an asset in the list carried no id',
        assumption: 'the asset id field name (required - an asset without one cannot federate)',
      });
    }
    const upstreamFile = firstString(a, FILENAME_KEYS);
    const fileName = upstreamFile ?? rid;
    const format = firstString(firstRecord(a, FILE_PROPERTIES_KEYS), FORMAT_KEYS) ?? extOf(fileName);
    const sizeBytes = sizeOf(a);
    const status = firstString(a, STATUS_KEYS);
    const updatedAt = firstString(a, UPDATED_AT_KEYS);
    const availableFrom = firstString(a, AVAILABLE_FROM_KEYS);
    const availableUntil = firstString(a, AVAILABLE_UNTIL_KEYS);
    const formats: ProviderFormatRef[] = [{
      format, remoteRef: 'original',
      ...(sizeBytes !== undefined ? { size: sizeBytes } : {}),
      ...(upstreamFile ? { filename: upstreamFile } : {}),
    }];
    return {
      remoteId: rid,
      name: stripExt(fileName),
      nativeType: format,
      sections: sectionsOf(a),
      tags: [],
      // status → approved (§9): absent status is treated as approved; the window time-gates.
      approved: status === undefined ? true : approvedStatuses.includes(status),
      ...(updatedAt ? { updatedAt } : {}),
      // Native availability (§2): release/expiration map directly.
      ...(availableFrom ? { availableFrom } : {}),
      ...(availableUntil ? { availableUntil } : {}),
      formats,
    };
  };

  /** Map one page, and say out loud what did not match (plans/33 §5). */
  const mapPage = (doc: unknown): ProviderPage & { pageSize: number } => {
    const items = recordArray(doc, 'acquia-dam', LIST_ENVELOPE_KEYS, 'LIST_ENVELOPE_KEYS').records;
    const assets = items.map(toAsset);
    const notes: string[] = [];
    if (assets.length > 0 && assets.every((a) => a.approved === false)) {
      notes.push(liveVerifyMessage({
        kind: 'acquia-dam', constant: 'STATUS_KEYS and options.approvedStatuses',
        tried: approvedStatuses,
        problem: `treated all ${assets.length} asset(s) on this page as not approved`,
        assumption: 'the asset status VALUES (the key was read, no value matched the approved set)',
      }));
    }
    return { assets, pageSize: items.length, ...(notes.length ? { notes } : {}) };
  };

  const listPath = (offset: number): string => {
    const q = options.query ? `&search=${encodeURIComponent(options.query)}` : '';
    return `/assets?limit=${PAGE_SIZE}&offset=${offset}&expand=file_properties,embeds,thumbnails${q}`;
  };

  return {
    id,
    kind: 'acquia-dam',
    capabilities: { authKind: 'credential', search: true, thumbnails: false, expiringUrls: true },

    async listAssets(cursor) {
      const offset = cursor ? Number(cursor) : 0;
      const { assets, pageSize, notes } = mapPage(await api<unknown>(listPath(offset)));
      return {
        assets,
        ...(notes ? { notes } : {}),
        ...(pageSize === PAGE_SIZE ? { next: String(offset + pageSize) } : {}),
      };
    },

    async searchAssets(query, limit) {
      const doc = await api<unknown>(`/assets?limit=${limit}&offset=0&expand=file_properties,embeds&search=${encodeURIComponent(query)}`);
      return mapPage(doc).assets.slice(0, limit);
    },

    /** One page, reported as key names and TYPES only - never a value (§3). */
    async sampleShape(): Promise<ProviderShapeReport> {
      const path = listPath(0);
      const doc = await api<unknown>(path);
      const found = findRecordArray(doc, LIST_ENVELOPE_KEYS);
      return buildShapeReport({
        kind: 'acquia-dam',
        endpoint: `GET ${new URL(base).pathname}${path}`,
        doc,
        records: found?.records ?? [],
        recordsKey: found?.key ?? null,
        envelopeExpected: ENVELOPE_EXPECTED,
        recordExpected: RECORD_EXPECTED,
        notes: ['file_properties, embeds and thumbnails only appear when the ?expand= list above asked for them, so an absent one may be an expand problem rather than a wrong key. Run the same command with --remote-id <asset id> for the report on the call the bytes come from.'],
      });
    },

    /** The DETAIL call resolveBlob makes, reported the same way (§3). The
     *  link path is the guess the exit depends on, and it is nested, so this
     *  report descends one level further than the list one. */
    async detailShape(remoteId): Promise<ProviderShapeReport> {
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad acquia-dam asset id');
      // The path resolveBlob itself calls, expand list included - a wider one
      // here would report an embed the byte path never receives.
      const path = `/assets/${remoteId}?expand=embeds`;
      return buildDetailShapeReport({
        kind: 'acquia-dam',
        endpoint: `GET ${new URL(base).pathname}${path}`,
        doc: await api<unknown>(path),
        wrapperKeys: [], // Widen returns the asset bare - there is no wrapper to guess
        wrapperConstant: '',
        recordExpected: DETAIL_EXPECTED,
        depth: 2,
        notes: [
          'an ABSENT file_properties here is not fatal: resolveBlob reads the size out of it, so the stream simply carries no size. This call asks the expand list resolveBlob asks for, so widening it is a driver edit, not an option.',
          'which named embed carries the ORIGINAL rather than a rendition is not a key name and is not in this report - only the step 3 checksum answers that.',
        ],
      });
    },

    async resolveBlob(remoteId, formatRef): Promise<ResolvedBlob> {
      if (formatRef !== 'original') throw new Error('acquia-dam assets have a single original format');
      if (!/^[A-Za-z0-9_-]+$/.test(remoteId)) throw new Error('bad acquia-dam asset id');
      // Re-fetch the asset for a FRESH signed embed/download URL every request.
      const path = `/assets/${remoteId}?expand=embeds`;
      const a = asRecord(await api<unknown>(path)) ?? {};
      const url = downloadUrlOf(a);
      if (!url) {
        throw liveVerifyError({
          kind: 'acquia-dam', constant: 'EMBED_KEYS / LINKS_KEYS / DOWNLOAD_URL_KEYS',
          tried: ['embeds.original.url', '_links.download.href'],
          problem: `asset has no download url in the response to GET ${path}`,
          assumption: 'the embed/download link path (also check that the ?expand= list asks for embeds)',
        });
      }
      const res = await upstream(url, () => liveVerifyError({
        kind: 'acquia-dam', constant: 'EMBED_KEYS / LINKS_KEYS', tried: ['embeds.original.url', '_links.download.href'],
        problem: 'blob fetch 404 for the signed embed link',
        assumption: 'the embed that carries the ORIGINAL bytes (the link was read but the CDN would not serve it; a named embed may be a rendition rather than the original)',
      }));
      const sizeBytes = sizeOf(a);
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
