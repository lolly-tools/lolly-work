// SPDX-License-Identifier: MPL-2.0
/**
 * The checks a partner company's logo passes on upload (plans/82 M3, section 4).
 *
 * The same answers reach the console and a contact's sheet, because they come
 * from here and travel as data:
 *
 * - **File type.** SVG or PNG. Anything else is refused (415); JPEG too,
 *   because a logo needs a transparent background.
 * - **SVG cleaning.** The same DOMPurify SVG profile the Lolly shell applies at
 *   upload (shells/web/src/bridge/svg-sanitize.ts), run over jsdom and
 *   serialised from the cleaned DOM node, so `<style>` and animation survive
 *   and the stored bytes are what the shell would have stored. A file that
 *   carried script, an event handler, a `javascript:` reference or a
 *   `<foreignObject>` is refused rather than quietly cleaned, and so is one
 *   that refers to another file, so the logo stays self-contained.
 *   tests/company-logo-checks.test.ts holds this to the shell's own answers.
 * - **Size.** SVG up to 512 KB; PNG up to 2 MB and at least 400 px on its long
 *   side.
 * - **Warnings, never refusals:** a PNG with no transparent background, an SVG
 *   that only wraps a picture, parts of an SVG removed by cleaning, and ink
 *   colours below 3:1 against the lead brand's surface for that logo.
 *
 * Nothing here stores anything or knows about companies: the route decides.
 * Clear space, minimum size and allowed treatments wait for partner kits
 * (plan 334 P2 and P3), so nothing is refused on those grounds.
 */
import { loadEngine, loadJsdom } from '../render/contract.ts';
import { sniffBytes } from '../catalog/submit.ts';

export type LogoSurface = 'light' | 'dark' | 'mark';
export const LOGO_SURFACES: readonly LogoSurface[] = ['light', 'dark', 'mark'];

/** The file types a logo may be, as the console offers them. */
export const LOGO_TYPES = ['image/svg+xml', 'image/png'] as const;
export const SVG_MAX_BYTES = 512 * 1024;
export const PNG_MAX_BYTES = 2 * 1024 * 1024;
export const PNG_MIN_LONG_SIDE = 400;
/** WCAG's floor for large graphics, which a logo is. */
export const LOGO_MIN_CONTRAST = 3;

export interface LogoWarning {
  code: 'no-transparency' | 'opaque-edge' | 'raster-in-svg' | 'svg-cleaned' | 'low-contrast';
  message: string;
  /** For low-contrast: the surface it fails on, the weakest ink colour and its ratio. */
  surface?: 'light' | 'dark';
  colour?: string;
  ratio?: number;
}

export interface LogoSurfaces {
  light: string;
  dark: string;
  /** Read from the design system's surface tokens, or the neutral defaults. */
  source: 'design-system' | 'default';
}

export type LogoCheck =
  | { ok: true; format: 'svg' | 'png'; contentType: string; bytes: Buffer; width?: number; height?: number; inks: string[]; warnings: LogoWarning[] }
  | { ok: false; status: 413 | 415 | 422; code: string; detail: string };

const kb = (n: number): string => `${Math.round(n / 1024)} KB`;

// ── SVG ─────────────────────────────────────────────────────────────────────

/** The options the shell's sanitizeSvgToString passes DOMPurify, verbatim. */
export const SHELL_SVG_PROFILE = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_ATTR: ['calcMode'],
  RETURN_DOM: true,
} as const;

/** The little of the DOM this module reads; the server has no DOM types. */
interface DomElement {
  nodeName: string;
  nodeType: number;
  textContent: string | null;
  getAttribute?(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): Iterable<DomElement>;
}
type Purify = {
  sanitize(markup: string, opts: Record<string, unknown>): unknown;
  removed: Array<{ element?: DomElement; attribute?: { name: string; value: string } | null; from?: DomElement }>;
  addHook(name: string, fn: (node: DomElement, data: Record<string, unknown>) => void): void;
  removeAllHooks(): void;
};
interface SvgDom { purify: Purify; serialize(node: DomElement): string }

let svgDom: Promise<SvgDom> | null = null;
/** One jsdom window and DOMPurify instance per process; sanitising is synchronous. */
function loadSvgDom(): Promise<SvgDom> {
  svgDom ??= (async () => {
    const { JSDOM } = await loadJsdom();
    const { window } = new JSDOM('<!doctype html><html><body></body></html>') as unknown as { window: { XMLSerializer: new () => { serializeToString(node: unknown): string } } };
    const createDOMPurify = (await import('dompurify')).default as unknown as (w: unknown) => Purify;
    const purify = createDOMPurify(window);
    const serializer = new window.XMLSerializer();
    return { purify, serialize: (node: DomElement) => serializer.serializeToString(node) };
  })().catch((err: unknown) => { svgDom = null; throw err; });
  return svgDom;
}

