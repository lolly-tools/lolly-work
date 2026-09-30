// SPDX-License-Identifier: MPL-2.0
/** Mixed SVG text uses shaped outlines and the same prepared emoji as HTML. */
import type { TextAPI } from '@lolly-tools/core/host-v1';
import type { EmojiStyleV1 } from '@lolly-tools/core/emoji-v1';
import type { VerifiedEmojiPack } from './emoji-pack.ts';
import type { EmojiDomOptions, EmojiDomResult } from './emoji-dom.ts';
import { prepareEmojiText, type EmojiTextIO } from './emoji-inline.ts';
import { segmentEmojiText, requiresEmojiBidiLayout } from './emoji-segment.ts';
import { emojiTextPath } from './emoji-text-path.ts';
import { escapeXml } from './xml-escape.ts';

interface SvgElement {
  tagName: string;
  textContent: string | null;
  innerHTML: string;
  children: ArrayLike<SvgElement>;
  attributes: ArrayLike<{ name: string; value: string }>;
  parentElement: SvgElement | null;
  ownerDocument: {
    createElementNS(ns: string, name: string): SvgElement;
    defaultView?: { getComputedStyle(node: unknown): { getPropertyValue(name: string): string } } | null;
  };
  querySelectorAll(selector: string): ArrayLike<SvgElement>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  appendChild(node: SvgElement): unknown;
  replaceWith(node: SvgElement): void;
}
const NS = 'http://www.w3.org/2000/svg';
const n = (value: number): string => {
  if (!Number.isFinite(value) || Math.abs(value) > 1e7) throw new Error('Unsupported SVG text geometry.');
  return String(Math.round(value * 1e6) / 1e6);
};
const layout = new Set(['x', 'y', 'dx', 'dy', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'textLength', 'lengthAdjust']);
function property(node: SvgElement, name: string, fallback = ''): string {
  for (let at: SvgElement | null = node; at; at = at.parentElement) {
    const computed = at.ownerDocument.defaultView?.getComputedStyle(at).getPropertyValue(name);
    if (computed && !/^(inherit|initial|unset)$/.test(computed)) return computed;
    const attr = at.getAttribute(name); if (attr) return attr;
  }
  return fallback;
}
function percentageBasis(node: SvgElement, axis: 'x' | 'y'): number {
  let svg: SvgElement | null = node;
  while (svg && svg.tagName.toLowerCase() !== 'svg') svg = svg.parentElement;
  const box = svg?.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number);
  if (box?.length === 4 && Number.isFinite(box[axis === 'x' ? 2 : 3])) return box[axis === 'x' ? 2 : 3]!;
  return parseFloat(svg?.getAttribute(axis === 'x' ? 'width' : 'height') || '') || (axis === 'x' ? 300 : 150);
}
function coordinate(value: string | null, em: number, fallback = 0, percent?: number): number {
  if (!value) return fallback;
  if (value.endsWith('%') && percent !== undefined) return coordinate(value.slice(0,-1),em) * percent / 100;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:px|em)?$/.test(value.trim())) throw new Error('SVG text needs scalar pixel or em coordinates.');
  return parseFloat(value) * (value.endsWith('em') ? em : 1);
}
function textOnly(node: SvgElement): boolean { return !node.children.length; }

/** Restore authoring text before a new style is applied or editing begins. */
export function revertEmojiSvgText(root: unknown): void {
  const tree = root as SvgElement;
  if (typeof tree?.querySelectorAll !== 'function') return;
  for (const group of Array.from(tree.querySelectorAll('[data-lolly-emoji-svg]'))) {
    const source = Array.from(group.querySelectorAll('text[data-lolly-emoji-source]'))[0];
    if (!source) continue;
    source.removeAttribute('data-lolly-emoji-source');
    const id = source.getAttribute('data-lolly-emoji-id');
    if (id) { source.setAttribute('id', id); source.removeAttribute('data-lolly-emoji-id'); }
    group.replaceWith(source);
  }
}

