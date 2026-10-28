// SPDX-License-Identifier: MPL-2.0
/**
 * Pull dispatch for the render worker (plan 324 M3, decision D5). Off by
 * default: `render.worker.dispatch` stays "push" unless an operator sets "pull".
 *
 * Under push, Work POSTs each worker job to the worker Service and a full
 * worker answers 503 RENDER_BUSY. Under pull, the same job waits here until a
 * worker with a free browser slot asks for it over the lease endpoint
 * (lease-routes.ts), and the worker reports the answer back.
 *
 * The unit of a lease is one worker call, a /render or /rasterise job: the very
 * payload push would POST, signed with the same key at the moment a worker
 * takes it. It is NOT the durable render row. The row keeps its PostgreSQL
 * claim, heartbeat, fencing and retry rules in renders/runner.ts unchanged, and
 * the pipeline only waits on a different transport (worker-client.ts verifies
 * the reply the same way either way). Jobs live in this process's memory: if
 * Work stops, the durable row's lease expires and another attempt runs, as it
 * does when Work stops in the middle of a push.
 *
 * Leases:
 *  - A waiting worker gets a job the moment the pipeline records it.
 *  - A lease lasts `leaseMs` and the worker renews it while it works. A lease
 *    that lapses (the worker died or lost the network) is reclaimed: the job
 *    goes back to the head of its queue for another worker, up to `maxReclaims`
 *    times, then fails as a 502 like a push to an unreachable worker.
 *  - Each lease carries a fresh token. Only the current token can renew or
 *    report, so a worker that lost its lease can never publish over the next.
 *  - A job that no worker takes within `queueTimeoutMs` fails as 503
 *    RENDER_BUSY, exactly as a full worker answers under push, so the durable
 *    runner's retry and back-off rules apply unchanged.
 *  - The whole exchange is bounded by the worker timeout from the moment of
 *    the lease, as a push request is.
 *  - Cancelling the render (its AbortSignal) drops a queued job, or ends the
 *    lease so the worker's next renewal tells it to stop.
 */
import { canonicalJson, randomId } from '../lib/crypto.ts';
import { signBody, WorkerError, type WorkerExchange, type WorkerPath, type WorkerReply } from './worker-client.ts';
import { WORKER_PATH_POOL, type RenderPool } from './pools.ts';

export interface LeaseBrokerOptions {
  /** The worker HMAC key (LW_RENDER_WORKER_SECRET) that signs each handed-out job. */
  secret: string;
  /** How long a lease lasts without renewal. */
  leaseMs?: number;
  /** How long a job may wait for a worker before it fails as RENDER_BUSY. */
  queueTimeoutMs?: number;
  /** How many times a lapsed lease is handed to another worker. */
  maxReclaims?: number;
  now?: () => number;
  /** Lease events for the lease-rate counter. */
  onEvent?: (pool: RenderPool, event: LeaseEvent) => void;
}

export type LeaseEvent = 'granted' | 'completed' | 'expired' | 'reclaimed' | 'timed_out' | 'queue_timeout' | 'cancelled';

/** What a worker receives: the signed job push would have POSTed. */
export interface LeaseGrant {
  id: string;
  token: string;
  pool: RenderPool;
  path: WorkerPath;
  payload: string;
  signature: string;
  leaseMs: number;
}

export interface LeasePoolStats {
  pool: RenderPool;
  /** Jobs waiting for a worker. */
  waiting: number;
  /** Seconds the oldest waiting job has waited (0 when none). */
  oldestWaitSeconds: number;
  /** Jobs a worker holds a lease on. */
  leased: number;
  /** Worker slots waiting for a job (open long-polls). */
  idleWorkers: number;
}

interface Task {
  id: string;
  seq: number;
  pool: RenderPool;
  path: WorkerPath;
  job: Record<string, unknown>;
  timeoutMs: number;
  enqueuedAt: number;
  reclaims: number;
  lease?: { token: string; until: number; deadline: number; payload: string };
  timer?: ReturnType<typeof setTimeout>;
  settle: (error: unknown, value?: WorkerExchange) => void;
}

interface Waiter {
  pools: readonly RenderPool[];
  grant: (task: Task) => void;
  cancel: () => void;
}

