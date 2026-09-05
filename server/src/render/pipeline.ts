/**
 * The render pipeline - the fourth HostV1 shell's core (plans/07).
 *
 * renderTool(): tool id + format + URL-mode query → bytes. It loads the tool via
 * the real engine, enforces policy (overlays) BEFORE rendering, renders the
 * hook-less fast path in jsdom, optionally composites a preview watermark, and
 * rasterises to PNG via resvg. An in-process LRU caches finished bytes, keyed by
 * the render cache-key contract (render/cache-key.ts) so a policy edit or pack
 * publish invalidates exactly the affected renders.
 *
 * The engine, jsdom, and resvg are HEAVY and imported LAZILY (dynamic import)
 * inside the functions that need them, so importing this module - which app.ts
 * does at boot - pulls in only zero-dep code (cache-key, overlay, org-config,
 * watermark, host). A boot that never renders stays instant.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { InstanceConfig } from '../config/instance.ts';
import type { EngineApi, LoadedTool, Profile } from './contract.ts';
import { loadEngine } from './contract.ts';
import type { ToolOverlay, ParamViolation } from '../policy/overlay.ts';
import { checkParams, lockedValues } from '../policy/overlay.ts';
import { policyVersionOf } from '../policy/org-config.ts';
import { renderViaWorker, rasteriseViaWorker, WorkerError, type WorkerConfig } from './worker-client.ts';
import type { LoadedSigner } from './c2pa-signer.ts';
import { renderCacheKey } from './cache-key.ts';
import { applyPreviewWatermark } from './watermark.ts';
import { withRenderHost } from './host.ts';
import { parseHostedProviderRef, type HostedAssetResult, type HostedProviderRef } from '../catalog/providers/asset-resolver.ts';
import {
  addPngProvenance, collectCatalogRefs, embedSvgProvenance, provenanceDoc,
  type ProvenanceDoc, type ProvenanceIngredient,
} from './provenance.ts';

// The format ceiling lives in capabilities.ts (shared with org-config's
// advertisement - plans/23 §3.A); re-exported so render callers keep one import.
export { RENDER_TIER, WORKER_RASTER_FORMATS, renderCapabilities, type RenderFormat, type RenderCapabilities } from './capabilities.ts';
import { renderCapabilities } from './capabilities.ts';

/** Longest raster edge the resvg path will produce (an unbounded content-sized
 *  SVG must never dictate the allocation - mirrors the MCP service's cap). */
const MAX_RASTER_EDGE_PX = 10_000;

/** Upper bound on the resvg scale factor itself - guards against a degenerate
 *  targetWidthPx producing an absurd scale before the aspect-ratio check below. */
const MAX_SCALE = 1e9;

/** Escape hatch during the Tier-B consolidation (plans/22): force the in-process
 *  resvg raster path even when a Chromium worker is configured. Lets a deploy fall
 *  back for one release if the worker raster path misbehaves. Removed with resvg. */
const LEGACY_RESVG = process.env.LW_RENDER_LEGACY_RESVG === '1';

/** A caller-facing render problem carrying an HTTP status + envelope code. */
export class RenderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly violations?: ParamViolation[];
  /** Seconds the caller should back off - set when a saturated worker answered
   *  503 RENDER_BUSY (plans/23 §3.C); app.ts surfaces it as `Retry-After`. */
  retryAfter?: number;
  constructor(code: string, status: number, message: string, violations?: ParamViolation[]) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.status = status;
    if (violations) this.violations = violations;
  }
}

/** A saturated worker (503 RENDER_BUSY + Retry-After) is a retryable capacity
 *  answer, not a worker fault - keep its code and back-off so app.ts can pass
 *  both to the client (plans/23 §3.C). Anything else stays the generic wrap. */
function renderErrorFromWorker(e: WorkerError): RenderError {
  const err = new RenderError(e.code ?? 'RENDER_WORKER_FAILED', e.status, e.message);
  if (e.retryAfter !== undefined) err.retryAfter = e.retryAfter;
  return err;
}

