// SPDX-License-Identifier: MPL-2.0
/** Bounded style observations shared by saved-page and browser capture readers. */
export const BRAND_STYLE_PROPERTIES = [
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'gap', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-left-radius',
] as const;
export type BrandStyleProperty = typeof BRAND_STYLE_PROPERTIES[number];
export interface BrandStyleValue { property: BrandStyleProperty; value: string; count: number }
export interface BrandStyleEvidence {
  version: 1;
  mode: 'declared' | 'computed';
  sampled: number;
  truncated: boolean;
  values: BrandStyleValue[];
  missing: BrandStyleProperty[];
  viewport?: { width: number; height: number; scheme: 'light' | 'dark' };
}

const properties = new Set<string>(BRAND_STYLE_PROPERTIES);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Accept only known style fields. No selectors, page text, URLs or font bytes travel. */
export function summarizeBrandStyles(mode: BrandStyleEvidence['mode'], rows: unknown, sampled = 0, truncated = false): BrandStyleEvidence {
  const entries = Array.isArray(rows) ? rows : [];
  const values = new Map<string, BrandStyleValue>();
  for (const row of entries.slice(0, 2400)) {
    if (!record(row) || typeof row.property !== 'string' || !properties.has(row.property) || typeof row.value !== 'string') continue;
    const value = row.value.trim().replace(/\s+/g, ' ');
    if (!value || value.length > 160 || /[<>{};\\]|url\s*\(|var\s*\(/i.test(value)) continue;
    const property = row.property as BrandStyleProperty;
    if (property !== 'font-family' && !/^(?:normal|bold|bolder|lighter|[-+.\d]+(?:px|rem|em|%|pt)?)$/i.test(value)) continue;
    const count = typeof row.count === 'number' && Number.isFinite(row.count) ? Math.min(2400, Math.max(1, Math.floor(row.count))) : 1;
    const key = `${property}:${value}`;
    const previous = values.get(key);
    if (previous) previous.count = Math.min(2400, previous.count + count);
    else values.set(key, { property, value, count });
  }
  const kept = [...values.values()].sort((a, b) => a.property < b.property ? -1 : a.property > b.property ? 1 : b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const limited = BRAND_STYLE_PROPERTIES.flatMap(property => kept.filter(v => v.property === property).slice(0, 12));
  return {
    version: 1, mode, sampled: Number.isFinite(sampled) ? Math.min(100_000, Math.max(0, Math.floor(sampled))) : 0,
    truncated: truncated || entries.length > 2400 || limited.length < kept.length,
    values: limited, missing: BRAND_STYLE_PROPERTIES.filter(property => !limited.some(v => v.property === property)),
  };
}

/** Revalidate persisted or transported observations before showing them as evidence. */
export function readBrandStyleEvidence(value: unknown): BrandStyleEvidence | null {
  if (!record(value) || value.version !== 1 || (value.mode !== 'computed' && value.mode !== 'declared')) return null;
  const evidence = summarizeBrandStyles(value.mode, value.values, typeof value.sampled === 'number' ? value.sampled : 0, value.truncated === true);
  const viewport = value.viewport;
  if (record(viewport) && typeof viewport.width === 'number' && typeof viewport.height === 'number' && Number.isFinite(viewport.width) && Number.isFinite(viewport.height) && viewport.width > 0 && viewport.width < 100_000 && viewport.height > 0 && viewport.height < 100_000 && (viewport.scheme === 'light' || viewport.scheme === 'dark')) evidence.viewport = { width: viewport.width, height: viewport.height, scheme: viewport.scheme };
  return evidence;
}
