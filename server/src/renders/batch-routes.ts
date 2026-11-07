import { readJson, sendError, sendJson, type createRouter, type Handler } from '../api/router.ts';
import { INERT_BYTE_HEADERS } from '../api/file-delivery.ts';
import { RENDER_ARCHIVE_MAX_BYTES, archivePlan, writeBatchArchive } from './archive.ts';
import { batchProgress, batchRequestHash, batchWire, newRenderBatch, parseBatchBinding, parseRenderBatchSpec, rowsFromBinding } from './batch.ts';
import { assertCallbackAllowed, parseRenderSpec } from './request.ts';
import { principalFor, type RoutesDeps } from './routes.ts';
import { RenderResourceError, type RenderBatchRecord, type RenderBatchSpec } from './types.ts';

export function registerRenderBatchRoutes(router: Pick<ReturnType<typeof createRouter>, 'add'>, deps: RoutesDeps): void {
  const { store } = deps;
  const principalOf = principalFor(deps);
  const add = (method: string, path: string, handler: (principal: string, ...args: Parameters<Handler>) => Promise<void>, options: { outputToken?: boolean; personPrivate?: boolean } = {}): void => {
    router.add(method, `/api/v1/render-batches${path}`, async (req, res, ctx) => {
      try {
        const principal = await principalOf(req, options.outputToken ? ctx.params.id : undefined);
        if (!principal) return sendError(res, 401, 'UNAUTHORIZED', 'an authenticated user or service token is required');
        await handler(principal, req, res, ctx);
      } catch (e) {
        if (e instanceof RenderResourceError) {
          if (e.retryAfterSec !== undefined) res.setHeader('retry-after', String(e.retryAfterSec));
          return sendError(res, e.status, e.code, e.message, e.detail);
        }
        throw e;
      }
    }, options.personPrivate ? { delivery: 'person-private' } : undefined);
  };
  const find = async (id: string, principal: string): Promise<RenderBatchRecord> => {
    const batch = await store.getRenderBatch(id, principal);
    if (!batch) throw new RenderResourceError('NOT_FOUND', 404, 'render batch not found');
    return batch;
  };
  const submit = async (batch: RenderBatchRecord) => {
    if (!deps.kick) throw new RenderResourceError('RENDER_RUNNER_UNAVAILABLE', 503, 'durable batches require the long-lived server');
    await deps.authorize(batch.principal, batch.request);
    assertCallbackAllowed(batch.request, deps.callbackAllowed);
    // Reusing a successful row keeps its exact bytes. Only new attempts need current input validation.
    for (const row of batch.rows) {
      if (row.render.state !== 'queued') continue;
      try { await deps.validate(batch.principal, row.render.request); }
      catch (e) {
        if (e instanceof RenderResourceError) throw new RenderResourceError(e.code, e.status, `row ${row.key}: ${e.message}`);
        throw e;
      }
    }
    // Every new row is counted at once, and a batch the budget cannot hold is
    // refused whole. A row a retry reuses ran before and counts nothing now.
    const batchKey = batch.idempotencyKey;
    const giveBack = await deps.chargeRenders?.(batch.principal, batch.rows.filter((row) => row.render.state === 'queued').length,
      batchKey === undefined ? undefined : async () => !!(await store.findRenderBatchByKey(batch.principal, batchKey)));
    let saved: { record: RenderBatchRecord; reused: boolean };
    try { saved = await store.insertRenderBatch(batch); }
    catch (error) { await giveBack?.(); throw error; }
    if (saved.reused) await giveBack?.();
    if (saved.record.requestHash !== batch.requestHash) throw new RenderResourceError('IDEMPOTENCY_KEY_REUSED', 409, 'Idempotency-Key already identifies a different batch request');
    if (!saved.reused) await deps.audit(batch.principal, batch.retryOf ? 'render.batch.retry' : 'render.batch.create', saved.record.id,
      { toolId: batch.request.toolId, format: batch.request.format, rows: batch.rows.length, ...(batch.retryOf ? { retryOf: batch.retryOf } : {}) });
    deps.kick();
    return saved;
  };
  const key = (req: Parameters<Handler>[0]): string | undefined => {
    const value = req.headers['idempotency-key'];
    if (Array.isArray(value)) throw new RenderResourceError('INVALID_INPUT', 400, 'one Idempotency-Key required');
    return value;
  };

  /** A bound batch's rows, read once at submission. The source is read only for a
   *  caller who holds the grants, and not at all for a replay of a batch that exists. */
  const boundRequest = async (principal: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<{ replay: RenderBatchRecord } | { spec: RenderBatchSpec }> => {
    const { bind, rows, ...base } = body;
    if (rows !== undefined) throw new RenderResourceError('INVALID_INPUT', 400, 'a batch takes rows or bind, not both');
    const binding = parseBatchBinding(bind);
    const request = parseRenderSpec(base);
    await deps.authorize(principal, request);
    if (idempotencyKey !== undefined) {
      const existing = await store.findRenderBatchByKey(principal, idempotencyKey);
      if (existing) {
        if (existing.requestHash !== batchRequestHash({ ...request, bind: binding, rows: [] })) throw new RenderResourceError('IDEMPOTENCY_KEY_REUSED', 409, 'Idempotency-Key already identifies a different batch request');
        return { replay: existing };
      }
    }
    if (!deps.resolveBinding) throw new RenderResourceError('DATA_BINDING_ERROR', 400, 'this deployment cannot read data sources');
    let resolved: Record<string, unknown>[];
    try { resolved = await deps.resolveBinding(principal, request, binding); }
    catch (e) {
      if (e instanceof RenderResourceError) throw e;
      throw new RenderResourceError('DATA_BINDING_ERROR', 400, (e as Error).message);
    }
    return { spec: parseRenderBatchSpec({ ...base, bind: binding, rows: rowsFromBinding(resolved, binding.keyField) }) };
  };

  add('POST', '', async (principal, req, res) => {
    const body = await readJson(req) as Record<string, unknown> | null;
    const idempotencyKey = key(req);
    const request = body && typeof body === 'object' && !Array.isArray(body) && body.bind !== undefined
      ? await boundRequest(principal, body, idempotencyKey) : { spec: parseRenderBatchSpec(body) };
    const saved = 'replay' in request
      ? { record: request.replay, reused: true }
      : await submit(newRenderBatch(principal, request.spec, idempotencyKey));
    sendJson(res, saved.reused ? 200 : 202, batchWire(saved.record), { location: `/api/v1/render-batches/${saved.record.id}` });
  });
  add('GET', '', async (principal, _req, res, ctx) => {
    const limit = Number(ctx.url.searchParams.get('limit') ?? 10);
    const offset = Number(ctx.url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new RenderResourceError('INVALID_INPUT', 400, 'limit must be 1–20 and offset a non-negative integer');
    }
    const page = await store.listRenderBatches(principal, limit, offset);
    const visible = [];
    for (const batch of page) {
      try { await deps.authorize(principal, batch.request); visible.push(batchWire(batch, true)); }
      catch (e) { if (!(e instanceof RenderResourceError && e.status === 403)) throw e; }
    }
    sendJson(res, 200, { batches: visible, nextOffset: page.length === limit ? offset + limit : null });
  });
  add('GET', '/:id', async (principal, _req, res, ctx) => {
    const batch = await find(ctx.params.id!, principal);
    await deps.authorize(principal, batch.request);
    const callback = await store.renderCallbackSummary(batch.id);
    sendJson(res, 200, { ...batchWire(batch), ...(callback ? { callback } : {}) });
  });
  add('GET', '/:id/manifest', async (principal, _req, res, ctx) => {
    const batch = await find(ctx.params.id!, principal);
    await deps.authorize(principal, batch.request);
    sendJson(res, 200, { manifestVersion: 1, ...batchWire(batch) }, {
      'content-disposition': `attachment; filename="${batch.id}.json"`, 'cache-control': 'private, no-store',
    });
  }, { outputToken: true });
  add('GET', '/:id/archive', async (principal, _req, res, ctx) => {
    const batch = await find(ctx.params.id!, principal);
    await deps.authorize(principal, batch.request);
    const { progress } = batchProgress(batch);
    if (progress.done !== progress.total) throw new RenderResourceError('BATCH_NOT_FINISHED', 409, 'the archive is available once every row has finished');
    const plan = archivePlan(batch);
    if (!plan.members) throw new RenderResourceError('BATCH_HAS_NO_OUTPUT', 409, 'no row of this batch has an output to archive');
    if (plan.bytes > RENDER_ARCHIVE_MAX_BYTES) throw new RenderResourceError('ARCHIVE_TOO_LARGE', 413, `this batch holds ${plan.bytes} bytes, more than one archive carries; download the rows from their own output URLs`);
    res.writeHead(200, { ...INERT_BYTE_HEADERS, 'content-type': 'application/zip', 'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="${batch.id}.zip"` });
    // The status has gone out, so a failure from here closes the connection. A
    // truncated ZIP has no central directory, and no extractor mistakes it for a whole one.
    try {
      await writeBatchArchive(batch, deps.blobs, (chunk) => new Promise<boolean>((resolve) => {
        if (res.destroyed) return resolve(false);
        if (res.write(chunk)) return resolve(true);
        const done = (): void => { res.off('drain', done); res.off('close', done); resolve(!res.destroyed); };
        res.once('drain', done); res.once('close', done);
      }));
      res.end();
    } catch { res.destroy(); }
  }, { outputToken: true, personPrivate: true });
  add('DELETE', '/:id', async (principal, _req, res, ctx) => {
    const batch = await store.cancelRenderBatch(ctx.params.id!, principal);
    if (!batch) throw new RenderResourceError('NOT_FOUND', 404, 'render batch not found');
    if (!batchProgress(batch).progress.cancelled) throw new RenderResourceError('BATCH_TERMINAL', 409, 'completed batch history is retained');
    for (const row of batch.rows) if (row.render.state === 'cancelled') deps.cancel?.(row.render.id);
    deps.callbacksChanged?.();
    await deps.audit(principal, 'render.batch.cancel', batch.id, {});
    sendJson(res, 200, batchWire(batch));
  });
  add('POST', '/:id/retry', async (principal, req, res, ctx) => {
    const old = await find(ctx.params.id!, principal);
    const saved = await submit(newRenderBatch(principal, old.request, key(req), old));
    sendJson(res, saved.reused ? 200 : 202, batchWire(saved.record), { location: `/api/v1/render-batches/${saved.record.id}` });
  });
}
