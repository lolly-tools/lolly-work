/**
 * Catalog content lifecycle — expiry, scheduling, and revocation (plans/06 §3).
 *
 * Pure functions only: no fs, no store. `assetState` resolves a lifecycle row
 * (or its absence) to one of four states at a given instant; `applyLifecycleToIndex`
 * folds those states into a served assets/index.json feed (drop/keep/annotate);
 * `buildPathMap` inverts an index's format entries into path → assetId, so the
 * blob-serving route (app.ts) can gate an individual file the same way, without
 * re-deriving the state logic.
 */

export type OnExpiry = 'hide' | 'warn';

export interface LifecycleRow {
  assetId: string;
  validFrom?: string; // ISO — not live before this instant
  validUntil?: string; // ISO — expired at/after this instant
  revokedAt?: string; // ISO — revoked forever, regardless of validFrom/validUntil
  onExpiry: OnExpiry;
}

export type AssetState = 'live' | 'scheduled' | 'expired' | 'revoked';

/**
 * Resolve a lifecycle row (or its absence) to a state at `now` (epoch ms).
 * Precedence: revoked always wins; a not-yet-valid asset is 'scheduled' even
 * if its validUntil has also passed (it never went live); otherwise
 * expired-by-date; otherwise live. No row at all is always 'live'.
 */
export function assetState(row: LifecycleRow | undefined, now: number): AssetState {
  if (!row) return 'live';
  if (row.revokedAt) return 'revoked';
  if (row.validFrom && Date.parse(row.validFrom) > now) return 'scheduled';
  if (row.validUntil && Date.parse(row.validUntil) <= now) return 'expired';
  return 'live';
}

export interface AssetFormatEntry {
  format: string;
  url?: string;
  [key: string]: unknown;
}

export interface AssetIndexEntry {
  id: string;
  expired?: boolean;
  formats?: AssetFormatEntry[];
  [key: string]: unknown;
}

export interface AssetIndex {
  assets?: AssetIndexEntry[];
  [key: string]: unknown;
}

/**
 * Fold lifecycle rows into a servable feed: revoked, scheduled, and
 * expired-with-'hide' entries are dropped; expired-with-'warn' entries are
 * kept with `expired: true` added so a client can show the nag without a
 * second fetch. An index with no lifecycle rows at all — the common case —
 * is returned untouched (same reference; no copy made).
 */
export function applyLifecycleToIndex(index: AssetIndex, rows: LifecycleRow[], now: number): AssetIndex {
  if (!rows.length || !Array.isArray(index.assets)) return index;
  const byId = new Map(rows.map((r) => [r.assetId, r]));
  const assets: AssetIndexEntry[] = [];
  for (const entry of index.assets) {
    const row = byId.get(entry.id);
    const state = assetState(row, now);
    if (state === 'revoked' || state === 'scheduled') continue;
    if (state === 'expired') {
      if (row?.onExpiry === 'warn') assets.push({ ...entry, expired: true });
      continue; // 'hide' (the default) drops it
    }
    assets.push(entry);
  }
  return { ...index, assets };
}

/**
 * Invert an index's format entries into a path → assetId map, where the path
 * is relative to the pack's catalog/ root — the same shape as the `rel` the
 * /catalog/* route already computes from the request URL. Tolerant of a
 * leading '/' and/or 'catalog/' prefix on the stored url (both forms appear
 * across packs); a format entry with no url is skipped.
 */
export function buildPathMap(index: AssetIndex): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(index.assets)) return map;
  for (const asset of index.assets) {
    if (typeof asset?.id !== 'string' || !Array.isArray(asset.formats)) continue;
    for (const fmt of asset.formats) {
      const url = typeof fmt?.url === 'string' ? fmt.url : undefined;
      if (!url) continue;
      const rel = url.replace(/^\/+/, '').replace(/^catalog\//, '');
      if (rel) map.set(rel, asset.id);
    }
  }
  return map;
}
