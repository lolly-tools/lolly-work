// SPDX-License-Identifier: MPL-2.0
/** Admit verified artwork to a bounded static SVG subset without silent visual removals. */
import type { EmojiMeaningV1 } from '@lolly-tools/core';
import { sha256Hex } from './bytes.ts';
import { escapeXml } from './xml-escape.ts';
import { findEmojiGlyph, matchesEmojiPack, verifyEmojiArtwork } from './emoji-pack.ts';
import type { VerifiedEmojiPack } from './emoji-pack.ts';
import { svgNumberList, svgPath, svgScalar, svgTransform } from './emoji-svg-syntax.ts';
import { NAMED_COLORS, parseColor, formatColor } from './css-color.ts';

export const EMOJI_SVG_VERSION = 'static-svg-v1';
/** What {@link recolorPreparedEmojiSvg} stamps: the same subset, with paints rewritten by the treatment recipe. */
export const EMOJI_TREATED_SVG_VERSION = 'static-svg-v1+emoji-treatment-v1';
/** What {@link inkPreparedEmojiSvg} stamps: the same subset, with foreground ink bound to the text colour. */
export const EMOJI_INK_SVG_VERSION = 'static-svg-v1+emoji-ink-v1';
export type EmojiXmlParser = (source: string) => Document;
export interface PreparedEmojiSvg { readonly checksum: string; readonly sourceChecksum: string; readonly normalizer: typeof EMOJI_SVG_VERSION | typeof EMOJI_TREATED_SVG_VERSION | typeof EMOJI_INK_SVG_VERSION }
interface SvgNode { tag: string; attributes: Record<string, string>; children: SvgNode[] }
interface SvgRecord { tree: SvgNode; changes: string[]; textInk?: readonly string[] }
const prepared = new WeakMap<PreparedEmojiSvg, SvgRecord>();
// This admitted Fluent release uses dark greys as foreground ink. Pin the
// exception so other artwork, including Fluent Flat, keeps its authored greys.
const FLUENT_HIGH_CONTRAST = {
  id: 'community/emoji/fluent/high-contrast',
  pin: { version: '2026.8.24' },
  checksum: 'sha256:0428cfd8a440aef92a1ea1d227c1b601c79d747144d26159336ed0c3230dbd7e',
};
const FLUENT_HIGH_CONTRAST_INK = ['#212121', '#1c1c1c'] as const;
const namespace = 'http://www.w3.org/2000/svg';
const idPattern = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const tags: Record<string, string[]> = {
  svg: ['viewBox', 'width', 'height', 'preserveAspectRatio'], g: [], defs: [],
  path: ['d'], circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'], line: ['x1', 'y1', 'x2', 'y2'],
  polygon: ['points'], polyline: ['points'],
  linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  stop: ['offset'],
  clipPath: ['clipPathUnits'],
  // References are limited to local shapes, so they cannot recurse.
  use: ['href', 'x', 'y', 'width', 'height'],
};
const xlinkNamespace = 'http://www.w3.org/1999/xlink';
const shapes = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polygon', 'polyline']);
// Elements never rendered directly: they stay referenceable even inside a hidden group.
const referenceOnly = new Set(['linearGradient', 'radialGradient', 'clipPath', 'defs']);
const presentation = new Set(['fill', 'stroke', 'fill-rule', 'opacity', 'fill-opacity', 'stroke-opacity', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stop-color', 'stop-opacity', 'color-interpolation', 'clip-rule', 'clip-path', 'paint-order']);
// Inert with this subset (no filters, no stylesheets, no currentColor paint): omitted and recorded.
const inert: Record<string, string> = {
  'enable-background': 'Omitted inert enable-background; filters are unsupported.',
  color: 'Omitted inert color; currentColor paint is unsupported.',
  class: 'Omitted class names; stylesheets are unsupported.',
  overflow: 'Omitted inert overflow; no element here establishes a viewport.',
};
const units = new Set(['x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'x1', 'y1', 'x2', 'y2', 'width', 'height']);
const nonnegative = new Set(['r', 'rx', 'ry', 'fr', 'width', 'height', 'stroke-width']);
const choices: Record<string, string[]> = {
  'fill-rule': ['nonzero', 'evenodd'], 'clip-rule': ['nonzero', 'evenodd'], 'stroke-linecap': ['butt', 'round', 'square'],
  'stroke-linejoin': ['miter', 'round', 'bevel'], gradientUnits: ['userSpaceOnUse', 'objectBoundingBox'],
  clipPathUnits: ['userSpaceOnUse', 'objectBoundingBox'],
  spreadMethod: ['pad', 'reflect', 'repeat'], 'color-interpolation': ['sRGB', 'linearRGB'],
  preserveAspectRatio: ['xMidYMid meet'],
};
// What a local reference (url(#id), or #id on use) may point at, per referencing attribute.
const referenceTargets: Record<string, string[]> = { fill: ['linearGradient', 'radialGradient'], stroke: ['linearGradient', 'radialGradient'], 'clip-path': ['clipPath'], href: [...shapes] };
// The referenced local id: `#id` on a use href, `url(#id)` on a paint or clip-path. A hex colour is not a reference.
const localId = (name: string, value: string): string | null =>
  (name === 'href' ? /^#([A-Za-z_][A-Za-z0-9_.-]{0,127})$/ : /^url\(#([A-Za-z_][A-Za-z0-9_.-]{0,127})\)$/).exec(value)?.[1] ?? null;

export function staticSvgAttribute(name: string, value: string, tag: string, authoredPaint = false): string {
  value = value.trim();
  if (name === 'id') { if (!idPattern.test(value)) throw new Error('Unsupported SVG id.'); return value; }
  if (name === 'd') return svgPath(value);
  if (name === 'transform' || name === 'gradientTransform') return svgTransform(value);
  if (name === 'viewBox') {
    const parts = svgNumberList(value, [4]);
    if (Number(parts[2]) <= 0 || Number(parts[3]) <= 0) throw new Error('Invalid SVG viewBox.');
    return parts.join(' ');
  }
  if (name === 'points' || name === 'stroke-dasharray') {
    if (name === 'stroke-dasharray' && value === 'none') return value;
    const parts = svgNumberList(value);
    if (name === 'points' ? parts.length < 4 || parts.length % 2 !== 0 : parts.some(part => Number(part) < 0)) throw new Error('Invalid SVG geometry list.');
    return parts.join(' ');
  }
  if (['fill', 'stroke', 'stop-color'].includes(name)) {
    if (authoredPaint && value.length <= 256) { const parsed = parseColor(value); if (parsed) return /^#[a-f0-9]{6}$/i.test(value) ? value.toLowerCase() : formatColor(parsed); }
    const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(value);
    if (rgb?.slice(1).every(channel => Number(channel) <= 255)) return `#${rgb.slice(1).map(channel => Number(channel).toString(16).padStart(2, '0')).join('')}`;
    if (/^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i.test(value)) return value.toLowerCase();
    // A CSS colour keyword is an explicit colour; canonicalize it to hex.
    const named = NAMED_COLORS[value.toLowerCase()];
    if (named !== undefined) return `#${named.toString(16).padStart(6, '0')}`;
    if (name !== 'stop-color' && (value === 'none' || /^url\(#[A-Za-z_][A-Za-z0-9_.-]{0,127}\)$/.test(value))) return value;
    throw new Error('Unsupported SVG paint; colours must be explicit and references local.');
  }
  if (name === 'clip-path') {
    if (value === 'none' || /^url\(#[A-Za-z_][A-Za-z0-9_.-]{0,127}\)$/.test(value)) return value;
    throw new Error('Unsupported SVG clip-path; only a local clipPath reference is supported.');
  }
  if (name === 'href') {
    if (tag === 'use' && /^#[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value)) return value;
    throw new Error('Unsupported SVG href; only a local shape reference on use is supported.');
  }
  if (name === 'paint-order') {
    const tokens = value.split(/\s+/).filter(Boolean);
    if (tokens.length === 1 && tokens[0] === 'normal') return 'normal';
    if (!tokens.length || tokens.length > 3 || new Set(tokens).size !== tokens.length || tokens.some(token => !['fill', 'stroke', 'markers'].includes(token))) {
      throw new Error('Unsupported SVG paint-order.');
    }
    return tokens.join(' ');
  }
  if (choices[name]) {
    if (!choices[name]!.includes(value)) throw new Error(`Unsupported SVG ${name}.`);
    return value;
  }
  if (name.endsWith('opacity') || name === 'opacity') return svgScalar(value, 0, 1);
  if (name === 'offset') return value.endsWith('%') ? `${svgScalar(value.slice(0, -1), 0, 100)}%` : svgScalar(value, 0, 1);
  if (units.has(name) || ['stroke-width', 'stroke-miterlimit', 'stroke-dashoffset'].includes(name)) {
    if ((units.has(name) || ['stroke-width', 'stroke-dashoffset'].includes(name)) && value.endsWith('px')) value = value.slice(0, -2);
    if (tag.endsWith('Gradient') && value.endsWith('%')) return `${svgScalar(value.slice(0, -1), nonnegative.has(name) ? 0 : undefined)}%`;
    return svgScalar(value, nonnegative.has(name) ? 0 : name === 'stroke-miterlimit' ? 1 : undefined);
  }
  throw new Error(`Unsupported SVG attribute ${name}.`);
}

function normalize(source: string, viewBox: readonly number[] | null, parseXml: EmojiXmlParser, authoredPaint = false): SvgRecord {
  let body = source.replace(/^\uFEFF?\s*<\?xml\s+version=["']1\.0["'](?:\s+encoding=["']utf-8["'])?(?:\s+standalone=["'](?:yes|no)["'])?\s*\?>/i, '');
  // Remove only this exact inert declaration before invoking the host parser.
  // Internal subsets, entities and every other doctype remain refused.
  const withoutDoctype = body.replace(/^\s*<!DOCTYPE svg PUBLIC "-\/\/W3C\/\/DTD SVG 1\.1\/\/EN" "http:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd">/, '');
  const omittedDoctype = withoutDoctype !== body;
  body = withoutDoctype;
  if (/<!DOCTYPE|<!ENTITY|<\?/i.test(body)) throw new Error('SVG declarations and processing instructions are unsupported.');
  const doc = parseXml(body);
  if (!doc.documentElement || doc.getElementsByTagName('parsererror').length) throw new Error('Invalid SVG XML.');
  const ids = new Map<string, string>(), references: { id: string; targets: string[] }[] = [];
  const changes = new Set(['Canonicalized SVG syntax and inline presentation styles.', 'Prefixed local SVG ids and paint references for placement.']);
  if (omittedDoctype) changes.add('Omitted the standard SVG 1.1 doctype without loading its external subset.');
  let nodes = 0, totalArguments = 0;
  // One declaration, from an attribute or an inline style. Returns false when
  // the declaration is inert and was omitted (recorded as a change), true when
  // it was kept. `display: none` is reported through `hidden`.
  function declare(attributes: Record<string, string>, name: string, value: string, tag: string, depth: number, hidden: { value: boolean }): void {
    if (name === 'enable-background') {
      if (!/^new(?:\s|$)/.test(value.trim())) throw new Error('Unsupported SVG enable-background.');
      changes.add(inert[name]!);
      return;
    }
    if (Object.hasOwn(inert, name)) { changes.add(inert[name]!); return; }
    if (name === 'display') {
      // Anything but none renders in SVG; none hides the element and its rendered content.
      if (value.trim() === 'none') { if (depth === 0) throw new Error('Unsupported hidden SVG root.'); hidden.value = true; }
      else changes.add('Omitted inert display values.');
      return;
    }
    if (name !== 'id' && name !== 'transform' && !presentation.has(name) && !tags[tag]!.includes(name)) throw new Error(`Unsupported SVG attribute ${name}.`);
    attributes[name] = staticSvgAttribute(name, value, tag, authoredPaint);
  }
  function walk(element: Element, depth: number): SvgNode | null {
    if (++nodes > 4096 || depth > 32) throw new Error('SVG exceeds the supported element or depth limit.');
    const tag = element.localName;
    if (element.namespaceURI !== namespace || element.prefix || !Object.hasOwn(tags, tag) || (tag === 'svg') !== (depth === 0)) throw new Error(`Unsupported SVG element ${tag}.`);
    if (element.attributes.length > 48) throw new Error('SVG exceeds the supported attribute count.');
    const attributes: Record<string, string> = {};
    const hidden = { value: false };
    let style = '';
    for (const attr of Array.from(element.attributes)) {
      const value = attr.value;
      let name = attr.name;
      if (/[^\x20-\x7e\t\r\n]/.test(value)) throw new Error('Unsupported SVG attribute characters.');
      totalArguments += value.length;
      if (totalArguments > 1_000_000) throw new Error('SVG exceeds the supported geometry budget.');
      if (name === 'xmlns' && value === namespace) {
        // The same default namespace restated on a child is inert (Twemoji's 1faf7-1f3fe does this).
        if (depth > 0) changes.add('Omitted a redundant xmlns on a child element.');
        continue;
      }
      if (depth === 0 && name === 'xmlns:serif' && value === 'http://www.serif.com/') { changes.add('Omitted the unused Affinity namespace declaration.'); continue; }
      if (depth === 0 && ['width', 'height'].includes(name) && value === '100%') { changes.add('Resolved the root percentage viewport to the pinned viewBox.'); continue; }
      if (depth === 0 && ((name === 'xmlns:xlink' && value === xlinkNamespace) || (name === 'xml:space' && value === 'preserve') || (name === 'version' && value === '1.1') || (['x', 'y'].includes(name) && /^0(?:px)?$/.test(value)))) { changes.add(`Omitted inert root ${name}.`); continue; }
      // The legacy xlink form of a use reference canonicalizes to plain href.
      if (tag === 'use' && name === 'xlink:href' && attr.namespaceURI === xlinkNamespace) { name = 'href'; changes.add('Canonicalized xlink:href to href.'); }
      else if (attr.namespaceURI || attr.prefix) throw new Error('Unsupported SVG attribute namespace.');
      if (name === 'style') { style = value; continue; }
      if (name === 'href' && attributes.href !== undefined) throw new Error('Duplicate SVG use reference.');
      declare(attributes, name, value, tag, depth, hidden);
    }
    // Inline declarations override presentation attributes. No CSS selectors or inherited variables.
    for (const declaration of style.split(';')) {
      if (!declaration.trim()) continue;
      const index = declaration.indexOf(':');
      if (index < 1) throw new Error('Malformed SVG style.');
      const name = declaration.slice(0, index).trim(), value = declaration.slice(index + 1).trim();
      if (name !== 'id' && name !== 'transform' && !presentation.has(name) && !Object.hasOwn(inert, name) && name !== 'display') throw new Error(`Unsupported SVG style ${name}.`);
      declare(attributes, name, value, tag, depth, hidden);
    }
    if (attributes.id) {
      if (ids.has(attributes.id)) throw new Error('Duplicate SVG id.');
      ids.set(attributes.id, tag);
    }
    if (tag === 'use' && attributes.href === undefined) throw new Error('SVG use without a reference.');
    for (const name of Object.keys(referenceTargets)) {
      const id = attributes[name] === undefined ? null : localId(name, attributes[name]!);
      if (id) references.push({ id, targets: referenceTargets[name]! });
    }
    const children: SvgNode[] = [];
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 1) { const node = walk(child as Element, depth + 1); if (node) children.push(node); }
      else if (child.nodeType === 8) changes.add('Omitted XML comments; source bytes remain pinned.');
      else if (child.nodeType !== 3 || child.textContent?.trim()) throw new Error('Unsupported SVG text or node.');
    }
    const childrenAllowed = tag.endsWith('Gradient') ? children.every(child => child.tag === 'stop')
      : tag === 'clipPath' ? children.every(child => shapes.has(child.tag) || child.tag === 'use')
        : ['svg', 'g', 'defs'].includes(tag) || !children.length;
    if (!childrenAllowed) throw new Error('Unsupported SVG child structure.');
    if (!hidden.value) return { tag, attributes, children };
    // A hidden element renders nothing, but the paint servers and clip paths it
    // contains stay referenceable (display never applies to them), so those are
    // kept in a definitions container and everything rendered is dropped.
    changes.add('Omitted elements hidden by display none.');
    const kept = children.filter(child => referenceOnly.has(child.tag));
    return kept.length ? { tag: 'defs', attributes: {}, children: kept } : null;
  }
  for (const child of Array.from(doc.childNodes)) if (child !== doc.documentElement && child.nodeType !== 8 && (child.nodeType !== 3 || child.textContent?.trim())) throw new Error('Unsupported SVG document node.');
  const tree = walk(doc.documentElement, 0)!;
  viewBox ??= tree.attributes.viewBox?.split(' ').map(Number) ?? [0, 0, Number(tree.attributes.width), Number(tree.attributes.height)];
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2]! <= 0 || viewBox[3]! <= 0) throw new Error('SVG needs a finite positive viewport.');
  if (tree.attributes.viewBox === undefined && viewBox[0] === 0 && viewBox[1] === 0
    && tree.attributes.width === String(viewBox[2]) && tree.attributes.height === String(viewBox[3])) {
    tree.attributes.viewBox = viewBox.join(' ');
    changes.add('Made the fixed root viewport explicit as a viewBox.');
  }
  if (tree.attributes.viewBox !== viewBox.map(String).join(' ')) throw new Error('SVG viewBox differs from its manifest.');
  for (const [index, name] of ['width', 'height'].entries()) {
    const expected = String(viewBox[index + 2]);
    if (tree.attributes[name] !== undefined && tree.attributes[name] !== expected) throw new Error('SVG viewport differs from its manifest.');
    tree.attributes[name] = expected;
  }
  for (const reference of references) if (!reference.targets.includes(ids.get(reference.id) ?? '')) throw new Error('SVG paint or clip reference is missing or unsupported.');
  tree.attributes.xmlns = namespace;
  // Make implicit presentation defaults explicit before this becomes a nested SVG.
  tree.attributes.fill ??= '#000000';
  tree.attributes.stroke ??= 'none';
  tree.attributes['color-interpolation'] ??= 'sRGB';
  return { tree, changes: [...changes].sort() };
}

function serialize(node: SvgNode, prefix: string): string {
  const attrs = Object.entries(node.attributes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, raw]) => {
    const value = name === 'id' ? `${prefix}-${raw}`
      : raw.startsWith('url(#') ? `url(#${prefix}-${raw.slice(5, -1)})`
        : name === 'href' ? `#${prefix}-${raw.slice(1)}` : raw;
    return ` ${name}="${escapeXml(value)}"`;
  }).join('');
  return `<${node.tag}${attrs}>${node.children.map(child => serialize(child, prefix)).join('')}</${node.tag}>`;
}

/** Admit authored inline artwork through the same bounded static subset as emoji. */
export function admitTextInlineSvg(source: string, parseXml: EmojiXmlParser, prefix: string): string {
  if (typeof source !== 'string' || new TextEncoder().encode(source).byteLength > 2 * 1024 * 1024 || !idPattern.test(prefix)) throw new Error('Invalid inline SVG size or placement prefix.');
  return serialize(normalize(source, null, parseXml, true).tree, prefix);
}

/** The host parser must parse XML without network access. DTDs are rejected before it runs. */
export async function prepareEmojiSvg(pack: VerifiedEmojiPack, meaning: EmojiMeaningV1, bytes: Uint8Array, parseXml: EmojiXmlParser): Promise<
  { ok: true; svg: PreparedEmojiSvg } | { ok: false; message: string }
> {
  const verified = await verifyEmojiArtwork(pack, meaning, bytes);
  if (!verified.ok) return { ok: false, message: verified.issue.message };
  const entry = findEmojiGlyph(pack, meaning)!;
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(verified.bytes);
    const record = normalize(source, entry.glyph.viewBox, parseXml);
    if (matchesEmojiPack(pack, FLUENT_HIGH_CONTRAST)) record.textInk = FLUENT_HIGH_CONTRAST_INK;
    const checksum = `sha256:${await sha256Hex(new TextEncoder().encode(serialize(record.tree, 'emoji')))}`;
    const svg = Object.freeze({ checksum, sourceChecksum: entry.glyph.asset.checksum, normalizer: EMOJI_SVG_VERSION });
    prepared.set(svg, record);
    return { ok: true, svg };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'SVG admission failed.' }; }
}

/** Canonical bytes use prefix "emoji". A placement must use its own stable prefix for local IDs. */
export function emojiSvgMarkup(svg: PreparedEmojiSvg, prefix = 'emoji'): string {
  const record = prepared.get(svg);
  if (!record || !idPattern.test(prefix)) throw new Error('Invalid prepared SVG or placement prefix.');
  return serialize(record.tree, prefix);
}

const paintNames = ['fill', 'stroke', 'stop-color'] as const;
const hexPaint = /^#(?:[a-f0-9]{3}|[a-f0-9]{6})$/i;

function recolor(node: SvgNode, map: (hex: string, attribute: string) => string): SvgNode {
  const attributes: Record<string, string> = { ...node.attributes };
  for (const name of paintNames) {
    const value = attributes[name];
    // Paint none and a local url() reference carry no colour of their own; a
    // gradient's stops are recoloured where they are declared.
    if (value === undefined || !hexPaint.test(value)) continue;
    const next = map(value, name);
    if (!hexPaint.test(next)) throw new Error('Recoloured SVG paint must be a hex colour.');
    attributes[name] = next.toLowerCase();
  }
  return { tag: node.tag, attributes, children: node.children.map(child => recolor(child, map)) };
}

/**
 * Rewrite every hex fill, stroke and stop-color in an admitted tree through
 * `map`, returning a new handle over a cloned tree with its own checksum and
 * `change` recorded alongside the admission changes. The input handle is left
 * as it was, so the canonical artwork and its treated form both stay readable.
 */
export async function recolorPreparedEmojiSvg(
  svg: PreparedEmojiSvg,
  map: (hex: string, attribute: string) => string,
  change: string,
): Promise<PreparedEmojiSvg> {
  const record = prepared.get(svg);
  if (!record) throw new Error('SVG has not been admitted.');
  const tree = recolor(record.tree, map);
  const changes = [...new Set([...record.changes, change])];
  const checksum = `sha256:${await sha256Hex(new TextEncoder().encode(serialize(tree, 'emoji')))}`;
  const treated = Object.freeze({ checksum, sourceChecksum: svg.sourceChecksum, normalizer: EMOJI_TREATED_SVG_VERSION });
  prepared.set(treated, { tree, changes });
  return treated;
}

/**
 * The one sentence {@link inkPreparedEmojiSvg} records. It deliberately does NOT
 * start with `EMOJI_RECOLOUR_PREFIX`: binding black line art to the text colour
 * is the intended use of a monochrome set, not a palette treatment, and the
 * colour comes from the document's own text. See the note beside the
 * `recoloured` derivation in emoji-rights.ts.
 */
export const EMOJI_SINGLE_INK_CHANGE = 'Single-ink paints follow the surrounding text colour.';

/** The two paints a single-ink glyph is allowed to carry, in the canonical lowercase form. */
const BLACK_PAINT = /^#(?:000|000000)$/i;
const WHITE_PAINT = /^#(?:fff|ffffff)$/i;

/**
 * Whether every paint is `none`, white, black or the pack's pinned foreground ink.
 * A gradient, a `url(#…)` reference or any other colour makes it false, and so
 * does `currentColor`, which is what makes the rewrite below idempotent.
 */
function singleInk(node: SvgNode, textInk: readonly string[] = []): boolean {
  for (const name of paintNames) {
    const value = node.attributes[name];
    if (value === undefined || value === 'none') continue;
    if (!BLACK_PAINT.test(value) && !WHITE_PAINT.test(value) && !textInk.includes(value)) return false;
  }
  return node.children.every(child => singleInk(child, textInk));
}

/** Foreground ink becomes `currentColor`; white and `none` stay as they are. */
function inkTree(node: SvgNode, counted: { value: number }, textInk: readonly string[] = []): SvgNode {
  const attributes: Record<string, string> = { ...node.attributes };
  for (const name of paintNames) {
    const value = attributes[name];
    if (value !== undefined && (BLACK_PAINT.test(value) || textInk.includes(value))) { attributes[name] = 'currentColor'; counted.value += 1; }
  }
  return { tag: node.tag, attributes, children: node.children.map(child => inkTree(child, counted, textInk)) };
}

/** Whether an admitted tree uses only foreground ink, white and `none`. */
export function isSingleInkEmojiSvg(svg: PreparedEmojiSvg): boolean {
  const record = prepared.get(svg);
  if (!record) throw new Error('SVG has not been admitted.');
  return singleInk(record.tree, record.textInk);
}

/**
 * Bind a single-ink glyph's foreground paints to the surrounding text colour, so a
 * monochrome set draws the way the same artwork draws when it ships as a font.
 * An inline `<svg>` inherits CSS `color`, so `currentColor` is the whole
 * mechanism and no caller has to style the placement.
 *
 * The input handle comes back untouched whenever there is nothing to do: a glyph
 * carrying any other colour, a gradient or a `url(#…)` reference, a tree that is
 * already bound this way, and artwork whose ink is all white. A string and tree
 * rewrite only, with no colour maths.
 */
export async function inkPreparedEmojiSvg(svg: PreparedEmojiSvg): Promise<PreparedEmojiSvg> {
  const record = prepared.get(svg);
  if (!record) throw new Error('SVG has not been admitted.');
  if (!singleInk(record.tree, record.textInk)) return svg;
  const counted = { value: 0 };
  const tree = inkTree(record.tree, counted, record.textInk);
  if (!counted.value) return svg;
  const changes = [...new Set([...record.changes, EMOJI_SINGLE_INK_CHANGE])];
  const checksum = `sha256:${await sha256Hex(new TextEncoder().encode(serialize(tree, 'emoji')))}`;
  const inked = Object.freeze({ checksum, sourceChecksum: svg.sourceChecksum, normalizer: EMOJI_INK_SVG_VERSION });
  prepared.set(inked, { tree, changes });
  return inked;
}

/**
 * Show every hex fill, stroke and stop-color in an admitted tree to `visit`,
 * without cloning it, re-serialising it or hashing anything. The counting half of
 * `recolorPreparedEmojiSvg`, for a caller that already knows it is going to keep
 * the artwork exactly as it is and only wants the paint counts.
 */
export function visitPreparedEmojiPaints(svg: PreparedEmojiSvg, visit: (hex: string, attribute: string) => void): void {
  const record = prepared.get(svg);
  if (!record) throw new Error('SVG has not been admitted.');
  const walk = (node: SvgNode): void => {
    for (const name of paintNames) {
      const value = node.attributes[name];
      if (value === undefined || !hexPaint.test(value)) continue;
      visit(value, name);
    }
    for (const child of node.children) walk(child);
  };
  walk(record.tree);
}

export function emojiSvgChanges(svg: PreparedEmojiSvg): string[] {
  const record = prepared.get(svg);
  if (!record) throw new Error('SVG has not been admitted.');
  return [...record.changes];
}
