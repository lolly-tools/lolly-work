// SPDX-License-Identifier: MPL-2.0
/** Unicode 17 source analysis. Reordering changes placements, never authored text. */
import { analyze } from 'bidi-shaper';
import { Rules } from '@cto.af/linebreak';
import data from './text-unicode-data.json' with { type: 'json' };
import { emojiGraphemes } from './emoji-segment.ts';
import { assertTextRange, textBoundaries } from './text-source.ts';
import type { TextDirection, TextRangeV1 } from '@lolly-tools/core';
export const TEXT_UNICODE_VERSION = '17.0.0';
const breakers = new Rules();
function property(cp: number, table: { ranges: number[]; values: string[] }): string {
  let low = 0, high = table.ranges.length / 3 - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1, index = middle * 3;
    if (cp < table.ranges[index]!) high = middle - 1;
    else if (cp > table.ranges[index + 1]!) low = middle + 1;
    else return table.values[table.ranges[index + 2]!]!;
  }
  return table.values[0]!;
}
export const textBidiClass = (cp: number): string => property(cp, data.bidi);
export const textScript = (cp: number): string => property(cp, data.scripts);
export function textScripts(cp: number): string[] {
  const extensions = data.extensions as Array<[number, number, string[]]>;
  let low = 0, high = extensions.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1, item = extensions[middle]!;
    if (cp < item[0]) high = middle - 1;
    else if (cp > item[1]) low = middle + 1;
    else return item[2];
  }
  return [textScript(cp)];
}
export interface TextBidiParagraph { source: string; starts: number[]; classes: string[]; levels: number[]; base: number }
export function analyzeTextBidi(source: string, direction: TextDirection = 'auto'): TextBidiParagraph {
  textBoundaries(source);
  const bidi = analyze(source, { direction, shape: false, mirror: false, paragraphs: 'single' });
  const starts: number[] = [], classes: string[] = []; let offset = 0;
  for (const character of source) { starts.push(offset); classes.push(textBidiClass(character.codePointAt(0)!)); offset += character.length; }
  starts.push(source.length);
  return { source, starts, classes, levels: [...bidi.levels], base: bidi.direction === 'rtl' ? 1 : 0 };
}
const removedTypes = new Set(['BN', 'RLE', 'LRE', 'RLO', 'LRO', 'PDF']);
const resettable = new Set(['WS', 'BN', 'RLE', 'LRE', 'RLO', 'LRO', 'PDF', 'RLI', 'LRI', 'FSI', 'PDI']);
/** UAX9 L1 is applied again at the chosen line boundary, then L2 orders whole runs. */
export function textLineLevels(paragraph: TextBidiParagraph, range: TextRangeV1): Array<TextRangeV1 & { level: number; removed: boolean }> {
  assertTextRange(paragraph.source, range);
  const index=(at:number)=>{let low=0,high=paragraph.starts.length-1;while(low<high){const middle=(low+high)>>>1;if(paragraph.starts[middle]!<at)low=middle+1;else high=middle;}return low;};
  const first = index(range.start), last = index(range.end);
  const levels = paragraph.levels.slice(first, last), classes = paragraph.classes.slice(first, last);
  const resetBefore = (index: number): void => { while (index >= 0 && resettable.has(classes[index]!)) levels[index--] = paragraph.base; };
  resetBefore(levels.length - 1);
  for (let i = 0; i < levels.length; i++) if (classes[i] === 'S' || classes[i] === 'B') { levels[i] = paragraph.base; resetBefore(i - 1); }
  const runs: Array<TextRangeV1 & { level: number; removed: boolean }> = [];
  for (let i = 0; i < levels.length; i++) {
    const start = paragraph.starts[first + i]!, end = paragraph.starts[first + i + 1]!, level = levels[i]!, removed = removedTypes.has(classes[i]!);
    const previous = runs.at(-1);
    if (previous?.level === level && previous.removed === removed) previous.end = end; else runs.push({ start, end, level, removed });
  }
  return runs;
}
export function reorderTextRuns<T extends { level: number; removed?: boolean }>(logical: readonly T[]): T[] {
  const visual = logical.filter(run => !run.removed); let maximum = 0, minimumOdd = Infinity;
  for (const run of visual) { maximum = Math.max(maximum, run.level); if (run.level % 2) minimumOdd = Math.min(minimumOdd, run.level); }
  for (let level = maximum; level >= minimumOdd; level--) for (let start = 0; start < visual.length;) {
    if (visual[start]!.level < level) { start++; continue; }
    let end = start + 1; while (end < visual.length && visual[end]!.level >= level) end++;
    for (let a = start, b = end - 1; a < b; a++, b--) [visual[a], visual[b]] = [visual[b]!, visual[a]!];
    start = end;
  }
  return visual;
}
export function textBreakOpportunities(source: string): Array<{ offset: number; required: boolean }> {
  const boundaries = textBoundaries(source);
  return [...breakers.breaks(source)].filter(item => boundaries.has(item.position)).map(item => ({ offset: item.position, required: item.required }));
}
/** Resolve Common/Inherited script clusters without breaking their graphemes. */
export function textScriptRuns(source: string): Array<TextRangeV1 & { script: string }> {
  const clusters = emojiGraphemes(source).map(cluster => {
    let scripts: string[] = [];
    for (const character of source.slice(cluster.start, cluster.end)) {
      const candidates = textScripts(character.codePointAt(0)!).filter(script => script !== 'Zyyy' && script !== 'Zinh' && script !== 'Zzzz');
      if (!candidates.length) continue;
      if (!scripts.length) scripts = candidates;
      else { const common = scripts.filter(script => candidates.includes(script)); if (common.length) scripts = common; }
    }
    return { ...cluster, scripts, script: '' };
  });
  let previous = '';
  for (const cluster of clusters) { cluster.script = cluster.scripts.includes(previous) ? previous : cluster.scripts[0] ?? previous; if (cluster.script) previous = cluster.script; }
  let next = 'Zyyy';
  for (let i = clusters.length - 1; i >= 0; i--) { if (!clusters[i]!.script) clusters[i]!.script = next; else next = clusters[i]!.script; }
  const runs: Array<TextRangeV1 & { script: string }> = [];
  for (const cluster of clusters) { const previous = runs.at(-1); if (previous?.script === cluster.script) previous.end = cluster.end; else runs.push({ start: cluster.start, end: cluster.end, script: cluster.script }); }
  return runs;
}
