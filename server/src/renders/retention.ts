// SPDX-License-Identifier: MPL-2.0
/**
 * Optional retention for durable render outputs (`policy.retention.renderOutputDays`,
 * 0 keeps everything, the default). The bytes go and the record stays: the
 * request, the receipt and the identity still say what was made.
 *
 * Two steps, a pass apart. A pass marks an output expired, and from then on it is
 * no longer served or delivered. A later pass removes the bytes of what was marked
 * at least `graceMs` ago. The gap closes the race with a delivery that read the
 * output just before the mark: its record is committed by the time bytes are about
 * to go, and a delivery that names a render clears the mark and keeps them.
 * A pass that stops between removing bytes and recording that simply repeats, since
 * removing a missing blob changes nothing.
 */
import type { BlobStore } from '../blobs/types.ts';
import type { Store } from '../store/types.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 500;
const SWEEP_ROUNDS = 20;
/** A delivery that read an output before it was marked has long finished by then. */
const PURGE_GRACE_MS = 60 * 60 * 1000;

export type RenderRetentionStore = Pick<Store, 'expireRenderOutputs' | 'renderOutputsToPurge' | 'markRenderOutputPurged' | 'appendAudit'>;

export interface RenderOutputSweepOptions {
  store: RenderRetentionStore;
  blobs: BlobStore;
  days: number;
  now?: () => Date;
  graceMs?: number;
  limit?: number;
}

/** One bounded pass. Returns how many outputs were marked and how many lost their bytes. */
export async function sweepRenderOutputs({ store, blobs, days, now = () => new Date(), graceMs = PURGE_GRACE_MS, limit = SWEEP_BATCH }: RenderOutputSweepOptions): Promise<{ expired: number; purged: number }> {
  if (!(days > 0)) return { expired: 0, purged: 0 };
  const at = now().getTime();
  let purged = 0;
  for (const output of await store.renderOutputsToPurge(new Date(at - graceMs).toISOString(), limit)) {
    await blobs.delete(output.ref);
    await store.markRenderOutputPurged(output.id);
    purged++;
  }
  const expiredAt = new Date(at).toISOString();
  const expired = await store.expireRenderOutputs(new Date(at - days * DAY_MS).toISOString(), expiredAt, limit);
  for (const output of expired) {
    await store.appendAudit({ at: expiredAt, actor: 'system', action: 'render.output.expire', subject: `render:${output.id}`,
      payload: { toolId: output.toolId, format: output.format, retentionDays: days } });
  }
  return { expired: expired.length, purged };
}

/** Boot and daily, on the long-lived server only. Nothing is scheduled while retention is off. */
export function scheduleRenderOutputSweep(
  store: RenderRetentionStore, blobs: BlobStore, days: number,
  { intervalMs = DAY_MS, log = console }: { intervalMs?: number; log?: Pick<Console, 'log' | 'error'> } = {},
): { first: Promise<void>; stop: () => void } {
  if (!(days > 0)) return { first: Promise.resolve(), stop: () => {} };
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let expired = 0, purged = 0;
      for (let round = 0; round < SWEEP_ROUNDS; round++) {
        const result = await sweepRenderOutputs({ store, blobs, days });
        expired += result.expired; purged += result.purged;
        if (result.expired < SWEEP_BATCH && result.purged < SWEEP_BATCH) break;
      }
      if (expired || purged) log.log(`[lolly-work] render output retention: ${expired} expired, ${purged} removed`);
    } catch (error) {
      log.error(`[lolly-work] render output retention failed: ${(error as Error).message}`);
    } finally { running = false; }
  };
  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref();
  return { first: pass(), stop: () => clearInterval(timer) };
}
