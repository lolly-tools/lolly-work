// SPDX-License-Identifier: MPL-2.0
/**
 * Connection settings shared by every node-postgres pool and client this
 * server opens (record store, blob store, migration runner).
 *
 * - A connect timeout. node-postgres waits forever by default, so a database
 *   that never answers (a suspended Neon compute that cannot resume, a black-
 *   holed route) used to hang a boot or a request with no error at all. 15 s
 *   covers a Neon cold start, which takes well under a few seconds.
 * - An idle timeout. A pool closes a connection nobody has used for 30 s, so a
 *   quiet long-lived host holds no connections. Neon suspends a compute after
 *   5 minutes without active queries and closes idle connections when it does
 *   (neon.com/docs/introduction/compute-lifecycle, checked 2026-10-03); an open
 *   idle connection does not keep it awake, but releasing them means a suspend
 *   never kills one that the pool would hand out next.
 * - A pool error listener. A connection that dies while idle in the pool (a
 *   compute suspend or restart, a network blip) makes the pool emit 'error';
 *   with no listener Node treats that as an unhandled 'error' event and exits
 *   the process. The pool has already dropped the connection, so logging it is
 *   all that is needed.
 */

export const PG_CONNECT_TIMEOUT_MS = 15_000;
export const PG_IDLE_TIMEOUT_MS = 30_000;

export interface PgPoolOptions {
  connectionString: string;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  max?: number;
}

/** Options for `new pg.Pool(...)`. */
export function pgPoolOptions(connectionString: string, extra: { max?: number } = {}): PgPoolOptions {
  return {
    connectionString,
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: PG_IDLE_TIMEOUT_MS,
    ...(extra.max !== undefined ? { max: extra.max } : {}),
  };
}

/** Log, rather than crash on, an error from a connection idling in `pool`.
 *  The message names the pool, never the connection string. */
export function guardPool<T>(pool: T, name: string): T {
  (pool as unknown as { on(event: 'error', listener: (err: Error) => void): void })
    .on('error', (err) => console.error(`[lolly-work] ${name} pool: idle connection closed: ${err.message}`));
  return pool;
}
