/**
 * Instance assets (plans/26 §4, plans/27 §5) - catalog assets whose BYTES the
 * instance owns, held in the BlobStore rather than the pack filesystem or an
 * upstream DAM. Two producers mint them: plans/26's "add to org catalog" submit,
 * and plans/27's exit (materialize a federated asset into the instance's own
 * store). They compose into the served `assets/index.json` per caller exactly as
 * federation fragments do, their bytes stream from `/catalog/inst/<id>/<format>`,
 * and lifecycle/holds/credentials/grants apply to them like any asset. **The pack
 * filesystem is never written.**
 */
import { sha256Hex } from '../lib/crypto.ts';
import type { AssetIndex, AssetIndexEntry } from './lifecycle.ts';

/** Prefix every instance-owned asset id carries; also the blob route mount. */
export const INST_PREFIX = 'inst/';

/** Deterministic instance-asset id for a materialized federated asset - stable
 *  per (provider, remoteId) so re-materialization is idempotent and the ext/*
 *  blob route can find a pinned copy without a reverse-lookup table (plans/27 §5). */
export function materializedIdFor(providerId: string, remoteId: string): string {
  return `${INST_PREFIX}${sha256Hex(`${providerId}:${remoteId}`).slice(0, 16)}`;
}

/** Where a materialized asset came from - kept permanently so provenance stays
 *  honest long after the source DAM is gone (plans/27 §5). */
export interface InstanceAssetOrigin {
  provider: string;
  providerKind: string;
  remoteId: string;
  filename?: string;
  sourceUpdatedAt?: string;
  materializedAt: string;
}

export interface InstanceAssetRecord {
  /** 'inst/<opaque>' - single-segment id so the blob path is inst/<id>/<format>. */
  id: string;
  /** The served catalog entry (formats carry url + computed size + checksum). */
  entry: AssetIndexEntry;
  /** Format name → BlobStore blobId; the inst/* blob route resolves through this. */
  blobs: Record<string, string>;
  /** Original provider `remoteRef` → format name, for a pinned asset whose bytes
   *  are local but whose identity stays ext/* - the ext blob route maps the
   *  requested formatRef to the local format through this (plans/27 §5). */
  refMap?: Record<string, string>;
  /** Exposure groups, copied from the source provider on exit; '*'/absent = all
   *  members (a pack-like asset). */
  groups?: string[] | '*';
  origin?: InstanceAssetOrigin;
  /**
   * True once this asset's identity has been cut over from ext/* to inst/*
   * (plans/27 §5). Until then a materialized asset is a *pin*: the bytes are
   * local but the catalog identity - and the lifecycle/credential rows that gate
   * it - stay ext/*, so the feed keeps showing the ext entry and only the
   * ext blob route (pin-prefers-local) serves. Only an EXITED asset substitutes
   * its inst entry into the feed and carries its own migrated lifecycle row.
   */
  exited?: boolean;
  createdAt: string;
}

/** Whether this caller sees an instance asset at all (mirrors provider group
 *  visibility so an exited asset keeps the exposure the DAM slice had). */
export function instanceAssetVisible(rec: InstanceAssetRecord, callerGroups: string[]): boolean {
  const g = rec.groups;
  if (!g || g === '*') return true;
  return g.some((x) => callerGroups.includes(x));
}

/** Append caller-visible instance-asset entries onto a served index (the
 *  federation precedent). An asset that has been **cut over** (`exited`)
 *  substitutes its inst entry for the now-retired federated one - while the
 *  source provider is still enabled its ext/* entry is suppressed so nothing
 *  appears twice (plans/27 §5). A merely *pinned* asset (materialized but not
 *  yet exited) does NOT touch the feed: its identity - and the lifecycle row
 *  that gates it - stays ext/*, so the federated entry is served as-is (bytes
 *  come from the local pin via the ext blob route). Lifecycle + credentials fold
 *  over the combined set. */
export function composeInstanceAssets(index: AssetIndex, records: InstanceAssetRecord[], callerGroups: string[]): AssetIndex {
  const exited = records.filter((r) => r.exited);
  if (!exited.length && records.every((r) => r.origin)) return index; // only pins/no exits → feed unchanged
  const shadowed = new Set(exited.filter((r) => r.origin).map((r) => `${EXT_PREFIX}${r.origin!.provider}/${r.origin!.remoteId}`));
  const kept = (index.assets ?? []).filter((e) => !shadowed.has(e.id));
  // Exited assets substitute their entry; instance assets with no origin (a
  // plans/26 catalog submit) are ordinary feed members and always compose in.
  const composable = records.filter((r) => (r.exited || !r.origin) && instanceAssetVisible(r, callerGroups)).map((r) => r.entry);
  if (!shadowed.size && !composable.length) return index;
  return { ...index, assets: [...kept, ...composable] };
}

/** Prefix a federated asset id carries - mirrors providers/types EXT_PREFIX
 *  without importing the driver module into this pure catalog helper. */
const EXT_PREFIX = 'ext/';

/** Combined content hash of all instance-asset entries - folded into
 *  catalogVersion so a new/changed instance asset ripples render invalidation
 *  like a pack or provider change. */
export function instanceAssetsFingerprint(records: InstanceAssetRecord[]): string {
  return records.map((r) => `${r.id}:${(r.entry.formats ?? []).map((f) => (f as { checksum?: string }).checksum ?? '').join(',')}`).sort().join('|');
}

/** The served entry for a materialized asset: its formats point at the inst/*
 *  blob route and carry the computed checksum + size the OSS shell verifies. */
export function instanceAssetEntry(id: string, base: Omit<AssetIndexEntry, 'id' | 'formats'>, formats: Array<{ format: string; size: number; checksum: string }>): AssetIndexEntry {
  return {
    ...base,
    id,
    formats: formats.map((f) => ({ format: f.format, url: `/catalog/${id}/${f.format}`, size: f.size, checksum: f.checksum })),
  };
}