/** A failed layout is explicit. It never hands emoji back to the operating system. */
export async function applyEmojiToSvgText(root: unknown, style: EmojiStyleV1 | null | undefined, packs: readonly VerifiedEmojiPack[], io: EmojiTextIO, text: TextAPI | undefined, options: EmojiDomOptions = {}): Promise<EmojiDomResult> {
  const tree = root as SvgElement;
  const result: EmojiDomResult = { replaced: 0, unresolved: 0, census: [] };
  if (typeof tree?.querySelectorAll !== 'function') return result;
  revertEmojiSvgText(root);
  const runs = [...(tree.tagName?.toLowerCase() === 'text' ? [tree] : []), ...Array.from(tree.querySelectorAll('text'))];
  let markupBytes = 0;
  for (let index = 0; index < runs.length; index++) {
    const source = runs[index]!;
    let inert = false;
    for (let parent = source.parentElement; parent; parent = parent.parentElement) if (/^(defs|clipPath|mask)$/i.test(parent.tagName)) inert = true;
    if (inert) continue;
    const raw = source.textContent ?? '';
    let spans: ReturnType<typeof segmentEmojiText>;
    try { spans = segmentEmojiText(raw); } catch { continue; }
    if (!spans.some(span => span.kind !== 'text')) continue;
    const group = source.ownerDocument.createElementNS(NS, 'g');
    group.setAttribute('data-lolly-emoji-svg', '1');
    group.setAttribute('role', 'img'); group.setAttribute('aria-label', raw);
    for (const attr of Array.from(source.attributes)) if (!layout.has(attr.name) && attr.name !== 'id') group.setAttribute(attr.name, attr.value);
    const sourceId = source.getAttribute('id'); if (sourceId) group.setAttribute('id', sourceId);
    let markup = '';
    try {
      if (!text?.fontUrl || requiresEmojiBidiLayout(raw)) throw new Error('This SVG text layout needs a supported text shaper.');
      if (source.getAttribute('textLength')) throw new Error('Stretched SVG text needs explicit outlines.');
      const lines = textOnly(source) ? [source] : Array.from(source.children);
      if (lines.some(line => !['tspan', 'textpath'].includes(line.tagName.toLowerCase()) && line !== source || !textOnly(line))) throw new Error('Nested SVG text needs explicit outlines.');
      if (!textOnly(source) && source.innerHTML.replace(/<(tspan|textPath)\b[^>]*>[\s\S]*?<\/\1>/gi, '').trim()) throw new Error('Mixed SVG text children need explicit outlines.');
      const rootEm = coordinate(property(source, 'font-size', '16'), 16);
      let x = coordinate(source.getAttribute('x'), rootEm, 0, percentageBasis(source,'x')), y = coordinate(source.getAttribute('y'), rootEm, 0, percentageBasis(source,'y'));
      if (lines[0] !== source) { x += coordinate(source.getAttribute('dx'), rootEm); y += coordinate(source.getAttribute('dy'), rootEm); }
      const pending: EmojiDomResult = { replaced: 0, unresolved: 0, census: [] };
      for (let row = 0; row < lines.length; row++) {
        const line = lines[row]!;
        const em = coordinate(property(line, 'font-size', String(rootEm)), rootEm);
        const family = property(line, 'font-family');
        const weightRaw = property(line, 'font-weight', '400');
        const weight = weightRaw === 'bold' ? 700 : parseFloat(weightRaw) || 400;
        const italic = /italic|oblique/.test(property(line, 'font-style'));
        let font: Awaited<ReturnType<NonNullable<TextAPI['fontUrl']>>> = null;
        for (const name of family.split(',').map(item => item.trim().replace(/^['"]|['"]$/g, ''))) {
          if (name) font = await text.fontUrl(name, { weight, italic });
          if (font) break;
        }
        const lineText = line.textContent ?? '';
        const prepared = await prepareEmojiText(lineText, style, packs, io, { cache: options.cache, prefix: `${options.idScope ?? 'e'}_svg_${index}_${row}` });
        const fill = property(line, 'fill', '#000000');
        const spacing = property(line, 'letter-spacing', '0');
        const tracking = spacing === 'normal' ? 0 : coordinate(spacing, em);
        let advance = 0; const parts: string[] = [];
        const curveText = line.tagName.toLowerCase() === 'textpath';
        const pieces: Array<{markup:string;x:number;advance:number}> = [];
        const add = (markup: string, x: number, width: number): void => {
          if (curveText) pieces.push({ markup, x, advance: width }); else parts.push(markup);
        };
        for (const segment of prepared.segments) {
          if (segment.kind === 'text') {
            if (!font) throw new Error(`No pinned font for ${family || 'this SVG text'}.`);
            const shaped = await text.toPath({ text: segment.text, fontUrl: font.url, fontSize: em,
              variations: font.variations, letterSpacing: tracking, preserveWhitespaceAdvance: true, clusters: curveText });
            if (shaped.notdef) throw new Error('The selected font does not cover this SVG text.');
            if (curveText) {
              if (!shaped.clusters) throw new Error('SVG text paths need cluster outlines.');
              for (const cluster of shaped.clusters) add(`<path fill="${escapeXml(fill)}" transform="translate(${n(advance)} 0)" d="${escapeXml(cluster.d)}"/>`, advance + cluster.x, cluster.advance);
            } else add(`<path fill="${escapeXml(fill)}" transform="translate(${n(advance)} 0)" d="${escapeXml(shaped.d)}"/>`, advance, shaped.advanceWidth);
            advance += shaped.advanceWidth;
          } else if (segment.kind === 'emoji') {
            const m = segment.metrics;
            const art = segment.markup.replace(/<svg\b[^>]*>/, tag => tag.replace(/ (?:width|height|x|y)="[^"]*"/g, '').replace(/<svg\b/, `<svg x="${n(advance)}" y="${n((m.descentEm - m.heightEm) * em)}" width="${n(m.widthEm * em)}" height="${n(m.heightEm * em)}"`));
            add(art, advance, m.advanceEm * em + tracking); advance += m.advanceEm * em + tracking; pending.replaced++;
          } else {
            add(`<rect x="${n(advance + em * .1)}" y="${n(-em * .75)}" width="${n(em * .7)}" height="${n(em * .8)}" fill="none" stroke="${escapeXml(fill)}" stroke-width="${n(em * .05)}"/>`, advance, em);
            advance += em; pending.unresolved++;
          }
        }
        x = coordinate(line.getAttribute('x'), em, x, percentageBasis(line,'x')) + coordinate(line.getAttribute('dx'), em);
        y = coordinate(line.getAttribute('y'), em, y, percentageBasis(line,'y')) + coordinate(line.getAttribute('dy'), em);
        const anchor = property(line, 'text-anchor', 'start');
        const baseline = property(line, 'dominant-baseline', 'auto');
        const aligned = property(line, 'alignment-baseline');
        const mode = aligned && !/^(auto|baseline)$/.test(aligned) ? aligned : baseline;
        if (!/^(auto|alphabetic|middle|central|hanging|text-before-edge|text-after-edge)$/.test(mode)) throw new Error('Unsupported SVG text baseline.');
        let baselineOffset = 0;
        if (mode === 'middle' || mode === 'central') {
          const metrics = font && text ? await text.toPath({text:mode === 'middle' ? 'x' : 'Hg',fontUrl:font.url,fontSize:em,variations:font.variations}) : null;
          baselineOffset = metrics?.bbox ? -(metrics.bbox.y1 + (mode === 'central' ? metrics.bbox.y2 : 0))/2 : em * .3;
        } else if (mode === 'hanging' || mode === 'text-before-edge') baselineOffset = em * .8;
        else if (mode === 'text-after-edge') baselineOffset = -em * .2;
        const at = x - (anchor === 'middle' ? advance / 2 : anchor === 'end' ? advance : 0);
        if (curveText) {
          const href = line.getAttribute('href') || line.getAttribute('xlink:href') || '';
          if (!/^#[A-Za-z_][\w.-]*$/.test(href)) throw new Error('SVG text paths need a local path.');
          let scope = source; while (scope.parentElement && scope.tagName.toLowerCase() !== 'svg') scope = scope.parentElement;
          const path = Array.from(scope.querySelectorAll('path')).find(item => item.getAttribute('id') === href.slice(1));
          if (!path || path.getAttribute('transform') || path.getAttribute('pathLength')) throw new Error('SVG text path transforms need explicit outlines.');
          const curve = emojiTextPath(path.getAttribute('d') || '');
          const offset = line.getAttribute('startOffset') || '0';
          let start = offset.endsWith('%') ? coordinate(offset.slice(0,-1),em) * curve.length / 100 : coordinate(offset, em);
          const fit = line.getAttribute('data-lolly-text-fit') === 'shrink';
          const scale = fit && advance > curve.length * .97 ? curve.length * .97 / advance : 1;
          if (fit) {
            const position = coordinate(line.getAttribute('data-lolly-text-position'), em) / 100;
            start = Math.max(0, Math.min(curve.length - advance * scale, position * curve.length - (anchor === 'middle' ? advance * scale / 2 : anchor === 'end' ? advance * scale : 0)));
          } else start -= anchor === 'middle' ? advance / 2 : anchor === 'end' ? advance : 0;
          for (const piece of pieces) {
            const mid = piece.x + piece.advance / 2, distance = start + mid * scale;
            if (distance < 0 || distance > curve.length) continue;
            const at = curve.at(distance);
            parts.push(`<g transform="translate(${n(at.x)} ${n(at.y)}) rotate(${n(at.angle)}) scale(${n(scale)}) translate(${n(-mid)} ${n(y + baselineOffset)})">${piece.markup}</g>`);
          }
          if (parts.length) markup += `<g color="${escapeXml(fill)}">${parts.join('')}</g>`;
        } else if (parts.length) markup += `<g color="${escapeXml(fill)}" transform="translate(${n(at)} ${n(y + baselineOffset)})">${parts.join('')}</g>`;
        if (markupBytes + markup.length > 4 * 1024 * 1024) throw new Error('SVG emoji artwork exceeds the 4 MiB layout budget.');
        x = at + advance; pending.census.push(...prepared.census);
      }
      markupBytes += markup.length;
      result.replaced += pending.replaced; result.unresolved += pending.unresolved; result.census.push(...pending.census);
    } catch (error) {
      // Preserve ordinary text and expose the refusal on the element for inspectors.
      const fallback = source.ownerDocument.createElementNS(NS, 'text');
      for (const attr of Array.from(source.attributes)) if (!['id', 'transform'].includes(attr.name)) fallback.setAttribute(attr.name, attr.value);
      fallback.textContent = spans.map(span => span.kind === 'text' ? span.text : '\u25a1').join('');
      markup = ''; group.appendChild(fallback);
      group.setAttribute('data-emoji-layout-issue', error instanceof Error ? error.message : 'Unsupported SVG text layout.');
      result.unresolved += spans.filter(span => span.kind !== 'text').length;
    }
    if (markup) group.innerHTML = markup;
    const defs = source.ownerDocument.createElementNS(NS, 'defs');
    source.replaceWith(group); source.setAttribute('data-lolly-emoji-source', '1');
    if (sourceId) { source.setAttribute('data-lolly-emoji-id', sourceId); source.removeAttribute('id'); }
    defs.appendChild(source); group.appendChild(defs);
  }
  return result;
}
