// SPDX-License-Identifier: MPL-2.0
/**
 * A partner's agent uses a published Share with rules tool over the
 * organisation MCP (plans/82 M7, W-M7-3a): list_tools lists it, describe_tool
 * reads it from the caller's own feed, and render_tool accepts it under its own
 * rules, refusing at once what the designer fixed or ruled out. validate refuses
 * the same things with the same codes, image framing given as one object reads
 * as framing, and a token outside the audience gets nothing.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';
import { vectorFieldParams } from '../server/src/render/pipeline.ts';
import { queryFromInputs } from '../server/src/automation/verbs.ts';

const ENGINE: string = '@lolly/engine';
const { compileDesignTool, parseUrlState } = await import(ENGINE) as {
  compileDesignTool(d: Record<string, unknown>, r: { source: string; styles: string }, a: Record<string, Uint8Array>): { files: Record<string, string | Uint8Array> };
  parseUrlState(query: string, manifest: unknown): { values: Record<string, unknown> };
};

const AUTHOR_RENDERER = '/* the author\'s own Design renderer */ var LollyDesignRules = {};';
const WORKSPACE_RENDERER = '/* this workspace\'s Design renderer */ var LollyDesignRules = {};';
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

function definition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1, id: 'partner-data-sheet', name: 'Partner data sheet', description: 'Add your price.', version: '1.0.1',
    presentation: 'sidebar', formats: ['png', 'svg', 'pdf'],
    inputs: [{ input: { id: 'price', label: 'Price', type: 'text', default: '€ 1,240', maxLength: 40 }, targets: [{ variantId: 'a4', layerId: 'price', property: 'text' }] }],
    variants: [{ id: 'a4', label: 'A4', width: 595, height: 842, background: '#ffffff', boxes: [
      { id: 'title', kind: 'text', text: 'SLES 16' }, { id: 'price', kind: 'text', text: '€ 1,240' },
    ] }],
    defaultVariant: 'a4', choices: [], recipes: [],
    compilerVersion: 1, rendererDigest: sha256(AUTHOR_RENDERER), css: '.lolly-locked-design{--brand:#0c322c}', dependencies: [],
    ...overrides,
  };
}

/** A rules tool with image framing (a vector input) and one designer-approved colour. */
function heroDefinition(): Record<string, unknown> {
  return definition({
    id: 'partner-hero', name: 'Partner hero', description: 'Frame your photo.', version: '1.0.0', formats: ['png', 'svg'],
    inputs: [
      { input: { id: 'shade', label: 'Shade', type: 'color', default: '#ffffff' }, approved: ['#ffffff'], targets: [{ variantId: 'wide', layerId: 'band', property: 'fill' }] },
      { input: { id: 'frame', label: 'Framing', type: 'vector', default: { x: 50, y: 50, zoom: 100 }, fields: [
        { id: 'x', label: 'X', min: 0, max: 100, step: 1 }, { id: 'y', label: 'Y', min: 0, max: 100, step: 1 }, { id: 'zoom', label: 'Zoom', min: 100, max: 400, step: 1 },
      ] }, targets: [{ variantId: 'wide', layerId: 'photo', property: 'imageFraming' }] },
    ],
    variants: [{ id: 'wide', label: 'Wide', width: 1200, height: 600, background: '#ffffff', boxes: [
      { id: 'band', kind: 'rect', fill: '#ffffff' }, { id: 'photo', kind: 'image', src: '' },
    ] }],
    defaultVariant: 'wide',
  });
}

/** A Share with rules file the way Lolly writes one: the compiled tool under tool/. */
function lollyFile(def: Record<string, unknown>, opts: { session?: boolean; corrupt?: boolean } = {}): Buffer {
  const compiled = compileDesignTool(def, { source: AUTHOR_RENDERER, styles: '' }, {});
  const files: Record<string, Buffer> = {};
  for (const [path, value] of Object.entries(compiled.files)) files[`tool/${path}`] = Buffer.from(value as string);
  if (opts.session) {
    const manifest = JSON.parse(files['tool/tool.json']!.toString());
    manifest.designTool.sourceTool = { id: 'price-card', version: '1.0.0', inputs: { price: 'price' } };
    files['tool/tool.json'] = Buffer.from(JSON.stringify(manifest));
  }
  const integrity = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)]));
  if (opts.corrupt) files['tool/template.html'] = Buffer.from('<div>changed</div>');
  const manifest = {
    format: 'lolly-share', kind: 'tool', minReader: 2, tool: { id: def.id, version: def.version },
    bundledTool: { id: def.id, version: def.version, trust: 'custom', files: Object.keys(files).map((path) => ({ path })) },
    integrity,
  };
  const zip = new ZipBuilder();
  const parts = [zip.add('manifest.json', Buffer.from(JSON.stringify(manifest)))];
  for (const [path, bytes] of Object.entries(files)) parts.push(zip.add(path, bytes));
  parts.push(zip.end());
  return Buffer.concat(parts);
}


