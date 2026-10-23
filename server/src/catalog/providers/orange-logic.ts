/**
 * Orange Logic public Search v4 source (plans/81). Returned files are permitted
 * renditions, never protected originals. Missing formats are not generated.
 * LIVE-VERIFY: tenant fields, OAuth, scoped pagination, format substitutions
 * and storage origins. See the runbook live-verify/orange-logic.md.
 */
import { createHash } from 'node:crypto';
import { assertDamExposure, createDamHttp, DamHttpError, damDate, damLimit, damNumber, damOrigin, damRecord, damString } from './dam-http.ts';
import { buildShapeReport, type ProviderShapeReport } from './shape.ts';
import { extOf, type CatalogProvider, type ProviderAssetRef, type ProviderExposure, type ProviderPage } from './types.ts';

export interface OrangeLogicOptions {
  baseUrl: string;
  /** Administrator query, always combined with member searches and ID lookups. */
  query?: string;
  /** Public proxy codes to expose. Originals require a separate protected API. */
  formats?: string[];
  pageSize?: number;
  minGapMs?: number;
  /** Exact HTTPS origins for unauthenticated rendition reads, besides baseUrl. */
  storageOrigins?: string[];
  approvalField?: string;
  approvedValues?: string[];
}

export const SEARCH_FIELDS = ['SystemIdentifier', 'Title', 'CaptionLong', 'MediaType', 'MIMEtype', 'Directory', 'ParentFolderIdentifier', 'ParentFolderTitle', 'Keywords', 'EditDate', 'FileMD5'] as const;
const field = (record: Record<string, unknown>, name: string): unknown => record[name] ?? record[Object.keys(record).find(key => key.toLowerCase() === name.toLowerCase()) ?? ''];
const text = (record: Record<string, unknown>, name: string) => damString(field(record, name));
const literal = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&')}"`;
const validId = (value: string): boolean => /^[A-Za-z0-9_-]{1,200}$/.test(value);

