import { canonicalJson, randomId, sha256Hex } from '../lib/crypto.ts';
import { checkInputs, newRender, parseRenderSpec, renderWire } from './request.ts';
import { RenderResourceError, type RenderBatchBinding, type RenderBatchRecord, type RenderBatchSpec, type RenderRecord, type RenderSpec } from './types.ts';

function invalid(message: string): never { throw new RenderResourceError('INVALID_INPUT', 400, message); }

/** A row's own request. The callback and the data source stay on the parent. */
export function batchRowRequest(request: RenderBatchSpec, inputs: Record<string, unknown>): RenderSpec {
  const { rows: _rows, bind: _bind, callbackUrl: _callbackUrl, ...base } = request;
  return { ...base, inputs: { ...base.inputs, ...inputs } };
}

const ROW_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
export const MAX_ROWS = 200;

/** Shape only: whether the source resolves, and for whom, is decided at submission. */
export function parseBatchBinding(value: unknown): RenderBatchBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('bind must be an object');
  const bind = value as Record<string, unknown>;
  for (const key of Object.keys(bind)) if (!['source', 'query', 'as', 'keyField'].includes(key)) invalid(`unknown bind field: ${key}`);
  if (typeof bind.source !== 'string' || !bind.source || bind.source.length > 2048) invalid('bind.source must be a provider reference');
  for (const key of ['query', 'as'] as const) {
    const part = bind[key];
    if (part === undefined) continue;
    if (!part || typeof part !== 'object' || Array.isArray(part)) invalid(`bind.${key} must be an object`);
    checkInputs(part);
  }
  if (bind.keyField !== undefined && (typeof bind.keyField !== 'string' || !bind.keyField || bind.keyField.length > 200)) invalid('bind.keyField must name a column');
  return {
    source: bind.source,
    ...(bind.query ? { query: structuredClone(bind.query) as Record<string, unknown> } : {}),
    ...(bind.as ? { as: structuredClone(bind.as) as Record<string, unknown> } : {}),
    ...(bind.keyField !== undefined ? { keyField: bind.keyField as string } : {}),
  };
}

function bindingError(message: string): never { throw new RenderResourceError('DATA_BINDING_ERROR', 400, message); }

/** Turn rows from a data source into batch rows. A row with no key column is numbered in source order. */
export function rowsFromBinding(rows: Record<string, unknown>[], keyField?: string): RenderBatchSpec['rows'] {
  if (rows.length < 1 || rows.length > MAX_ROWS) bindingError(`data source returned ${rows.length} rows; a render batch takes 1 to ${MAX_ROWS}`);
  const seen = new Set<string>();
  return rows.map((row, index) => {
    if (keyField === undefined) return { key: `row-${index + 1}`, inputs: row };
    const { [keyField]: value, ...inputs } = row;
    const key = typeof value === 'number' ? String(value) : value;
    if (typeof key !== 'string' || !ROW_KEY.test(key)) bindingError(`data row ${index} has no usable ${keyField}: a key is 1 to 80 letters, digits, underscores or hyphens, starting with a letter or digit`);
    if (seen.has(key)) bindingError(`data row ${index} repeats the key ${key}`);
    seen.add(key);
    return { key, inputs };
  });
}

/** What makes two submissions the same request. A bound batch is named by its
 *  source, not by what the source held, so a replay still matches after the data moves on. */
export function batchRequestHash(request: RenderBatchSpec, retryOf?: string): string {
  const { rows: _rows, ...source } = request;
  return sha256Hex(canonicalJson({ request: request.bind ? source : request, retryOf: retryOf ?? null }));
}

/** Bound the expanded requests as well as the HTTP body: shared inputs multiply per row. */
export function parseRenderBatchSpec(value: unknown): RenderBatchSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('JSON object required');
  const { rows, bind, ...base } = value as Record<string, unknown>;
  const binding = bind === undefined ? undefined : parseBatchBinding(bind);
  const request = parseRenderSpec(base);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS) invalid('rows must contain 1–200 entries');
  const keys = new Set<string>();
  let bytes = 0;
  const parsed = rows.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid('each row must be an object');
    const r = row as Record<string, unknown>;
    if (Object.keys(r).some((k) => k !== 'key' && k !== 'inputs')) invalid('rows accept only key and inputs');
    if (typeof r.key !== 'string' || !ROW_KEY.test(r.key)) invalid('row key must be 1–80 letters, digits, underscores or hyphens, starting with a letter or digit');
    if (keys.has(r.key)) invalid(`duplicate row key: ${r.key}`);
    keys.add(r.key);
    const inputs = parseRenderSpec({ ...request, inputs: r.inputs }).inputs;
    const expanded = parseRenderSpec({ ...request, inputs: { ...request.inputs, ...inputs } });
    bytes += Buffer.byteLength(canonicalJson(expanded));
    if (bytes > 2_000_000) invalid('expanded batch requests exceed 2 MB');
    return { key: r.key, inputs };
  });
  return { ...request, rows: parsed, ...(binding ? { bind: binding } : {}) };
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
    requestHash: batchRequestHash(request, previous?.id),
    ...(key !== undefined ? { idempotencyKey: key } : {}), ...(previous ? { retryOf: previous.id } : {}),
    createdAt: new Date().toISOString(),
    rows: request.rows.map((row) => {
      const old = prior.get(row.key);
      // A row whose output has expired has nothing left to reuse.
      return { key: row.key, render: old?.state === 'succeeded' && !old.output?.expiredAt
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
    archiveUrl: `/api/v1/render-batches/${batch.id}/archive`,
    ...(!summary ? { rows: rows.map(({ key, render }) => ({ key, ...renderWire(render) })) } : {}),
  };
}
