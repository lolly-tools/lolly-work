/**
 * Chromium render worker (plans/07/11) - the isolated browser tier the control
 * plane dispatches hooked / HTML-heavy tools to. It runs the LEAST-TRUSTED
 * content (tool hooks.js), so it is a separate, hardened deployment with no
 * database, no secrets beyond the shared HMAC key, and a locked-down browser
 * context; blast-separated from the control plane.
 *
 * Contract (mirrors server/src/render/worker-client.ts in the control plane):
 *   POST /render   headers: x-lw-render-sig: hmac_sha256_base64url(rawBody, SECRET)
 *                  body: { toolId, query, overrides, format:'svg', profile, ts }
 *                  → 200 { svg } | 4xx/5xx { error: { code, message } }
 *                  → 503 { error: { code: 'RENDER_BUSY', … } } + Retry-After
 *                    when LW_RENDER_MAX_CONCURRENT contexts are already open
 *   POST /rasterise  same envelope/backpressure; body: { svg, format, width?, ts }
 *   GET  /healthz  → 200 { ok } - liveness, independent of load
 *   GET  /readyz   → 200 { ok:true } below capacity, 503 { ok:false } at
 *                    capacity - readiness, so k8s pulls a saturated pod from
 *                    the Service instead of routing new work to it (plans/22
 *                    §5). Unauthenticated by design (no HMAC on a probe path).
 *
 * Rendering mirrors the proven MCP Tier-B path: drive a headless Chromium against
 * a real Lolly web shell's export URL and capture the SVG the app's own export
 * downloads - so hooks run in a real browser exactly as a user's Download would.
 * The browser is launched once and reused (a lazy singleton).
 *
 * Zero framework: node:http + node:crypto + playwright-core.
 */
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Browser } from 'playwright-core';
import { createSemaphore } from './semaphore.ts';

const PORT = Number(process.env.PORT ?? 8791);
const SECRET = process.env.LW_RENDER_WORKER_SECRET ?? '';
const WEB_BASE = (process.env.LOLLY_WEB_BASE ?? '').replace(/\/$/, '');
const TS_SKEW_MS = Number(process.env.LW_RENDER_TS_SKEW_MS ?? 5 * 60 * 1000);
const NAV_TIMEOUT_MS = Number(process.env.LW_RENDER_NAV_TIMEOUT_MS ?? 30_000);
const EXPORT_TIMEOUT_MS = Number(process.env.LW_RENDER_EXPORT_TIMEOUT_MS ?? 20_000);
const MAX_CONCURRENT = Number(process.env.LW_RENDER_MAX_CONCURRENT ?? 4);

if (!SECRET) { console.error('[render-worker] LW_RENDER_WORKER_SECRET is required'); process.exit(1); }
if (!WEB_BASE) { console.error('[render-worker] LOLLY_WEB_BASE is required (a served Lolly web shell)'); process.exit(1); }

// Caps concurrent Chromium contexts (plans/22 §5, plans/23 §3.C): one browser,
// unboundedly many `browser.newContext()`s per request was the exposure - a
// 400-asset batch fanned out 400 contexts. Guards the context-open→close span
// of both /render and /rasterise below. At capacity the HTTP layer answers 503
// immediately (see `busy()`) rather than queueing - an in-worker queue would
// hide saturation from the HPA, so the plane owns retry policy instead.
const sem = createSemaphore(MAX_CONCURRENT);

// ── HMAC (identical scheme to lib/crypto.ts hmac/macEquals) ────────────────────
const hmac = (data: string): string => createHmac('sha256', SECRET).update(data).digest('base64url');
function macEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ── lazy Chromium singleton ───────────────────────────────────────────────────
let browserP: Promise<Browser> | null = null;
// Test-only injection point: swaps the real Chromium singleton for a stub so
// the HTTP/HMAC/semaphore behavior in this file is exercisable without
// launching a browser. Production never calls this; it's exported purely for
// tests (see tests/render-worker-server.test.ts).
let browserGetterOverride: (() => Promise<Browser>) | null = null;
export function __setBrowserGetterForTests(fn: (() => Promise<Browser>) | null): void {
  browserGetterOverride = fn;
}
async function getBrowser(): Promise<Browser> {
  if (browserGetterOverride) return browserGetterOverride();
  if (!browserP) {
    browserP = (async () => {
      const { chromium } = await import('playwright-core');
      return chromium.launch({
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        ...(process.env.LOLLY_BROWSER_PATH ? { executablePath: process.env.LOLLY_BROWSER_PATH } : {}),
        ...(process.env.LOLLY_BROWSER_CHANNEL ? { channel: process.env.LOLLY_BROWSER_CHANNEL } : {}),
      });
    })().catch((err) => { browserP = null; throw err; });
  }
  return browserP;
}

