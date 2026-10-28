// SPDX-License-Identifier: MPL-2.0
/**
 * The lease endpoint render workers poll under pull dispatch (worker-leases.ts).
 * Registered only when render.worker.dispatch is "pull"; otherwise every path
 * here is a plain 404.
 *
 *   POST /api/internal/render/lease               { pools, waitMs, ts, nonce }
 *        → 200 LeaseGrant | 204 nothing within waitMs
 *   POST /api/internal/render/leases/:id/renew    { token, ts }       → 204 | 410
 *   POST /api/internal/render/leases/:id/result   { token, ts, status, body, outputSig?, retryAfter? } → 204 | 410
 *
 * Every request carries `x-lw-render-sig`, the HMAC of its exact body under the
 * worker key (LW_RENDER_WORKER_SECRET) that already signs push jobs. A worker
 * therefore gains nothing here it does not hold under push: it receives the
 * same signed jobs and returns the same signed replies. A body older or newer
 * than 60 seconds is refused, and a lease request's nonce is accepted once, so
 * a recorded request cannot be replayed to take a job. A request that fails
 * any check gets a bare 401 before it can hold a connection open. The 410 on
 * renew is how a worker learns its lease is gone (lapsed, reclaimed, or the
 * render was cancelled) and stops.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readRaw, sendError, sendJson, type createRouter } from '../api/router.ts';
import { verifyBody, type WorkerReply } from './worker-client.ts';
import { isRenderPool, type RenderPool } from './pools.ts';
import type { LeaseBroker } from './worker-leases.ts';

/** Accepted clock difference between a worker and Work for these requests. */
export const LEASE_SKEW_MS = 60_000;
/** The longest long-poll a worker may ask for; below common proxy idle limits. */
export const LEASE_MAX_WAIT_MS = 30_000;
/** A reported reply's envelope: the largest raster (base64) with room for JSON. */
export const LEASE_RESULT_MAX_BYTES = 64 * 1024 * 1024;

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface LeaseRouteDeps {
  broker: LeaseBroker;
  secret: string;
  now?: () => number;
}

export function registerLeaseRoutes(router: Pick<ReturnType<typeof createRouter>, 'add'>, deps: LeaseRouteDeps): void {
  const now = deps.now ?? Date.now;
  const seen = new Map<string, number>();
  const firstUse = (nonce: string, at: number): boolean => {
    if (seen.size > 4096) for (const [key, expiry] of seen) if (expiry <= at) seen.delete(key);
    if (seen.has(nonce)) return false;
    seen.set(nonce, at + 2 * LEASE_SKEW_MS);
    return true;
  };

  /** The verified body, or null after answering 401/400/413. */
  const signed = async (req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<Record<string, unknown> | null> => {
    let raw: string;
    try { raw = (await readRaw(req, maxBytes)).toString('utf8'); }
    catch { sendError(res, 413, 'TOO_LARGE', 'request body too large'); return null; }
    const sig = req.headers['x-lw-render-sig'];
    if (typeof sig !== 'string' || !verifyBody(raw, deps.secret, sig)) { sendError(res, 401, 'UNAUTHORIZED', 'invalid or missing worker signature'); return null; }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { sendError(res, 400, 'BAD_JSON', 'invalid JSON body'); return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { sendError(res, 400, 'BAD_REQUEST', 'JSON object required'); return null; }
    const ts = (body as { ts?: unknown }).ts;
    if (typeof ts !== 'number' || Math.abs(now() - ts) > LEASE_SKEW_MS) { sendError(res, 401, 'STALE', 'request timestamp outside the accepted window'); return null; }
    return body as Record<string, unknown>;
  };
  const gone = (res: ServerResponse) => sendError(res, 410, 'LEASE_GONE', 'this lease is no longer held');

  router.add('POST', '/api/internal/render/lease', async (req, res) => {
    const body = await signed(req, res, 4096); if (!body) return;
    const { pools, waitMs, nonce } = body;
    if (!Array.isArray(pools) || !pools.length || pools.length > 8 || !pools.every(isRenderPool)
      || typeof waitMs !== 'number' || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > LEASE_MAX_WAIT_MS
      || typeof nonce !== 'string' || !NONCE.test(nonce)) return sendError(res, 400, 'BAD_REQUEST', 'expected { pools, waitMs, ts, nonce }');
    if (!firstUse(nonce, now())) return sendError(res, 401, 'REPLAYED', 'this lease request was already used');
    // The worker hung up: stop waiting for it.
    const hungUp = new AbortController();
    const onClose = (): void => { if (!res.writableEnded) hungUp.abort(); };
    res.once('close', onClose);
    try {
      const grant = await deps.broker.lease(pools as RenderPool[], waitMs, hungUp.signal);
      if (!grant) { if (!res.destroyed) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); } return; }
      // A grant that cannot reach its worker goes straight back to the queue.
      if (res.destroyed || hungUp.signal.aborted) { deps.broker.abandon(grant.id, grant.token); return; }
      sendJson(res, 200, grant, { 'cache-control': 'no-store' });
    } finally { res.removeListener('close', onClose); }
  });

  router.add('POST', '/api/internal/render/leases/:id/renew', async (req, res, ctx) => {
    const body = await signed(req, res, 4096); if (!body) return;
    const id = ctx.params.id ?? '';
    if (!ID.test(id) || typeof body.token !== 'string') return sendError(res, 400, 'BAD_REQUEST', 'expected { token, ts }');
    if (!deps.broker.renew(id, body.token)) return gone(res);
    res.writeHead(204, { 'cache-control': 'no-store' }); res.end();
  });

  router.add('POST', '/api/internal/render/leases/:id/result', async (req, res, ctx) => {
    const body = await signed(req, res, LEASE_RESULT_MAX_BYTES); if (!body) return;
    const id = ctx.params.id ?? '';
    const { token, status, outputSig, retryAfter } = body;
    if (!ID.test(id) || typeof token !== 'string' || typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599
      || typeof body.body !== 'string' || (outputSig != null && typeof outputSig !== 'string') || (retryAfter != null && typeof retryAfter !== 'string')) {
      return sendError(res, 400, 'BAD_REQUEST', 'expected { token, ts, status, body, outputSig?, retryAfter? }');
    }
    const reply: WorkerReply = { status, body: body.body, outputSig: (outputSig as string | null | undefined) ?? null, retryAfter: (retryAfter as string | null | undefined) ?? null };
    if (!deps.broker.complete(id, token, reply)) return gone(res);
    res.writeHead(204, { 'cache-control': 'no-store' }); res.end();
  });
}
