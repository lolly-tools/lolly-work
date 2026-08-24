/**
 * Asset versions and supersession (plans/31 section 6).
 *
 * An instance asset used to be one row and one set of blobs: new bytes for the
 * same idea meant a second asset id, and every link, collection, session and
 * rendered SVG that named the first one kept serving last quarter's logo. This
 * module makes the id durable and the BYTES a sequence:
 *
 *  - a VERSION ROW is an immutable snapshot of one format set, keyed
 *    (assetId, version). Versions are 1-based, monotonic, and never reused -
 *    a deleted version leaves a hole rather than letting a later row inherit
 *    an id somebody already downloaded;
 *  - the HEAD is a number on the instance-asset record, not a flag on a row,
 *    so "exactly one head" is a property of the shape rather than an invariant
 *    a write has to maintain. Rollback is one record write;
 *  - RETENTION is policy (`policy.catalog.versionKeep`, default keep-all), and
 *    trimming is a pure decision here so the route only has to obey it.
 *
 * Supersession is the other half and works one level up: it is about IDS, not
 * bytes. Asset A retired in favour of asset B writes `replacedBy` on A, which
 * rides the served feed additively (asset-meta.ts) - a new version is "these
 * bytes changed", a supersession is "stop using this asset, use that one".
 *
 * Pure functions only - no store, no fs, no blobs - so the routes, the feed and
 * the tests fold identical rules.
 */
import type { AssetIndexEntry } from './lifecycle.ts';
import { instanceAssetEntry, type InstanceAssetRecord } from './instance-assets.ts';

/** One stored format inside a version. `blobId` is the BlobStore key; it is
 *  never re-derived from the asset id, because version 1 of a pre-versioning
 *  asset points at the flat key the submit/materialize path wrote. */
export interface AssetVersionFormat {
  format: string;
  blobId: string;
  size: number;
  checksum: string;
  contentType?: string;
}

export interface AssetVersionRecord {
  /** The catalog id these bytes belong to - always `inst/*`. */
  assetId: string;
  /** 1-based, monotonic, never reused. */
  version: number;
  /** The whole format set this version serves. A version replaces the asset's
   *  bytes, not one file of them, so the set is snapshotted whole and a
   *  rollback restores it whole. */
  formats: AssetVersionFormat[];
  /** 'user:<id>' who put these bytes here. */
  by: string;
  at: string;
  /** Why these bytes replaced the last - the changelog line a curator reads. */
  note?: string;
  /** Pixel dimensions, when the bytes declared them. */
  width?: number;
  height?: number;
}

/** Where a version's bytes live. Version 1 of an asset that predates versioning
 *  keeps the flat key it was written under; every version minted here is
 *  addressed by its number, so no two versions can ever collide on a key and
 *  overwrite each other's bytes. */
export function versionBlobKey(assetId: string, version: number, format: string): string {
  return `${assetId}/v${version}/${format}`;
}

/**
 * The version an asset serves right now. An asset with no `headVersion` has
 * never been versioned and reads as version 1: the record's own blobs ARE
 * version 1, which is what lets migration 0020 ship without a data backfill and
 * a pre-versioning asset answer `?v=1` correctly the moment it grows a history.
 */
export function headVersionOf(rec: InstanceAssetRecord): number {
  return rec.headVersion ?? 1;
}

/** The formats a record currently serves, as a version's format set. This is
 *  how version 1 is materialized the first time an asset gains a second one -
 *  lazily, from what the record already holds, so nothing is copied and no
 *  bytes move. */
export function formatsOfRecord(rec: InstanceAssetRecord): AssetVersionFormat[] {
  const byFormat = new Map<string, { size: number; checksum: string }>();
  for (const f of rec.entry.formats ?? []) {
    const name = String((f as { format?: unknown }).format ?? '');
    if (!name) continue;
    const size = (f as Record<string, unknown>).size;
    const checksum = (f as Record<string, unknown>).checksum;
    byFormat.set(name, {
      size: typeof size === 'number' ? size : 0,
      checksum: typeof checksum === 'string' ? checksum : '',
    });
  }
  const out: AssetVersionFormat[] = [];
  for (const [format, blobId] of Object.entries(rec.blobs)) {
    const stat = byFormat.get(format);
    out.push({
      format,
      blobId,
      size: stat?.size ?? 0,
      checksum: stat?.checksum ?? '',
      ...(rec.submission?.contentType && byFormat.size === 1 ? { contentType: rec.submission.contentType } : {}),
    });
  }
  return out;
}

/** The version-1 row for an asset that predates versioning, built from what it
 *  already serves. `by` falls back to the submitter, then to the instance
 *  itself for a materialized asset nobody submitted. */
export function backfillVersionOne(rec: InstanceAssetRecord): AssetVersionRecord {
  return {
    assetId: rec.id,
    version: 1,
    formats: formatsOfRecord(rec),
    by: rec.submission?.by ?? 'instance',
    at: rec.submission?.at ?? rec.createdAt,
    ...(typeof rec.entry.width === 'number' && typeof rec.entry.height === 'number'
      ? { width: rec.entry.width, height: rec.entry.height }
      : {}),
  };
}

