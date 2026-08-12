/**
 * Hand-rolled counting semaphore (plans/22 §5, plans/23 §3.C) — the render
 * worker's only concurrency guard around the Chromium context-open→close span.
 * Zero dependencies, on purpose: this worker stays free of anything beyond
 * node:http + node:crypto + playwright-core (see server.ts header), and a
 * semaphore is small enough to own outright rather than pull in a package for.
 *
 * Two properties the caller depends on:
 *   - FIFO fairness: whoever has been waiting longest gets the next permit
 *     that frees up, so one hot caller can't starve another under load.
 *   - A release always happens, even when the task throws/rejects — a
 *     concurrency guard that leaks permits on failure gets worse, not better,
 *     under exactly the load it exists to survive. `run()` is the way to get
 *     this for free (try/finally); `acquire()`'s caller must finally-release
 *     itself if it doesn't use `run()`.
 *
 * Deliberately NOT a queue with unbounded wait: `tryAcquire` exists so the
 * server can answer 503 immediately at capacity instead of queueing requests
 * inside the process — an in-worker queue would hide saturation from the HPA
 * (plans/23 §3.C's whole point). `acquire`/`run` (which DO wait) are here for
 * completeness and for tests; the HTTP routes use `tryAcquire`.
 */

export interface Semaphore {
  /** Permits currently checked out (0..limit). */
  readonly inUse: number;
  /** Configured capacity. */
  readonly limit: number;
  /** True when no permit is free right now (inUse >= limit). */
  readonly atCapacity: boolean;
  /** Callers currently queued in acquire() waiting for a permit (FIFO order). */
  readonly waiting: number;
  /** Take a permit if one is free right now; otherwise return null without
   *  waiting — no internal queue. The caller decides what "busy" means. */
  tryAcquire(): (() => void) | null;
  /** Take a permit, joining the FIFO wait line if none is free yet. Resolves
   *  with a release function. Calling the release function more than once is
   *  a no-op (idempotent) — it must never hand out a second permit. */
  acquire(): Promise<() => void>;
  /** Run `fn` under a permit (waiting if needed) and release it whether `fn`
   *  resolves or throws/rejects. The no-leak-on-failure guarantee lives here. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`semaphore limit must be a positive integer, got ${limit}`);
  }
  let inUse = 0;
  // FIFO queue of resolvers waiting for a permit — push to join the back,
  // shift to serve the front (the caller that has been waiting longest).
  const waiters: Array<(release: () => void) => void> = [];

  // Each acquired permit gets its OWN release closure (rather than one shared
  // release() that takes a token) so a caller can only ever double-release
  // the permit it was actually given, and that double-release is a safe no-op.
  function makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // idempotent: never hand out a permit twice
      released = true;
      const next = waiters.shift();
      if (next) {
        // Hand the permit directly to the next waiter (inUse stays the same)
        // rather than decrementing then letting a fresh tryAcquire() race for
        // it — that would break FIFO order under concurrent acquirers.
        next(makeRelease());
      } else {
        inUse--;
      }
    };
  }

  function tryAcquire(): (() => void) | null {
    if (inUse >= limit) return null;
    inUse++;
    return makeRelease();
  }

  function acquire(): Promise<() => void> {
    const immediate = tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    return new Promise<() => void>((resolve) => {
      waiters.push(resolve);
    });
  }

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    get inUse() { return inUse; },
    get limit() { return limit; },
    get atCapacity() { return inUse >= limit; },
    get waiting() { return waiters.length; },
    tryAcquire,
    acquire,
    run,
  };
}
