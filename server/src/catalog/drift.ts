/**
 * Drift report (plans/33 §2b) - has anything changed upstream since I
 * materialized it? The question a platform team asks on every cadence check of
 * a staged exit, answered from stamps that already exist: materialize writes
 * `sourceUpdatedAt` (the upstream `updatedAt` at copy time) and `materializedAt`
 * into each instance asset's `origin` (catalog/materialize.ts), and the current
 * provider fragment carries today's `updatedAt` per federated id.
 *
 * Pure comparison, no I/O: the caller supplies the fragment it already has and
 * the instance assets from the store. Nothing here writes, and nothing here
 * re-materializes - the report names the remedy and a human runs it.
 */
import { extAssetId } from './providers/types.ts';
import type { InstanceAssetRecord } from './instance-assets.ts';
import type { AssetIndexEntry } from './lifecycle.ts';

export interface DriftedAsset {
  /** The instance-owned copy that has fallen behind (`inst/…`). */
  id: string;
  remoteId: string;
  /** Upstream `updatedAt` as it stood when the copy was made; null when the
   *  upstream record carried no timestamp then (the comparison falls back to
   *  `materializedAt`, which is what the off-boarding guides describe). */
  sourceUpdatedAt: string | null;
  materializedAt: string;
  /** Upstream `updatedAt` now, off the current fragment. */
  upstreamUpdatedAt: string;
}

export interface DriftReport {
  provider: string;
  /** Materialized copies belonging to this provider. */
  materialized: number;
  /** How many of those the fragment could actually be compared against - every
   *  copy counted here got a real answer, drifted or not. The three ways a copy
   *  drops out of it are counted separately below, because "cannot tell" must
   *  never read as "unchanged". */
  compared: number;
  drifted: DriftedAsset[];
  /** Copies whose remote id is in the current fragment but whose upstream
   *  record carries no readable change stamp at all - the driver's
   *  `UPDATED_AT_KEYS` guess, or an upstream that stamps nothing. */
  unstamped: number;
  /** Copies whose stamp is there but will not parse as a date, on either side.
   *  Counted apart from `compared` so a non-ISO upstream cannot report a clean
   *  bill of health for a provider whose drift detection is inoperative. */
  unparsable: number;
  /** Those stamps as a format skeleton (digits as N, letters as A), deduped -
   *  enough to recognise the format without carrying a value. */
  unparsableShapes: string[];
  /** Copies compared through a stamp that does NOT pin its own instant (no `Z`,
   *  no offset, no named zone). These ARE counted in `compared` - a best-effort
   *  answer beats none - but the parse falls back to the SERVER's timezone, so
   *  the answer can be off by its UTC offset. Reported so a near-miss is never
   *  read as exact. */
  timezoneless: number;
  /** Shapes of those stamps, same rules as `unparsableShapes`. */
  timezonelessShapes: string[];
  /** Copies whose remote id is no longer in the current listing at all. */
  missingUpstream: number;
  /** Remote ids in the current fragment with no materialized copy at all. */
  neverMaterialized: string[];
}

/** Strictly newer, by parsed instant, or `null` for "cannot tell" when a stamp
 *  on either side will not parse. Never `false` in that case: a false positive
 *  would send an operator re-materializing for nothing, and a false negative
 *  would hide a provider whose drift detection does not work at all. */
function isNewer(upstream: string, baseline: string): boolean | null {
  const a = Date.parse(upstream);
  const b = Date.parse(baseline);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return a > b;
}

/** A stamp's shape rather than its value: digits collapse to `N`, letters to
 *  `A`, punctuation stays. `01/06/2026 10:00` reports as `NN/NN/NNNN NN:NN`,
 *  which names the format an operator has to teach the driver about without
 *  putting an upstream value in a report. */
