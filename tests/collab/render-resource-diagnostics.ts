// SPDX-License-Identifier: MPL-2.0
/** Fixed paths and match categories explain a missed hold without exposing tickets. */
import type { IncomingMessage, ServerResponse } from 'node:http';

const CATALOG = /^\/catalog\/(?:tools|assets)\/index(?:\.slim|\.sig)?(?:\.[a-f0-9]{16})?\.json$/;
const HOOK = /^\/tools\/(?:qr-code|sandbox)(?:@[a-f0-9]{16})?\/hooks\.js$/;
const FIXED = /^\/(?:api\/auth\/(?:config|session)|t\/(?:qr-code|sandbox))$/;
const TOOL_FILE = /^\/tools\/(?:qr-code|sandbox)(?:@[a-f0-9]{16})?\/(tool\.json|template\.html|styles\.css|presentation\.js)$/;
const TOOL_PHASE = { 'tool.json': 'tool-manifest', 'template.html': 'tool-template', 'styles.css': 'tool-style', 'presentation.js': 'tool-presentation' } as const;
const EVENTS = ['page-created', 'main-frame-navigation', 'domcontentloaded', 'load'] as const;
type Event = typeof EVENTS[number];

/** Queries, other origins and arbitrary same-origin paths are never retained. */
export function renderDiagnosticPath(raw: string, base: string): string {
  try {
    const url = new URL(raw, base);
    if (url.origin !== new URL(base).origin) return 'external-or-unsupported';
    if (/^\/_app\/[A-Za-z0-9_-]+\.js$/.test(url.pathname)) return 'app-script';
    if (/^\/_app\/[A-Za-z0-9_-]+\.css$/.test(url.pathname)) return 'app-style';
    const tool = TOOL_FILE.exec(url.pathname)?.[1] as keyof typeof TOOL_PHASE | undefined;
    if (tool) return TOOL_PHASE[tool];
    return url.pathname.length <= 256 && (url.pathname === '/' || CATALOG.test(url.pathname)
      || HOOK.test(url.pathname) || FIXED.test(url.pathname)) ? url.pathname : 'internal-other';
  } catch { return 'unparseable'; }
}

interface Read {
  path: string; atMs: number;
  pathMatches: boolean; methodMatches: boolean;
  tokenPresent: boolean; tokenMatches: boolean;
  revisionPresent: boolean; revisionMatches: boolean;
  status?: number; responseAtMs?: number; closedAtMs?: number;
}

interface Resource {
  requests: number; completed: number; closed: number; pending: number; errorResponses: number;
  firstAtMs: number; lastAtMs: number; lastResponseAtMs?: number; lastStatus?: number;
}

function resourceCategory(path: string): string | undefined {
  if (HOOK.test(path)) return 'tool-hook';
  if (CATALOG.test(path)) return path.startsWith('/catalog/assets/') ? 'catalog-assets'
    : path.includes('.sig.') ? 'catalog-signature' : path.includes('.slim.') ? 'catalog-slim' : 'catalog-tools';
  if (Object.values(TOOL_PHASE).some(value => value === path) || path === 'app-script' || path === 'app-style') return path;
  if (path === '/api/auth/config') return 'auth-config';
  if (path === '/api/auth/session') return 'auth-session';
  if (path === '/') return 'entry';
  if (FIXED.test(path)) return 'tool-navigation';
}

/** Observe the real phase; this recorder neither holds requests nor changes deadlines. */
export function createRenderCancellationDiagnostics(base: string) {
  let target: { path: string; readToken: string; revision: string } | undefined;
  let started = 0, hookReads = 0, catalogReads = 0, bootstrapReads = 0, toolReads = 0;
  const hooks: Read[] = [], catalog: Read[] = [], bootstrap: Read[] = [], tools: Read[] = [], recent: Read[] = [];
  const resources: Record<string, Resource> = Object.create(null);
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
      const category = resourceCategory(path);
      if (!category) return;
      const rows = HOOK.test(path) ? hooks : CATALOG.test(path) ? catalog
        : category.startsWith('tool-') && !FIXED.test(path) ? tools : bootstrap;
      if (rows === hooks) hookReads++; else if (rows === catalog) catalogReads++; else if (rows === tools) toolReads++; else bootstrapReads++;
      const row: Read = { path, atMs: performance.now() - started, pathMatches: path === target.path,
        methodMatches: req.method === 'GET', tokenPresent: !!req.headers['x-lw-render-read'],
        tokenMatches: req.headers['x-lw-render-read'] === target.readToken,
        revisionPresent: !!req.headers['x-lolly-brand-revision'], revisionMatches: req.headers['x-lolly-brand-revision'] === target.revision };
      if (rows.length < (rows === hooks ? 24 : 32)) rows.push(row);
      recent.push(row); if (recent.length > 32) recent.shift();
      const summary = resources[category] ??= { requests: 0, completed: 0, closed: 0, pending: 0, errorResponses: 0,
        firstAtMs: row.atMs, lastAtMs: row.atMs };
      summary.requests++; summary.pending++; summary.lastAtMs = row.atMs;
      let done = false;
      res.once('finish', () => {
        if (done) return;
        done = true; row.status = res.statusCode; row.responseAtMs = performance.now() - started;
        summary.completed++; summary.pending--; summary.lastResponseAtMs = row.responseAtMs; summary.lastStatus = row.status;
        if (row.status >= 400) summary.errorResponses++;
      });
      res.once('close', () => { if (!done) { done = true; row.closedAtMs = performance.now() - started; summary.closed++; summary.pending--; } });
    },
    snapshot() {
      const now = performance.now() - started;
      const reads = (rows: Read[]) => rows.map(row => ({ ...row,
        ...(row.responseAtMs === undefined && row.closedAtMs === undefined ? { pendingMs: now - row.atMs } : {}) }));
      return { targetPath: target?.path, hookReads, catalogReads, bootstrapReads, toolReads, hooks: reads(hooks), catalog: reads(catalog),
        bootstrap: reads(bootstrap), tools: reads(tools), recent: reads(recent),
        resources: Object.fromEntries(Object.entries(resources).map(([category, row]) => [category, { ...row }])),
        lifecycle: Object.fromEntries(Object.entries(lifecycle).map(([event, row]) => [event, { ...row }])) };
    },
  };
}