export interface LeaseBroker {
  /** The pipeline's side (worker-client.ts WorkerDispatch). */
  dispatch(path: WorkerPath, job: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<WorkerExchange>;
  /** A worker asks for a job; resolves null when `waitMs` passes or `signal` aborts first. */
  lease(pools: readonly RenderPool[], waitMs: number, signal?: AbortSignal): Promise<LeaseGrant | null>;
  /** Renew a lease. False: the lease is gone, and the worker should stop. */
  renew(id: string, token: string): boolean;
  /** Report a leased job's reply. False: the lease is gone, and the reply is discarded. */
  complete(id: string, token: string, reply: WorkerReply): boolean;
  /** Put back a job whose grant never reached its worker. */
  abandon(id: string, token: string): void;
  stats(): LeasePoolStats[];
  close(): void;
}

export function createLeaseBroker(options: LeaseBrokerOptions): LeaseBroker {
  const leaseMs = options.leaseMs ?? 15_000;
  const queueTimeoutMs = options.queueTimeoutMs ?? 30_000;
  const maxReclaims = options.maxReclaims ?? 1;
  const now = options.now ?? Date.now;
  const event = (pool: RenderPool, e: LeaseEvent): void => { try { options.onEvent?.(pool, e); } catch { /* metrics never fail a render */ } };
  const queues = new Map<RenderPool, Task[]>();
  const leased = new Map<string, Task>();
  const waiters: Waiter[] = [];
  let seq = 0;
  let closed = false;

  const queueOf = (pool: RenderPool): Task[] => {
    let q = queues.get(pool);
    if (!q) { q = []; queues.set(pool, q); }
    return q;
  };
  const unqueue = (task: Task): boolean => {
    const q = queueOf(task.pool), i = q.indexOf(task);
    if (i < 0) return false;
    q.splice(i, 1);
    return true;
  };
  const arm = (task: Task, at: number, fire: () => void): void => {
    if (task.timer) clearTimeout(task.timer);
    task.timer = setTimeout(fire, Math.max(0, at - now()));
    task.timer.unref?.();
  };

  /** Queue in order: a reclaimed job keeps its place ahead of later ones. */
  const enqueue = (task: Task): void => {
    delete task.lease;
    const q = queueOf(task.pool);
    let at = q.length;
    while (at > 0 && q[at - 1]!.seq > task.seq) at--;
    q.splice(at, 0, task);
    arm(task, now() + queueTimeoutMs, () => {
      if (!unqueue(task)) return;
      event(task.pool, 'queue_timeout');
      task.settle(new WorkerError('render worker at capacity: no worker took the job in time', 503, { code: 'RENDER_BUSY', retryAfter: 2 }));
    });
    const w = waiters.findIndex((waiter) => waiter.pools.includes(task.pool));
    if (w >= 0) {
      const [waiter] = waiters.splice(w, 1);
      unqueue(task);
      waiter!.grant(task);
    }
  };

  const onLeaseTimer = (task: Task): void => {
    const lease = task.lease;
    if (!lease || leased.get(task.id) !== task) return;
    const t = now();
    if (t >= lease.deadline) {
      leased.delete(task.id);
      delete task.lease;
      event(task.pool, 'timed_out');
      task.settle(new WorkerError('render worker did not answer within its timeout', 502));
      return;
    }
    if (t < lease.until) { arm(task, Math.min(lease.until, lease.deadline), () => onLeaseTimer(task)); return; }
    leased.delete(task.id);
    event(task.pool, 'expired');
    if (task.reclaims >= maxReclaims) {
      delete task.lease;
      task.settle(new WorkerError('render worker lease expired: the worker stopped renewing it', 502));
      return;
    }
    task.reclaims++;
    task.enqueuedAt = t;
    event(task.pool, 'reclaimed');
    enqueue(task);
  };

  const grantTo = (task: Task): LeaseGrant => {
    const t = now();
    // Signed now, not when queued: the worker refuses a payload older than its skew window.
    const payload = canonicalJson({ ...task.job, ts: t });
    task.lease = { token: randomId(16), until: t + leaseMs, deadline: t + task.timeoutMs, payload };
    leased.set(task.id, task);
    arm(task, Math.min(task.lease.until, task.lease.deadline), () => onLeaseTimer(task));
    event(task.pool, 'granted');
    return { id: task.id, token: task.lease.token, pool: task.pool, path: task.path, payload, signature: signBody(payload, options.secret), leaseMs };
  };

  const current = (id: string, token: string): Task | undefined => {
    const task = leased.get(id);
    return task?.lease && task.lease.token === token ? task : undefined;
  };

  return {
    dispatch(path, job, opts) {
      opts.signal?.throwIfAborted();
      if (closed) return Promise.reject(new WorkerError('render worker dispatch is closed', 503, { code: 'RENDER_BUSY', retryAfter: 2 }));
      return new Promise<WorkerExchange>((resolve, reject) => {
        let done = false;
        const onAbort = (): void => {
          if (done) return;
          const wasQueued = unqueue(task);
          if (!wasQueued) leased.delete(task.id);
          event(task.pool, 'cancelled');
          task.settle(opts.signal!.reason ?? new Error('render cancelled'));
        };
        const task: Task = {
          id: randomId(16), seq: ++seq, pool: WORKER_PATH_POOL[path], path, job, timeoutMs: opts.timeoutMs,
          enqueuedAt: now(), reclaims: 0,
          settle: (error, value) => {
            if (done) return;
            done = true;
            if (task.timer) clearTimeout(task.timer);
            opts.signal?.removeEventListener('abort', onAbort);
            if (error !== undefined) reject(error); else resolve(value!);
          },
        };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        enqueue(task);
      });
    },

    lease(pools, waitMs, signal) {
      if (closed || signal?.aborted) return Promise.resolve(null);
      // The oldest waiting job across the pools this worker serves.
      let oldest: Task | undefined;
      for (const pool of pools) {
        const head = queueOf(pool)[0];
        if (head && (!oldest || head.seq < oldest.seq)) oldest = head;
      }
      if (oldest) { unqueue(oldest); return Promise.resolve(grantTo(oldest)); }
      return new Promise<LeaseGrant | null>((resolve) => {
        const finish = (value: LeaseGrant | null): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const drop = (): void => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); };
        const onAbort = (): void => { drop(); finish(null); };
        const waiter: Waiter = { pools, grant: (task) => finish(grantTo(task)), cancel: () => finish(null) };
        const timer = setTimeout(() => { drop(); finish(null); }, Math.max(0, waitMs));
        timer.unref?.();
        signal?.addEventListener('abort', onAbort, { once: true });
        waiters.push(waiter);
      });
    },