export interface RenderDeps {
  config: InstanceConfig;
  /** The Chromium render worker, when configured (config.render.worker.url set +
   *  LW_RENDER_WORKER_SECRET present). Absent ⇒ hooked tools still 501. */
  worker?: WorkerConfig;
  /** The instance C2PA signing identity, when configured. Present ⇒ every export
   *  carries a signed Content Credential; absent ⇒ unsigned provenance. */
  signer?: LoadedSigner | null;
  /** Resolve catalog refs the render consumed into provenance ingredients
   *  (plans/17: "«filename» from «provider»" travels with every export).
   *  Provided by app.ts, which can see the store + federation; absent (older
   *  callers, unit tests) → exports carry no provenance block. */
  resolveProvenance?: (refs: string[]) => Promise<ProvenanceIngredient[]>;
  /**
   * The instance-owned half of `catalogVersion` (plans/31 §6). The pack's own
   * catalog index is a file, so its mtime sees pack changes; instance assets
   * live in the store and their bytes can move under a stable id when a new
   * version lands or a rollback points the head at an older one. Without this
   * component a render that consumed `inst/<id>` would keep serving the old
   * bytes from cache under a key that never changed. Supplied by app.ts (which
   * can see the store) and memoized there; absent - older callers, unit tests -
   * leaves the key exactly as it was.
   */
  instanceCatalogVersion?: () => Promise<string> | string;
  /** Hosted rungs of the engine asset-provider grammar. Resolved before the
   * cache key and before worker dispatch so both render tiers see identical,
   * content-addressed values. */
  hostedResolver?: (ref: HostedProviderRef) => Promise<HostedAssetResult | null>;
}

export interface RenderRequest {
  toolId: string;
  format: string;
  /** URL-mode query string (no leading '?'), the shared param contract. */
  query: string;
  /** The caller's group set for policy resolution (never trusted for identity). */
  principal: { groups: string[] } | null;
  /** Server-built profile for `bindToProfile` resolution - from the auth'd user, never params. */
  profile: Profile;
  /** All tool overlays (the policy version hashes the full set; the tool's own is derived). */
  overlays: Map<string, ToolOverlay>;
  /** Force the preview watermark (link/preview contexts) regardless of overlay. */
  watermarkPreview?: boolean;
}

export interface RenderOutput {
  bytes: Uint8Array;
  mime: string;
  cacheKey: string;
  /** Present when the render consumed catalog assets and a resolver was wired. */
  provenance?: ProvenanceDoc;
}

