/**
 * Cloudinary read-only source (plans/81), using documented Search/Admin and
 * asset-ID download APIs. No SDK, transformation, upload or AI execution.
 * LIVE-VERIFY: regional API, Search entitlement, metadata mapping, private/raw
 * downloads and byte fidelity. See the runbook live-verify/cloudinary.md.
 */
import { createHash } from 'node:crypto';
import { assertDamExposure, createDamHttp, DamHttpError, damDate, damLimit, damNumber, damRecord, damString } from './dam-http.ts';
import { buildDetailShapeReport, buildShapeReport } from './shape.ts';
import { extOf, type CatalogProvider, type ProviderAssetRef, type ProviderExposure, type ProviderPage } from './types.ts';

export interface CloudinaryOptions {
  cloudName: string;
  region?: 'us' | 'eu' | 'ap';
  /** Exact dynamic asset folder, without subfolders. Omit for the whole cloud. */
  assetFolder?: string;
  pageSize?: number;
  minGapMs?: number;
  /** Request structured metadata in Search; requires its tenant entitlement. */
  includeMetadata?: boolean;
  /** Explicit source approval convention, separate from moderation or rights. */
  approvedTag?: string;
}

const RECORD_KEYS = ['asset_id', 'public_id', 'version', 'resource_type', 'type', 'format', 'bytes', 'width', 'height', 'asset_folder', 'display_name', 'original_filename', 'filename', 'created_at', 'updated_at', 'tags', 'context', 'metadata'];
const expected = RECORD_KEYS.map(key => ({ keys: [key], constant: 'Cloudinary resource fields' }));
const literal = (text: string): string => `"${text.replace(/[\\"]/g, '\\$&')}"`;
const raster = (format: string): boolean => ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'].includes(format);

