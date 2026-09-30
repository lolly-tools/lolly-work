// SPDX-License-Identifier: MPL-2.0
/** Pinned Liang patterns produce candidate offsets, never edited source text. */
import { textBoundaries } from './text-source.ts';
interface PatternData { language: string; sha256: string; left: number; right: number; patterns: string; exceptions: string[] }
interface Trie { children: Map<string, Trie>; values?: number[] }
export interface TextHyphenator {
  id: string; sha256: string;
  points(word: string, before: number, after: number): number[];
}
const loaders = {
  'en-us': () => import('./text-hyphen-data/en-us.json', { with: { type: 'json' } }),
  'en-gb': () => import('./text-hyphen-data/en-gb.json', { with: { type: 'json' } }),
  fr: () => import('./text-hyphen-data/fr.json', { with: { type: 'json' } }),
  es: () => import('./text-hyphen-data/es.json', { with: { type: 'json' } }),
  'de-1996': () => import('./text-hyphen-data/de-1996.json', { with: { type: 'json' } }),
};
const cache = new Map<string, Promise<TextHyphenator>>();
/** English without a region uses US spelling; spelling variants are explicit saved tags. */
export function textHyphenationLanguage(language = 'und'): keyof typeof loaders | null {
  const tag = language.toLowerCase();
  if (tag === 'en-gb' || tag.startsWith('en-gb-')) return 'en-gb';
  if (tag === 'en' || tag === 'en-us' || tag.startsWith('en-us-')) return 'en-us';
  if (tag === 'de' || tag === 'de-de' || tag === 'de-1996') return 'de-1996';
  if (tag === 'fr' || tag.startsWith('fr-')) return 'fr';
  if (tag === 'es' || tag.startsWith('es-')) return 'es';
  return null;
}
function compile(data: PatternData): TextHyphenator {
  const root: Trie = { children: new Map() }, exceptions = new Map<string, number[]>();
  for (const pattern of data.patterns.split(' ')) {
    const values = [0]; let node = root;
    for (const char of pattern) {
      if (/\d/.test(char)) values[values.length - 1] = Number(char);
      else { let child = node.children.get(char); if (!child) { child = { children: new Map() }; node.children.set(char, child); } node = child; values.push(0); }
    }
    node.values = values;
  }
  for (const item of data.exceptions) {
    const points: number[] = []; let word = '';
    for (const char of item) { if (char === '-') points.push(word.length); else word += char; }
    exceptions.set(word, points);
  }
  return { id: `hyphen:${data.language}`, sha256: data.sha256, points(word, before, after) {
    if (word.length > 256) return [];
    const lower = word.toLowerCase();
    if (lower.length !== word.length) return [];
    const left = Math.max(before, data.left), right = Math.max(after, data.right), boundaries = textBoundaries(word);
    const valid = (at: number) => at >= left && at <= word.length - right && boundaries.has(at);
    const exact = exceptions.get(lower); if (exact) return exact.filter(valid);
    const chars = [...`.${lower}.`], levels = Array<number>(chars.length + 1).fill(0);
    for (let start = 0; start < chars.length; start++) {
      let node: Trie | undefined = root;
      for (let end = start; end < chars.length; end++) {
        node = node.children.get(chars[end]!); if (!node) break;
        for (const [i, weight] of (node.values ?? []).entries()) levels[start + i] = Math.max(levels[start + i]!, weight);
      }
    }
    const points: number[] = []; let offset = 0;
    for (let i = 1; i < chars.length - 1; i++) { if (levels[i]! % 2 && valid(offset)) points.push(offset); offset += chars[i]!.length; }
    return points;
  } };
}
export async function textHyphenator(language?: string): Promise<TextHyphenator | null> {
  const key = textHyphenationLanguage(language); if (!key) return null;
  let value = cache.get(key); if (!value) { value = loaders[key]().then(module => compile(module.default)); cache.set(key, value); }
  return value;
}