function exportUrl(toolId: string, query: string, overrides: Record<string, unknown>): string {
  const params = new URLSearchParams(query); // parses the shared param contract (incl. packed z=)
  // Policy-baked locked values win - appended after, so they override the query.
  for (const [k, v] of Object.entries(overrides ?? {})) {
    params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  params.set('format', 'svg');
  params.set('export', '1');
  return `${WEB_BASE}/t/${encodeURIComponent(toolId)}?${params.toString()}`;
}

async function renderSvg(job: { toolId: string; query: string; overrides: Record<string, unknown> }): Promise<string> {
  const browser = await getBrowser();
  const ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    const downloadP = page.waitForEvent('download', { timeout: EXPORT_TIMEOUT_MS });
    // 'commit' returns once navigation starts; the export fires later, after the
    // tool mounts and its hooks settle. The download event is the real gate.
    await page.goto(exportUrl(job.toolId, job.query, job.overrides), { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS });
    const download = await downloadP;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    await download.delete().catch(() => {});
    const svg = Buffer.concat(chunks).toString('utf8');
    if (!/<svg[\s>]/i.test(svg)) throw new Error('export did not produce an <svg>');
    return svg;
  } finally {
    await ctx.close();
  }
}

// Rasterise a FINISHED svg (already watermarked + provenance-islanded by the plane)
// to `format` bytes via Chromium - the single-rasteriser path replacing in-process
// resvg (plans/22). The plane keeps provenance + C2PA; the worker only turns pixels.
// NOTE: written to the worker-client contract but must be verified against a real
// Chromium before the plane removes its resvg fallback (see plans/22 phase 4).
const RASTER_MAX_EDGE = 10_000;
/**
 * Chromium's page.pdf stamps wall-clock CreationDate/ModDate into the document
 * info, so two renders of the SAME svg differ whenever the clock ticks a second
 * between them - measured in the 2026-08-11 fidelity audit (plans/22 §6.2), and
 * a direct break of "same inputs, same pixels" (cache re-fills would churn
 * ETags, and re-signed C2PA bytes would differ for no visual reason). Pin both
 * dates to the epoch by SAME-LENGTH byte splice - xref offsets stay valid
 * because nothing moves. A date whose length doesn't match is left alone
 * (defensive: a future Chromium format change must not corrupt the file).
 * Exported for its unit test.
 */
export function pinPdfDates(pdf: Buffer): Buffer {
  const out = Buffer.from(pdf); // copy - never mutate the caller's view
  const re = /\/(CreationDate|ModDate) \(D:([^)]*)\)/g;
  const text = out.toString('latin1');
  for (const m of text.matchAll(re)) {
    const stamp = m[2]!;
    const pinned = `19700101000000+00'00'`.slice(0, stamp.length);
    if (pinned.length !== stamp.length) continue;
    out.write(pinned, m.index! + m[0]!.indexOf('(D:') + 3, 'latin1');
  }
  return out;
}

async function rasterise(job: { svg: string; format: string; width?: number }): Promise<{ bytes: Buffer; mime: string }> {
  const fmt = job.format.toLowerCase();
  const browser = await getBrowser();
  const ctx = await browser.newContext({ serviceWorkers: 'block', deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    const w = job.width && job.width > 0 ? Math.min(Math.round(job.width), RASTER_MAX_EDGE) : 0;
    // Lay the SVG out at the requested width (height follows its aspect). Transparent
    // ground so PNG keeps alpha; the SVG's own background rect (if any) still paints.
    const html = `<!doctype html><meta charset="utf-8">`
      + `<style>*{margin:0;padding:0}html,body{background:transparent}`
      + `svg{display:block;${w ? `width:${w}px;height:auto;` : ''}}</style>${job.svg}`;
    await page.setContent(html, { waitUntil: 'networkidle', timeout: EXPORT_TIMEOUT_MS });
    if (fmt === 'pdf') {
      const pdf = await page.pdf({ printBackground: true });
      return { bytes: pinPdfDates(Buffer.from(pdf)), mime: 'application/pdf' };
    }
    const el = await page.$('svg');
    if (!el) throw new Error('no <svg> in raster payload');
    // Playwright screenshot emits png/jpeg only; jpg→jpeg, everything else→png.
    const type = fmt === 'jpg' || fmt === 'jpeg' ? 'jpeg' as const : 'png' as const;
    const buf = await el.screenshot({ type, ...(type === 'png' ? { omitBackground: true } : {}) });
    return { bytes: Buffer.from(buf), mime: type === 'jpeg' ? 'image/jpeg' : 'image/png' };
  } finally {
    await ctx.close();
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const sendJson = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
};
const fail = (res: import('node:http').ServerResponse, status: number, code: string, message: string): void =>
  sendJson(res, status, { error: { code, message } });
// Capacity refusal: immediate, no queueing (see `sem` above). Retry-After is a
// plain, deliberately-static hint (plans/23 §3.C) - the plane decides its own
// retry policy; this just says "not now, don't hammer it".
const busy = (res: import('node:http').ServerResponse): void => {
  res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '2' });
  res.end(JSON.stringify({ error: { code: 'RENDER_BUSY', message: 'render worker at capacity — retry shortly' } }));
};