export function createCloudinaryProvider(id: string, options: CloudinaryOptions, secret: string | undefined,
  fetchImpl: typeof fetch = fetch, availability?: { from?: string; until?: string }, exposure?: ProviderExposure): CatalogProvider {
  if (typeof options.cloudName !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(options.cloudName)) throw new Error('cloudinary needs options.cloudName');
  const host = { us: 'api.cloudinary.com', eu: 'api-eu.cloudinary.com', ap: 'api-ap.cloudinary.com' }[options.region ?? 'us'];
  if (!host) throw new Error('cloudinary region must be us, eu or ap');
  if (options.assetFolder !== undefined && (typeof options.assetFolder !== 'string' || options.assetFolder.length > 500 || /[\x00-\x1f]/.test(options.assetFolder))) throw new Error('cloudinary assetFolder must be an exact folder name');
  if (options.approvedTag !== undefined && (typeof options.approvedTag !== 'string' || !options.approvedTag || options.approvedTag.length > 300)) throw new Error('cloudinary approvedTag must be a tag name');
  if (options.includeMetadata !== undefined && typeof options.includeMetadata !== 'boolean') throw new Error('cloudinary includeMetadata must be a boolean');
  const availabilityKeys = [availability?.from, availability?.until].filter(key => key !== undefined);
  if (availabilityKeys.some(key => typeof key !== 'string' || !key || key.length > 300 || /[\x00-\x1f]/.test(key))) throw new Error('cloudinary availability field name is invalid');
  if (availabilityKeys.some(key => key!.startsWith('metadata.')) && !options.includeMetadata) throw new Error('cloudinary metadata availability fields require includeMetadata and its Search entitlement');
  const pageSize = damLimit(options.pageSize ?? 100);
  const http = createDamHttp('cloudinary', fetchImpl, options.minGapMs ?? 2000);
  const base = `https://${host}/v1_1/${options.cloudName}`;
  const credentials = () => {
    try {
      const value = JSON.parse(secret ?? '') as { apiKey?: unknown; apiSecret?: unknown };
      if (typeof value.apiKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.apiKey) || typeof value.apiSecret !== 'string' || !value.apiSecret || /[\r\n]/.test(value.apiSecret)) throw new Error();
      return { apiKey: value.apiKey, apiSecret: value.apiSecret };
    } catch { throw new Error('cloudinary credential must be JSON containing apiKey and apiSecret'); }
  };
  const headers = () => { const c = credentials(); return { authorization: `Basic ${Buffer.from(`${c.apiKey}:${c.apiSecret}`).toString('base64')}`, accept: 'application/json' }; };
  const scope = options.assetFolder !== undefined ? `asset_folder=${literal(options.assetFolder)}` : 'resource_type:(image OR video OR raw)';
  const inScope = (record: Record<string, unknown>): boolean => (!record.status || record.status === 'active') && (options.assetFolder === undefined || record.asset_folder === options.assetFolder);
  const fields = ['tags', 'context', ...(options.includeMetadata ? ['metadata'] : [])];
  const searchDoc = async (query: string | undefined, limit: number, cursor?: string) => {
    if (cursor !== undefined && (!cursor || cursor.length > 4000 || /[\x00-\x1f]/.test(cursor))) throw new Error('cloudinary invalid cursor');
    if (query !== undefined && (query.length > 1000 || /[\x00-\x1f]/.test(query))) throw new Error('cloudinary search query is invalid');
    const expression = query ? `(${scope}) AND (filename:${literal(query)} OR public_id:${literal(query)} OR tags:${literal(query)})` : scope;
    return damRecord(await http.json(`${base}/resources/search`, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ expression, max_results: limit, with_field: fields, sort_by: [{ public_id: 'asc' }], ...(cursor ? { next_cursor: cursor } : {}) }) }));
  };
  const toAsset = (raw: unknown): ProviderAssetRef => {
    const a = damRecord(raw), remoteId = damString(a.asset_id);
    if (!remoteId || !/^[A-Za-z0-9_-]{1,200}$/.test(remoteId)) throw new Error('cloudinary resource has no valid asset_id');
    if (!['image', 'video', 'raw'].includes(a.resource_type as string) || !['upload', 'private', 'authenticated'].includes(a.type as string)) throw new Error('cloudinary unsupported resource or delivery type');
    if (!Number.isSafeInteger(a.version) || (a.version as number) < 1) throw new Error('cloudinary resource has no version');
    const publicId = damString(a.public_id);
    if (!publicId) throw new Error('cloudinary resource has no public_id');
    const format = (damString(a.format) ?? extOf(publicId)).toLowerCase();
    if (!/^[a-z0-9]{1,16}$/.test(format)) throw new Error('cloudinary resource has no valid file format');
    const original = damString(a.original_filename) ?? damString(a.filename) ?? publicId.split('/').at(-1)!;
    const filename = original.toLowerCase().endsWith(`.${format}`) ? original : `${original}.${format}`;
    const context = a.context && typeof a.context === 'object' ? damRecord(a.context) : {};
    const custom = context.custom && typeof context.custom === 'object' ? damRecord(context.custom) : context;
    const metadata = a.metadata && typeof a.metadata === 'object' ? damRecord(a.metadata) : {};
    const sourceField = (key?: string) => key ? (key.startsWith('metadata.') ? metadata[key.slice(9)] : custom[key.replace(/^context\./, '')]) : undefined;
    const tags = Array.isArray(a.tags) ? a.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const folder = damString(a.asset_folder), size = damNumber(a.bytes), width = damNumber(a.width), height = damNumber(a.height);
    return { remoteId, name: damString(a.display_name) ?? original, description: damString(custom.caption) ?? damString(custom.alt), nativeType: format,
      sections: folder ? [folder] : [], tags, ...(folder ? { taxonomy: [{ id: folder, name: folder, kind: 'folder' }] } : {}),
      ...(options.approvedTag ? { approved: tags.includes(options.approvedTag) } : {}),
      updatedAt: damString(a.updated_at) ?? damString(a.created_at),
      availableFrom: damDate(sourceField(availability?.from), 'cloudinary'), availableUntil: damDate(sourceField(availability?.until), 'cloudinary'),
      originalsAvailable: true,
      formats: [{ format, remoteRef: `original-${a.version}`, role: 'original', filename,
        ...(size !== undefined ? { size } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) }],
      hasThumbnail: a.resource_type === 'image' && raster(format) && size !== undefined && size <= 2 * 1024 * 1024,
    };
  };
  const mapPage = (doc: Record<string, unknown>): ProviderPage => {
    if (!Array.isArray(doc.resources)) throw new Error('cloudinary response has no resources array; inspect --shape');
    const assets: ProviderAssetRef[] = []; let skipped = 0;
    for (const raw of doc.resources) {
      const record = damRecord(raw);
      if (!inScope(record)) throw new Error('cloudinary returned an asset outside the configured folder');
      if (!['upload', 'private', 'authenticated'].includes(record.type as string)) { skipped++; continue; }
      assets.push(toAsset(record));
    }
    const next = doc.next_cursor;
    if (next !== undefined && (typeof next !== 'string' || !next || next.length > 4000)) throw new Error('cloudinary returned an invalid next_cursor');
    return { assets, ...(next ? { next: next as string } : {}), ...(skipped ? { skipped, notes: ['Unsupported external delivery types were skipped; this source supports upload, private and authenticated assets.'] } : {}) };
  };
  const detail = async (remoteId: string): Promise<Record<string, unknown> | null> => {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(remoteId)) throw new Error('cloudinary invalid asset id');
    try {
      const a = damRecord(await http.json(`${base}/resources/${remoteId}?tags=true&context=true&metadata=true`, { headers: headers() }));
      if (a.asset_id !== remoteId) throw new Error('cloudinary detail returned a different asset');
      return inScope(a) ? a : null;
    } catch (error) { if (error instanceof DamHttpError && error.status === 404) return null; throw error; }
  };
  return {
    id, kind: 'cloudinary', capabilities: { authKind: 'credential', search: true, thumbnails: true, expiringUrls: true, originals: true },
    async listAssets(cursor) {
      const page = mapPage(await searchDoc(undefined, pageSize, cursor));
      if (cursor && page.next === cursor) throw new Error('cloudinary repeated a pagination cursor');
      return page;
    },
    async searchAssets(query, limit) { return mapPage(await searchDoc(query, damLimit(limit))).assets.slice(0, limit); },
    async getAsset(remoteId) { const a = await detail(remoteId); return a ? toAsset(a) : null; },
    async sampleShape() {
      const doc = await searchDoc(undefined, pageSize);
      return buildShapeReport({ kind: 'cloudinary', endpoint: 'POST /resources/search', doc, records: Array.isArray(doc.resources) ? doc.resources : [], recordsKey: 'resources',
        envelopeExpected: [{ keys: ['resources'], constant: 'Search response' }, { keys: ['next_cursor'], constant: 'Search cursor' }], recordExpected: expected });
    },
    async detailShape(remoteId) {
      const doc = await detail(remoteId);
      if (!doc) throw new Error('cloudinary asset unavailable in this source');
      return buildDetailShapeReport({ kind: 'cloudinary', endpoint: 'GET /resources/:asset_id', doc, wrapperKeys: [], wrapperConstant: '', recordExpected: expected });
    },
    async resolveBlob(remoteId, formatRef) {
      const record = await detail(remoteId);
      if (!record) throw new Error('cloudinary asset unavailable in this source');
      const a = toAsset(record), format = a.formats[0]!;
      assertDamExposure(a, exposure);
      if (formatRef === 'thumb') {
        if (!a.hasThumbnail) throw new Error('cloudinary has no existing image preview for this asset');
      } else if (formatRef !== format.remoteRef) throw new Error('cloudinary selected file version changed or is invalid; refresh the source');
      const c = credentials(), timestamp = Math.floor(Date.now() / 1000);
      const params = { asset_id: remoteId, expires_at: String(timestamp + 60), timestamp: String(timestamp) };
      const signed = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('&');
      const signature = createHash('sha256').update(signed + c.apiSecret).digest('hex');
      return http.stream(`${base}/asset/download`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...params, api_key: c.apiKey, signature }).toString() });
    },
    async healthCheck() {
      try { mapPage(await searchDoc(undefined, 1)); return { ok: true, detail: 'Cloudinary read access checked; tenant originals still require verification.' }; }
      catch (error) { return { ok: false, detail: (error as Error).message }; }
    },
  };
}