export function createOrangeLogicProvider(id: string, options: OrangeLogicOptions, secret: string | undefined,
  fetchImpl: typeof fetch = fetch, availability?: { from?: string; until?: string }, exposure?: ProviderExposure): CatalogProvider {
  const base = damOrigin(options.baseUrl, 'orange-logic');
  if (options.storageOrigins !== undefined && (!Array.isArray(options.storageOrigins) || options.storageOrigins.length > 20 || options.storageOrigins.some(origin => typeof origin !== 'string'))) throw new Error('orange-logic storageOrigins must be exact HTTPS origins');
  const origins = new Set([base, ...(options.storageOrigins ?? []).map(origin => damOrigin(origin, 'orange-logic storage'))]);
  const formats = options.formats ?? ['TR1', 'WebHigh'];
  if (!Array.isArray(formats) || formats.length < 1 || formats.length > 20 || formats.some(code => typeof code !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,49}$/.test(code)) || new Set(formats.map(code => code.toLowerCase())).size !== formats.length) throw new Error('orange-logic formats must contain distinct proxy codes');
  if (options.query !== undefined && (typeof options.query !== 'string' || options.query.length > 2000 || /[\x00-\x1f]/.test(options.query))) throw new Error('orange-logic query is invalid');
  if (options.approvedValues !== undefined && (!Array.isArray(options.approvedValues) || options.approvedValues.length > 100 || options.approvedValues.some(value => typeof value !== 'string' || !value))) throw new Error('orange-logic approvedValues must be exact status names');
  if (options.approvalField && !options.approvedValues?.length) throw new Error('orange-logic approvalField requires approvedValues');
  const custom = [options.approvalField, availability?.from, availability?.until].filter((key): key is string => key !== undefined);
  if (custom.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.]{0,150}$/.test(key))) throw new Error('orange-logic metadata field identifier is invalid');
  const pageSize = damLimit(options.pageSize ?? 100);
  const http = createDamHttp('orange-logic', fetchImpl, options.minGapMs ?? 250);
  const fields = [...new Set([...SEARCH_FIELDS, ...formats.map(code => `Path_${code}`), ...custom])].join(',');
  let token: { value: string; until: number } | undefined, pending: Promise<string> | undefined;
  const credentials = (): { bearerToken?: string; clientId?: string; clientSecret?: string } => {
    try {
      if (!secret || /[\r\n]/.test(secret)) throw new Error();
      if (!secret.trimStart().startsWith('{')) return { bearerToken: secret };
      const value = JSON.parse(secret) as Record<string, unknown>;
      if (typeof value.bearerToken === 'string' && value.bearerToken && !/[\r\n]/.test(value.bearerToken)) return { bearerToken: value.bearerToken };
      if (typeof value.clientId !== 'string' || !value.clientId || typeof value.clientSecret !== 'string' || !value.clientSecret) throw new Error();
      return { clientId: value.clientId, clientSecret: value.clientSecret };
    } catch { throw new Error('orange-logic credential needs clientId/clientSecret JSON or a bearer token'); }
  };
  const accessToken = async (): Promise<string> => {
    const credential = credentials();
    if (credential.bearerToken) return credential.bearerToken;
    if (token && token.until > Date.now()) return token.value;
    if (!pending) pending = (async () => {
      const doc = damRecord(await http.json(`${base}/webapi/security/clientcredentialsauthentication/authenticate_46H_v1`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_id: credential.clientId, client_secret: credential.clientSecret }),
      }));
      const value = damString(doc.access_token), expires = damNumber(doc.expires_in);
      if (!value || /[\r\n]/.test(value) || !expires || expires > 86400) throw new Error('orange-logic token response is invalid');
      token = { value, until: Date.now() + Math.max(0, expires - 30) * 1000 };
      return value;
    })().finally(() => { pending = undefined; });
    return pending;
  };
  const searchDoc = async (query: string, page: number, count: number, shape = false) => {
    const body = new URLSearchParams({ query, fields, countperpage: String(count), pagenumber: String(page), sort: 'file name',
      format: 'JSON', generateformatifnotexists: 'false', getpermanentassetspaths: 'false', includebinned: 'false' }).toString();
    for (let attempt = 0; ; attempt++) {
      try {
        const doc = damRecord(await http.json(`${base}/API/search/v4.0/search`, { method: 'POST',
          headers: { authorization: `Bearer ${await accessToken()}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body }));
        const info = doc.APIRequestInfo;
        if (info && typeof info === 'object' && damRecord(info).IsLoggedIn === false) throw new Error('orange-logic account is not authenticated');
        if (shape) return doc.APIResponse && typeof doc.APIResponse === 'object' && !Array.isArray(doc.APIResponse) ? damRecord(doc.APIResponse) : doc;
        const response = damRecord(doc.APIResponse);
        if (!Array.isArray(response.Items)) throw new Error('orange-logic response has no APIResponse.Items array; inspect --shape');
        return response;
      } catch (error) {
        if (error instanceof DamHttpError && error.status === 401 && attempt === 0 && !credentials().bearerToken) { token = undefined; continue; }
        throw error;
      }
    }
  };
  const combined = (member?: string) => [options.query, member].filter(Boolean).map(query => `(${query})`).join(' AND ');
  const revision = (a: Record<string, unknown>, code: string): string => createHash('sha256').update(JSON.stringify([field(a, 'FileMD5') ?? null, field(a, 'EditDate') ?? null, code])).digest('hex').slice(0, 16);
  const proxy = (a: Record<string, unknown>, code: string): Record<string, unknown> | undefined => {
    if (field(a, 'Warning') || field(a, 'SubstituteFormat')) return undefined;
    const value = field(a, `Path_${code}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const format = damRecord(value);
    if (field(format, 'Warning') || field(format, 'SubstituteFormat')) return undefined;
    return text(format, 'URI') ? format : undefined;
  };
  const fileUrl = (a: Record<string, unknown>, code: string): string | undefined => {
    const value = proxy(a, code), uri = value && text(value, 'URI');
    if (!uri) return undefined;
    let url: URL;
    try { url = new URL(uri); } catch { throw new Error('orange-logic rendition URL is invalid'); }
    if (/[\s\\]/.test(uri) || url.protocol !== 'https:' || url.username || url.password || url.hash || !origins.has(url.origin)) throw new Error('orange-logic rendition is outside reviewed storage origins');
    return url.href;
  };
  const toAsset = (a: Record<string, unknown>): ProviderAssetRef => {
    const remoteId = text(a, 'SystemIdentifier');
    if (!remoteId || !validId(remoteId)) throw new Error('orange-logic record has no valid SystemIdentifier');
    const name = text(a, 'Title') ?? remoteId;
    const directory = text(a, 'Directory'), parent = text(a, 'ParentFolderIdentifier'), parentName = text(a, 'ParentFolderTitle');
    const keywords = field(a, 'Keywords');
    const tags = Array.isArray(keywords) ? keywords.flatMap(value => typeof value === 'string' ? [value] : value && typeof value === 'object' && !Array.isArray(value) ? [text(damRecord(value), 'Label')].filter((tag): tag is string => !!tag) : []) : [];
    const status = options.approvalField ? text(a, options.approvalField) : undefined;
    return { remoteId, name, description: [text(a, 'CaptionLong'), 'Available files are renditions. Protected originals are unavailable through this connection.'].filter(Boolean).join('\n'),
      nativeType: text(a, 'MediaType') ?? 'file', sections: directory ? [directory] : parentName ? [parentName] : [], tags,
      ...(parent && parentName ? { taxonomy: [{ id: parent, name: parentName, kind: 'folder' }] } : {}),
      ...(options.approvalField ? { approved: status !== undefined && options.approvedValues!.includes(status) } : {}),
      updatedAt: text(a, 'EditDate'), originalsAvailable: false,
      availableFrom: damDate(availability?.from ? field(a, availability.from) : undefined, 'orange-logic'),
      availableUntil: damDate(availability?.until ? field(a, availability.until) : undefined, 'orange-logic'),
      formats: formats.flatMap(code => {
        const value = proxy(a, code), url = fileUrl(a, code);
        if (!value || !url) return [];
        const format = extOf(new URL(url).pathname);
        if (!/^[a-z0-9]{1,16}$/.test(format) || format === 'bin') return [];
        const width = damNumber(field(value, 'Width')), height = damNumber(field(value, 'Height'));
        return [{ format, remoteRef: `rendition-${code}-${revision(a, code)}`, role: 'rendition' as const, filename: `${name} (${code} rendition).${format}`,
          ...(width ? { width } : {}), ...(height ? { height } : {}) }];
      }),
      hasThumbnail: formats.some(code => {
        if (code.toLowerCase() !== 'tr1') return false;
        const url = fileUrl(a, code);
        return !!url && ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'].includes(extOf(new URL(url).pathname));
      }),
    };
  };
  const mapPage = (response: Record<string, unknown>, page: number, count: number): ProviderPage => {
    const records = response.Items as unknown[];
    const assets = records.map(raw => toAsset(damRecord(raw)));
    const global = response.GlobalInfo && typeof response.GlobalInfo === 'object' ? damRecord(response.GlobalInfo) : {};
    const total = damNumber(global.TotalCount);
    return { assets, ...((total === undefined ? records.length >= count : page * count < total) ? { next: String(page + 1) } : {}),
      notes: ['This connection exposes permitted renditions only. Protected originals require the separate Extract Original Document API.',
        ...(assets.some(asset => !asset.formats.length) ? ['Some records have no available requested rendition; no format was generated.'] : [])] };
  };
  const detail = async (remoteId: string): Promise<Record<string, unknown> | null> => {
    if (!validId(remoteId)) throw new Error('orange-logic invalid asset id');
    const response = await searchDoc(combined(`SystemIdentifier:${literal(remoteId)}`), 1, 2);
    const items = response.Items as unknown[];
    if (!items.length) return null;
    if (items.length !== 1) throw new Error('orange-logic identifier lookup is ambiguous');
    const a = damRecord(items[0]);
    if (text(a, 'SystemIdentifier') !== remoteId) throw new Error('orange-logic detail returned a different asset');
    return a;
  };
  const report = (doc: Record<string, unknown>, scope: 'list' | 'detail'): ProviderShapeReport => buildShapeReport({ kind: 'orange-logic', scope,
    endpoint: 'POST /API/search/v4.0/search', doc, records: Array.isArray(doc.Items) ? doc.Items : [], recordsKey: Array.isArray(doc.Items) ? 'APIResponse.Items' : null,
    envelopeExpected: [{ keys: ['Items'], constant: 'Search response' }],
    recordExpected: [...SEARCH_FIELDS, ...formats.map(code => `Path_${code}`), ...custom].map(key => ({ keys: [key], constant: 'SEARCH_FIELDS and configured fields' })),
    notes: ['Structure only. Protected originals are unsupported; public rendition paths are never persisted.'], depth: 1 });
  return {
    id, kind: 'orange-logic', capabilities: { authKind: 'credential', search: true, thumbnails: formats.some(code => code.toLowerCase() === 'tr1'), expiringUrls: true, originals: false, ranges: true },
    async listAssets(cursor) {
      if (cursor !== undefined && !/^[1-9][0-9]{0,6}$/.test(cursor)) throw new Error('orange-logic invalid page cursor');
      const page = cursor ? Number(cursor) : 1;
      return mapPage(await searchDoc(combined(), page, pageSize), page, pageSize);
    },
    async searchAssets(query, limit) {
      if (!query || query.length > 1000 || /[\x00-\x1f]/.test(query)) throw new Error('orange-logic search query is invalid');
      const count = damLimit(limit);
      return mapPage(await searchDoc(combined(`text:${literal(query)}`), 1, count), 1, count).assets.slice(0, count);
    },
    async getAsset(remoteId) { const a = await detail(remoteId); return a ? toAsset(a) : null; },
    async sampleShape() { return report(await searchDoc(combined(), 1, pageSize, true), 'list'); },
    async detailShape(remoteId) {
      if (!validId(remoteId)) throw new Error('orange-logic invalid asset id');
      return report(await searchDoc(combined(`SystemIdentifier:${literal(remoteId)}`), 1, 2, true), 'detail');
    },
    async resolveBlob(remoteId, formatRef, options) {
      if (formatRef === 'original') throw new Error('orange-logic protected originals require the Extract Original Document API; this connection provides renditions only');
      const a = await detail(remoteId);
      if (!a) throw new Error('orange-logic asset unavailable in this source');
      const selected = toAsset(a);
      assertDamExposure(selected, exposure);
      let code: string | undefined;
      if (formatRef === 'thumb') code = formats.find(code => code.toLowerCase() === 'tr1');
      else code = formats.find(code => selected.formats.some(format => format.remoteRef === formatRef && format.remoteRef === `rendition-${code}-${revision(a, code)}`));
      const url = code && fileUrl(a, code);
      if (!url) throw new Error('orange-logic selected rendition is unavailable, substituted or changed; refresh the source');
      // Rendition files are plain GETs, so a viewer's byte range goes upstream after the fresh exposure check above.
      return http.stream(url, undefined, options?.range);
    },
    async healthCheck() {
      try { mapPage(await searchDoc(combined(), 1, 1), 1, 1); return { ok: true, detail: 'Orange Logic search checked; protected originals are unavailable through this connection.' }; }
      catch (error) { return { ok: false, detail: (error as Error).message }; }
    },
  };
}
