// SPDX-License-Identifier: MPL-2.0
/**
 * `lw render-api`: moving off a hosted render API, one stage at a time.
 *
 *   inventory  reads the vendor account. Read only, and it needs no Work server.
 *   sample     asks the vendor for a reference render. Spends the customer's credits.
 *   check      reads a mapping against the effective schema on this Work instance.
 *   compare    renders here and measures the result against a reference.
 *
 * Built from the vendors' public documentation and a local stub of their public
 * schema. None of it has been run against a live account. A token is read from the
 * environment variable named by --token-env, is sent only to the vendor's API host
 * and is never printed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapBannerbearV2, mapBannerbearV5, mapPlacid, type MappingLookup } from '../server/src/render-api/mappers.ts';
import { mappingIndex, parseRenderApiMappings } from '../server/src/render-api/mapping.ts';
import { RENDER_API_SOURCES, RenderApiRefusal, type RenderApiMapping, type RenderApiSource } from '../server/src/render-api/types.ts';

export interface RenderApiCli {
  values: Record<string, unknown>;
  call(path: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<unknown>;
  response(path: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<Response>;
  fail(message: string): never;
  log(line: string): void;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_BASES: Record<RenderApiSource, string> = {
  'bannerbear-v5': 'https://api.bannerbear.com',
  'bannerbear-v2': 'https://api.bannerbear.com',
  placid: 'https://api.placid.app/api/rest',
};
const NOT_LIVE = 'This adapter is built from public documentation and fixtures. It has not been run against a live account.';
const MAX_PAGES = 500;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/** Base64 of the reference travels in the request, and the render route caps that at 900,000 characters. */
const MAX_REFERENCE_BYTES = 675_000;

export interface InventoryLayer { name: string; type: string | null; properties: string[]; note?: string }
export interface InventoryTemplate {
  id: string; name: string; width: number | null; height: number | null; tags: string[]; preview: string | null;
  layers: InventoryLayer[];
  /** Whether the vendor's API exposes this template's design, or only its field names. */
  design: 'importable' | 'rebuild';
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safeFile = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'template';

/** Properties a modification can set, from the V5 create-image docs. Other layer
 *  types have no property confirmed from those docs, so they are listed and not guessed. */
const V5_PROPERTIES: Record<string, string> = {
  text: 'text', rectangle: 'background-color', circle: 'background-color',
  rectangle_image_container: 'background-image', circle_image_container: 'background-image',
  svg_shape: 'fill', qr_code: 'qr-target', bar_code: 'barcode-data', rating: 'rating-score', lottie: 'lottie-url', audio_wave: 'audio-url',
};
const PLACID_PROPERTIES: Record<string, string> = {
  text: 'text', picture: 'image', rectangle: 'background_color', browserframe: 'image', barcode: 'value', rating: 'value', subtitle: 'srt',
};

export function normaliseTemplate(source: RenderApiSource, raw: Record<string, unknown>): InventoryTemplate {
  const numberOrNull = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [];
  if (source === 'bannerbear-v5') {
    const objects = Array.isArray((raw.config as { objects?: unknown } | undefined)?.objects) ? (raw.config as { objects: unknown[] }).objects : [];
    const layers = objects.filter(isObject).map((object): InventoryLayer => {
      const type = typeof object.type === 'string' ? object.type : null;
      const property = type ? V5_PROPERTIES[type] : undefined;
      return { name: String(object.name ?? object.id ?? ''), type, properties: property ? [property] : [], ...(property ? {} : { note: 'no modification property confirmed for this layer type' }) };
    });
    return { id: String(raw.uid), name: String(raw.name ?? raw.uid), width: numberOrNull(raw.width), height: numberOrNull(raw.height), tags, preview: typeof raw.preview === 'string' ? raw.preview : null, layers, design: objects.length ? 'importable' : 'rebuild' };
  }
  if (source === 'bannerbear-v2') {
    const modifications = Array.isArray(raw.available_modifications) ? raw.available_modifications.filter(isObject) : [];
    const layers = modifications.map((item): InventoryLayer => ({ name: String(item.name ?? ''), type: null, properties: Object.keys(item).filter((key) => key !== 'name') }));
    return { id: String(raw.uid), name: String(raw.name ?? raw.uid), width: numberOrNull(raw.width), height: numberOrNull(raw.height), tags, preview: typeof raw.preview_url === 'string' ? raw.preview_url : null, layers, design: 'rebuild' };
  }
  const listed = Array.isArray(raw.layers) ? raw.layers.filter(isObject) : [];
  const layers = listed.map((item): InventoryLayer => {
    const type = typeof item.type === 'string' ? item.type : null;
    const property = type ? PLACID_PROPERTIES[type] : undefined;
    return { name: String(item.name ?? ''), type, properties: property ? [property] : [], ...(property ? {} : { note: 'no property confirmed for this layer type' }) };
  });
  // Placid's template object has no size or geometry. A reference render gives the size.
  return { id: String(raw.uuid), name: String(raw.title ?? raw.uuid), width: null, height: null, tags, preview: typeof raw.thumbnail === 'string' ? raw.thumbnail : null, layers, design: 'rebuild' };
}

const inputId = (name: string, fallback: string): string => {
  const slug = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[A-Za-z0-9_]/.test(slug) && slug ? slug.slice(0, 100) : fallback;
};
const toolSlug = (name: string, fallback: string): string => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? slug.slice(0, 100) : fallback;
};

