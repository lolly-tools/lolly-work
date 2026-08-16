/**
 * Client for the Chromium render worker (plans/07/11). Hooked / HTML-heavy tools
 * can't run in the in-process jsdom fast path - this dispatches them to an
 * ISOLATED browser worker (a separate, hardened deployment that renders the
 * least-trusted content, blast-separated from the control plane).
 *
 * Zero-dep by design: the control plane never imports Playwright. It signs a
 * render job with the shared HMAC key and POSTs it; the worker drives a headless
 * Chromium and returns SVG, which the plane then watermarks / provenances /
 * rasterises exactly like an in-process render (policy stays in the plane).
 */
import { hmac, macEquals, canonicalJson } from '../lib/crypto.ts';

export interface WorkerConfig { url: string; secret: string; timeoutMs: number }

export interface WorkerJob {
  toolId: string;
  /** The original (possibly packed) URL-mode query - the shared param contract. */
  query: string;
  /** Policy-baked locked values, applied OVER the query by the worker so a locked
   *  input renders its policy value regardless of what the caller supplied. */
  overrides: Record<string, unknown>;
  format: 'svg';
  /** Server-built profile (never caller params) for bindToProfile resolution. */
  profile: unknown;
}

/** Rasterise-an-SVG job: the plane hands the worker a FINISHED svg (already
 *  watermarked + provenance-islanded) and asks for pixel/vector-print bytes in
 *  `format`. Rasterisation is the ONLY thing that moves to the worker - provenance
 *  (needs the plane's federation resolver) and C2PA signing (needs the org signer)
 *  stay plane-side, so the DB/secret-less, blast-separated worker never touches
 *  them. This is the single-rasteriser path that replaces in-process resvg. */
export interface RasterJob {
  svg: string;
  /** A raster / vector-print format the worker's Chromium can produce. */
  format: string;
  /** Target longest-edge / width in px (the plane's computed pxW). */
  width?: number;
}

export interface RasterResult { bytes: Uint8Array; mime: string }

/** A worker failure the render pipeline maps to an HTTP status. */
export class WorkerError extends Error {
  readonly status: number;
  /** Set when the failure maps to a specific plane-recognized code rather than
   *  a generic worker failure - today, only capacity backpressure (503
   *  RENDER_BUSY, plans/23 §3.C). Undefined for the generic 4xx/5xx paths,
   *  which keep the existing behavior of that call site. */
  readonly code?: string;
  /** Seconds the caller should wait before retrying, echoed straight through
   *  from the worker's Retry-After header (503 RENDER_BUSY only). No retry
   *  loop lives here - renders are idempotent-by-cache-key, so retrying, if
   *  at all, is the caller's call, not this client's. */
  readonly retryAfter?: number;
  constructor(message: string, status = 502, opts: { code?: string; retryAfter?: number } = {}) {
    super(message);
    this.name = 'WorkerError';
    this.status = status;
    this.code = opts.code;
    this.retryAfter = opts.retryAfter;
  }
}

/** Signature header for a render request body (stamped with `ts` for replay
 *  resistance). Exported so the worker verifies with the identical scheme. */
export function signBody(body: string, secret: string): string {
  return hmac(body, secret);
}
export function verifyBody(body: string, secret: string, presented: string): boolean {
  return macEquals(presented, hmac(body, secret));
}

/** Maximum clock skew accepted on the `ts` field (both directions). */
export const WORKER_TS_SKEW_MS = 5 * 60 * 1000;

/** The worker sends Retry-After as a plain integer-seconds string (see
 *  server.ts `busy()`); tolerate anything else by simply not passing a hint
 *  through rather than throwing on a malformed header. */
function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Render a hooked tool via the worker, returning the SVG string. `now`/`fetchImpl`
 * are injectable for tests. Throws WorkerError on any transport/protocol failure.
 */
export async function renderViaWorker(
  cfg: WorkerConfig,
  job: WorkerJob,
  opts: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const payload = canonicalJson({ ...job, ts: now });
  const sig = signBody(payload, cfg.secret);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url.replace(/\/$/, '')}/render`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lw-render-sig': sig },
      body: payload,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new WorkerError(`render worker unreachable: ${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json() as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch { /* non-JSON error body */ }
    // The worker answers capacity saturation with 503 + Retry-After - surface
    // it as its own code/status rather than folding it into the generic 502
    // below, so callers can tell "busy, try again" apart from a real failure.
    if (res.status === 503) {
      throw new WorkerError(`render worker at capacity: ${detail}`, 503, {
        code: 'RENDER_BUSY',
        retryAfter: parseRetryAfter(res),
      });
    }
    // Surface the worker's own status where sensible; other 5xx stays a plane 502.
    const status = res.status === 422 || res.status === 400 ? res.status : 502;
    throw new WorkerError(`render worker rejected the job (${res.status}): ${detail}`, status);
  }

  const out = await res.json().catch(() => null) as { svg?: unknown } | null;
  if (!out || typeof out.svg !== 'string' || !/<svg[\s>]/i.test(out.svg)) {
    throw new WorkerError('render worker returned no SVG', 502);
  }
  return out.svg;
}

/**
 * Rasterise a finished SVG to `format` bytes via the worker's Chromium - the
 * single-rasteriser replacement for in-process resvg. Same HMAC scheme as
 * renderViaWorker; POSTs to `/rasterise`. The worker returns base64 bytes + mime.
 * `now`/`fetchImpl` injectable for tests. Throws WorkerError on any failure.
 */
export async function rasteriseViaWorker(
  cfg: WorkerConfig,
  job: RasterJob,
  opts: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<RasterResult> {
  const now = opts.now ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const payload = canonicalJson({ ...job, ts: now });
  const sig = signBody(payload, cfg.secret);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url.replace(/\/$/, '')}/rasterise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lw-render-sig': sig },
      body: payload,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new WorkerError(`render worker unreachable: ${(e as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json() as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch { /* non-JSON error body */ }
    // Same RENDER_BUSY special-case as renderViaWorker above.
    if (res.status === 503) {
      throw new WorkerError(`render worker at capacity: ${detail}`, 503, {
        code: 'RENDER_BUSY',
        retryAfter: parseRetryAfter(res),
      });
    }
    const status = res.status === 422 || res.status === 400 ? res.status : 502;
    throw new WorkerError(`render worker rejected the raster job (${res.status}): ${detail}`, status);
  }

  const out = await res.json().catch(() => null) as { bytesB64?: unknown; mime?: unknown } | null;
  if (!out || typeof out.bytesB64 !== 'string' || typeof out.mime !== 'string') {
    throw new WorkerError('render worker returned no raster bytes', 502);
  }
  return { bytes: new Uint8Array(Buffer.from(out.bytesB64, 'base64')), mime: out.mime };
}
