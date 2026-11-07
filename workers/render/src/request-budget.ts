// SPDX-License-Identifier: MPL-2.0
/**
 * How many requests one render may make (plans/82 M3, W-M3-6).
 *
 * A render opens the Lolly shell, which loads its code as many small files.
 * The old flat budget of 512 requests fell behind the shell: exporting a
 * Design rules tool now takes about 535 requests, so the worker refused it.
 * The budget now follows the shell the worker renders with: the number of
 * app files the shell lists in its precache.json, plus fixed headroom for
 * what is not shell code (the catalog, fonts, tool files and API calls).
 * A page cannot load more distinct app files than the shell has, so this
 * keeps a runaway page bounded while a growing shell still fits.
 *
 * It stays a bound whatever the shell says: never below the floor, never
 * above the ceiling, and the fallback applies when the list cannot be read.
 * Dependency-free on purpose, so the control plane and the console can read
 * the same numbers.
 */

/**
 * The most requests one render fetches at a time. Each fetch the page makes
 * goes through the worker, which would otherwise open about 500 connections
 * to the instance at once while the shell loads; queued, they open 32 at a
 * time, still well above the 6 per host a browser opens on its own.
 */
export const REQUEST_CONCURRENCY = 32;
/** Never below the budget the worker had before it followed the shell. */
export const REQUEST_BUDGET_FLOOR = 512;
/** Requests on top of the shell's own files: catalog, fonts, tool files, API. */
export const REQUEST_BUDGET_HEADROOM = 256;
/** A hard bound, whatever the shell lists. */
export const REQUEST_BUDGET_CEILING = 4096;
/** When the shell's file list cannot be read: room for today's shell. */
export const REQUEST_BUDGET_FALLBACK = 1024;
/** How long a reading of the shell's file list is used before it is read again. */
export const REQUEST_BUDGET_REFRESH_MS = 60_000;
/** The largest file list the worker reads. */
export const PRECACHE_MAX_BYTES = 4 * 1024 * 1024;
/** The largest single response a render may receive. */
export const RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
/** The most a render may receive in all. */
export const RENDER_MAX_BYTES = 128 * 1024 * 1024;

/** The per-render request budget for a shell with this many app files. */
export function requestBudgetFor(appFiles: number | null): number {
  if (appFiles === null || !Number.isSafeInteger(appFiles) || appFiles < 0) return REQUEST_BUDGET_FALLBACK;
  return Math.min(REQUEST_BUDGET_CEILING, Math.max(REQUEST_BUDGET_FLOOR, appFiles + REQUEST_BUDGET_HEADROOM));
}

/** The number of app files a shell's precache.json lists, or null when it lists none. */
export function shellAppFiles(precache: unknown): number | null {
  const groups = (precache as { groups?: unknown } | null)?.groups;
  const app = groups && typeof groups === 'object' ? (groups as { app?: unknown }).app : undefined;
  return Array.isArray(app) ? app.length : null;
}

export interface ShellBudget {
  /** The budget for the next render, read from the shell when the last reading is stale. */
  current(): Promise<number>;
}

/**
 * Reads the shell's precache.json at most once per refresh interval, one
 * reading at a time. A failed reading keeps the last good budget, or the
 * fallback when there is none, until the next interval.
 */
export function createShellBudget(webBase: string, opts: {
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number; onFallback?: (reason: string) => void;
} = {}): ShellBudget {
  const get = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let good: number | null = null;
  let value: number | null = null;
  let readAt = 0;
  let reading: Promise<number> | null = null;
  const read = async (): Promise<number> => {
    let reason: string;
    try {
      const res = await get(`${webBase}/precache.json`, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      const declared = Number(res.headers.get('content-length'));
      if (!res.ok) reason = `the shell answered ${res.status}`;
      else if (Number.isFinite(declared) && declared > PRECACHE_MAX_BYTES) reason = 'the file list is larger than the worker reads';
      else {
        const text = await res.text();
        const files = text.length > PRECACHE_MAX_BYTES ? null : shellAppFiles(JSON.parse(text));
        if (files !== null) return good = requestBudgetFor(files);
        reason = 'the file list has no app files';
      }
    } catch {
      reason = 'the file list could not be read';
    }
    opts.onFallback?.(reason);
    return good ?? REQUEST_BUDGET_FALLBACK;
  };
  return {
    current() {
      if (value !== null && now() - readAt < REQUEST_BUDGET_REFRESH_MS) return Promise.resolve(value);
      reading ??= read().then((budget) => { value = budget; readAt = now(); return budget; }).finally(() => { reading = null; });
      return reading;
    },
  };
}
