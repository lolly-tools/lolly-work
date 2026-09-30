// SPDX-License-Identifier: MPL-2.0
/** Settled text becomes vector markup without a second shaping or wrapping pass. */
import type { TextLayoutV1, TextStoryV1 } from '@lolly-tools/core';
import { admitTextInlineSvg, type EmojiXmlParser } from './emoji-svg.ts';
import { sha256Hex } from './bytes.ts';
import { TextSourceError } from './text-source.ts';
import { formatColor, parseColor } from './css-color.ts';
const escapeMarkup = (value: string): string => value.replace(/[&<>"'\r]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;', '\r': '&#13;' })[c]!);
const n = (value: number): string => {
  if (!Number.isFinite(value) || Math.abs(value) > 100000000) throw new TextSourceError('layout-coordinate', 'Text layout contains an invalid coordinate.');
  return String(Math.round(value * 10000) / 10000);
};
const color = (value: string): string => {
  const parsed = value.length <= 256 && parseColor(value);
  if (!parsed) throw new TextSourceError('layout-color', 'Text layout contains an invalid colour.');
  return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value : formatColor(parsed);
};
export async function textLayoutSvg(layout: TextLayoutV1, story: TextStoryV1, frameId: string, parseXml: EmojiXmlParser): Promise<string> {
  if (layout.storyId !== story.id || layout.revision !== story.revision) throw new TextSourceError('layout-stale', 'Finish text layout before exporting this revision.');
  const frame = layout.frames.find(item => item.id === frameId);
  if (!frame) throw new TextSourceError('frame-missing', 'The settled text frame is missing.');
  const fragments: string[] = frame.guide ? [`<path d="${escapeMarkup(frame.guide)}" fill="none" stroke="#666666" stroke-width="1"/>`] : [];
  const prefix = `text-${await sha256Hex(new TextEncoder().encode(`${story.id}\0${frameId}`))}`;
  let placement = 0;
  for (const line of layout.lines) {
    if (line.frameId !== frameId) continue;
    for(const rule of line.rules??[])fragments.push(`<rect x="${n(rule.x)}" y="${n(rule.y)}" width="${n(rule.width)}" height="${n(rule.height)}" fill="${color(rule.color)}"/>`);
    for(const leader of line.leaders??[])for(let i=0;i<leader.count;i++)fragments.push(`<g fill="${color(leader.color)}" transform="translate(${n(leader.x+i*leader.step)} ${n(leader.y)})">${leader.shape.clusters.map(cluster=>`<path d="${escapeMarkup(cluster.d)}"/>`).join('')}</g>`);
    for (const run of line.runs) {
      const paths = run.shape.clusters.map(cluster => `<path data-text-start="${n(cluster.start)}" data-text-end="${n(cluster.end)}" d="${escapeMarkup(cluster.d)}"/>`).join('');
      const decoration = (y: number): string => `<rect x="0" y="${n(y)}" width="${n(run.shape.advance)}" height="${n(Math.max(.5, run.shape.size / 16))}"/>`;
      fragments.push(`<g fill="${color(run.color)}" transform="translate(${n(run.x)} ${n(run.y)}) rotate(${n(run.angle)})">${paths}${run.character.underline ? decoration(run.shape.size / 10) : ''}${run.character.strike ? decoration(-run.shape.size * .3) : ''}</g>`);
    }
    for (const inline of line.inlines) {
      const svg = admitTextInlineSvg(inline.svg, parseXml, `${prefix}-${placement++}`);
      const fitted = svg.replace(/^<svg([^>]*)>/, (_match, attributes: string) => `<svg${attributes.replace(/ (width|height)="[^"]*"/g, '')} width="${n(inline.width)}" height="${n(inline.height)}"${inline.overflow==='visible'?' overflow="visible"':''}>`);
      const sources=story.inlines.find(item=>item.offset===inline.offset)?.emojiSources;
      fragments.push(`<g data-text-start="${n(inline.offset)}"${sources?.length?` data-emoji-vector-sources="${escapeMarkup(JSON.stringify(sources))}"`:``} transform="translate(${n(inline.x)} ${n(inline.y)}) rotate(${n(inline.angle)})">${fitted}</g>`);
    }
    if (line.hyphen) fragments.push(`<g fill="${color(line.hyphen.color ?? '#000000')}" transform="translate(${n(line.hyphen.x)} ${n(line.hyphen.y)})">${line.hyphen.shape.clusters.map(cluster => `<path d="${escapeMarkup(cluster.d)}"/>`).join('')}</g>`);
  }
  const stamp=await sha256Hex(new TextEncoder().encode(JSON.stringify([layout.algorithm,layout.shaper,layout.documentHash,layout.resources,frame.width,frame.height,frame.clip,frame.guide,layout.lines.filter(line=>line.frameId===frameId)])));
  return `<svg xmlns="http://www.w3.org/2000/svg" data-composed-text="${escapeMarkup(story.id)}" data-text-layout="${stamp}" data-text-frame="${escapeMarkup(frameId)}" data-text-revision="${n(story.revision)}"${layout.overset && layout.frames.at(-1)?.id===frameId?' data-text-overset="'+n(layout.overset.start)+'"':''} role="img" width="${n(frame.width)}" height="${n(frame.height)}" viewBox="0 0 ${n(frame.width)} ${n(frame.height)}" overflow="${frame.clip?'hidden':'visible'}"><title>${escapeMarkup(story.source.slice(frame.start, frame.end))}</title>${fragments.join('')}</svg>`;
}
