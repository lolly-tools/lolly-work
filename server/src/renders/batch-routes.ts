import { readJson, sendError, sendJson, type createRouter, type Handler } from '../api/router.ts';
import { batchProgress, batchWire, newRenderBatch, parseRenderBatchSpec } from './batch.ts';
import type { RoutesDeps } from './routes.ts';
import { RenderResourceError, type RenderBatchRecord } from './types.ts';

export function registerRenderBatchRoutes(router: Pick<ReturnType<typeof createRouter>, 'add'>, deps: RoutesDeps): void {
  const { store } = deps;
  const add = (method: string, path: string, handler: (principal: string, ...args: Parameters<Handler>) => Promise<void>): void => {
    router.add(method, `/api/v1/render-batches${path}`, async (req, res, ctx) => {
      try {
        const principal = await deps.authenticate(req);
        if (!principal) return sendError(res, 401, 'UNAUTHORIZED', 'an authenticated user or service token is required');
        await handler(principal, req, res, ctx);
      } catch (e) {
        if (e instanceof RenderResourceError) return sendError(res, e.status, e.code, e.message);
        throw e;
      }
    });
  };
  const find = async (id: string, principal: string): Promise<RenderBatchRecord> => {
    const batch = await store.getRenderBatch(id, principal);
    if (!batch) throw new RenderResourceError('NOT_FOUND', 404, 'render batch not found');
    return batch;
  };
  const submit = async (batch: RenderBatchRecord) => {
    if (!deps.kick) throw new RenderResourceError('RENDER_RUNNER_UNAVAILABLE', 503, 'durable batches require the long-lived server');
    await deps.authorize(batch.principal, batch.request);
    // Reusing a successful row keeps its exact bytes. Only new attempts need current input validation.
    for (const row of batch.rows) {
      if (row.render.state !== 'queued') continue;
      try { await deps.validate(batch.principal, row.render.request); }
      catch (e) {
        if (e instanceof RenderResourceError) throw new RenderResourceError(e.code, e.status, `row ${row.key}: ${e.message}`);
        throw e;
      }
    }
    const saved = await store.insertRenderBatch(batch);
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

  add('POST', '', async (principal, req, res) => {
    const batch = newRenderBatch(principal, parseRenderBatchSpec(await readJson(req)), key(req));
    const saved = await submit(batch);
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
    sendJson(res, 200, batchWire(batch));
  });
  add('GET', '/:id/manifest', async (principal, _req, res, ctx) => {
    const batch = await find(ctx.params.id!, principal);
    await deps.authorize(principal, batch.request);
    sendJson(res, 200, { manifestVersion: 1, ...batchWire(batch) }, {
      'content-disposition': `attachment; filename="${batch.id}.json"`, 'cache-control': 'private, no-store',
    });
  });
  add('DELETE', '/:id', async (principal, _req, res, ctx) => {
    const batch = await store.cancelRenderBatch(ctx.params.id!, principal);
    if (!batch) throw new RenderResourceError('NOT_FOUND', 404, 'render batch not found');
    if (!batchProgress(batch).progress.cancelled) throw new RenderResourceError('BATCH_TERMINAL', 409, 'completed batch history is retained');
    await deps.audit(principal, 'render.batch.cancel', batch.id, {});
    sendJson(res, 200, batchWire(batch));
  });
  add('POST', '/:id/retry', async (principal, req, res, ctx) => {
    const old = await find(ctx.params.id!, principal);
    const saved = await submit(newRenderBatch(principal, old.request, key(req), old));
    sendJson(res, saved.reused ? 200 : 202, batchWire(saved.record), { location: `/api/v1/render-batches/${saved.record.id}` });
  });
}