/** A first mapping to review. Input ids come from layer names; nothing is assumed about the tool. */
export function draftMapping(source: RenderApiSource, template: InventoryTemplate, toolId: string): RenderApiMapping {
  const layers: RenderApiMapping['layers'] = {};
  template.layers.forEach((layer, index) => {
    if (!layer.properties.length || !layer.name) return;
    const base = inputId(layer.name, `layer_${index + 1}`);
    layers[layer.name] = Object.fromEntries(layer.properties.map((property, at) => [property, at === 0 ? base : `${base}_${inputId(property, `p${at}`)}`]));
  });
  return { source, template: template.id, toolId, format: 'png', layers, ignore: [], fixed: {} };
}

function coverageReport(source: RenderApiSource, templates: InventoryTemplate[], readAt: string): string {
  const lines = [
    `# What this account holds: ${source}`, '', `Read ${readAt}. Read only: nothing was changed on the account.`, '', NOT_LIVE, '',
    source === 'bannerbear-v5'
      ? 'This source returns each template\'s full layer design, so a template can be imported as a Design document with `lolly import`.'
      : 'This source returns field names and a preview only, not the design. Each template is rebuilt against its reference, then measured with `lw render-api compare`.',
    '',
  ];
  for (const template of templates) {
    const size = template.width && template.height ? `${template.width} x ${template.height}` : 'size not given';
    lines.push(`## ${template.name}`, '', `Id \`${template.id}\`, ${size}. Design: ${template.design === 'importable' ? 'can be imported' : 'rebuild against the reference'}.`, '');
    if (!template.layers.length) { lines.push('No layers were listed.', ''); continue; }
    lines.push('| Layer | Type | Maps | Note |', '|---|---|---|---|');
    for (const layer of template.layers) {
      const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${cell(layer.name) || '(no name)'} | ${cell(layer.type ?? 'not given')} | ${cell(layer.properties.join(', ')) || 'nothing yet'} | ${cell(layer.note ?? '')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** A loopback address may use plain HTTP, for a local stub. Anything else must be HTTPS. */
function checkedBase(cli: RenderApiCli, source: RenderApiSource): string {
  const value = typeof cli.values['source-url'] === 'string' ? cli.values['source-url'] : DEFAULT_BASES[source];
  let url: URL;
  try { url = new URL(value); } catch { return cli.fail('--source-url must be a URL'); }
  if (url.username || url.password) cli.fail('--source-url must not carry a credential');
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) cli.fail('--source-url must use HTTPS');
  return value.replace(/\/+$/, '');
}

function sourceOf(cli: RenderApiCli): RenderApiSource {
  const from = cli.values.from;
  if (!RENDER_API_SOURCES.includes(from as RenderApiSource)) cli.fail(`--from must be one of ${RENDER_API_SOURCES.join(', ')}`);
  return from as RenderApiSource;
}

function tokenOf(cli: RenderApiCli): string {
  const name = cli.values['token-env'];
  if (typeof name !== 'string' || !name) return cli.fail('--token-env must name the environment variable holding the vendor API key');
  const token = cli.env[name];
  if (!token) return cli.fail(`the environment variable ${name} is not set`);
  return token;
}

/** The vendor client. The token goes only to the API host, and redirects are refused so it cannot travel further. */
function vendorClient(cli: RenderApiCli, base: string, token: string) {
  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
      } catch (error) {
        return cli.fail(`could not reach ${new URL(url).host}: ${(error as Error).message}`);
      }
      if (res.status !== 429 || attempt >= 3) return res;
      const wait = Math.min(60, Number(res.headers.get('retry-after')) || 2 ** attempt * 5);
      await new Promise((resolve) => { setTimeout(resolve, wait * 1000); });
    }
  };
  return {
    json: async (path: string, init: RequestInit = {}): Promise<unknown> => {
      const url = path.startsWith('http') ? path : `${base}${path}`;
      const res = await request(url, init);
      if (!res.ok) cli.fail(`${new URL(url).host} answered ${res.status} for ${new URL(url).pathname}`);
      return res.json();
    },
  };
}