/** Elements whose presence means the file carried active content. */
const ACTIVE_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'handler', 'listener']);
/** Element names a cleaning pass may drop with no effect on the drawing. */
const quietRemoval = (name: string): boolean => name.includes(':') || name === 'metadata';
const DRAWABLE = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'image', 'use']);
const SCRIPT_URL = /^\s*(?:javascript|vbscript|data\s*:\s*text\/html)/i;
/** A reference that stays inside the file: a fragment or an embedded data URL. */
const selfContained = (value: string): boolean => /^\s*(?:#|data:)/i.test(value);
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)|@import/gi;

/** The cleaned markup the shell would produce, and what the cleaning found. */
export async function cleanSvg(markup: string): Promise<{ svg: string; active: string[]; external: string[]; removed: string[]; drawables: string[] }> {
  const { purify, serialize } = await loadSvgDom();
  const external: string[] = [];
  const noteCss = (css: string): void => {
    for (const m of css.matchAll(CSS_URL)) {
      if (m[0].toLowerCase() === '@import') external.push('@import');
      else if (m[2] !== undefined && !selfContained(m[2]) && m[2].trim()) external.push(m[2].trim().slice(0, 120));
    }
  };
  // Read references before the profile runs, because it drops some carriers
  // (a <use> into another file goes entirely) and the refusal has to say why.
  purify.addHook('uponSanitizeElement', (node, data) => {
    if (typeof node.getAttribute !== 'function') return;
    // A hyperlink loads nothing into the drawing, so only resource references count.
    if (String(data.tagName ?? '').toLowerCase() !== 'a') for (const name of ['href', 'xlink:href', 'src']) {
      const v = node.getAttribute(name);
      if (v && !selfContained(v) && !SCRIPT_URL.test(v)) external.push(v.trim().slice(0, 120));
    }
    const style = node.getAttribute('style');
    if (style) noteCss(style);
    if (String(data.tagName ?? '').toLowerCase() === 'style') noteCss(node.textContent ?? '');
  });
  let dom: DomElement;
  try {
    dom = purify.sanitize(markup, { ...SHELL_SVG_PROFILE }) as DomElement;
  } finally {
    purify.removeAllHooks();
  }
  const active: string[] = [];
  const removed: string[] = [];
  for (const r of purify.removed) {
    if (r.element) {
      const name = r.element.nodeName.toLowerCase();
      if (ACTIVE_ELEMENTS.has(name)) active.push(`<${name}>`);
      else if (r.element.nodeType === 1 && !quietRemoval(name) && name !== 'body') removed.push(name);
    } else if (r.attribute) {
      const name = r.attribute.name.toLowerCase();
      if (name.startsWith('on')) active.push(`${name}=`);
      else if (SCRIPT_URL.test(r.attribute.value)) active.push('javascript:');
    }
  }
  const root = dom.querySelector('svg');
  const svg = root ? serialize(root) : '';
  const drawables = root ? [...root.querySelectorAll('*')].map((e) => e.nodeName.toLowerCase()).filter((n) => DRAWABLE.has(n)) : [];
  return { svg, active: [...new Set(active)], external: [...new Set(external)], removed: [...new Set(removed)], drawables };
}

async function checkSvg(bytes: Buffer, width?: number, height?: number): Promise<LogoCheck> {
  if (bytes.length > SVG_MAX_BYTES) return { ok: false, status: 413, code: 'LOGO_TOO_LARGE', detail: `An SVG logo can be up to ${kb(SVG_MAX_BYTES)}; this one is ${kb(bytes.length)}.` };
  const cleaned = await cleanSvg(bytes.toString('utf8'));
  if (cleaned.active.length) {
    return { ok: false, status: 422, code: 'LOGO_ACTIVE_CONTENT', detail: `This SVG carries active content (${cleaned.active.slice(0, 4).join(', ')}), which a logo never needs. Export it again from your design tool as a plain SVG.` };
  }
  if (cleaned.external.length) {
    return { ok: false, status: 422, code: 'LOGO_EXTERNAL_REFERENCE', detail: `This SVG refers to another file (${cleaned.external.slice(0, 2).join(', ')}). Embed everything in the SVG so the logo is self-contained.` };
  }
  if (!/<svg[\s>]/i.test(cleaned.svg) || !cleaned.drawables.length) {
    return { ok: false, status: 422, code: 'LOGO_EMPTY', detail: 'Nothing drawable is left in this SVG once it is cleaned.' };
  }
  const warnings: LogoWarning[] = [];
  if (cleaned.drawables.every((n) => n === 'image')) {
    warnings.push({ code: 'raster-in-svg', message: 'This SVG only wraps a picture, so it will not stay sharp when it is enlarged.' });
  }
  if (cleaned.removed.length) {
    warnings.push({ code: 'svg-cleaned', message: `Cleaning removed parts this workspace does not keep (${cleaned.removed.slice(0, 4).join(', ')}). Check how the logo looks on both surfaces.` });
  }
  const engine = await loadEngine() as unknown as EngineColour;
  const found = engine.extractSvgColors(cleaned.svg).map((c) => toHex(engine, c)).filter((c): c is string => !!c);
  // An SVG that names no colour paints in black, the SVG default.
  const inks = found.length ? [...new Set(found)] : ['#000000'];
  return { ok: true, format: 'svg', contentType: 'image/svg+xml', bytes: Buffer.from(cleaned.svg, 'utf8'), ...(width ? { width } : {}), ...(height ? { height } : {}), inks, warnings };
}