async function resolveHostedValues(value: unknown, resolve?: RenderDeps['hostedResolver']): Promise<unknown> {
  if (!resolve) return value;
  const ref = parseHostedProviderRef(value);
  if (ref && (ref.provider === 'cms' || ref.provider === 'net')) {
    const result = await resolve(ref);
    if (!result) throw new RenderError('ASSET_PROVIDER_UNAVAILABLE', 422, `No hosted resolver could resolve ${ref.raw}`);
    return result.asset;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveHostedValues(item, resolve)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveHostedValues(item, resolve)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

function queryFromValues(values: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return query.toString();
}

export async function renderTool(deps: RenderDeps, req: RenderRequest): Promise<RenderOutput> {
  // 'jpeg' is the same format as 'jpg' everywhere downstream (the worker
  // normalises too) - fold it before the gate so both spellings behave alike.
  const format = req.format.toLowerCase() === 'jpeg' ? 'jpg' : req.format.toLowerCase();
  // Capability gate: the SAME function that fills org_config's render block
  // (plans/23 §3.A), so what shells are offered and what this gate accepts can
  // never drift. A worker widens the set (plans/22 §6.3); the legacy-resvg
  // escape hatch narrows it back to the workerless tier, honestly.
  const caps = renderCapabilities(!!deps.worker && !LEGACY_RESVG);
  if (!caps.formats.includes(format)) {
    throw new RenderError('UNSUPPORTED_FORMAT', 400,
      `Format "${req.format}" is not rendered here — supported: ${caps.formats.join(', ')}`);
  }

  const engine = await loadEngine();
  const pack = deps.config.instance.pack;

  // Load the tool through the real engine (validates the manifest + enforces its
  // engineVersion range). fetchFile resolves against <pack>/tools/.
  const fetchFile = (p: string): Promise<string> => readFile(join(pack, 'tools', p), 'utf8');
  let tool: LoadedTool;
  try {
    tool = await engine.loadTool(req.toolId, fetchFile);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      throw new RenderError('TOOL_NOT_FOUND', 404, `No such tool: ${req.toolId}`);
    }
    throw new RenderError('TOOL_LOAD_FAILED', 400, `Tool "${req.toolId}" failed to load: ${(e as Error).message}`);
  }

  // A hooked tool can't run in the in-process jsdom fast path (its hooks.js may
  // use real browser APIs). It renders in-process only when the pack is curated
  // to allow it; otherwise it goes to the isolated Chromium worker, and 501s only
  // when no worker is configured. Decision applied AFTER policy/baking below.
  const hooked = !!tool.hooksSource && !deps.config.render.allowHooksInFastPath;

  // Parse the shared URL-mode query (unpacking a packed z= first).
  const expanded = await engine.expandQuery(req.query);
  const st = engine.parseUrlState(expanded, tool.manifest);

  // Policy BEFORE render. A caller that supplies a locked/hidden/not-allowed
  // param is refused (422); then the overlay's locked values are baked over the
  // caller's - so a locked input renders its policy value regardless of input.
  const overlay = req.overlays.get(req.toolId);
  const groups = req.principal?.groups ?? [];
  // Per-tool format policy (overlay enforce.formats - plans/23 §3.A): a format
  // the deployment CAN produce may still be disallowed for this tool. A policy
  // 403, deliberately distinct from the capability 400 at the top: absent (400)
  // vs forbidden-for-this-tool (403), so shells and operators can tell which.
  if (overlay?.enforce?.formats
      && !overlay.enforce.formats.some((f) => (f === 'jpeg' ? 'jpg' : f) === format)) {
    throw new RenderError('FORMAT_NOT_ALLOWED', 403,
      `Policy allows only ${overlay.enforce.formats.join(', ')} for "${req.toolId}"`);
  }
  const violations = checkParams(st.values as Record<string, unknown>, overlay, groups);
  if (violations.length) {
    const params = violations.map((v) => v.param).join(', ');
    throw new RenderError(violations[0]!.code, 422,
      `Policy forbids these params for your access: ${params}`, violations);
  }
  const bakedValues = await resolveHostedValues(
    { ...st.values, ...lockedValues(overlay, groups) }, deps.hostedResolver,
  ) as Record<string, unknown>;

  // Cache key: tool + version + engine + catalog + policy + format + baked params.
  // The catalog half is the pack's index version AND the instance-owned assets'
  // fingerprint, so a head move on an inst/* asset invalidates every render
  // that could have consumed it (plans/31 §6).
  const catalogVersion = await catalogVersionOf(deps, pack);
  const policyVersion = policyVersionOf(req.overlays, {});
  const cacheKey = renderCacheKey({
    toolId: req.toolId,
    toolVersion: tool.manifest.version,
    engineVersion: engine.ENGINE_VERSION,
    catalogVersion,
    policyVersion,
    format,
    params: bakedValues,
  });

  const cached = cacheGet(cacheKey);
  if (cached) return { bytes: cached.bytes, mime: cached.mime, cacheKey, ...(cached.provenance ? { provenance: cached.provenance } : {}) };

  const watermark = req.watermarkPreview === true || overlay?.enforce?.watermark === 'always';

  // Pixel dimensions for the export (physical units → px via the engine's math).
  const pxW = toPx(engine, st.width, st.unit, st.dpi);
  const pxH = toPx(engine, st.height, st.unit, st.dpi);

  // Render path: hooked tool → Chromium worker (or 501 when none); otherwise the
  // in-process jsdom fast path. Both converge on an SVG string post-processed
  // identically below (watermark → provenance → raster).
  let svgStr: string;
  if (hooked) {
    if (!deps.worker) {
      throw new RenderError('HOOKED_TOOL_NEEDS_CHROMIUM', 501,
        `Tool "${req.toolId}" ships hooks; the in-process render path runs hook-less tools only ` +
        `(set render.allowHooksInFastPath for a curated pack, or configure render.worker.url + ` +
        `LW_RENDER_WORKER_SECRET for the Chromium worker - see docs/configuration.md)`);
    }
    try {
      svgStr = await renderViaWorker(deps.worker, {
        toolId: req.toolId,
        query: queryFromValues(bakedValues),
        overrides: {},
        format: 'svg',
        profile: req.profile,
      });
    } catch (e) {
      if (e instanceof WorkerError) throw renderErrorFromWorker(e);
      throw e;
    }
  } else {
    svgStr = await withRenderHost({ pack, profile: req.profile, hostedResolver: deps.hostedResolver }, async (dom, host) => {
      const runtime = await engine.createRuntime(tool, host, bakedValues);
      const canvas = dom.window.document.getElementById('canvas');
      if (!canvas) throw new RenderError('RENDER_FAILED', 500, 'render canvas missing');
      canvas.innerHTML = runtime.getHydrated();
      const opts: Record<string, unknown> = { embedMeta: false, watermark };
      if (pxW) opts.width = pxW;
      if (pxH) opts.height = pxH;
      const blob = await runtime.export(canvas, 'svg', opts);
      const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
      // Honest failure: a lifecycle hook threw AND the output is blank ⇒ the bytes
      // aren't a real render. (A hookless tool has no hookErrors; a trivial {} hook
      // doesn't error.)
      if (runtime.hookErrors.length && (!text.trim() || !/<svg[\s>]/i.test(text))) {
        const detail = runtime.hookErrors.map((h) => `${h.hook}: ${h.message}`).join('; ');
        throw new RenderError('RENDER_FAILED', 400, `Render produced no output — ${detail}`);
      }
      return text;
    });
  }

  if (watermark) svgStr = applyPreviewWatermark(svgStr);

  // Provenance: whatever catalog assets this render referenced (baked params or
  // the SVG itself) become ingredients, embedded in the bytes so attribution
  // survives the file leaving lolly. Resolver failures never fail a render.
  let provenance: ProvenanceDoc | undefined;
  if (deps.resolveProvenance) {
    const refs = collectCatalogRefs(svgStr, bakedValues);
    if (refs.length) {
      try {
        const ingredients = await deps.resolveProvenance(refs);
        if (ingredients.length) provenance = provenanceDoc(ingredients);
      } catch { /* attribution is best-effort; the render itself is not */ }
    }
  }
  if (provenance) svgStr = embedSvgProvenance(svgStr, provenance);

  let out: CacheEntry;
  if (format === 'svg') {
    out = { bytes: new TextEncoder().encode(svgStr), mime: 'image/svg+xml' };
  } else {
    // Rasterise the finished (watermarked + provenance-islanded) SVG. The Chromium
    // worker is the single rasteriser when configured - one engine so what the shell
    // shows is what exports; in-process resvg is the fallback for a worker-less deploy
    // (the hosted demo today). Provenance + C2PA stay plane-side either way. Once a
    // worker is always present, resvg (and its native binary) is removed - see
    // plans/22.
    let raster: { bytes: Uint8Array; mime: string };
    if (deps.worker && !LEGACY_RESVG) {
      try {
        raster = await rasteriseViaWorker(deps.worker, { svg: svgStr, format, ...(pxW ? { width: pxW } : {}) });
      } catch (e) {
        if (e instanceof WorkerError) throw renderErrorFromWorker(e);
        throw e;
      }
    } else {
      raster = { bytes: await svgToPng(svgStr, pxW), mime: 'image/png' };
    }
    let bytes = raster.bytes;
    // PNG carries provenance in an iTXt chunk; other raster/vector-print formats get
    // it from the plane-side C2PA sign below (the worker never signs).
    if (provenance && raster.mime === 'image/png') bytes = addPngProvenance(bytes, provenance);
    out = { bytes, mime: raster.mime };
  }
  if (provenance) out.provenance = provenance;

  // Real C2PA signing (plans/17 §16): with an instance signer configured, sign
  // the finished bytes - including the provenance island above - so the export
  // carries a verifiable, tamper-evident Content Credential. Best-effort: a
  // signing failure must never fail an otherwise-good render (the unsigned bytes
  // still ship), matching how provenance degrades. Cache the signed bytes.
  if (deps.signer) {
    try {
      out.bytes = await engine.embedC2pa(out.bytes, format, {
        signer: { privateKey: deps.signer.privateKey, certDer: deps.signer.certDer, chain: deps.signer.chain },
        title: req.toolId,
        ...(deps.signer.claimGenerator ? { claimGenerator: deps.signer.claimGenerator } : {}),
      });
    } catch (e) {
      // Log to stderr (container stream); ship the unsigned bytes rather than 500.
      process.stderr.write(`[render:c2pa] signing ${req.toolId}.${format} failed: ${(e as Error).message}\n`);
    }
  }

  cachePut(cacheKey, out, req.toolId);
  return { ...out, cacheKey };
}

/** Rasterise an SVG string to PNG via resvg, longest edge bounded by the cap. */
async function svgToPng(svg: string, targetWidthPx: number | null): Promise<Uint8Array> {
  const { Resvg } = await import('@resvg/resvg-js');
  const probe = new Resvg(svg, { font: { loadSystemFonts: false } });
  const iw = probe.width, ih = probe.height;
  if (!(iw > 0) || !(ih > 0)) throw new RenderError('RENDER_FAILED', 400, 'SVG has no rasterisable size');
  const capScale = Math.min(MAX_RASTER_EDGE_PX / iw, MAX_RASTER_EDGE_PX / ih);
  const wantScale = targetWidthPx && targetWidthPx > 0 ? targetWidthPx / iw : 1;
  const scale = Math.min(wantScale, capScale, MAX_SCALE);
  if (iw * scale < 1 || ih * scale < 1) {
    throw new RenderError('RENDER_FAILED', 400, 'SVG aspect ratio is too extreme to rasterise within the size cap — request svg instead');
  }
  const fitTo = targetWidthPx && targetWidthPx > 0 && scale === wantScale
    ? { mode: 'width' as const, value: Math.round(targetWidthPx) }
    : { mode: 'zoom' as const, value: scale };
  const r = new Resvg(svg, { fitTo, font: { loadSystemFonts: true } });
  return r.render().asPng();
}

/** Convert a parsed dimension to CSS pixels (px/absent pass through; physical → px at dpi). */
function toPx(
  engine: Pick<EngineApi, 'parseDimension' | 'toPixels'>,
  value: number | null,
  unit: string | null,
  dpi: number | null,
): number | null {
  if (!value || value <= 0) return null;
  if (!unit || unit === 'px') return Math.round(value);
  const dim = engine.parseDimension(`${value}${unit}`);
  return dim ? Math.round(engine.toPixels(dim, dpi ?? 300)) : Math.round(value);
}

// ── catalog version (read once per pack, mtime-checked) ───────────────────────

/** The pack's own catalog version, plus the instance-owned assets' fingerprint
 *  when a caller wired one. Joined rather than hashed together so an operator
 *  reading a cache key's inputs can still see which half moved. */
async function catalogVersionOf(deps: RenderDeps, pack: string): Promise<string> {
  const packVersion = await readCatalogVersion(pack);
  if (!deps.instanceCatalogVersion) return packVersion;
  return `${packVersion}/${await deps.instanceCatalogVersion()}`;
}

const catalogVersionCache = new Map<string, { mtimeMs: number; version: string }>();

async function readCatalogVersion(pack: string): Promise<string> {
  const file = join(pack, 'catalog', 'tools', 'index.json');
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return '0'; // no catalog index in this pack
  }
  const hit = catalogVersionCache.get(pack);
  if (hit && hit.mtimeMs === mtimeMs) return hit.version;
  let version = '0';
  try {
    const doc = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown };
    if (doc.version != null) version = String(doc.version);
  } catch {
    /* unreadable/malformed index — treat as version 0 */
  }
  catalogVersionCache.set(pack, { mtimeMs, version });
  return version;
}

