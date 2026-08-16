/**
 * The fourth HostV1 shell - a minimal, headless capability bridge for
 * server-side rendering (plans/07). It is a FRESH, deliberately small
 * implementation (not a dependency on shells/cli): the render plane only needs
 * hook-less tools to SVG, so it implements exactly the required HostV1 members
 * and nothing more.
 *
 * Two facts shape it:
 *   1. jsdom mutates shared globals (window/document/Element), so every render is
 *      serialized through a module-level promise chain and the globals are
 *      installed for the render's duration and restored after - exactly what the
 *      public MCP service does. Worker-thread isolation is a later optimisation.
 *   2. The profile is built server-side from the authenticated user (never from
 *      caller params), so `bindToProfile` inputs resolve to the real identity.
 *
 * jsdom loads lazily (heavy) so a boot that never renders stays instant.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  loadJsdom,
  type AssetQuery, type AssetRef, type AssetsAPI, type ExportOpts,
  type Profile, type RenderDom, type RenderElement, type StateEntry, type WorkHost,
} from './contract.ts';

// One catalog-asset record as it appears in <pack>/catalog/assets/index.json.
interface CatalogAssetFormat { format: string; url: string; checksum?: string; width?: number; height?: number }
interface CatalogAsset {
  id: string;
  name?: string;
  type: AssetRef['type'];
  version?: string;
  tags?: string[];
  deprecated?: boolean;
  formats: CatalogAssetFormat[];
}

function mimeFor(format: string): string {
  switch (format) {
    case 'svg': return 'image/svg+xml';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

function matchesFilter(meta: CatalogAsset, filter: AssetQuery): boolean {
  if (filter.type && meta.type !== filter.type) return false;
  if (filter.namespace && !meta.id.startsWith(filter.namespace + '/') && meta.id !== filter.namespace) return false;
  if (filter.tags?.length) {
    const tags = new Set(meta.tags ?? []);
    if (!filter.tags.every((t) => tags.has(t))) return false;
  }
  if (!filter.includeDeprecated && meta.deprecated) return false;
  return true;
}

/**
 * Build the headless assets API. Reads the pack's catalog asset index once (an
 * absent/unreadable index is fine - the render plane's v1 tools are asset-free);
 * `get` returns referenced files as data: URLs (jsdom has no createObjectURL),
 * `pick` throws (no picker chrome server-side).
 */
