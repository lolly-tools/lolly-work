// SPDX-License-Identifier: MPL-2.0
/** Deterministic dictionary segmentation; unknown runs remain intact. */
import data from './text-thai-data.json' with { type: 'json' };
import { textBoundaries } from './text-source.ts';
interface Node { next: Map<string, Node>; word?: boolean }
let root: Node | undefined;
function dictionary(): Node {
  if (root) return root;
  root = { next: new Map() };
  for (const word of data.words) {
    let node = root;
    for (const character of word) {
      let child = node.next.get(character);
      if (!child) { child = { next: new Map() }; node.next.set(character, child); }
      node = child;
    }
    node.word = true;
  }
  return root;
}
export const TEXT_THAI_RESOURCE = { id: 'thai-dictionary-icu-v1', sha256: data.source.sha256 };
export function thaiTextBreaks(source: string): number[] {
  const breaks: number[] = [], trie = dictionary();
  for (const run of source.matchAll(/[\u0e01-\u0e3a\u0e40-\u0e4e]+/gu)) {
    const text = run[0], bounds = [...textBoundaries(text)], allowed = new Set(bounds);
    const cost = new Float64Array(text.length + 1), next = new Uint32Array(text.length + 1), known = new Uint8Array(text.length + 1);
    cost.fill(Infinity); cost[text.length] = 0;
    for (let i = bounds.length - 2; i >= 0; i--) {
      const start = bounds[i]!, end = bounds[i + 1]!;
      next[start] = end; cost[start] = cost[end]! + 64001 * (end - start);
      let node: Node | undefined = trie;
      for (let at = start; at < Math.min(text.length, start + 128); at++) {
        node = node.next.get(text[at]!); if (!node) break;
        if (!node.word || !allowed.has(at + 1)) continue;
        const candidate = 1 + cost[at + 1]!;
        if (candidate <= cost[start]!) { cost[start] = candidate; next[start] = at + 1; known[start] = 1; }
      }
    }
    if (run.index > 0) breaks.push(run.index);
    for (let at = 0; at < text.length;) {
      const end = next[at]!;
      if (known[at] || known[end] || end === text.length) breaks.push(run.index + end);
      at = end;
    }
  }
  return breaks;
}
