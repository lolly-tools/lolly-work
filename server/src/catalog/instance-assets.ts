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

/**
 * Where a SUBMITTED instance asset stands (plans/31 section 3). Absent on a
 * materialized (exit) asset, which never went through the submit pipeline.
 *  - `submitted` - stored, gated by an approval chain, invisible in the feed.
 *  - `live` - servable; this is the immediate state when no chain is configured.
 *  - `returned` - rejected with a comment; the bytes stay, the feed does not.
 */
export type SubmissionState = 'submitted' | 'live' | 'returned';

export interface AssetSubmission {
  state: SubmissionState;
  /** 'user:<id>' who submitted it. */
  by: string;
  /** ISO instant the bytes were stored. */
  at: string;
  /** sha256 hex of the submitted bytes - the duplicate short-circuit key. */
  checksum: string;
  size: number;
  /** Sniffed container type and pixel dimensions, when the bytes declare them. */
  contentType?: string;
  width?: number;
  height?: number;
  /** The approval opened for this submission, when policy names a submit chain. */
  approvalId?: string;
  /** 'user:<id>' who approved or returned it, and when. */
  decidedBy?: string;
  decidedAt?: string;
  /** The reviewer's comment, carried onto a return so the submitter reads why. */
  comment?: string;
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
  /** Set only on an asset that arrived through the submit pipeline (plans/31
   *  section 3). Its absence means "not a submission", never "a pending one". */
  submission?: AssetSubmission;
  /**
   * The version this asset SERVES (plans/31 section 6). Absent means the asset
   * has never been versioned and reads as version 1 - its `entry` + `blobs` ARE
   * version 1 - which is what lets migration 0020 ship with no data backfill.
   * The head lives here rather than as a flag on a version row so that two
   * heads are unrepresentable and a rollback is one record write.
   */
  headVersion?: number;
  /**
   * The highest version number ever minted for this asset. It is NOT
   * `max(rows)`: deleting a version (retention, or an explicit delete) leaves a
   * hole, and re-using its number would hand a different set of bytes to
   * anyone still holding its `?v=N` URL. Absent on an asset that has never been
   * versioned, where the head answers the question.
   */
  versionSeq?: number;
  createdAt: string;
}

/** Whether an instance asset may be served at all: a submission is servable
 *  only once it is live, and everything that never went through submit
 *  (materialized copies, exits) always is. The feed and the blob routes ask
 *  this, so a pending or returned submission can never leak through either. */
export function submissionServable(rec: InstanceAssetRecord): boolean {
  return !rec.submission || rec.submission.state === 'live';
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
 *  come from the local pin via the ext blob route). A submission that is not
 *  yet live composes into nothing at all (plans/31 section 3). Lifecycle +
 *  credentials fold over the combined set. */
export function composeInstanceAssets(index: AssetIndex, records: InstanceAssetRecord[], callerGroups: string[]): AssetIndex {
  const exited = records.filter((r) => r.exited);
  if (!exited.length && records.every((r) => r.origin)) return index; // only pins/no exits → feed unchanged
  const shadowed = new Set(exited.filter((r) => r.origin).map((r) => `${EXT_PREFIX}${r.origin!.provider}/${r.origin!.remoteId}`));
  const kept = (index.assets ?? []).filter((e) => !shadowed.has(e.id));
  // Exited assets substitute their entry; instance assets with no origin (a
  // plans/26 catalog submit) are ordinary feed members and always compose in.
  const composable = records
    .filter((r) => (r.exited || !r.origin) && submissionServable(r) && instanceAssetVisible(r, callerGroups))
    .map((r) => r.entry);
  if (!shadowed.size && !composable.length) return index;
  return { ...index, assets: [...kept, ...composable] };
}

/** Prefix a federated asset id carries - mirrors providers/types EXT_PREFIX
 *  without importing the driver module into this pure catalog helper. */
const EXT_PREFIX = 'ext/';

/**
 * Combined content hash of all instance-asset entries - folded into the render
 * cache key's `catalogVersion` so a new, changed or ROLLED-BACK instance asset
 * ripples render invalidation like a pack or provider change (plans/31 §6).
 *
 * Content-derived rather than a counter, deliberately: two plane nodes that
 * each recompute it arrive at the same string, where two counters would drift.
 * The served version rides in it as well as the format checksums, so a head
 * move is visible even in the corner where two versions hold identical bytes.
 */
export function instanceAssetsFingerprint(records: InstanceAssetRecord[]): string {
  return records
    .map((r) => `${r.id}@${r.headVersion ?? 1}:${(r.entry.formats ?? []).map((f) => (f as { checksum?: string }).checksum ?? '').join(',')}`)
    .sort()
    .join('|');
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
