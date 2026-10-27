// SPDX-License-Identifier: MPL-2.0
/** Summaries for the push-against-pull benchmark. Pure, so the test pins them. */

export interface RenderRow {
  id: string; pool: string; entry: string; state: string; attempt: number;
  /** Epoch ms, from the database: the server's own clock at insert and settle. */
  createdAt: number; finishedAt: number | null; errorCode: string | null;
}

export interface Summary {
  renders: number; succeeded: number; failed: number;
  /** Seconds from submission (row inserted) to settlement, succeeded renders only. */
  p50: number | null; p95: number | null; p99: number | null; mean: number | null;
  /** Succeeded renders per second, over the window from the first submission
   *  until every render settled (succeeded or failed). A render that fails
   *  fast cannot shorten the window in its own favour beyond its settle time. */
  throughput: number | null;
  /** Share of renders that succeeded. */
  completion: number;
  /** p95 over every render, a failed one counting as never delivered
   *  (Infinity, which JSON writes as null). The D5 check uses this one. */
  p95Delivered: number | null;
  /** Attempts beyond the first, across all renders: retries after RENDER_BUSY or a worker failure. */
  retries: number;
  /** Error codes of failed renders, and of retried attempts that were recorded. */
  errors: Record<string, number>;
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarise(rows: readonly RenderRow[]): Summary {
  const done = rows.filter((r) => r.state === 'succeeded' && r.finishedAt !== null);
  const latencies = done.map((r) => (r.finishedAt! - r.createdAt) / 1000).sort((a, b) => a - b);
  const first = rows.length ? Math.min(...rows.map((r) => r.createdAt)) : 0;
  const settled = rows.filter((r) => r.finishedAt !== null);
  const last = settled.length ? Math.max(...settled.map((r) => r.finishedAt!)) : 0;
  const errors: Record<string, number> = {};
  for (const r of rows) if (r.errorCode) errors[r.errorCode] = (errors[r.errorCode] ?? 0) + 1;
  const round = (v: number | null, digits = 3) => (v === null ? null : Number(v.toFixed(digits)));
  return {
    renders: rows.length, succeeded: done.length, failed: rows.filter((r) => r.state === 'failed').length,
    p50: round(percentile(latencies, 50)), p95: round(percentile(latencies, 95)), p99: round(percentile(latencies, 99)),
    mean: round(latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null),
    throughput: round(done.length && last > first ? done.length / ((last - first) / 1000) : null),
    completion: round(rows.length ? done.length / rows.length : 0)!,
    p95Delivered: rows.length ? (() => {
      const all = rows.map((r) => (r.state === 'succeeded' && r.finishedAt !== null ? (r.finishedAt - r.createdAt) / 1000 : Infinity)).sort((a, b) => a - b);
      const v = percentile(all, 95)!;
      return Number.isFinite(v) ? round(v) : Infinity;
    })() : null,
    retries: rows.reduce((n, r) => n + Math.max(0, r.attempt - 1), 0),
    errors,
  };
}

/** Per pool plus `all`. */
export function summariseByPool(rows: readonly RenderRow[]): Record<string, Summary> {
  const pools = [...new Set(rows.map((r) => r.pool))].sort();
  return { all: summarise(rows), ...Object.fromEntries(pools.map((pool) => [pool, summarise(rows.filter((r) => r.pool === pool))])) };
}
