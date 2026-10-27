// SPDX-License-Identifier: MPL-2.0
/**
 * Render pools (plan 324 M3): where a render's work runs, decided by Work from
 * the tool and the instance policy, never by the request.
 *
 *  - `tier-a`: the in-process jsdom path in Work (hook-less tools, or hooked
 *    tools in a pack curated with render.allowHooksInFastPath).
 *  - `tier-b`: the Chromium render worker (hooked tools, and every raster or
 *    print conversion when a worker is configured).
 *
 * The pool is a label for queue signals and the lease endpoint today. Separate
 * worker deployments per pool, and an `untrusted` pool, are later M3 phases.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkerPath } from './worker-client.ts';

export const RENDER_POOLS = ['tier-a', 'tier-b'] as const;
export type RenderPool = typeof RENDER_POOLS[number];

export const isRenderPool = (value: unknown): value is RenderPool =>
  typeof value === 'string' && (RENDER_POOLS as readonly string[]).includes(value);

/** The pool each worker call needs. */
export const WORKER_PATH_POOL: Readonly<Record<WorkerPath, RenderPool>> = { '/render': 'tier-b', '/rasterise': 'tier-b' };

/** Mirrors pipeline.ts: a hooked tool renders in the worker unless the pack is curated for the fast path. */
export function renderPoolOf(manifest: { hooks?: unknown } | null | undefined, allowHooksInFastPath: boolean): RenderPool {
  return manifest?.hooks && !allowHooksInFastPath ? 'tier-b' : 'tier-a';
}

const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * Pool of a queued render, from the tool's manifest in the instance pack. Cached
 * for `ttlMs` because /metrics asks on every scrape; a tool that cannot be read
 * counts as `tier-a`, where the render will fail when it runs.
 */
export function createToolPoolReader(opts: { pack: string; allowHooksInFastPath: boolean; ttlMs?: number; now?: () => number }) {
  const ttl = opts.ttlMs ?? 60_000, now = opts.now ?? Date.now;
  const cache = new Map<string, { pool: RenderPool; at: number }>();
  return async (toolId: string): Promise<RenderPool> => {
    if (!TOOL_ID.test(toolId)) return 'tier-a';
    const hit = cache.get(toolId);
    if (hit && now() - hit.at < ttl) return hit.pool;
    let pool: RenderPool = 'tier-a';
    try {
      const manifest = JSON.parse(await readFile(join(opts.pack, 'tools', toolId, 'tool.json'), 'utf8')) as { hooks?: unknown };
      pool = renderPoolOf(manifest, opts.allowHooksInFastPath);
    } catch { /* unreadable tool: tier-a, see above */ }
    if (cache.size > 1024) cache.clear();
    cache.set(toolId, { pool, at: now() });
    return pool;
  };
}