// ── PNG ─────────────────────────────────────────────────────────────────────

let sharpModule: Promise<typeof import('sharp')> | null = null;
function loadSharp(): Promise<typeof import('sharp')> {
  sharpModule ??= import('sharp').catch((e: unknown) => {
    sharpModule = null;
    throw new Error(`checking a PNG logo needs the sharp native module on this host: ${e instanceof Error ? e.message : String(e)}`);
  });
  return sharpModule;
}

const hex2 = (n: number): string => Math.round(n).toString(16).padStart(2, '0');

async function checkPng(bytes: Buffer): Promise<LogoCheck> {
  if (bytes.length > PNG_MAX_BYTES) return { ok: false, status: 413, code: 'LOGO_TOO_LARGE', detail: `A PNG logo can be up to ${kb(PNG_MAX_BYTES)}; this one is ${kb(bytes.length)}. An SVG keeps it sharp at any size.` };
  const sharp = (await loadSharp()).default;
  let meta: { width?: number; height?: number; hasAlpha?: boolean };
  try { meta = await sharp(bytes).metadata(); } catch {
    return { ok: false, status: 415, code: 'LOGO_UNREADABLE', detail: 'This PNG could not be read.' };
  }
  const width = meta.width ?? 0, height = meta.height ?? 0;
  const long = Math.max(width, height);
  if (long < PNG_MIN_LONG_SIDE) {
    return { ok: false, status: 422, code: 'LOGO_TOO_SMALL', detail: `A PNG logo needs at least ${PNG_MIN_LONG_SIDE} pixels on its long side; this one has ${long}. Use a larger PNG, or an SVG.` };
  }
  // A small copy is enough to judge the edge and the ink colours. Nearest
  // neighbour, so shrinking invents no blended colours of its own.
  const { data, info } = await sharp(bytes).ensureAlpha().resize({ width: 128, height: 128, fit: 'inside', kernel: 'nearest' }).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): [number, number, number, number] => {
    const i = (y * info.width + x) * 4;
    return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
  };
  const edge: Array<[number, number, number, number]> = [];
  for (let x = 0; x < info.width; x++) { edge.push(at(x, 0), at(x, info.height - 1)); }
  for (let y = 1; y < info.height - 1; y++) { edge.push(at(0, y), at(info.width - 1, y)); }
  const opaqueEdge = edge.filter((p) => p[3] >= 250).length >= edge.length * 0.9;
  const warnings: LogoWarning[] = [];
  const boxed = 'This logo has no transparent background and will show as a box on coloured surfaces.';
  if (!meta.hasAlpha) warnings.push({ code: 'no-transparency', message: boxed });
  else if (opaqueEdge) warnings.push({ code: 'opaque-edge', message: boxed });
  // The background a boxed logo carries is its edge colour; ink is what differs.
  const bucket = (p: readonly number[]): number => ((p[0]! >> 4) << 8) | ((p[1]! >> 4) << 4) | (p[2]! >> 4);
  const background = opaqueEdge ? mode(edge.map(bucket)) : undefined;
  const sums = new Map<number, { n: number; r: number; g: number; b: number }>();
  let counted = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const p = at(x, y);
    if (p[3] < 128) continue;
    const k = bucket(p);
    if (k === background) continue;
    counted++;
    const s = sums.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
    s.n++; s.r += p[0]; s.g += p[1]; s.b += p[2];
    sums.set(k, s);
  }
  const inks = [...sums.values()].filter((s) => s.n >= counted * 0.05).sort((a, b) => b.n - a.n).slice(0, 6)
    .map((s) => `#${hex2(s.r / s.n)}${hex2(s.g / s.n)}${hex2(s.b / s.n)}`);
  return { ok: true, format: 'png', contentType: 'image/png', bytes, width, height, inks, warnings };
}