/**
 * Point a record's served bytes at one version - the ONE head move, used by
 * both the new-bytes path and rollback so the two can never disagree about
 * what serving a version means.
 *
 * The served URLs do not change (`/catalog/<id>/<format>` is the id's address,
 * not a version's), so every link, collection and rendered reference keeps
 * resolving; what changes is the checksum + size the feed advertises, which is
 * exactly what tells a shell holding an old copy to fetch again.
 */
export function applyVersionToRecord(rec: InstanceAssetRecord, row: AssetVersionRecord): InstanceAssetRecord {
  const base = { ...rec.entry } as Record<string, unknown>;
  delete base.id;
  delete base.formats;
  const entry = instanceAssetEntry(rec.id, base as Omit<AssetIndexEntry, 'id' | 'formats'>,
    row.formats.map((f) => ({ format: f.format, size: f.size, checksum: f.checksum })));
  if (row.width && row.height) {
    entry.width = row.width;
    entry.height = row.height;
  }
  return {
    ...rec,
    entry,
    blobs: Object.fromEntries(row.formats.map((f) => [f.format, f.blobId])),
    headVersion: row.version,
    // The high-water mark only ever rises, so a rollback onto version 1 does
    // not make the NEXT upload version 2 all over again.
    versionSeq: Math.max(rec.versionSeq ?? 0, rec.headVersion ?? 1, row.version),
  };
}

/** The number the next version of this asset takes: one past the highest ever
 *  minted, never one past the highest still stored. */
export function nextVersionNumber(rec: InstanceAssetRecord, rows: AssetVersionRecord[]): number {
  return Math.max(rec.versionSeq ?? 0, rec.headVersion ?? 1, ...rows.map((r) => r.version)) + 1;
}

/**
 * Which versions retention drops, oldest first.
 *
 * `keep` is a count of versions to hold per asset, head included; 0 (the
 * default) keeps everything, which is the only safe default for an org that has
 * just moved its brand history off a DAM - blob growth is an operator's call to
 * make deliberately, not a surprise the product springs on them
 * (docs/operations.md carries the sizing note).
 *
 * The HEAD is never trimmed, whatever its age: a rollback deliberately makes an
 * old version current, and retention must not then delete the bytes the asset
 * is serving. Rows are dropped oldest-first from what remains.
 */
export function versionsToTrim(rows: AssetVersionRecord[], headVersion: number, keep: number): AssetVersionRecord[] {
  if (!Number.isFinite(keep) || keep <= 0) return [];
  const ordered = [...rows].sort((a, b) => b.version - a.version); // newest first
  const kept = new Set<number>([headVersion]);
  for (const row of ordered) {
    if (kept.size >= keep) break;
    kept.add(row.version);
  }
  return ordered.filter((r) => !kept.has(r.version)).reverse();
}

/** Blob ids a trim may actually delete: the ones no surviving version still
 *  points at. Two versions can share a blob (a rollback that re-lands identical
 *  bytes), and deleting the shared copy would blank a version that is still
 *  listed. */
export function orphanBlobIds(trimmed: AssetVersionRecord[], surviving: AssetVersionRecord[]): string[] {
  const live = new Set(surviving.flatMap((r) => r.formats.map((f) => f.blobId)));
  const out = new Set<string>();
  for (const row of trimmed) {
    for (const f of row.formats) if (!live.has(f.blobId)) out.add(f.blobId);
  }
  return [...out];
}

/** The API/CLI/console view of one version. Blob ids stay server-side: they are
 *  a storage detail and naming them would invite a caller to address bytes by
 *  something other than the gated routes. */
export function versionView(row: AssetVersionRecord, headVersion: number): Record<string, unknown> {
  return {
    version: row.version,
    head: row.version === headVersion,
    at: row.at,
    by: row.by,
    ...(row.note ? { note: row.note } : {}),
    ...(row.width && row.height ? { width: row.width, height: row.height } : {}),
    formats: row.formats.map((f) => ({
      format: f.format, size: f.size, checksum: f.checksum,
      ...(f.contentType ? { contentType: f.contentType } : {}),
    })),
    size: row.formats.reduce((n, f) => n + f.size, 0),
  };
}

// -- supersession -------------------------------------------------------------

/** A catalog asset id, in any of the three shapes a supersession may name. */
const ASSET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * Validate a `replacedBy` target, or return the refusal. `null`/'' clears it.
 *
 * A self-reference is refused because it is a loop a consumer would follow
 * forever, and a traversal-shaped id is refused for the same reason a
 * collection member is: this id is handed to the resolvers that read the pack
 * filesystem.
 */
export function parseReplacedBy(raw: unknown, selfId: string): { value: string | null } | { error: string } {
  if (raw === null || raw === '') return { value: null };
  if (typeof raw !== 'string') return { error: 'replacedBy must be a catalog asset id, or null to clear it' };
  const id = raw.trim();
  if (!id) return { value: null };
  if (id.includes('..') || !ASSET_ID_RE.test(id) || id.length > 200) return { error: `bad asset id "${id}"` };
  if (id === selfId) return { error: 'an asset cannot replace itself' };
  return { value: id };
}