async function buildAssets(pack: string): Promise<AssetsAPI> {
  const catalogDir = join(pack, 'catalog');
  const byId = new Map<string, CatalogAsset>();
  try {
    const raw = await readFile(join(catalogDir, 'assets', 'index.json'), 'utf8');
    const index = JSON.parse(raw) as { assets?: CatalogAsset[] };
    for (const a of index.assets ?? []) byId.set(a.id, a);
  } catch {
    /* no asset catalog in this pack — leave the map empty */
  }
  return {
    async get(id: string): Promise<AssetRef> {
      const meta = byId.get(id);
      if (!meta) throw new Error(`Asset not in catalog: ${id}`);
      const fmt = meta.formats[0];
      if (!fmt) throw new Error(`Asset has no formats: ${id}`);
      const bytes = await readFile(join(catalogDir, fmt.url.replace(/^\//, '')));
      const url = `data:${mimeFor(fmt.format)};base64,${bytes.toString('base64')}`;
      return {
        source: 'library', id, type: meta.type, format: fmt.format, url,
        version: meta.version, checksum: fmt.checksum, meta: { name: meta.name, tags: meta.tags },
      };
    },
    async query(filter: AssetQuery = {}): Promise<AssetRef[]> {
      return [...byId.values()].filter((m) => matchesFilter(m, filter)).map((m): AssetRef => ({
        source: 'library', id: m.id, type: m.type, format: m.formats[0]?.format ?? 'svg', url: '',
        version: m.version, meta: { name: m.name, tags: m.tags, _placeholder: true },
      }));
    },
    async pick(): Promise<AssetRef | null> {
      throw new Error('Asset picker is not available server-side');
    },
    async isAvailable(id: string): Promise<boolean> {
      return byId.has(id);
    },
  };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Construct the render host bound to `dom` + `profile`, reading assets from
 * `pack`. Produces SVG only (the render plane rasterises to PNG downstream via
 * resvg); every other format throws so a mis-wired caller fails honestly.
 */
async function buildHost(dom: RenderDom, pack: string, profile: Profile): Promise<WorkHost> {
  const w = dom.window;
  const state = new Map<string, object>();
  const assets = await buildAssets(pack);

  return {
    version: '1',
    // The render plane is the "work" shell. (HostV1.shell's union predates it.)
    shell: 'work',
    log(level, msg, ctx): void {
      // Never stdout - a serverless/container log stream, like the MCP service.
      process.stderr.write(`[render:${level}] ${msg}${ctx ? ' ' + safeJson(ctx) : ''}\n`);
    },
    profile: {
      async get(): Promise<Profile> { return profile; },
      subscribe(): () => void { return () => {}; },
    },
    assets,
    state: {
      async save(slot, data): Promise<void> { state.set(slot, data); },
      async load(slot): Promise<object | null> { return state.get(slot) ?? null; },
      async list(): Promise<StateEntry[]> { return [...state.keys()].map((slot) => ({ slot })); },
      async delete(slot): Promise<void> { state.delete(slot); },
    },
    clipboard: {
      async writeText(): Promise<void> { throw new Error('Clipboard is unavailable server-side'); },
      async writeImage(): Promise<{ method: 'clipboard' | 'download' }> {
        throw new Error('Clipboard is unavailable server-side');
      },
    },
    export: {
      async render(node: unknown, format: string, opts: ExportOpts = {}): Promise<Blob> {
        if (format !== 'svg') {
          throw new Error(`render host produces svg only (got "${format}") — raster is rasterised downstream`);
        }
        const el = node as RenderElement;
        const svg = el.querySelector('svg') ?? el;
        if (svg.tagName?.toLowerCase() !== 'svg') {
          throw new Error('SVG export requires an <svg> in the template');
        }
        // Honour explicit pixel dimensions when the template didn't fix them.
        const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null);
        const dw = num(opts.width);
        const dh = num(opts.height);
        if ((dw || dh) && !svg.getAttribute('viewBox')) {
          const vw = dw ?? (Number.parseFloat(svg.getAttribute('width') ?? '') || 0);
          const vh = dh ?? (Number.parseFloat(svg.getAttribute('height') ?? '') || 0);
          if (vw && vh) svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
        }
        if (dw) svg.setAttribute('width', String(dw));
        if (dh) svg.setAttribute('height', String(dh));
        const xml = new w.XMLSerializer().serializeToString(svg);
        return new Blob(['<?xml version="1.0" standalone="no"?>\n' + xml], { type: 'image/svg+xml' });
      },
      async download(): Promise<void> { throw new Error('No browser download server-side'); },
      async file(): Promise<void> { throw new Error('No file delivery server-side'); },
    },
  };
}

// ── the render mutex ─────────────────────────────────────────────────────────
// jsdom mutates globalThis.{window,document,Element}, so renders are serialized
// process-wide through this chain (correct, if not maximally concurrent).
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Run `fn` with a fresh jsdom DOM + a headless host bound to `profile` and the
 * catalog under `pack`. Globals are installed for the duration and restored
 * afterward; serialized process-wide via the mutex above.
 */
export function withRenderHost<T>(
  opts: { pack: string; profile: Profile },
  fn: (dom: RenderDom, host: WorkHost) => Promise<T>,
): Promise<T> {
  return enqueue(async () => {
    const { JSDOM } = await loadJsdom();
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="canvas"></div></body></html>');
    const g = globalThis as Record<string, unknown>;
    const prev = { window: g['window'], document: g['document'], Element: g['Element'] };
    g['window'] = dom.window;
    g['document'] = dom.window.document;
    g['Element'] = dom.window.Element;
    try {
      const host = await buildHost(dom, opts.pack, opts.profile);
      return await fn(dom, host);
    } finally {
      g['window'] = prev.window;
      g['document'] = prev.document;
      g['Element'] = prev.Element;
      try { dom.window.close?.(); } catch { /* ignore */ }
    }
  });
}