let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let runner: RenderRunner | undefined;
const tokens: Record<string, string> = {};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-rules-tools-mcp-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'design', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design', name: 'Design', version: '1.0.0', inputs: [] }));
  await writeFile(join(pack, 'tools', 'design', 'assets', 'rules-renderer.js'), WORKSPACE_RENDERER);
  await writeFile(join(pack, 'tools', 'design', 'styles.css'), '.design{}');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'design' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin', 'owner'] }] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'si', link: 'li' }, onRenderRunner: (r) => { runner = r; r.kick = () => {}; } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = await fetch(`${base}/api/auth/dev?email=admin@test`, { redirect: 'manual' });
  const admin = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie: admin, 'content-type': raw ? 'application/octet-stream' : 'application/json' },
      ...(raw ? { body: new Uint8Array(raw) } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
  };
  assert.equal((await call('PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: [] })).status, 201);
  assert.equal((await call('PUT', '/api/v1/programmes/distributors', { name: 'Distributors', tools: [] })).status, 201);
  assert.ok((await call('PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status < 300);
  await store.putGrant({ principal: 'group:programme-resellers', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putGrant({ principal: 'group:programme-distributors', action: 'export.server', resource: '*', effect: 'allow' });
  const published = await call('POST', '/api/v1/catalog/submit?type=rules-tool&groups=programme-resellers', undefined, lollyFile(definition()));
  assert.equal(published.status, 201, JSON.stringify(published.body));
  const hero = await call('POST', '/api/v1/catalog/submit?type=rules-tool&groups=programme-resellers', undefined, lollyFile(heroDefinition()));
  assert.equal(hero.status, 201, JSON.stringify(hero.body));
  for (const [key, programme, body] of [['northwind', 'resellers', { company: 'northwind' }], ['outsider', 'distributors', {}]] as const) {
    const made = await call('POST', `/api/v1/programmes/${programme}/tokens`, { label: `${key} agent`, scopes: ['render', 'catalog.read'], ...body });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    tokens[key] = made.body.token;
  }
});
after(() => server.close());

let id = 0;
async function mcp(who: string, method: string, params?: unknown) {
  const res = await fetch(`${base}/api/v1/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }) });
  return (await res.json() as { result: Record<string, any> }).result;
}
const tool = async (who: string, name: string, args: Record<string, unknown>) => {
  const result = await mcp(who, 'tools/call', { name, arguments: args });
  return { isError: result.isError === true, value: result.structuredContent as Record<string, any> };
};

test('a Northwind IT agent lists, describes and renders the published rules tool', async () => {
  const listed = await tool('northwind', 'list_tools', { limit: 100 });
  assert.ok(listed.value.tools.some((t: { id: string }) => t.id === 'partner-data-sheet'), JSON.stringify(listed.value));
  const described = await tool('northwind', 'describe_tool', { toolId: 'partner-data-sheet' });
  assert.equal(described.isError, false, JSON.stringify(described.value));
  assert.ok(Object.hasOwn(described.value.schema.properties ?? described.value.schema.inputs ?? {}, 'price') || JSON.stringify(described.value.schema).includes('"price"'), JSON.stringify(described.value.schema));
  const made = await tool('northwind', 'render_tool', { toolId: 'partner-data-sheet', format: 'svg', inputs: { price: '€ 99' } });
  assert.equal(made.isError, false, JSON.stringify(made.value));
  assert.match(made.value.id, /^rnd_/);
  const valid = await tool('northwind', 'validate', { toolId: 'partner-data-sheet', inputs: { price: '€ 99' } });
  assert.equal(valid.isError, false, JSON.stringify(valid.value));
});

test('the rules tool\'s own rules refuse at once: what the designer fixed, and values outside the rules', async () => {
  const fixed = await tool('northwind', 'render_tool', { toolId: 'partner-data-sheet', format: 'svg', inputs: { price: '€ 99', title: 'Cheaper' } });
  assert.equal(fixed.isError, true);
  assert.equal(fixed.value.code, 'INPUT_LOCKED');
  assert.equal(fixed.value.status, 422);
  assert.equal(fixed.value.input, 'title');
  const outside = await tool('northwind', 'render_tool', { toolId: 'partner-data-sheet', format: 'svg', inputs: { price: '€'.repeat(60) } });
  assert.equal(outside.value.code, 'INPUT_NOT_ALLOWED');
  const renders = await store.listRenders((await store.listApiTokens()).filter((t) => t.label === 'northwind agent').map((t) => `service:svc_${t.id}`)[0]!, 100, 0);
  assert.equal(renders.length, 1, 'only the render within the rules was accepted');
});

test('image framing given as one object reads as framing and renders over render_tool, the same as per field', async () => {
  const framing = { x: 30, y: 40, zoom: 120 };
  // The object form becomes URL mode's per-field params before the query is read.
  const manifest = JSON.parse(String(compileDesignTool(heroDefinition(), { source: AUTHOR_RENDERER, styles: '' }, {}).files['tool.json']));
  const query = vectorFieldParams(queryFromInputs({ frame: framing }), manifest);
  assert.equal(query, 'frame.x=30&frame.y=40&frame.zoom=120');
  assert.deepEqual(parseUrlState(query, manifest).values.frame, framing);
  const perField = await fetch(`${base}/api/v1/validate`, { method: 'POST', headers: { authorization: `Bearer ${tokens.northwind}`, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'partner-hero', format: 'svg', recipe: 'frame.x=30&frame.y=40&frame.zoom=120' }) });
  const perFieldBody = await perField.json() as { ok?: boolean };
  assert.equal(perFieldBody.ok, true, JSON.stringify(perFieldBody));
  const asObject = await tool('northwind', 'render_tool', { toolId: 'partner-hero', format: 'svg', inputs: { frame: framing } });
  assert.equal(asObject.isError, false, JSON.stringify(asObject.value));
  assert.match(asObject.value.id, /^rnd_/);
  const valid = await tool('northwind', 'validate', { toolId: 'partner-hero', format: 'svg', inputs: { frame: framing } });
  assert.equal(valid.value.ok, true, JSON.stringify(valid.value));
  const outside = await tool('northwind', 'render_tool', { toolId: 'partner-hero', format: 'svg', inputs: { frame: { x: 30, y: 40, zoom: 900 } } });
  assert.equal(outside.isError, true);
  assert.equal(outside.value.code, 'INPUT_NOT_ALLOWED');
  assert.equal(outside.value.input, 'frame');
});

test('validate refuses what render refuses under the tool\'s own rules, with the same codes', async () => {
  const cases: Array<[Record<string, unknown>, string | undefined, string, string]> = [
    [{ shade: '#ff0000' }, 'svg', 'INPUT_NOT_ALLOWED', '/shade'],
    [{ shade: '#ffffff', headline: 'Cheaper' }, 'svg', 'INPUT_LOCKED', '/headline'],
  ];
  for (const [inputs, format, code, path] of cases) {
    const valid = await tool('northwind', 'validate', { toolId: 'partner-hero', inputs, ...(format ? { format } : {}) });
    assert.equal(valid.value.ok, false, JSON.stringify(valid.value));
    const error = valid.value.errors.find((e: { code?: string }) => e.code === code);
    assert.ok(error, `${code} in ${JSON.stringify(valid.value.errors)}`);
    assert.equal(error.path, path);
    const made = await tool('northwind', 'render_tool', { toolId: 'partner-hero', format: format ?? 'svg', inputs });
    assert.equal(made.isError, true, `render refuses ${JSON.stringify(inputs)} as ${format}`);
    assert.equal(made.value.code, code);
  }
  // A format the designer did not enable is not one the compiled tool declares,
  // so both refuse it before the rules are read.
  const pdfValid = await tool('northwind', 'validate', { toolId: 'partner-hero', format: 'pdf', inputs: { shade: '#ffffff' } });
  const pdfRender = await tool('northwind', 'render_tool', { toolId: 'partner-hero', format: 'pdf', inputs: { shade: '#ffffff' } });
  assert.equal(pdfValid.isError, true, JSON.stringify(pdfValid.value));
  assert.equal(pdfRender.isError, true, JSON.stringify(pdfRender.value));
  const allowed = await tool('northwind', 'validate', { toolId: 'partner-hero', format: 'png', inputs: { shade: '#ffffff' } });
  assert.equal(allowed.value.ok, true, JSON.stringify(allowed.value));
});

test('a token outside the audience gets nothing', async () => {
  const listed = await tool('outsider', 'list_tools', { limit: 100 });
  assert.ok(!listed.value.tools.some((t: { id: string }) => t.id === 'partner-data-sheet'));
  const described = await tool('outsider', 'describe_tool', { toolId: 'partner-data-sheet' });
  assert.equal(described.isError, true);
  assert.equal(described.value.code, 'FORBIDDEN');
  const made = await tool('outsider', 'render_tool', { toolId: 'partner-data-sheet', format: 'svg', inputs: { price: '€ 99' } });
  assert.equal(made.isError, true);
  assert.equal(made.value.code, 'FORBIDDEN');
});