// Exported so tests can listen on an OS-assigned port and drive real HTTP
// requests at it without launching Chromium (see __setBrowserGetterForTests).
export const server = createServer((req, res) => {
  void (async () => {
    if (req.method === 'GET' && req.url === '/healthz') return sendJson(res, 200, { ok: true });
    // Readiness tracks LOAD, not liveness: k8s should pull a saturated pod out
    // of the Service (plans/22 §5) so it stops receiving NEW requests while it
    // drains, without killing it. Deliberately unauthenticated (no HMAC) - a
    // probe endpoint that required signing the request wouldn't be a usable
    // probe endpoint.
    if (req.method === 'GET' && req.url === '/readyz') return sendJson(res, sem.atCapacity ? 503 : 200, { ok: !sem.atCapacity });
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'POST' || (path !== '/render' && path !== '/rasterise')) {
      return fail(res, 404, 'NOT_FOUND', `no route for ${req.method} ${req.url}`);
    }
    // Read the body (bounded).
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of req) {
      total += (c as Buffer).length;
      if (total > 256 * 1024) return fail(res, 413, 'TOO_LARGE', 'request body too large');
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8');

    // Verify the HMAC over the exact raw bytes, then the timestamp freshness.
    const sig = req.headers['x-lw-render-sig'];
    if (typeof sig !== 'string' || !macEquals(sig, hmac(raw))) {
      return fail(res, 401, 'BAD_SIGNATURE', 'invalid or missing render signature');
    }
    let job: { toolId?: unknown; query?: unknown; overrides?: unknown; format?: unknown; ts?: unknown; svg?: unknown; width?: unknown };
    try { job = JSON.parse(raw); } catch { return fail(res, 400, 'BAD_JSON', 'invalid JSON body'); }
    if (typeof job.ts !== 'number' || Math.abs(Date.now() - job.ts) > TS_SKEW_MS) {
      return fail(res, 401, 'STALE', 'request timestamp outside the accepted window');
    }

    // /rasterise - a finished SVG → format bytes (the single-rasteriser path).
    if (path === '/rasterise') {
      if (typeof job.svg !== 'string' || !/<svg[\s>]/i.test(job.svg) || typeof job.format !== 'string') {
        return fail(res, 400, 'BAD_REQUEST', 'expected { svg, format, width? }');
      }
      const width = typeof job.width === 'number' ? job.width : undefined;
      // No permit free ⇒ fail fast (503), don't wait in line - see `sem` above.
      const release = sem.tryAcquire();
      if (!release) return busy(res);
      try {
        const { bytes, mime } = await rasterise({ svg: job.svg, format: job.format, width });
        return sendJson(res, 200, { bytesB64: bytes.toString('base64'), mime });
      } catch (e) {
        return fail(res, 502, 'RASTER_FAILED', `Chromium raster failed: ${(e as Error).message}`);
      } finally {
        release(); // always, including on the catch above - a failed raster must not leak capacity
      }
    }

    // /render - a toolId → SVG via the shell export (hooked/HTML tools).
    if (typeof job.toolId !== 'string' || typeof job.query !== 'string' || job.format !== 'svg') {
      return fail(res, 400, 'BAD_REQUEST', 'expected { toolId, query, format:"svg", overrides }');
    }
    const overrides = (job.overrides && typeof job.overrides === 'object') ? job.overrides as Record<string, unknown> : {};

    const release = sem.tryAcquire();
    if (!release) return busy(res);
    try {
      const svg = await renderSvg({ toolId: job.toolId, query: job.query, overrides });
      return sendJson(res, 200, { svg });
    } catch (e) {
      return fail(res, 502, 'RENDER_FAILED', `Chromium render failed: ${(e as Error).message}`);
    } finally {
      release(); // always, including on the catch above - a failed render must not leak capacity
    }
  })().catch((e) => {
    if (!res.headersSent) fail(res, 500, 'INTERNAL', (e as Error).message);
  });
});

server.listen(PORT, () => console.log(`[render-worker] listening on :${PORT} → web shell ${WEB_BASE}`));

// Graceful shutdown so Chromium is torn down (no leaked processes).
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close();
    void browserP?.then((b) => b.close()).catch(() => {}).finally(() => process.exit(0));
    if (!browserP) process.exit(0);
  });
}
