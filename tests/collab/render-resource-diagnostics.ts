// SPDX-License-Identifier: MPL-2.0
/** Fixed paths and match categories explain a missed hold without exposing tickets. */
import type { IncomingMessage, ServerResponse } from 'node:http';

const CATALOG = /^\/catalog\/(?:tools|assets)\/index(?:\.slim|\.sig)?(?:\.[a-f0-9]{16})?\.json$/;
const HOOK = /^\/tools\/(?:qr-code|sandbox)(?:@[a-f0-9]{16})?\/hooks\.js$/;
const FIXED = /^\/(?:api\/auth\/(?:config|session)|t\/(?:qr-code|sandbox))$/;
const EVENTS = ['page-created', 'main-frame-navigation', 'domcontentloaded', 'load'] as const;
type Event = typeof EVENTS[number];

/** Queries, other origins and arbitrary same-origin paths are never retained. */
export function renderDiagnosticPath(raw: string, base: string): string {
  try {
    const url = new URL(raw, base);
    if (url.origin !== new URL(base).origin) return 'external-or-unsupported';
    if (/^\/_app\/[A-Za-z0-9_-]+\.js$/.test(url.pathname)) return 'app-script';
    if (/^\/_app\/[A-Za-z0-9_-]+\.css$/.test(url.pathname)) return 'app-style';
    return url.pathname.length <= 256 && (url.pathname === '/' || CATALOG.test(url.pathname)
      || HOOK.test(url.pathname) || FIXED.test(url.pathname)) ? url.pathname : 'internal-other';
  } catch { return 'unparseable'; }
}

interface Read {
  path: string; atMs: number;
  pathMatches: boolean; methodMatches: boolean;
  tokenPresent: boolean; tokenMatches: boolean;
  revisionPresent: boolean; revisionMatches: boolean;
  status?: number; responseAtMs?: number;
}

/** Observe the real phase; this recorder neither holds requests nor changes deadlines. */
export function createRenderCancellationDiagnostics(base: string) {
  let target: { path: string; readToken: string; revision: string } | undefined;
  let started = 0, hookReads = 0, catalogReads = 0, bootstrapReads = 0;
  const hooks: Read[] = [], catalog: Read[] = [], bootstrap: Read[] = [];
  const lifecycle: Partial<Record<Event, { count: number; firstAtMs: number; lastAtMs: number }>> = Object.create(null);
  return {
    arm(value: { path: string; readToken: string; revision: string }) {
      if (target || !HOOK.test(value.path) || !value.readToken || !value.revision) throw new Error('A fresh hook diagnostic phase is required');
      target = value; started = performance.now();
    },
    progress(event: Event) {
      if (!target || !EVENTS.includes(event)) return;
      const atMs = performance.now() - started, row = lifecycle[event];
      if (row) { row.count++; row.lastAtMs = atMs; }
      else lifecycle[event] = { count: 1, firstAtMs: atMs, lastAtMs: atMs };
    },
    observe(req: IncomingMessage, res: ServerResponse) {
      if (!target) return;
      const path = renderDiagnosticPath(req.url ?? '/', base);
      const rows = HOOK.test(path) ? hooks : CATALOG.test(path) ? catalog
        : path === '/' || FIXED.test(path) || path === 'app-script' || path === 'app-style' ? bootstrap : null;
      if (!rows) return;
      if (rows === hooks) hookReads++; else if (rows === catalog) catalogReads++; else bootstrapReads++;
      if (rows.length >= (rows === hooks ? 24 : 32)) return;
      const row: Read = { path, atMs: performance.now() - started, pathMatches: path === target.path,
        methodMatches: req.method === 'GET', tokenPresent: !!req.headers['x-lw-render-read'],
        tokenMatches: req.headers['x-lw-render-read'] === target.readToken,
        revisionPresent: !!req.headers['x-lolly-brand-revision'], revisionMatches: req.headers['x-lolly-brand-revision'] === target.revision };
      rows.push(row);
      res.once('finish', () => { row.status = res.statusCode; row.responseAtMs = performance.now() - started; });
    },
    snapshot() {
      const now = performance.now() - started;
      const reads = (rows: Read[]) => rows.map(row => ({ ...row,
        ...(row.responseAtMs === undefined ? { pendingMs: now - row.atMs } : {}) }));
      return { targetPath: target?.path, hookReads, catalogReads, bootstrapReads, hooks: reads(hooks), catalog: reads(catalog),
        bootstrap: reads(bootstrap), lifecycle: Object.fromEntries(Object.entries(lifecycle).map(([event, row]) => [event, { ...row }])) };
    },
  };
}