/** Downloads a preview or result. No token goes with it: these live on other hosts. */
async function download(url: string, cli: RenderApiCli): Promise<{ bytes: Buffer; type: string } | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) { cli.log(`  skipped ${parsed.host}${parsed.pathname}: ${res.status}`); return null; }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES) return null;
    return { bytes, type: res.headers.get('content-type') ?? '' };
  } catch { return null; }
}
const extensionOf = (url: string, type: string): string => {
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg')) return 'jpg';
  if (type.includes('webp')) return 'webp';
  if (type.includes('pdf')) return 'pdf';
  if (type.includes('svg')) return 'svg';
  return /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url)?.[1]?.toLowerCase() ?? 'bin';
};

async function listTemplates(cli: RenderApiCli, source: RenderApiSource, client: ReturnType<typeof vendorClient>, base: string): Promise<Record<string, unknown>[]> {
  const pageLimit = cli.values['max-pages'] ? Number(cli.values['max-pages']) : MAX_PAGES;
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) cli.fail('--max-pages must be a positive whole number');
  const all: Record<string, unknown>[] = [];
  if (source === 'placid') {
    let next: string | null = `${base}/templates`;
    for (let page = 0; next && page < pageLimit; page++) {
      const body = await client.json(next) as { data?: unknown; links?: { next?: unknown } };
      if (!Array.isArray(body.data)) cli.fail('Placid\'s template list did not have the documented `data` list');
      all.push(...(body.data as unknown[]).filter(isObject));
      const link: unknown = body.links?.next;
      next = typeof link === 'string' && link ? link : null;
      // A next link must stay on the API host, because the token goes with it.
      if (next && new URL(next).origin !== new URL(base).origin) cli.fail('Placid\'s next link left the API host, so the listing stopped');
    }
    return all;
  }
  const version = source === 'bannerbear-v5' ? 'v5/image_templates' : 'v2/templates';
  for (let page = 1; page <= pageLimit; page++) {
    const body = await client.json(`/${version}?page=${page}`);
    // The docs show a page parameter and not the list's outer shape, so both common shapes are read.
    const items = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.data) ? body.data : null;
    if (!items) cli.fail(`${source}'s template list was not a list`);
    if (!items!.length) break;
    all.push(...(items as unknown[]).filter(isObject));
  }
  return all;
}

