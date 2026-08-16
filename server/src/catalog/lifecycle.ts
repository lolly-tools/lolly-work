/**
 * Catalog content lifecycle - expiry, scheduling, and revocation (plans/06 §3).
 *
 * Pure functions only: no fs, no store. `assetState` resolves a lifecycle row
 * (or its absence) to one of four states at a given instant; `applyLifecycleToIndex`
 * folds those states into a served assets/index.json feed (drop/keep/annotate);
 * `buildPathMap` inverts an index's format entries into path → assetId, so the
 * blob-serving route (app.ts) can gate an individual file the same way, without
 * re-deriving the state logic.
 */

export type OnExpiry = 'hide' | 'warn';

/**
 * A permissioned block on making an asset go away (plans/27 §3). A held asset
 * refuses revocation, expiry-into-the-past/scheduling-into-the-future, and
 * (once plans/26 lands) blob deletion until the hold is released - the one
 * governance verb that only ever *preserves* availability. Setting it never
 * changes the resolved state; it only gates mutations.
 */
export interface LifecycleHold {
  by: string; // 'user:<id>' who set it
  at: string; // ISO
  note?: string;
}

export interface LifecycleRow {
  assetId: string;
  validFrom?: string; // ISO - not live before this instant
  validUntil?: string; // ISO - expired at/after this instant
  revokedAt?: string; // ISO - revoked forever, regardless of validFrom/validUntil
  onExpiry: OnExpiry;
  hold?: LifecycleHold;
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

/**
 * An availability window imported from an upstream DAM (plans/27 §2) - the
 * provider's own expiry/scheduling, folded onto the fragment entry by
 * `mapProviderAsset`. Absent for providers with no such API (the manual
 * lifecycle arm is then the whole story).
 */
export interface AvailabilityWindow {
  availableFrom?: string; // ISO
  availableUntil?: string; // ISO
}

export interface CombinedState {
  state: AssetState;
  /**
   * True only when the asset is 'expired' *because of the upstream window*
   * (`availableUntil` at/before now). Upstream-driven expiry ignores a local
   * `onExpiry: 'warn'` - the DAM is the source of truth for its own asset's
   * availability, so an unavailable-upstream asset is hidden, not merely
   * nagged. A purely-local expiry (`validUntil`) leaves this false and may warn.
   */
  upstreamExpired: boolean;
}

/**
 * Resolve the effective state from a local lifecycle row and an optional
 * upstream availability window (plans/27 §2). Most-restrictive-wins: 'scheduled'
 * if EITHER start is still in the future, 'expired' if EITHER end has passed - 
 * so a local admin can narrow an upstream window (pull the end earlier, delay
 * the start later) but never widen it past what the DAM allows. Revoked always
 * wins. With `window` undefined this reduces exactly to `assetState`.
 */
export function combinedState(
  row: LifecycleRow | undefined,
  window: AvailabilityWindow | undefined,
  now: number,
): CombinedState {
  if (row?.revokedAt) return { state: 'revoked', upstreamExpired: false };
  const future = (iso: string | undefined): boolean => iso !== undefined && Date.parse(iso) > now;
  const passed = (iso: string | undefined): boolean => iso !== undefined && Date.parse(iso) <= now;
  if (future(row?.validFrom) || future(window?.availableFrom)) return { state: 'scheduled', upstreamExpired: false };
  const upstreamExpired = passed(window?.availableUntil);
  if (upstreamExpired || passed(row?.validUntil)) return { state: 'expired', upstreamExpired };
  return { state: 'live', upstreamExpired: false };
}

/**
 * Read the upstream availability window off a feed entry (the `availableFrom` /
 * `availableUntil` keys `mapProviderAsset` stamps). Returns undefined - without
 * allocating - for the common pack entry that carries neither, so the fold's
 * fast path stays cheap.
 */
export function entryWindow(entry: AssetIndexEntry): AvailabilityWindow | undefined {
  const availableFrom = typeof entry.availableFrom === 'string' ? entry.availableFrom : undefined;
  const availableUntil = typeof entry.availableUntil === 'string' ? entry.availableUntil : undefined;
  if (availableFrom === undefined && availableUntil === undefined) return undefined;
  return {
    ...(availableFrom !== undefined ? { availableFrom } : {}),
    ...(availableUntil !== undefined ? { availableUntil } : {}),
  };
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
 * Fold lifecycle rows and imported upstream windows into a servable feed:
 * revoked, scheduled, and expired-with-'hide' entries are dropped; a purely-
 * local expired-with-'warn' entry is kept with `expired: true` added so a
 * client can show the nag without a second fetch. Upstream-driven expiry always
 * hides (the DAM is the source of truth for its own asset's availability), so
 * `onExpiry: 'warn'` never rescues it. An index with no lifecycle rows and no
 * entry carrying an upstream window - the common pack case - is returned
 * untouched (same reference; no copy made).
 */
export function applyLifecycleToIndex(index: AssetIndex, rows: LifecycleRow[], now: number): AssetIndex {
  if (!Array.isArray(index.assets)) return index;
  if (!rows.length && !index.assets.some((e) => entryWindow(e))) return index;
  const byId = new Map(rows.map((r) => [r.assetId, r]));
  const assets: AssetIndexEntry[] = [];
  for (const entry of index.assets) {
    const row = byId.get(entry.id);
    const { state, upstreamExpired } = combinedState(row, entryWindow(entry), now);
    if (state === 'revoked' || state === 'scheduled') continue;
    if (state === 'expired') {
      if (!upstreamExpired && row?.onExpiry === 'warn') assets.push({ ...entry, expired: true });
      continue; // 'hide' (the default), or any upstream expiry, drops it
    }
    assets.push(entry);
  }
  return { ...index, assets };
}

/**
 * Invert an index's format entries into a path → assetId map, where the path
 * is relative to the pack's catalog/ root - the same shape as the `rel` the
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