// ── in-process LRU (insertion-order eviction; capped by count AND bytes) ──────
const MAX_ENTRIES = 200;
const MAX_BYTES = 100 * 1024 * 1024;
interface CacheEntry { bytes: Uint8Array; mime: string; provenance?: ProvenanceDoc }
const cache = new Map<string, CacheEntry>();
const keyTool = new Map<string, string>(); // cacheKey -> toolId, for by-tool busting
let cacheBytes = 0;

function cacheGet(key: string): CacheEntry | undefined {
  return cache.get(key);
}

function cachePut(key: string, entry: CacheEntry, toolId: string): void {
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.bytes.byteLength;
  cache.set(key, entry);
  keyTool.set(key, toolId);
  cacheBytes += entry.bytes.byteLength;
  while ((cache.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) && cache.size > 0) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    keyTool.delete(oldest);
    if (evicted) cacheBytes -= evicted.bytes.byteLength;
  }
}

/**
 * Evict every cached render of `toolId`, returning the count dropped. The
 * reachable invalidation entry point plans/08 §6b asks a bulk session edit to
 * call: because the render cache key already folds in the tool's inputs, a
 * changed input structurally misses its old entry - but a bulk edit that sets a
 * value BACK to a previously-rendered one would otherwise hit stale bytes, so
 * this by-tool bust closes the gap. It over-busts (drops the tool's other cached
 * renders too), which is safe - renders are deterministic and simply recompute - 
 * and cheap for a rare admin op.
 */
export function invalidateRenderByTool(toolId: string): number {
  let dropped = 0;
  for (const [key, t] of [...keyTool]) {
    if (t !== toolId) continue;
    const entry = cache.get(key);
    cache.delete(key);
    keyTool.delete(key);
    if (entry) { cacheBytes -= entry.bytes.byteLength; dropped++; }
  }
  return dropped;
}
