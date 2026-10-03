/**
 * Retention (plans/35 wave 3) - bounded history, without giving up the two
 * things that make the history trustworthy.
 *
 * Telemetry is a dated delete and nothing more. Audit is where the design
 * work sits, because two invariants must hold through any trim:
 *
 *   1. TAMPER EVIDENCE. The chain verifies from genesis, so deleting old
 *      rows would break it - unless the boundary row's seq + hash are
 *      recorded first (the audit_anchor, migration 0025). The anchor is
 *      written BEFORE the delete; verifyChain starts from it; a trim
 *      interrupted between the two writes leaves a chain that still
 *      verifies. That ordering carries the correctness, not performance.
 *   2. DELIVERY. A trim never passes the SIEM cursor when forwarding is
 *      configured - nothing is deleted before the receiver confirmed it.
 *      An unreachable receiver therefore pauses audit retention rather
 *      than losing events, and the lw_siem_lag gauge says why.
 *
 * `retentionDays: 0` (the default, versionKeep's idiom) keeps everything -
 * an org states its policy; the product never assumes one.
 */
import type { BlobStore } from '../blobs/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { sweepExpiredProjectFiles } from '../projects/files.ts';
import type { Store } from '../store/types.ts';
import type { AuditEvent } from './chain.ts';

export interface RetentionResult {
  telemetryTrimmed: number;
  auditTrimmed: number;
  /** Expired unfinished project-file uploads removed (plans/74). Present only
   *  when the run was given the BlobStore their parts live in. */
  projectFilesSwept?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_BATCH = 500;

export async function runRetention(
  { config, store, blobs, now = () => new Date() }: { config: InstanceConfig; store: Store; blobs?: BlobStore; now?: () => Date },
): Promise<RetentionResult> {
  const { telemetryDays, auditDays } = config.policy.retention;
  const result: RetentionResult = { telemetryTrimmed: 0, auditTrimmed: 0 };

  // Not a policy choice: an expired upload is litter whatever the org keeps,
  // so this runs on every pass (a new reservation also sweeps a batch).
  if (blobs) result.projectFilesSwept = await sweepExpiredProjectFiles(store, blobs, { now: now().getTime(), limit: 500 });

  if (telemetryDays > 0) {
    const cutoff = new Date(now().getTime() - telemetryDays * DAY_MS).toISOString();
    result.telemetryTrimmed = await store.trimTelemetry(cutoff);
  }

  if (auditDays > 0) {
    const cutoff = new Date(now().getTime() - auditDays * DAY_MS).toISOString();
    const anchor = await store.getAuditAnchor();
    // Walk forward from the current anchor to the last row older than the
    // cutoff - batched, so retention never loads the whole log.
    let boundary: AuditEvent | null = null;
    let from = anchor?.seq ?? 0;
    scan: for (;;) {
      const batch = await store.listAuditAfter(from, SCAN_BATCH);
      if (!batch.length) break;
      for (const e of batch) {
        if (e.at >= cutoff) break scan;
        boundary = e;
      }
      from = (batch[batch.length - 1] as AuditEvent).seq;
    }
    if (boundary) {
      // Delivery before deletion: cap the trim at what the SIEM receiver
      // confirmed. The capped boundary must be a REAL row (the anchor's hash
      // has to be that row's), so re-resolve when the cursor is the cap.
      if (config.siem.url) {
        const cursor = await store.getSiemCursor();
        if (boundary.seq > cursor) {
          boundary = cursor > (anchor?.seq ?? 0)
            ? (await store.listAuditAfter(cursor - 1, 1))[0] ?? null
            : null;
          if (boundary && boundary.seq !== cursor) boundary = null;
        }
      }
      // The HEAD row is never trimmed, whatever the dates say: both drivers
      // continue the chain from the stored tail, so an emptied table would
      // restart seq at 1 against a higher anchor. One kept row on a quiet
      // instance is the cheap price of that invariant.
      if (boundary && !(await store.listAuditAfter(boundary.seq, 1)).length) {
        const prevSeq = boundary.seq - 1;
        boundary = prevSeq > (anchor?.seq ?? 0)
          ? (await store.listAuditAfter(prevSeq - 1, 1))[0] ?? null
          : null;
        if (boundary && boundary.seq !== prevSeq) boundary = null;
      }
      if (boundary) {
        await store.setAuditAnchor({ seq: boundary.seq, hash: boundary.hash });
        result.auditTrimmed = await store.trimAudit(boundary.seq);
      }
    }
  }

  return result;
}
