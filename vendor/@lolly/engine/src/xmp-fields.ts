// SPDX-License-Identifier: MPL-2.0
/** Bounded XMP/RDF property reader for metadata evidence, including namespace aliases. */
import type { MetaField } from './file-metadata.ts';

export type XmpFieldSpec = [prefix: string, namespace: string, property: string, group: MetaField['group'], label: string];

/** Decode XML character references without evaluating a DTD or creating a DOM. */
function xmlValue(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity[0] !== '#') return named[entity] ?? whole;
    const cp = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
  }).slice(0, 2048).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Read only named properties; preserve their source tags and never evaluate XML. */
export function readXmpFields(input: string, specs: readonly XmpFieldSpec[]): MetaField[] {
  const text = input.slice(0, 1024 * 1024).replace(/<!--[\s\S]*?-->/g, '');
  const out: MetaField[] = [];
  const namespaces = new Map<string, string>();
  for (const m of text.matchAll(/xmlns:([\w-]+)\s*=\s*["']([^"']+)["']/g)) namespaces.set(m[1]!, m[2]!);
  for (const [fallback, namespace, property, group, label] of specs) {
    const prefixes = [...namespaces].filter(([, uri]) => uri === namespace).map(([prefix]) => prefix);
    if (!namespaces.has(fallback)) prefixes.push(fallback);
    for (const prefix of prefixes) {
      const tag = `${prefix}:${property}`;
      const re = new RegExp(`<${tag}(?=[\\s/>])([^<>]*?)>|\\b${tag}\\s*=\\s*["']([^"']*)["']`, 'g');
      let missingClose = false;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (out.length >= 64) return out;
        let raw = m[2];
        if (raw === undefined) {
          raw = /[\w-]+:resource\s*=\s*["']([^"']*)["']/.exec(m[1] ?? '')?.[1];
          if (raw === undefined && !missingClose && !/\/\s*$/.test(m[1] ?? '')) {
            const start = m.index! + m[0].length;
            const end = text.indexOf(`</${tag}`, start);
            if (end < 0) missingClose = true;
            else { raw = text.slice(start, end); re.lastIndex = end + tag.length + 2; }
          }
        }
        const value = xmlValue(raw ?? '');
        if (value && !out.some((f) => f.label === label && f.value === value)) out.push({ label, value, group, source: `XMP/RDF ${tag}`, ...(label === 'Creator' || label.startsWith('Contact ') ? { sensitive: true } : {}) });
      }
    }
  }
  return out;
}
