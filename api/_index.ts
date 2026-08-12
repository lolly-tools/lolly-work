/**
 * Vercel Function entry — the ONE catch-all that fronts the entire
 * lolly-work HTTP surface (plans/01-architecture.md §4, "Vercel trial
 * (interim, decided 2026-07-21)"). Every path this instance serves —
 * /healthz, /admin, /admin/*, /l/*, /api/auth/*, /api/v1/*, /catalog/* —
 * is funnelled here by ../vercel.json's catch-all `routes` rule. See that
 * file's header comment for why a plain rewrite alone isn't enough (it
 * would leave req.url reading this file's own destination path, "/api/index",
 * instead of the path the caller actually requested) and how the
 * `request.path` transform fixes that before this function ever runs.
 *
 * Signature is the plain Node.js (req, res) handler Vercel's Node.js runtime
 * supports natively for /api functions — no fetch/Request/Response
 * translation, no @vercel/node dependency needed. It's the exact shape
 * buildApp() already returns (server/src/api/app.ts), so this file is a
 * thin call-through plus the defensive path check below.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getApp } from './_lib/bootstrap.ts';

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Defensive fallback only — ../vercel.json's `request.path` transform is
 * the PRIMARY mechanism restoring the caller's original path into req.url
 * (current, documented Vercel behaviour: Project Configuration → routes →
 * transforms → `request.path`, "This is the URL path your Function reads
 * from req.url"). If that transform somehow didn't fire (a future Vercel
 * change, a `vercel dev` quirk, someone editing vercel.json without reading
 * its comment), req.url would still read this function's own mount path,
 * "/api/index" — every request would 404 against the app's router instead
 * of reaching its real route. Recover from whichever header the platform
 * might expose the original path under; none of these are guaranteed by
 * current public docs (only the vercel.json transform is), so this checks
 * a few plausible names and, failing that, logs loudly instead of silently
 * mis-handling the request.
 */
function restoreOriginalPath(req: IncomingMessage): void {
  const url = new URL(req.url ?? '/', 'http://local');
  if (url.pathname !== '/api/index') return; // the transform already restored the real path

  const original =
    headerValue(req, 'x-vercel-original-pathname') ??
    headerValue(req, 'x-matched-path') ??
    headerValue(req, 'x-invoke-path');
  if (!original) {
    console.warn(
      '[lolly-work/vercel] req.url is still "/api/index" — the vercel.json request.path transform did not fire, ' +
        'and no fallback path header was present. See api/index.ts and vercel.json.',
    );
    return;
  }
  req.url = original + url.search;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  restoreOriginalPath(req);
  const app = await getApp();
  await app(req, res);
}
