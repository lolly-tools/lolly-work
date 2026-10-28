// SPDX-License-Identifier: MPL-2.0
/**
 * Pull dispatch, the worker's side (plan 324 M3, decision D5). Off unless
 * LW_RENDER_PULL_URL names the Work instance; Work must also be set to
 * render.worker.dispatch "pull" (server/src/render/worker-leases.ts).
 *
 * Each of the worker's browser slots (LW_RENDER_MAX_CONCURRENT) runs one loop:
 * ask Work for a job (a long-poll that returns the moment Work records one),
 * run it through the same handler a pushed POST uses, renew the lease while it
 * runs, and report the answer. The worker still holds no database credentials;
 * a job is the payload push would POST, read ticket included, signed by Work.
 * If Work says the lease is gone (410), the job is abandoned at once: the
 * render was cancelled, or the lease lapsed and another worker has it.
 */
import { createHmac, randomBytes } from 'node:crypto';

export type PullPath = '/render' | '/rasterise';
export interface PullJob { id: string; token: string; path: PullPath; payload: string; signature: string; leaseMs: number }
/** What a pushed POST would have answered: status, headers and body. */
export interface JobReply { status: number; headers: Record<string, string>; body: string }

export interface PullOptions {
  /** Work's base URL (pullBase). */
  base: string;
  secret: string;
  /** Concurrent loops, one per browser slot. */
  slots: number;
  /** The pools this worker serves. */
  pools: string[];
  /** Longest single long-poll; Work caps it at 30 s. */
  waitMs?: number;
  run: (job: PullJob, signal: AbortSignal) => Promise<JobReply>;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/** The largest reply the worker reports; Work refuses envelopes above 64 MiB. */
export const PULL_REPLY_MAX_BYTES = 60 * 1024 * 1024;

const message = 'LW_RENDER_PULL_URL must be the Work instance\'s HTTPS URL (HTTP only for explicit loopback evaluation), with no credentials, query or fragment';

/** Production pulls only over verified HTTPS, as Work only pushes over it. */
export function pullBase(value: string, production: boolean, env: NodeJS.ProcessEnv = process.env): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (!value || value.trim() !== value || /[\s\\]/.test(value) || url.username || url.password || url.search || url.hash
    || !['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error(message);
  if (url.protocol === 'http:' && (production || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]*)?(?:\/|$)/i.test(value))) throw new Error(message);
  if (production && env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Production pull dispatch requires TLS certificate verification');
  return url.href.replace(/\/$/, '');
}

const isJob = (value: unknown): value is PullJob => {
  const v = value as Partial<PullJob> | null;
  return !!v && typeof v.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v.id) && typeof v.token === 'string'
    && (v.path === '/render' || v.path === '/rasterise') && typeof v.payload === 'string' && typeof v.signature === 'string'
    && typeof v.leaseMs === 'number' && Number.isFinite(v.leaseMs) && v.leaseMs >= 1000;
};

export function startPull(opts: PullOptions): { stop(): Promise<void>; running(): number } {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((m: string) => console.warn(`[render-worker] ${m}`));
  const waitMs = Math.min(opts.waitMs ?? 25_000, 30_000);
  const stopping = new AbortController();
  let running = 0;

  const post = async (path: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<Response> => {
    const raw = JSON.stringify({ ...body, ts: Date.now() });
    const sig = createHmac('sha256', opts.secret).update(raw).digest('base64url');
    const limit = AbortSignal.timeout(timeoutMs);
    return fetchImpl(`${opts.base}${path}`, {
      method: 'POST', redirect: 'error', body: raw,
      headers: { 'content-type': 'application/json', 'x-lw-render-sig': sig },
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
  };
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    stopping.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  const lease = async (): Promise<PullJob | null> => {
    const res = await post('/api/internal/render/lease', { pools: opts.pools, waitMs, nonce: randomBytes(18).toString('base64url') },
      waitMs + 15_000, stopping.signal);
    if (res.status === 204) { await res.body?.cancel(); return null; }
    if (res.status !== 200) { await res.body?.cancel(); throw new Error(`lease request refused (${res.status})`); }
    const job = await res.json();
    if (!isJob(job)) throw new Error('lease grant is malformed');
    return job;
  };

  const report = async (job: PullJob, reply: JobReply): Promise<void> => {
    const body = Buffer.byteLength(reply.body) > PULL_REPLY_MAX_BYTES
      ? { status: 502, body: JSON.stringify({ error: { code: 'RESULT_TOO_LARGE', message: 'render result exceeds the pull reply budget' } }), outputSig: null, retryAfter: null }
      : { status: reply.status, body: reply.body, outputSig: reply.headers['x-lw-output-sig'] ?? null, retryAfter: reply.headers['retry-after'] ?? null };
    // A report lost on the network is retried; Work's lease still decides whether it counts.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await post(`/api/internal/render/leases/${encodeURIComponent(job.id)}/result`, { token: job.token, ...body }, 60_000);
        await res.body?.cancel();
        if (res.status === 204 || res.status === 410) return;
        log(`result report refused (${res.status})`);
        return;
      } catch { await pause(250 * 2 ** attempt); }
    }
    log('result report failed; the lease will lapse and the job runs elsewhere');
  };

  const slot = async (): Promise<void> => {
    let failures = 0;
    while (!stopping.signal.aborted) {
      let job: PullJob | null;
      try { job = await lease(); failures = 0; }
      catch (error) {
        if (stopping.signal.aborted) return;
        failures++;
        if (failures === 1 || failures % 30 === 0) log(`cannot lease from Work: ${(error as Error).message}`);
        await pause(Math.min(10_000, 500 * 2 ** Math.min(failures, 5)) * (0.5 + Math.random()));
        continue;
      }
      if (!job) continue;
      running++;
      const work = new AbortController();
      const stopWork = () => work.abort(new Error('worker stopping'));
      stopping.signal.addEventListener('abort', stopWork, { once: true });
      let gone = false;
      const renew = setInterval(() => {
        void post(`/api/internal/render/leases/${encodeURIComponent(job.id)}/renew`, { token: job.token }, Math.max(1000, job.leaseMs / 3))
          .then(async (res) => { await res.body?.cancel(); if (res.status === 410) { gone = true; work.abort(new Error('render lease is gone')); } })
          .catch(() => { /* the next renewal tries again; a lapse reclaims the job */ });
      }, Math.max(500, Math.floor(job.leaseMs / 3)));
      let reply: JobReply;
      try { reply = await opts.run(job, work.signal); }
      catch (error) {
        reply = { status: 502, headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ error: { code: 'RENDER_FAILED', message: `render failed: ${(error as Error).message}` } }) };
      } finally {
        clearInterval(renew);
        stopping.signal.removeEventListener('abort', stopWork);
        running--;
      }
      // A stopping worker does not report: its lease lapses and Work hands
      // the job to another worker instead of failing the render.
      if (!gone && !stopping.signal.aborted) await report(job, reply);
    }
  };

  const loops = Array.from({ length: Math.max(1, opts.slots) }, () => slot());
  return {
    async stop() { stopping.abort(); await Promise.allSettled(loops); },
    running: () => running,
  };
}