    renew(id, token) {
      const task = current(id, token);
      if (!task) return false;
      task.lease!.until = now() + leaseMs;
      return true;
    },

    complete(id, token, reply) {
      const task = current(id, token);
      if (!task) return false;
      leased.delete(id);
      const payload = task.lease!.payload;
      event(task.pool, 'completed');
      task.settle(undefined, { payload, reply });
      return true;
    },

    abandon(id, token) {
      const task = current(id, token);
      if (!task) return;
      leased.delete(id);
      task.enqueuedAt = now();
      enqueue(task);
    },

    stats() {
      const t = now();
      const pools = new Set<RenderPool>([...queues.keys(), ...[...leased.values()].map((task) => task.pool), ...waiters.flatMap((w) => w.pools)]);
      return [...pools].sort().map((pool) => {
        const q = queueOf(pool);
        const oldest = q.reduce((min, task) => Math.min(min, task.enqueuedAt), Infinity);
        return {
          pool, waiting: q.length, oldestWaitSeconds: q.length ? Math.max(0, (t - oldest) / 1000) : 0,
          leased: [...leased.values()].filter((task) => task.pool === pool).length,
          idleWorkers: waiters.filter((w) => w.pools.includes(pool)).length,
        };
      });
    },

    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter.cancel();
      const error = new WorkerError('render worker dispatch is closed', 503, { code: 'RENDER_BUSY', retryAfter: 2 });
      for (const q of queues.values()) for (const task of q.splice(0)) task.settle(error);
      for (const task of leased.values()) task.settle(error);
      leased.clear();
    },
  };
}