function mode(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  let best: number | undefined, top = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > top) { top = n; best = v; }
  }
  return best;
}

// ── contrast ────────────────────────────────────────────────────────────────

interface EngineColour {
  extractSvgColors(svg: string): string[];
  parseColor(input: string): unknown;
  colorToHexString(c: unknown): string;
  contrastRatio(a: string, b: string): number;
  createTokenSet(doc: unknown, opts?: { theme?: string }): { resolve(ref: string): unknown };
  colorToHex(value: unknown): string | null | undefined;
}

function toHex(engine: EngineColour, colour: string): string | null {
  const parsed = engine.parseColor(colour);
  return parsed ? engine.colorToHexString(parsed).slice(0, 7).toLowerCase() : null;
}

/** The surface tokens a design system names for its background, in order. */
const SURFACE_TOKENS = ['color.semantic.surface', 'color.semantic.background', 'color.background', 'color.surface'];
export const DEFAULT_SURFACES: LogoSurfaces = { light: '#ffffff', dark: '#000000', source: 'default' };

/** The lead brand's light and dark surfaces, read from its design tokens. */
export async function surfacesFromTokens(doc: unknown): Promise<LogoSurfaces> {
  if (!doc || typeof doc !== 'object') return DEFAULT_SURFACES;
  const engine = await loadEngine() as unknown as EngineColour;
  const read = (theme: 'light' | 'dark'): string | null => {
    const set = engine.createTokenSet(doc, { theme });
    for (const ref of SURFACE_TOKENS) {
      const value = set.resolve(ref);
      const hex = typeof value === 'string' ? toHex(engine, value) : engine.colorToHex(value);
      if (hex && /^#[0-9a-f]{6}/i.test(hex)) return hex.slice(0, 7).toLowerCase();
    }
    return null;
  };
  const light = read('light'), dark = read('dark');
  if (!light && !dark) return DEFAULT_SURFACES;
  return { light: light ?? DEFAULT_SURFACES.light, dark: dark ?? DEFAULT_SURFACES.dark, source: 'design-system' };
}

/** Low-contrast warnings for a logo's inks against the surfaces it is for: a
 *  light logo against the light surface, a dark one against the dark surface,
 *  a mark against both. */
export async function contrastWarnings(inks: readonly string[], surface: LogoSurface, surfaces: LogoSurfaces): Promise<LogoWarning[]> {
  if (!inks.length) return [];
  const engine = await loadEngine() as unknown as EngineColour;
  const against: Array<'light' | 'dark'> = surface === 'mark' ? ['light', 'dark'] : [surface];
  const out: LogoWarning[] = [];
  for (const side of against) {
    const ground = surfaces[side];
    let weakest: { colour: string; ratio: number } | null = null;
    for (const ink of inks) {
      const ratio = engine.contrastRatio(ink, ground);
      if (Number.isFinite(ratio) && ratio < LOGO_MIN_CONTRAST && (!weakest || ratio < weakest.ratio)) weakest = { colour: ink, ratio };
    }
    if (weakest) {
      const r = Math.round(weakest.ratio * 100) / 100;
      out.push({ code: 'low-contrast', surface: side, colour: weakest.colour, ratio: r,
        message: `${weakest.colour} in this logo has a contrast of ${r}:1 on the ${side} surface (${ground}), below ${LOGO_MIN_CONTRAST}:1, so it may be hard to see there.` });
    }
  }
  return out;
}

/** Run every check on uploaded bytes. Surfaces decide the contrast warnings. */
export async function checkLogo(bytes: Buffer, surface: LogoSurface, surfaces: LogoSurfaces): Promise<LogoCheck> {
  const sniffed = sniffBytes(bytes);
  let result: LogoCheck;
  if (sniffed.format === 'svg') result = await checkSvg(bytes, sniffed.width, sniffed.height);
  else if (sniffed.format === 'png') result = await checkPng(bytes);
  else {
    const jpeg = sniffed.format === 'jpg';
    return { ok: false, status: 415, code: 'LOGO_TYPE', detail: jpeg
      ? 'A logo is an SVG or a PNG. JPEG is refused because a logo needs a transparent background.'
      : 'A logo is an SVG or a PNG.' };
  }
  if (!result.ok) return result;
  return { ...result, warnings: [...result.warnings, ...await contrastWarnings(result.inks, surface, surfaces)] };
}
