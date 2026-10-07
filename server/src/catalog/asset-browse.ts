/**
 * Paged browse over the served asset feed: `GET /api/v1/catalog/assets`.
 *
 * A shell that would choke on mirroring a 50000-asset DAM asks for one page
 * at a time instead, with the same filters its own catalog view offers. Pages
 * come out of the memoised feed (served-index.ts), so they carry exactly the
 * entries, in exactly the shape, that `assets/index.json` serves this caller.
 *
 * Order is by lowercased name, then id. The cursor is an opaque token for the
 * last (name, id) a page returned, so a page boundary stays put while the feed
 * changes underneath a long walk: nothing is skipped or repeated because
 * something was added earlier in the order.
 */
import { compareKeys, sortKey, type ServedIndex } from './served-index.ts';
import type { AssetIndexEntry } from './lifecycle.ts';
import { extractedHaystack, fieldHaystack, type AssetMetaRecord } from './asset-meta.ts';
import { INST_PREFIX } from './instance-assets.ts';

export const BROWSE_DEFAULT_LIMIT = 100;
export const BROWSE_MAX_LIMIT = 500;
const MAX_PARAM = 300;
const MAX_CURSOR = 1200;
const TOP_TAGS = 50;
const TOP_GROUPS = 200;

export interface BrowseQuery {
  q?: string;
  source?: string;
  section?: string;
  collection?: string;
  tag?: string;
  type?: string;
  cursor?: [string, string];
  limit: number;
}

export interface FacetCount { name: string; count: number }

export interface BrowsePage {
  assets: AssetIndexEntry[];
  total: number;
  nextCursor: string | null;
  facets: {
    sources: Array<{ id: string; label: string; count: number }>;
    sections: FacetCount[];
    collections: FacetCount[];
    tags: FacetCount[];
    types: FacetCount[];
  };
  version: string;
}

export function encodeCursor(key: [string, string]): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(token: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return [parsed[0], parsed[1]];
    }
  } catch {
    /* refused below */
  }
  return null;
}

/** Read and bound the query string. Returns the parsed query or the reason it was refused. */
export function parseBrowseQuery(params: URLSearchParams): BrowseQuery | { error: string } {
  const out: BrowseQuery = { limit: BROWSE_DEFAULT_LIMIT };
  for (const key of ['q', 'source', 'section', 'collection', 'tag', 'type'] as const) {
    const value = params.get(key);
    if (value === null) continue;
    if (value.length > MAX_PARAM) return { error: `${key} is longer than ${MAX_PARAM} characters` };
    const trimmed = value.trim();
    if (trimmed) out[key] = key === 'q' ? trimmed.toLowerCase() : trimmed;
  }
  const limit = params.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1) return { error: 'limit must be a whole number of 1 or more' };
    out.limit = Math.min(n, BROWSE_MAX_LIMIT);
  }
  const cursor = params.get('cursor');
  if (cursor) {
    const decoded = cursor.length <= MAX_CURSOR ? decodeCursor(cursor) : null;
    if (!decoded) return { error: 'cursor is not one this route issued' };
    out.cursor = decoded;
  }
  return out;
}