async function inventory(cli: RenderApiCli): Promise<void> {
  const source = sourceOf(cli);
  const out = cli.values.out;
  if (typeof out !== 'string' || !out) cli.fail('--out must name a folder');
  const base = checkedBase(cli, source);
  const client = vendorClient(cli, base, tokenOf(cli));
  const raws = await listTemplates(cli, source, client, base);
  const folder = out as string;
  mkdirSync(join(folder, 'previews'), { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  const readAt = new Date().toISOString();
  const templates: InventoryTemplate[] = [];
  const mappings: RenderApiMapping[] = [];
  const toolIds = new Set<string>();
  for (const raw of raws) {
    const template = normaliseTemplate(source, raw);
    templates.push(template);
    let toolId = toolSlug(template.name, `template-${templates.length}`);
    if (toolIds.has(toolId)) toolId = `${toolId.slice(0, 90)}-${templates.length}`;
    toolIds.add(toolId);
    mappings.push(draftMapping(source, template, toolId));
    // The raw record is the source for `lolly import`, and the proof after the account ends.
    writeFileSync(join(folder, 'templates', `${safeFile(template.id)}.json`), `${JSON.stringify(raw, null, 2)}\n`);
    if (template.preview && !cli.values['no-previews']) {
      const file = await download(template.preview, cli);
      if (file) writeFileSync(join(folder, 'previews', `${safeFile(template.id)}.${extensionOf(template.preview, file.type)}`), file.bytes);
    }
  }
  writeFileSync(join(folder, 'inventory.json'), `${JSON.stringify({ source, readAt, coverage: NOT_LIVE, templates }, null, 2)}\n`);
  writeFileSync(join(folder, 'coverage.md'), `${coverageReport(source, templates, readAt)}\n`);
  writeFileSync(join(folder, 'mappings.draft.json'), `${JSON.stringify({ note: 'A first draft. Choose the real tool for each template, then run lw render-api check.', templates: mappings }, null, 2)}\n`);
  if (cli.values.json) { cli.log(JSON.stringify({ source, templates: templates.length, folder }, null, 2)); return; }
  cli.log(`${templates.length} template${templates.length === 1 ? '' : 's'} read from ${source}. Nothing was changed on the account.`);
  cli.log(`Wrote inventory.json, coverage.md, mappings.draft.json, templates/ and previews/ to ${folder}.`);
  cli.log(NOT_LIVE);
}

function readJsonFile(cli: RenderApiCli, flag: string): unknown {
  const path = cli.values[flag];
  if (typeof path !== 'string' || !path) return cli.fail(`--${flag} must name a file`);
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { return cli.fail(`could not read ${path}: ${(error as Error).message}`); }
}

function readMappings(cli: RenderApiCli): RenderApiMapping[] {
  const parsed = readJsonFile(cli, 'mapping');
  const list = Array.isArray(parsed) ? parsed : (parsed as { templates?: unknown })?.templates;
  try { return parseRenderApiMappings(list, String(cli.values.mapping)); }
  catch (error) { return cli.fail((error as Error).message); }
}

interface CheckedEntry { source: string; template: string; toolId: string; problems: string[]; warnings: string[] }
interface CheckedContract {
  schema: { properties?: Record<string, { readOnly?: boolean; default?: unknown }>; required?: string[] };
  render: { formats: string[] };
  unavailable?: Array<{ code: string; reason?: string; format?: string; action?: string }>;
}

async function checkEntry(cli: RenderApiCli, entry: RenderApiMapping): Promise<CheckedEntry> {
  const row: CheckedEntry = { source: entry.source, template: entry.template, toolId: entry.toolId, problems: [], warnings: [] };
  // The tool's formats come from the plain read, because asking for a format it does not declare is refused.
  const read = async (query: string): Promise<CheckedContract | null> => {
    const res = await cli.response(`/api/v1/schema/${encodeURIComponent(entry.toolId)}${query}`);
    if (res.ok) return await res.json() as CheckedContract;
    const body = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    row.problems.push(`tool ${entry.toolId}: ${res.status} ${body?.error?.code ?? ''} ${body?.error?.message ?? ''}`.trim());
    return null;
  };
  const plain = await read('');
  if (!plain) return row;
  const declared = plain.render.formats.includes(entry.format);
  if (!declared) row.problems.push(`format ${entry.format} is not available for this tool here`);
  const contract = declared ? await read(`?format=${encodeURIComponent(entry.format)}`) : plain;
  if (!contract) return row;
  const properties = contract.schema.properties ?? {};
  const targets = new Map<string, string>();
  for (const [layer, props] of Object.entries(entry.layers)) for (const [property, input] of Object.entries(props)) targets.set(input, `${layer}.${property}`);
  for (const input of Object.keys(entry.fixed)) targets.set(input, 'fixed');
  for (const [input, from] of targets) {
    if (!Object.hasOwn(properties, input)) row.problems.push(`${from}: the tool has no input ${input} this token may set`);
    else if (properties[input]!.readOnly) row.problems.push(`${from}: input ${input} is locked by policy`);
  }
  for (const required of contract.schema.required ?? []) {
    if (!targets.has(required) && properties[required]?.default === undefined) row.warnings.push(`required input ${required} has no default and nothing in this mapping fills it`);
  }
  for (const missing of contract.unavailable ?? []) {
    if (missing.action === 'render' || missing.format === entry.format) row.problems.push(`${missing.code}: ${missing.reason ?? 'not available'}`);
  }
  return row;
}

async function check(cli: RenderApiCli): Promise<void> {
  const rows: CheckedEntry[] = [];
  for (const entry of readMappings(cli)) rows.push(await checkEntry(cli, entry));
  const bad = rows.filter((row) => row.problems.length).length;
  if (cli.values.json) cli.log(JSON.stringify({ templates: rows.length, withProblems: bad, rows }, null, 2));
  else {
    for (const row of rows) {
      cli.log(`${row.problems.length ? 'problem' : 'ok     '}  ${row.source} ${row.template} -> ${row.toolId}`);
      for (const problem of row.problems) cli.log(`  ${problem}`);
      for (const warning of row.warnings) cli.log(`  warning: ${warning}`);
    }
    cli.log(`${rows.length - bad} of ${rows.length} mapped templates can run here.`);
  }
  if (bad) process.exitCode = 2;
}

/** Sends a vendor-shaped request to the vendor and keeps what it made. */
async function sample(cli: RenderApiCli): Promise<void> {
  const source = sourceOf(cli);
  if (!cli.values['spend-credits']) cli.fail(`this asks ${source} to render, which spends credits on your account. Add --spend-credits to go ahead`);
  const template = cli.values.template;
  if (typeof template !== 'string' || !template) cli.fail('--template must name the vendor template id');
  const out = cli.values.out;
  if (typeof out !== 'string' || !out) cli.fail('--out must name a folder');
  const request = readJsonFile(cli, 'values');
  if (!isObject(request)) cli.fail('--values must hold the vendor request as a JSON object');
  const base = checkedBase(cli, source);
  const client = vendorClient(cli, base, tokenOf(cli));
  const body = source === 'placid' ? { ...request as object, template_uuid: template } : { ...request as object, template };
  const createPath = source === 'bannerbear-v5' ? '/v5/images' : source === 'bannerbear-v2' ? '/v2/images' : '/images';
  let current = await client.json(createPath, { method: 'POST', body: JSON.stringify(body) }) as Record<string, unknown>;
  const id = source === 'placid' ? current.id : current.uid;
  if (id === undefined || id === null) cli.fail('the vendor did not return an id');
  const pollPath = `${createPath}/${encodeURIComponent(String(id))}`;
  const finished = (status: unknown): boolean => ['completed', 'finished', 'failed', 'error'].includes(String(status));
  const deadline = Date.now() + 120_000;
  while (!finished(current.status)) {
    if (Date.now() > deadline) cli.fail(`${id} did not finish in two minutes. It may still finish on the vendor's side`);
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    current = await client.json(pollPath) as Record<string, unknown>;
  }
  if (current.status === 'failed' || current.status === 'error') cli.fail(`the vendor could not render this: ${String(current.error ?? current.error_message ?? current.status)}`);
  const urls: string[] = source === 'bannerbear-v5' && isObject(current.files)
    ? Object.values(current.files).filter((url): url is string => typeof url === 'string')
    : [current.image_url, current.pdf_url].filter((url): url is string => typeof url === 'string');
  mkdirSync(out as string, { recursive: true });
  const saved: Array<{ file: string; sha256: string; size: number }> = [];
  for (const url of urls) {
    const file = await download(url, cli);
    if (!file) continue;
    const name = `${safeFile(template as string)}.${extensionOf(url, file.type)}`;
    writeFileSync(join(out as string, name), file.bytes);
    saved.push({ file: name, sha256: createHash('sha256').update(file.bytes).digest('hex'), size: file.bytes.byteLength });
  }
  if (!saved.length) cli.fail('the vendor finished, and no file could be downloaded');
  writeFileSync(join(out as string, `${safeFile(template as string)}.reference.json`), `${JSON.stringify({ source, template, request: body, files: saved, madeAt: new Date().toISOString() }, null, 2)}\n`);
  if (cli.values.json) { cli.log(JSON.stringify({ source, template, files: saved }, null, 2)); return; }
  cli.log(`Kept ${saved.map((item) => item.file).join(', ')} in ${out}. This used credits on your ${source} account.`);
}

/** The pixel size of a PNG or JPEG, read from its header. */
export function imageFacts(bytes: Buffer): { format: 'png' | 'jpg'; width: number; height: number } | null {
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { format: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { format: 'jpg', height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
      at += 2 + bytes.readUInt16BE(at + 2);
    }
  }
  return null;
}

interface ProductionCheckRow { id: string; state: string; actual?: unknown; expected?: unknown; reason?: string; location?: string }

function describeCheck(check: ProductionCheckRow): string {
  const measured = check.actual === undefined ? '' : `, measured ${String(check.actual)}${check.expected === undefined ? '' : ` against ${String(check.expected)}`}`;
  return `${check.state.padEnd(12)} ${check.id}${measured}${check.state === 'pass' ? '' : ` (${check.reason ?? 'no reason given'})`}`;
}

function mapValues(lookup: MappingLookup, source: RenderApiSource, values: Record<string, unknown>, template: string): Record<string, unknown> {
  if (source === 'placid') return mapPlacid({ ...values, template_uuid: template }, lookup).inputs;
  if (source === 'bannerbear-v5') return mapBannerbearV5({ ...values, template, formats: undefined }, lookup, false).inputs;
  return mapBannerbearV2({ modifications: [], ...values, template, webhook_url: undefined, render_pdf: undefined }, lookup, false).inputs;
}

/** Renders the mapped template here with the existing production comparison, and reports what moved. */
async function compare(cli: RenderApiCli): Promise<void> {
  const source = sourceOf(cli);
  const mappings = readMappings(cli);
  const template = cli.values.template;
  if (typeof template !== 'string' || !template) cli.fail('--template must name the vendor template id');
  const lookup = mappingIndex(mappings);
  const mapping = lookup(source, template as string) ?? cli.fail(`${source} template ${template} is not in this mapping`);
  const referencePath = cli.values.reference;
  if (typeof referencePath !== 'string' || !referencePath) cli.fail('--reference must name the vendor\'s render as a PNG or JPEG');
  const reference = readFileSync(referencePath as string);
  const facts = imageFacts(reference) ?? cli.fail('--reference must be a PNG or JPEG. A comparison reads decoded pixels');
  if (reference.byteLength > MAX_REFERENCE_BYTES) cli.fail(`the reference is ${reference.byteLength} bytes, and a comparison request holds at most ${MAX_REFERENCE_BYTES}. A comparison never resizes, so export a smaller one at the same pixel size, such as a PNG with fewer colours or a JPEG`);
  const values = cli.values.values ? readJsonFile(cli, 'values') : {};
  if (!isObject(values)) cli.fail('--values must hold the vendor request as a JSON object');
  let inputs: Record<string, unknown>;
  try { inputs = mapValues(lookup, source, values as Record<string, unknown>, template as string); }
  catch (error) {
    if (error instanceof RenderApiRefusal) cli.fail(error.message);
    throw error;
  }
  const regions = cli.values.regions ? readJsonFile(cli, 'regions') : [];
  if (!Array.isArray(regions)) cli.fail('--regions must hold a list of regions');
  const number = (flag: string, fallback: number): number => {
    const value = cli.values[flag] === undefined ? fallback : Number(cli.values[flag]);
    if (!Number.isFinite(value)) cli.fail(`--${flag} must be a number`);
    return value;
  };
  const created = await cli.call('/api/v1/renders', { method: 'POST', body: {
    toolId: mapping.toolId, format: facts.format, inputs, maxAttempts: 1,
    production: {
      contract: {
        profile: 'lolly/production-still-v1', id: `render-api-${safeFile(template as string)}`, revision: '1', format: facts.format,
        width: facts.width, height: facts.height, pages: 1, alpha: 'any', requirements: [],
        comparison: { referenceSha256: createHash('sha256').update(reference).digest('hex'), channelTolerance: number('tolerance', 8), maxChangedFraction: number('max-changed', 0.02), regions },
      },
      referenceBase64: reference.toString('base64'),
    },
  } }) as { id: string };
  const deadline = Date.now() + 120_000;
  let render: { id: string; state: string; error?: { code?: string; message?: string; production?: { checks?: ProductionCheckRow[] } } };
  for (;;) {
    render = await cli.call(`/api/v1/renders/${created.id}`) as typeof render;
    if (['succeeded', 'failed', 'cancelled'].includes(render.state)) break;
    if (Date.now() > deadline) cli.fail(`render ${created.id} did not finish in two minutes`);
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  let checks: ProductionCheckRow[] = render.error?.production?.checks ?? [];
  if (render.state === 'succeeded') {
    const evidence = await cli.call(`/api/v1/renders/${created.id}/evidence`) as { evidence?: { production?: { checks?: ProductionCheckRow[] } } };
    checks = evidence.evidence?.production?.checks ?? [];
  }
  const appearance = checks.filter((row) => row.id.startsWith('appearance.'));
  const passed = render.state === 'succeeded' && appearance.every((row) => row.state === 'pass');
  if (cli.values.json) cli.log(JSON.stringify({ template, toolId: mapping.toolId, renderId: created.id, passed, state: render.state, error: render.error ? { code: render.error.code, message: render.error.message } : null, checks: appearance }, null, 2));
  else {
    cli.log(`${passed ? 'matches' : 'differs'}  ${source} ${template} -> ${mapping.toolId} (render ${created.id})`);
    for (const row of appearance) cli.log(`  ${describeCheck(row)}`);
    if (!appearance.length && render.error) cli.log(`  ${render.error.code ?? ''} ${render.error.message ?? ''}`.trimEnd());
    cli.log('A match measures pixels against this reference. It is not an approval of the design.');
  }
  if (!passed) process.exitCode = 2;
}

export async function runRenderApi(action: string | undefined, cli: RenderApiCli): Promise<void> {
  switch (action) {
    case 'inventory': return inventory(cli);
    case 'check': return check(cli);
    case 'sample': return sample(cli);
    case 'compare': return compare(cli);
    default:
      cli.fail('usage: lw render-api inventory --from <source> --token-env <NAME> --out <dir> | check --mapping <file> | sample --from <source> --template <id> --token-env <NAME> --values <file> --out <dir> --spend-credits | compare --from <source> --mapping <file> --template <id> --reference <file> [--values <file>] [--regions <file>]');
  }
}