export function stampShape(stamp: string): string {
  // One pass: replacing digits first and letters second would turn every N back
  // into an A, which is how a shape stops being a shape.
  return stamp.slice(0, 40).replace(/[0-9A-Za-z]/g, (c) => (c >= '0' && c <= '9' ? 'N' : 'A'));
}

/** A trailing `Z`, a numeric offset or a named zone; or a bare ISO date, which
 *  the language spec reads as UTC. Anything else that still parses does so in
 *  the SERVER's timezone, which is a comparison against an ISO baseline that
 *  can be off by the offset - true, and worth saying out loud. */
const ZONED = /(?:Z|[+-]\d{2}:?\d{2}|\b(?:GMT|UTC|UT)\b)$/i;
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export function pinsItsOwnInstant(stamp: string): boolean {
  const s = stamp.trim();
  return ZONED.test(s) || ISO_DATE_ONLY.test(s);
}

/** Compare a provider's materialized copies against its current fragment.
 *  `fragment` is the mapped entry list (ids are `ext/<provider>/<remoteId>`);
 *  `instanceAssets` may be the whole store - entries from other providers are
 *  ignored. */
export function providerDrift(
  providerId: string,
  fragment: AssetIndexEntry[],
  instanceAssets: InstanceAssetRecord[],
): DriftReport {
  const upstream = new Map<string, AssetIndexEntry>();
  const prefix = extAssetId(providerId, '');
  for (const entry of fragment) {
    if (!entry.id.startsWith(prefix)) continue;
    upstream.set(entry.id.slice(prefix.length), entry);
  }

  const mine = instanceAssets.filter((r) => r.origin?.provider === providerId);
  const drifted: DriftedAsset[] = [];
  const held = new Set<string>();
  const shapes = new Set<string>();
  const looseShapes = new Set<string>();
  let compared = 0;
  let unstamped = 0;
  let unparsable = 0;
  let timezoneless = 0;
  let missingUpstream = 0;
  for (const rec of mine) {
    const origin = rec.origin;
    if (!origin) continue;
    held.add(origin.remoteId);
    const entry = upstream.get(origin.remoteId);
    if (!entry) { missingUpstream++; continue; } // gone from the listing: nothing to compare
    // `updatedAt` rides the entry's open index signature, so narrow it here.
    const stamp = entry.updatedAt;
    const now = typeof stamp === 'string' && stamp ? stamp : undefined;
    if (!now) { unstamped++; continue; } // an upstream that stamps nothing we can read
    // The stamp taken at copy time is the honest baseline. Without one, fall
    // back to when the copy was made - the phrasing the guides already use.
    const baseline = origin.sourceUpdatedAt ?? origin.materializedAt;
    const newer = isNewer(now, baseline);
    if (newer === null) {
      // Cannot tell, and it must not read as "unchanged": report a skeleton of
      // whichever side would not parse so the operator can name the format.
      unparsable++;
      for (const s of [now, baseline]) if (Number.isNaN(Date.parse(s))) shapes.add(stampShape(s));
      continue;
    }
    compared++;
    // Parsed, but not necessarily where the tenant meant: a stamp with no zone
    // is read in the server's, so say which shapes that applied to.
    for (const s of [now, baseline]) if (!pinsItsOwnInstant(s)) { timezoneless++; looseShapes.add(stampShape(s)); break; }
    if (!newer) continue;
    drifted.push({
      id: rec.id,
      remoteId: origin.remoteId,
      sourceUpdatedAt: origin.sourceUpdatedAt ?? null,
      materializedAt: origin.materializedAt,
      upstreamUpdatedAt: now,
    });
  }

  return {
    provider: providerId,
    materialized: mine.length,
    compared,
    drifted,
    unstamped,
    unparsable,
    unparsableShapes: [...shapes].sort(),
    timezoneless,
    timezonelessShapes: [...looseShapes].sort(),
    missingUpstream,
    neverMaterialized: [...upstream.keys()].filter((remoteId) => !held.has(remoteId)),
  };
}
