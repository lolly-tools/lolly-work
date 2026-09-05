// SPDX-License-Identifier: MPL-2.0
/** Resolve a live provider into typed batch rows. Network/provider access stays
 * in the hosted resolver; this module only decodes and shape-checks its result. */
import type { HostedAssetResult, HostedProviderRef } from '../catalog/providers/asset-resolver.ts';

export interface DataBinding { source: string; query?: Record<string, unknown>; as?: Record<string, unknown> }

export async function resolveBindingRows(binding: DataBinding, resolve: (ref: HostedProviderRef) => Promise<HostedAssetResult | null>): Promise<Record<string, unknown>[]> {
  const ref = parse(binding.source, binding.query);
  const result = await resolve(ref);
  if (!result) throw new Error(`data source is not available: ${binding.source}`);
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(result.asset.url);
  if (!match) throw new Error('data provider returned no readable bytes');
  const text = Buffer.from(match[2]!, 'base64').toString('utf8');
  let rows = /json/i.test(match[1]!) ? jsonRows(text) : csvRows(text);
  if (binding.query && Object.keys(binding.query).length) rows = rows.filter((row) => matchesSelector(row, binding.query!));
  if (!rows.length) throw new Error('data source returned no rows');
  if (binding.as) validateRows(rows, binding.as);
  return rows;
}

function validateRows(rows: Record<string, unknown>[], schema: Record<string, unknown>): void {
  if (schema.type !== undefined && schema.type !== 'object') throw new Error('binding.as must be an object JSON Schema');
  const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? schema.properties as Record<string, Record<string, unknown>> : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : []);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    for (const key of required) if (row[key] === undefined) throw new Error(`data row ${index} is missing required field ${key}`);
    if (schema.additionalProperties === false) {
      const extra = Object.keys(row).find((key) => !(key in properties));
      if (extra) throw new Error(`data row ${index} has unknown field ${extra}`);
    }
    for (const [key, spec] of Object.entries(properties)) {
      if (row[key] === undefined) continue;
      const types = Array.isArray(spec.anyOf)
        ? (spec.anyOf as Array<{ type?: unknown }>).map((item) => item.type).filter((type): type is string => typeof type === 'string')
        : typeof spec.type === 'string' ? [spec.type] : [];
      if (types.length && !types.some((type) => jsonTypeMatches(row[key], type))) throw new Error(`data row ${index} field ${key} does not match ${types.join('|')}`);
    }
  }
}

function jsonTypeMatches(value: unknown, type: string): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}

function parse(source: string, extra?: Record<string, unknown>): HostedProviderRef {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?([^#]*))?$/i.exec(source);
  if (!match) throw new Error(`invalid provider ref: ${source}`);
  const query = Object.fromEntries(new URLSearchParams(match[4] ?? ''));
  for (const [key, value] of Object.entries(extra ?? {})) {
    query[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return { raw: source, provider: match[1]!.toLowerCase(), scope: decodeURIComponent(match[2]!), path: decodeURIComponent(match[3] ?? ''), query };
}

/** A deliberately small structured selector: object members are ANDed and may
 * nest. It is enforced after provider resolution as well as being forwarded to
 * the provider, so connector quirks cannot broaden a governed batch. */
function matchesSelector(value: unknown, selector: unknown): boolean {
  if (selector && typeof selector === 'object' && !Array.isArray(selector)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(selector as Record<string, unknown>)
      .every(([key, expected]) => matchesSelector((value as Record<string, unknown>)[key], expected));
  }
  if (Array.isArray(selector)) {
    return Array.isArray(value) && selector.length === value.length
      && selector.every((expected, index) => matchesSelector(value[index], expected));
  }
  // CSV cells are strings; a typed selector still has useful, unsurprising
  // equality semantics for them while JSON retains strict primitive types.
  return Object.is(value, selector) || (typeof value === 'string' && String(selector) === value);
}

function jsonRows(text: string): Record<string, unknown>[] {
  const value = JSON.parse(text) as unknown;
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as { rows?: unknown }).rows) ? (value as { rows: unknown[] }).rows : [];
  if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) throw new Error('data source rows must be objects');
  return rows as Record<string, unknown>[];
}

function csvRows(text: string): Record<string, unknown>[] {
  const grid = parseCsv(text.replace(/^\uFEFF/, ''));
  if (grid.length < 2) return [];
  const headers = grid[0]!.map((header) => header.trim());
  if (headers.some((header) => !header)) throw new Error('CSV data source has an empty header');
  const duplicate = headers.find((header, index) => headers.indexOf(header) !== index);
  if (duplicate) throw new Error(`CSV data source has duplicate header ${duplicate}`);
  return grid.slice(1)
    .filter((row) => row.some((cell) => cell !== ''))
    .map((row) => Object.fromEntries(row.map((value, index) => [headers[index] ?? `column${index + 1}`, value])));
}

/** RFC 4180 reader kept local to the hosted boundary: the engine owns creative
 * batch parsing, while this path decodes arbitrary provider data before a tool
 * contract is selected. Quoted commas, CR/LF and doubled quotes remain data. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  const finishField = () => { row.push(field); field = ''; afterQuote = false; };
  const finishRow = () => { finishField(); rows.push(row); row = []; };

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else field += char;
      continue;
    }
    if (afterQuote && char !== ',' && char !== '\r' && char !== '\n') {
      if (/\s/.test(char)) continue;
      throw new Error('CSV data source has characters after a closing quote');
    }
    if (char === '"' && field === '') { quoted = true; continue; }
    if (char === ',') { finishField(); continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      finishRow();
      continue;
    }
    field += char;
  }
  if (quoted) throw new Error('CSV data source has an unterminated quoted field');
  if (field !== '' || row.length || afterQuote) finishRow();
  while (rows.length && rows.at(-1)!.every((cell) => cell === '')) rows.pop();
  return rows;
}
