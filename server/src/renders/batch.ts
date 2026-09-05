import { canonicalJson, randomId, sha256Hex } from '../lib/crypto.ts';
import { newRender, parseRenderSpec, renderWire } from './request.ts';
import { RenderResourceError, type RenderBatchRecord, type RenderBatchSpec, type RenderRecord, type RenderSpec } from './types.ts';

function invalid(message: string): never { throw new RenderResourceError('INVALID_INPUT', 400, message); }

export function batchRowRequest(request: RenderBatchSpec, inputs: Record<string, unknown>): RenderSpec {
  const { rows: _rows, ...base } = request;
  return { ...base, inputs: { ...base.inputs, ...inputs } };
}

/** Bound the expanded requests as well as the HTTP body: shared inputs multiply per row. */
export function parseRenderBatchSpec(value: unknown): RenderBatchSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('JSON object required');
  const { rows, ...base } = value as Record<string, unknown>;
  const request = parseRenderSpec(base);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 200) invalid('rows must contain 1–200 entries');
  const keys = new Set<string>();
  let bytes = 0;
  const parsed = rows.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('each row must be an object');
    const r = row as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== 'key' && k !== 'inputs')) invalid('rows accept only key and inputs');
    if (typeof r.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(r.key)) invalid('row key must be 1–80 letters, digits, underscores or hyphens, starting with a letter or digit');
    if (keys.has(r.key)) invalid(`duplicate row key: ${r.key}`);
    keys.add(r.key);
    const inputs = parseRenderSpec({ ...request, inputs: r.inputs }).inputs;
    const expanded = parseRenderSpec({ ...request, inputs: { ...request.inputs, ...inputs } });
    bytes += Buffer.byteLength(canonicalJson(expanded));
    if (bytes > 2_000_000) invalid('expanded batch requests exceed 2 MB');
    return { key: r.key, inputs };
  });
  return { ...request, rows: parsed };
}

export function batchProgress(batch: RenderBatchRecord) {
  const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of batch.rows) counts[row.render.state]++;
  const done = counts.succeeded + counts.failed + counts.cancelled;
  const total = batch.rows.length;
  const terminal = done === total;
  const state: RenderRecord['state'] = terminal
    ? counts.failed ? 'failed' : counts.cancelled ? 'cancelled' : 'succeeded'
    : counts.running || done || batch.rows.some((r) => r.render.attempt > 0) ? 'running' : 'queued';
  const updatedAt = batch.rows.reduce((at, row) => row.render.updatedAt > at ? row.render.updatedAt : at, batch.createdAt);
  const finishedAt = terminal ? batch.rows.reduce((at, row) => row.render.finishedAt! > at ? row.render.finishedAt! : at, batch.createdAt) : undefined;
  return { state, progress: { total, done, ...counts }, updatedAt, ...(finishedAt ? { finishedAt } : {}) };
}

export function newRenderBatch(principal: string, request: RenderBatchSpec, key?: string, previous?: RenderBatchRecord): RenderBatchRecord {
  // Keep the same header validation as individual requests.
  newRender(principal, batchRowRequest(request, {}), key);
  if (previous) {
    const { progress } = batchProgress(previous);
    if (previous.principal !== principal || progress.done !== progress.total || !(progress.failed + progress.cancelled)) {
      throw new RenderResourceError('BATCH_NOT_RETRYABLE', 409, 'retry requires a completed batch with failed or cancelled rows');
    }
  }
  const prior = new Map(previous?.rows.map((r) => [r.key, r.render]));
  return {
    id: `rbt_${randomId(16)}`, principal, request: structuredClone(request),
    requestHash: sha256Hex(canonicalJson({ request, retryOf: previous?.id ?? null })),
    ...(key !== undefined ? { idempotencyKey: key } : {}), ...(previous ? { retryOf: previous.id } : {}),
    createdAt: new Date().toISOString(),
    rows: request.rows.map((row) => {
      const old = prior.get(row.key);
      return { key: row.key, render: old?.state === 'succeeded'
        ? structuredClone(old) : newRender(principal, batchRowRequest(request, row.inputs), undefined, old?.id) };
    }),
  };
}

/** No private blob references or lease credentials leave this projection. */
export function batchWire(batch: RenderBatchRecord, summary = false): Record<string, unknown> {
  const { principal: _principal, rows, request, ...rest } = batch;
  return {
    ...rest, ...batchProgress(batch),
    request: summary ? { toolId: request.toolId, format: request.format } : request,
    statusUrl: `/api/v1/render-batches/${batch.id}`,
    manifestUrl: `/api/v1/render-batches/${batch.id}/manifest`,
    ...(!summary ? { rows: rows.map(({ key, render }) => ({ key, ...renderWire(render) })) } : {}),
  };
}