/** A stable string for the parsed query, for the response ETag. */
export function normalisedQuery(q: BrowseQuery): string {
  return JSON.stringify([q.q ?? '', q.source ?? '', q.section ?? '', q.collection ?? '', q.tag ?? '', q.type ?? '', q.cursor ?? null, q.limit]);
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const metaOf = (e: AssetIndexEntry): Record<string, unknown> =>
  (e.meta && typeof e.meta === 'object' && !Array.isArray(e.meta) ? e.meta as Record<string, unknown> : {});

/** Which source an entry came from: a provider id, 'instance', or 'pack'. */
export function entrySource(e: AssetIndexEntry): string {
  if (typeof e.provider === 'string' && e.provider) return e.provider;
  return e.id.startsWith(INST_PREFIX) ? 'instance' : 'pack';
}

function count(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function top(map: Map<string, number>, limit: number): FacetCount[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([name, n]) => ({ name, count: n }));
}

interface Matched { matched: AssetIndexEntry[]; facets: BrowsePage['facets'] }

/** Filtered lists and their facets per feed state and filter set: a walk asks
 *  for the same filters page after page, so only the first page pays for the
 *  scan. A feed change is a new ServedIndex object, which drops its entries. */
const matchMemo = new WeakMap<ServedIndex, Map<string, Matched>>();
const MATCH_MEMO_SIZE = 16;

export function browseAssets(
  served: ServedIndex, query: BrowseQuery, metaById: Map<string, AssetMetaRecord>,
): BrowsePage {
  const filterKey = JSON.stringify([query.q ?? '', query.source ?? '', query.section ?? '', query.collection ?? '', query.tag ?? '', query.type ?? '']);
  let perFeed = matchMemo.get(served);
  if (!perFeed) matchMemo.set(served, (perFeed = new Map()));
  let found = perFeed.get(filterKey);
  if (found) {
    perFeed.delete(filterKey);
  } else {
    found = matchAndCount(served, query, metaById);
    while (perFeed.size >= MATCH_MEMO_SIZE) perFeed.delete(perFeed.keys().next().value as string);
  }
  perFeed.set(filterKey, found);
  const { matched, facets } = found;

  // The matched list is sorted, so a binary search finds the first entry after the cursor.
  let start = 0;
  if (query.cursor) {
    let lo = 0;
    let hi = matched.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareKeys(sortKey(matched[mid] as AssetIndexEntry), query.cursor) <= 0) lo = mid + 1;
      else hi = mid;
    }
    start = lo;
  }
  const assets = matched.slice(start, start + query.limit);
  const last = assets[assets.length - 1];
  const more = start + assets.length < matched.length;
  return {
    assets,
    total: matched.length,
    nextCursor: more && last ? encodeCursor(sortKey(last)) : null,
    facets,
    version: served.version,
  };
}

function matchAndCount(served: ServedIndex, query: BrowseQuery, metaById: Map<string, AssetMetaRecord>): Matched {
  const matches = (e: AssetIndexEntry): boolean => {
    if (query.source && entrySource(e) !== query.source) return false;
    if (query.type && e.type !== query.type) return false;
    if (query.tag && !strings(e.tags).includes(query.tag)) return false;
    const meta = metaOf(e);
    if (query.section && !strings(meta.providerSections).includes(query.section)) return false;
    if (query.collection && !strings(meta.providerCollections).includes(query.collection)) return false;
    if (query.q) {
      const q = query.q;
      const hay = [e.id, e.name, e.description, ...strings(e.tags), ...fieldHaystack({ fields: e.fields }), ...extractedHaystack(metaById.get(e.id))];
      if (!hay.some((v) => typeof v === 'string' && v.toLowerCase().includes(q))) return false;
    }
    return true;
  };
  const matched = served.sorted().filter(matches);

  // Facets describe the whole matched set, not the page.
  const sources = new Map<string, number>();
  const sections = new Map<string, number>();
  const collections = new Map<string, number>();
  const tags = new Map<string, number>();
  const types = new Map<string, number>();
  for (const e of matched) {
    count(sources, entrySource(e));
    if (typeof e.type === 'string') count(types, e.type);
    for (const t of new Set(strings(e.tags))) count(tags, t);
    const meta = metaOf(e);
    for (const s of new Set(strings(meta.providerSections))) count(sections, s);
    for (const c of new Set(strings(meta.providerCollections))) count(collections, c);
  }
  const labels = new Map(served.providers.map((p) => [p.id, p.label]));
  const sourceLabel = (id: string): string => labels.get(id) ?? (id === 'instance' ? 'Instance assets' : id === 'pack' ? 'Pack' : id);
  return {
    matched,
    facets: {
      sources: [...sources.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([id, n]) => ({ id, label: sourceLabel(id), count: n })),
      sections: top(sections, TOP_GROUPS),
      collections: top(collections, TOP_GROUPS),
      tags: top(tags, TOP_TAGS),
      types: top(types, Infinity),
    },
  };
}
