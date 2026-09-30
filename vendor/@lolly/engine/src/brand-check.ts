// SPDX-License-Identifier: MPL-2.0
/** Checks authored Design values against one selected design system. No rendering. */
import { aliasPath, createTokenSet } from './tokens.ts';
import { deltaEOk } from './color-tools.ts';
import { parseColor } from './css-color.ts';
import { brandContext } from './brand-context.ts';

export interface BrandFix { layerId: string; field: string; before: unknown; after: string }
export interface BrandFinding {
  id: string;
  kind: 'color' | 'font' | 'asset' | 'reference' | 'coverage';
  status: 'review' | 'unknown';
  layerId?: string;
  label: string;
  field?: string;
  value?: string;
  suggestion?: string;
  fix?: BrandFix;
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const valueText = (v: unknown): string => typeof v === 'string' ? v : record(v) && typeof v.ref === 'string' ? v.ref : '';
const family = (v: string): string => v.split(',')[0]!.replace(/["']/g, '').trim().toLowerCase();

export function checkBrandDesign(boxes: unknown, doc: unknown, opts: { theme?: string } = {}) {
  const context = brandContext(doc, opts);
  const tokens = createTokenSet(doc, opts);
  const findings: BrandFinding[] = [];
  const checked = { colors: 0, fonts: 0, assets: 0 };
  const palette = context.colors.filter(c => parseColor(c.value));
  const allowedFonts = new Set(context.fonts.map(f => family(f.value)));
  const allowedAssets = new Set(context.assets.map(a => a.id));
  const nearest = new Map<string, { path: string; value: string; distance: number }>();
  const rows = Array.isArray(boxes) ? boxes.filter(record) : [];
  if (!Array.isArray(boxes)) findings.push({ id: 'brand.document', kind: 'coverage', status: 'unknown', label: 'No readable composition.' });
  const counts = new Map<string, number>();
  for (const row of rows) if (typeof row.id === 'string') counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  for (const row of rows.slice(0, 5000)) {
    if (row.hidden === true || row.hidden === 'true') continue;
    const id = typeof row.id === 'string' ? row.id : '';
    const label = String(row.name || (typeof row.text === 'string' ? row.text.slice(0, 40) : '') || id || 'Layer');
    const add = (field: string, kind: BrandFinding['kind'], status: BrandFinding['status'], value: string, suggestion?: string, after?: string): void => {
      findings.push({ id: `brand.${kind}.${id}.${field}`, layerId: id, label, field, kind, status, value, suggestion,
        ...(after && id && counts.get(id) === 1 && row.locked !== true && row.locked !== 'true' ? { fix: { layerId: id, field, before: row[field], after } } : {}),
      });
    };
    for (const field of ['bg', 'fg', 'stroke']) {
      if (field === 'fg' && !row.text) continue;
      const raw = valueText(row[field]);
      if (!raw || raw === 'transparent' || raw === 'none') continue;
      const path = aliasPath(raw) ?? (record(row[field]) ? valueText(row[field]).replace(/^\{|\}$/g, '') : null);
      if (path) {
        if (!tokens.has(path) || tokens.get(path)?.type !== 'color' || !parseColor(String(tokens.resolve(path)))) add(field, 'reference', 'unknown', raw);
        else checked.colors++;
        continue;
      }
      const parsed = parseColor(raw);
      if (parsed?.alpha === 0) continue;
      if (!parsed || parsed.alpha < 1) { add(field, 'color', 'unknown', raw); continue; }
      if (!palette.length) { add(field, 'color', 'unknown', raw); continue; }
      checked.colors++;
      let closest = nearest.get(raw);
      if (!closest) {
        for (const color of palette) {
          const distance = deltaEOk(raw, color.value);
          if (!closest || distance < closest.distance || (distance === closest.distance && color.path < closest.path)) closest = { path: color.path, value: color.value, distance };
        }
        nearest.set(raw, closest!);
      }
      if (!closest) continue;
      if (closest.distance < 0.000001) continue;
      add(field, 'color', 'review', raw, closest.value, `{${closest.path}}`);
    }
    if (row.text) {
      const font = valueText(row.font) || 'sans';
      const role = ({ sans: 'font.brand', display: 'font.display', mono: 'font.mono' } as Record<string, string>)[font];
      const path = aliasPath(font) ?? role;
      const resolved = path ? tokens.resolve(path) : font;
      if (!allowedFonts.size || typeof resolved !== 'string' || (path && !tokens.has(path))) add('font', 'font', 'unknown', font);
      else {
        checked.fonts++;
        if (!allowedFonts.has(family(resolved))) add('font', 'font', 'review', font, context.fonts[0]?.value, tokens.has('font.brand') ? 'sans' : undefined);
      }
    }
    const image = valueText(row.image) || (record(row.image) && typeof row.image.id === 'string' ? row.image.id : '');
    if (image) {
      const assetId = aliasPath(image) ? tokens.resolve(image) : image;
      if (!allowedAssets.size || typeof assetId !== 'string') add('image', 'asset', 'unknown', image);
      else { checked.assets++; if (!allowedAssets.has(assetId)) add('image', 'asset', 'review', image); }
    }
  }
  return {
    findings, checked,
    coverage: { truncated: rows.length > 5000, colors: palette.length > 0, fonts: allowedFonts.size > 0, assets: allowedAssets.size > 0 },
    requiresMount: ['computed contrast', 'font availability', 'text layout'],
    notAssessed: ['gradients', 'effects', 'nested tool content', 'motion', 'rights', 'subjective quality'],
  };
}

/** Compare before writing so a delayed fix cannot overwrite a newer edit or a locked layer. */
export function applyBrandFix(boxes: unknown, fix: BrandFix): Record<string, unknown>[] | null {
  if (!Array.isArray(boxes) || !['bg', 'fg', 'stroke', 'font'].includes(fix.field)) return null;
  const matches = boxes.filter(row => record(row) && row.id === fix.layerId);
  if (matches.length !== 1) return null;
  const target = matches[0] as Record<string, unknown>;
  if (target.locked === true || target.locked === 'true' || JSON.stringify(target[fix.field]) !== JSON.stringify(fix.before)) return null;
  return boxes.map(row => row === target ? { ...row, [fix.field]: fix.after } : row);
}
