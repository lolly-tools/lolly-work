import { randomId } from '../lib/crypto.ts';
import type { AutomationCallbackSummary } from '../store/types.ts';
import type { RenderBatchRecord, RenderOutputExpiry, RenderRecord, RenderStore } from './types.ts';

/** The render store's two touch points with the rest of the memory store. */
export interface MemoryRenderStoreLinks {
  /** Store a callback outbox entry; one per subject, as Postgres keeps. */
  appendCallback(subject: { renderId?: string; renderBatchId?: string }, principal: string, url: string): void;
  callbackSummary(id: string): AutomationCallbackSummary | null;
  /** Whether a delivery names this render, which keeps its output. */
  deliveryNamesRender(id: string): boolean;
}

const TERMINAL: readonly RenderRecord['state'][] = ['succeeded', 'failed', 'cancelled'];
const expiry = (r: RenderRecord): RenderOutputExpiry => ({ id: r.id, ref: r.output!.ref, toolId: r.request.toolId, format: r.request.format });

export function createMemoryRenderStore(links?: MemoryRenderStoreLinks): RenderStore {
  const records = new Map<string, RenderRecord>();
  const batches = new Map<string, RenderBatchRecord>();
  const clone = structuredClone;
  /** Match Postgres: the write that makes a render, or the last row of a batch,
   *  terminal also stores the callback that announces it. */
  const finished = (rendered: RenderRecord[]): void => {
    for (const r of rendered) if (r.request.callbackUrl) links?.appendCallback({ renderId: r.id }, r.principal, r.request.callbackUrl);
    const ids = new Set(rendered.map((r) => r.id));
    for (const batch of batches.values()) {
      if (!batch.request.callbackUrl || !batch.rows.some((row) => ids.has(row.render.id))) continue;
      if (batch.rows.every((row) => TERMINAL.includes(records.get(row.render.id)!.state))) {
        links?.appendCallback({ renderBatchId: batch.id }, batch.principal, batch.request.callbackUrl);
      }
    }
  };
  const held = (id: string, token: string): RenderRecord | undefined => {
    const r = records.get(id);
    return r?.state === 'running' && r.leaseToken === token && Date.parse(r.leaseUntil!) > Date.now() ? r : undefined;
  };
  const clearLease = (r: RenderRecord): void => { delete r.leaseToken; delete r.leaseUntil; };
  const snapshot = (batch: RenderBatchRecord): RenderBatchRecord => clone({
    ...batch, rows: batch.rows.map((row) => ({ key: row.key, render: records.get(row.render.id)! })),
  });
  return {
    async insertRenderBatch(batch) {
      const existing = batch.idempotencyKey === undefined ? undefined : [...batches.values()]
        .find((b) => b.principal === batch.principal && b.idempotencyKey === batch.idempotencyKey);
      if (existing) return { record: snapshot(existing), reused: true };
      if (batches.has(batch.id)) throw new Error('duplicate batch id');
      if (batch.retryOf && batches.get(batch.retryOf)?.principal !== batch.principal) throw new Error('batch retry parent not found');
      const staged = new Map<string, RenderRecord>();
      const keys = new Set<string>();
      const ids = new Set<string>();
      if (!batch.rows.length || batch.rows.length > 200) throw new Error('invalid batch size');
      // Validate everything before exposing any child to a claiming worker.
      for (const { key, render } of batch.rows) {
        if (keys.has(key) || ids.has(render.id) || render.principal !== batch.principal) throw new Error('invalid batch membership');
        keys.add(key); ids.add(render.id);
        if (render.state === 'succeeded') {
          const old = records.get(render.id);
          if (old?.principal !== batch.principal || old.state !== 'succeeded') throw new Error('successful child not found');
        } else {
          if (render.state !== 'queued' || render.idempotencyKey !== undefined || records.has(render.id)) throw new Error('invalid new child');
          if (render.retryOf && records.get(render.retryOf)?.principal !== batch.principal) throw new Error('child retry parent not found');
          staged.set(render.id, clone(render));
        }
      }
      const saved = clone(batch);
      for (const [id, record] of staged) records.set(id, record);
      batches.set(batch.id, saved);
      return { record: snapshot(saved), reused: false };
    },
    async getRenderBatch(id, principal) {
      const batch = batches.get(id);
      return batch?.principal === principal ? snapshot(batch) : null;
    },
    async findRenderBatchByKey(principal, key) {
      const batch = [...batches.values()].find((b) => b.principal === principal && b.idempotencyKey === key);
      return batch ? snapshot(batch) : null;
    },
    async listRenderBatches(principal, limit, offset) {
      return [...batches.values()].filter((b) => b.principal === principal)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(offset, offset + limit).map(snapshot);
    },
    async cancelRenderBatch(id, principal) {
      const batch = batches.get(id); if (!batch || batch.principal !== principal) return null;
      const now = new Date().toISOString();
      const stopped: RenderRecord[] = [];
      for (const row of batch.rows) {
        const r = records.get(row.render.id)!;
        if (r.state === 'queued' || r.state === 'running') {
          r.state = 'cancelled'; r.updatedAt = r.finishedAt = now; clearLease(r);
          stopped.push(r);
        }
      }
      finished(stopped);
      return snapshot(batch);
    },
    async insertRender(record) {
      if (record.idempotencyKey !== undefined) {
        const existing = [...records.values()].find((r) => r.principal === record.principal && r.idempotencyKey === record.idempotencyKey);
        if (existing) return { record: clone(existing), reused: true };
      }
      if (records.has(record.id)) throw new Error('duplicate render id');
      records.set(record.id, clone(record));
      return { record: clone(record), reused: false };
    },
    async findRenderByKey(principal, key) {
      const existing = [...records.values()].find((r) => r.principal === principal && r.idempotencyKey === key);
      return existing ? clone(existing) : null;
    },
    async getRender(id, principal) {
      const r = records.get(id);
      return r?.principal === principal ? clone(r) : null;
    },
    async listRenders(principal, limit, offset) {
      return [...records.values()].filter((r) => r.principal === principal)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(offset, offset + limit).map((r) => clone(r));
    },
    async claimRender(leaseMs) {
      const now = Date.now();
      const ready = [...records.values()].filter((r) =>
        (r.state === 'queued' && Date.parse(r.availableAt) <= now) || (r.state === 'running' && Date.parse(r.leaseUntil!) <= now));
      const exhausted: RenderRecord[] = [];
      for (const r of ready) {
        if (r.attempt < r.request.maxAttempts) continue;
        r.state = 'failed'; r.updatedAt = r.finishedAt = new Date(now).toISOString();
        r.error = { code: 'ATTEMPTS_EXHAUSTED', message: 'render exhausted its attempts before completion' };
        clearLease(r);
        exhausted.push(r);
      }
      finished(exhausted);
      const r = ready.filter((r) => r.state !== 'failed').sort((a, b) =>
        b.request.priority - a.request.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
      if (!r) return null;
      r.state = 'running'; r.attempt++; r.leaseToken = randomId(16);
      r.leaseUntil = new Date(now + leaseMs).toISOString(); r.updatedAt = new Date(now).toISOString();
      delete r.error;
      return clone(r);
    },
    async heartbeatRender(id, token, leaseMs) {
      const r = held(id, token); if (!r) return false;
      r.leaseUntil = new Date(Date.now() + leaseMs).toISOString(); r.updatedAt = new Date().toISOString(); return true;
    },
    async settleRender(id, token, outcome) {
      const r = held(id, token); if (!r) return false;
      r.updatedAt = new Date().toISOString(); clearLease(r);
      if (outcome.state === 'succeeded') {
        r.state = 'succeeded'; r.output = clone(outcome.output); r.finishedAt = r.updatedAt; delete r.error;
      } else {
        r.error = clone(outcome.error);
        if (outcome.retryAfterMs !== undefined && r.attempt < r.request.maxAttempts) {
          r.state = 'queued'; r.availableAt = new Date(Date.now() + outcome.retryAfterMs).toISOString();
        } else { r.state = 'failed'; r.finishedAt = r.updatedAt; }
      }
      if (TERMINAL.includes(r.state)) finished([r]);
      return true;
    },
    async renderQueue() {
      const now = Date.now(), byTool = new Map<string, { queued: number; oldest: number }>();
      for (const r of records.values()) {
        if (r.state !== 'queued') continue;
        const entry = byTool.get(r.request.toolId) ?? { queued: 0, oldest: Infinity };
        entry.queued++;
        const at = Date.parse(r.availableAt);
        if (at <= now) entry.oldest = Math.min(entry.oldest, at);
        byTool.set(r.request.toolId, entry);
      }
      return [...byTool].sort(([a], [b]) => a.localeCompare(b)).map(([toolId, e]) => ({ toolId, queued: e.queued,
        oldestClaimableAt: Number.isFinite(e.oldest) ? new Date(e.oldest).toISOString() : null }));
    },
    async cancelRender(id, principal) {
      const r = records.get(id); if (!r || r.principal !== principal) return null;
      if (r.state === 'queued' || r.state === 'running') {
        r.state = 'cancelled'; r.updatedAt = r.finishedAt = new Date().toISOString(); clearLease(r);
        finished([r]);
      }
      return clone(r);
    },
    async renderCallbackSummary(id) { return links?.callbackSummary(id) ?? null; },
    async expireRenderOutputs(cutoff, expiredAt, limit) {
      const due = [...records.values()]
        .filter((r) => r.state === 'succeeded' && r.output && !r.output.expiredAt && r.finishedAt! < cutoff && !links?.deliveryNamesRender(r.id))
        .sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!) || a.id.localeCompare(b.id)).slice(0, limit);
      return due.map((r) => { r.output!.expiredAt = expiredAt; r.updatedAt = expiredAt; return expiry(r); });
    },
    async renderOutputsToPurge(markedBefore, limit) {
      const marked = [...records.values()].filter((r) => r.state === 'succeeded' && r.output?.expiredAt && !r.output.purgedAt);
      const ready: RenderRecord[] = [];
      for (const r of marked) {
        if (links?.deliveryNamesRender(r.id)) { delete r.output!.expiredAt; continue; }
        if (r.output!.expiredAt! < markedBefore) ready.push(r);
      }
      return ready.sort((a, b) => a.finishedAt!.localeCompare(b.finishedAt!) || a.id.localeCompare(b.id)).slice(0, limit).map(expiry);
    },
    async markRenderOutputPurged(id) {
      const r = records.get(id);
      if (r?.output) r.output.purgedAt = new Date().toISOString();
    },
  };
}
