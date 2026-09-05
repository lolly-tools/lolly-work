import type { IncomingMessage } from 'node:http';
import { readBlobBody, type BlobStore } from '../blobs/types.ts';
import { readJson, sendError, sendJson, type createRouter, type Handler } from '../api/router.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { newRender, parseRenderSpec, renderWire } from './request.ts';
import { RenderResourceError, type RenderRecord, type RenderSpec, type RenderStore } from './types.ts';
import { registerRenderBatchRoutes } from './batch-routes.ts';
import { evidenceHash } from '../render/evidence.ts';

export interface RoutesDeps {
  store: RenderStore;
  blobs: BlobStore;
  authenticate(req: IncomingMessage): Promise<string | null>;
  authorize(principal: string, request: RenderSpec): Promise<void>;
  validate(principal: string, request: RenderSpec): Promise<void>;
  /** Absent in function-only hosts, where no background execution is guaranteed. */
  kick?: () => void;
  audit(principal: string, action: string, id: string, facts: Record<string, unknown>): Promise<void>;
}

export function registerRenderRoutes(router: Pick<ReturnType<typeof createRouter>, 'add'>, deps: RoutesDeps): void {
  registerRenderBatchRoutes(router, deps);
  const { store } = deps;
  const add = (method: string, path: string, handler: (principal: string, ...args: Parameters<Handler>) => Promise<void>): void => {
    router.add(method, path, async (req, res, ctx) => {
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
  const find = async (id: string, principal: string): Promise<RenderRecord> => {
    const r = await store.getRender(id, principal);
    if (!r) throw new RenderResourceError('NOT_FOUND', 404, 'render not found');
    return r;
  };
  const submit = async (principal: string, request: RenderSpec, key?: string, retryOf?: string) => {
    if (!deps.kick) throw new RenderResourceError('RENDER_RUNNER_UNAVAILABLE', 503, 'durable renders require the long-lived server');
    const proposed = newRender(principal, request, key, retryOf);
    await deps.authorize(principal, request);
    await deps.validate(principal, request);
    const saved = await store.insertRender(proposed);
    if (saved.record.requestHash !== proposed.requestHash) throw new RenderResourceError('IDEMPOTENCY_KEY_REUSED', 409, 'Idempotency-Key already identifies a different render request');
    if (!saved.reused) await deps.audit(principal, retryOf ? 'render.retry' : 'render.create', saved.record.id,
      { toolId: request.toolId, format: request.format, ...(retryOf ? { retryOf } : {}) });
    deps.kick();
    return saved;
  };

  add('POST', '/api/v1/renders', async (principal, req, res) => {
    const request = parseRenderSpec(await readJson(req));
    const key = req.headers['idempotency-key'];
    if (Array.isArray(key)) throw new RenderResourceError('INVALID_INPUT', 400, 'one Idempotency-Key required');
    const { record, reused } = await submit(principal, request, key);
    sendJson(res, reused ? 200 : 202, renderWire(record), { location: `/api/v1/renders/${record.id}` });
  });

  add('GET', '/api/v1/renders', async (principal, _req, res, ctx) => {
    const limit = Number(ctx.url.searchParams.get('limit') ?? 50);
    const offset = Number(ctx.url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new RenderResourceError('INVALID_INPUT', 400, 'limit must be 1–100 and offset a non-negative integer');
    }
    const page = await store.listRenders(principal, limit, offset);
    const visible = [];
    for (const r of page) {
      try { await deps.authorize(principal, r.request); visible.push(renderWire(r)); }
      catch (e) { if (!(e instanceof RenderResourceError && e.status === 403)) throw e; }
    }
    sendJson(res, 200, { renders: visible, nextOffset: page.length === limit ? offset + limit : null });
  });

  add('GET', '/api/v1/renders/:id', async (principal, _req, res, ctx) => {
    const r = await find(ctx.params.id!, principal);
    await deps.authorize(principal, r.request);
    sendJson(res, 200, renderWire(r));
  });

  add('GET', '/api/v1/renders/:id/output/:name', async (principal, _req, res, ctx) => {
    const r = await find(ctx.params.id!, principal);
    await deps.authorize(principal, r.request);
    if (ctx.params.name !== 'default') throw new RenderResourceError('NOT_FOUND', 404, 'output not found');
    if (r.state !== 'succeeded' || !r.output) throw new RenderResourceError('RENDER_NOT_SUCCEEDED', 409, 'render has no successful output');
    const blob = await deps.blobs.get(r.output.ref);
    if (!blob) throw new RenderResourceError('OUTPUT_UNAVAILABLE', 410, 'retained render output is unavailable');
    let bytes: Buffer;
    try { bytes = await readBlobBody(blob.body, r.output.size); }
    catch { throw new RenderResourceError('OUTPUT_INTEGRITY', 409, 'retained output no longer matches its receipt'); }
    if (bytes.byteLength !== r.output.size || sha256Hex(bytes) !== r.output.sha256) {
      throw new RenderResourceError('OUTPUT_INTEGRITY', 409, 'retained output no longer matches its receipt');
    }
    res.writeHead(200, { 'content-type': r.output.mime, 'content-length': String(bytes.byteLength),
      'cache-control': 'private, no-store', etag: `"${r.output.sha256}"`, 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="${r.id}.${r.request.format}"` });
    res.end(bytes);
  });

  add('GET', '/api/v1/renders/:id/evidence', async (principal, _req, res, ctx) => {
    const r = await find(ctx.params.id!, principal);
    await deps.authorize(principal, r.request);
    if (r.state !== 'succeeded') throw new RenderResourceError('RENDER_NOT_SUCCEEDED', 409, 'render has no successful output');
    const evidence = r.output?.evidence;
    if (!evidence) throw new RenderResourceError('EVIDENCE_UNAVAILABLE', 404, 'this output predates execution evidence or was produced without it');
    const { id, ...body } = evidence;
    if (body.outputSha256 !== r.output!.sha256 || id !== evidenceHash(body)) {
      throw new RenderResourceError('EVIDENCE_INTEGRITY', 409, 'retained evidence no longer matches its receipt');
    }
    sendJson(res, 200, { renderId: r.id, evidence }, {
      'content-disposition': `attachment; filename="${r.id}.evidence.json"`, 'cache-control': 'private, no-store',
    });
  });

  add('DELETE', '/api/v1/renders/:id', async (principal, _req, res, ctx) => {
    // An owner may stop their work even after losing permission to render it.
    const r = await store.cancelRender(ctx.params.id!, principal);
    if (!r) throw new RenderResourceError('NOT_FOUND', 404, 'render not found');
    if (r.state !== 'cancelled') throw new RenderResourceError('RENDER_TERMINAL', 409, 'completed render history is retained');
    await deps.audit(principal, 'render.cancel', r.id, {});
    sendJson(res, 200, renderWire(r));
  });

  add('POST', '/api/v1/renders/:id/retry', async (principal, req, res, ctx) => {
    const old = await find(ctx.params.id!, principal);
    if (old.state !== 'failed' && old.state !== 'cancelled') throw new RenderResourceError('RENDER_NOT_RETRYABLE', 409, 'only a failed or cancelled render can be retried');
    const key = req.headers['idempotency-key'];
    if (Array.isArray(key)) throw new RenderResourceError('INVALID_INPUT', 400, 'one Idempotency-Key required');
    const { record, reused } = await submit(principal, old.request, key, old.id);
    sendJson(res, reused ? 200 : 202, renderWire(record), { location: `/api/v1/renders/${record.id}` });
  });
}
