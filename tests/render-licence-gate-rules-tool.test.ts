// SPDX-License-Identifier: MPL-2.0
/**
 * The licence gate and a rules tool from the feed (plans/82 M2 and M4, W-M4-8).
 *
 * Pinned here: with the gate on, a Northwind IT token's server render of a
 * published rules tool is refused at once with 422 ASSET_HELD naming the file
 * when the tool's own default or the caller's value names a catalog file the
 * gate holds back, before the render reaches a worker. A rules file links no
 * picture (rules-tools.ts refuses one), so a catalog file reaches a rules tool
 * through an asset input. The rules tool's own rules still answer first
 * (#337), a file the feed holds goes ahead, and staff renders are unchanged.
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

const ENGINE: string = '@lolly/engine';
const { compileDesignTool } = await import(ENGINE) as {
  compileDesignTool(d: Record<string, unknown>, r: { source: string; styles: string }, a: Record<string, Uint8Array>): { files: Record<string, string | Uint8Array> };
};

const RENDERER = '/* the Design renderer */ var LollyDesignRules = {};';
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const SVG = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`;
const PACK = [
  { id: 'acme/photo/open', name: 'Open photo', type: 'vector', file: 'open.svg', body: SVG('#0a0'), license: 'CC-BY-4.0' },
  { id: 'acme/photo/unrecorded', name: 'Unrecorded photo', type: 'vector', file: 'unrecorded.svg', body: SVG('#a00') },
];

/** A rules tool whose image box draws the catalog file its asset input names. */
function definition(id: string, photo: string): Record<string, unknown> {
  return {
    schemaVersion: 1, id, name: `Partner sheet ${id}`, description: 'Add your price.', version: '1.0.0',
    presentation: 'sidebar', formats: ['svg'],
    inputs: [
      { input: { id: 'price', label: 'Price', type: 'text', default: '€ 1,240', maxLength: 40 }, targets: [{ variantId: 'a4', layerId: 'price', property: 'text' }] },
      { input: { id: 'photo', label: 'Photo', type: 'asset', assetType: 'image', default: photo }, targets: [{ variantId: 'a4', layerId: 'photo', property: 'image' }] },
    ],
    variants: [{ id: 'a4', label: 'A4', width: 595, height: 842, background: '#ffffff', boxes: [
      { id: 'photo', kind: 'image', src: '' }, { id: 'price', kind: 'text', text: '€ 1,240' },
    ] }],
    defaultVariant: 'a4', choices: [], recipes: [],
    compilerVersion: 1, rendererDigest: sha256(RENDERER), css: '', dependencies: [],
  };
}

/** A Share with rules file the way Lolly writes one: the compiled tool under tool/. */
function lollyFile(def: Record<string, unknown>): Buffer {
  const compiled = compileDesignTool(def, { source: RENDERER, styles: '' }, {});
  const files: Record<string, Buffer> = {};
  for (const [path, value] of Object.entries(compiled.files)) files[`tool/${path}`] = Buffer.from(value as string);
  const integrity = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)]));
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
let staff = '';
let northwind = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-render-licence-rules-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await mkdir(join(pack, 'tools', 'design', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design', name: 'Design', version: '1.0.0', inputs: [] }));
  await writeFile(join(pack, 'tools', 'design', 'assets', 'rules-renderer.js'), RENDERER);
  await writeFile(join(pack, 'tools', 'design', 'styles.css'), '.design{}');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'design' }] }));
  for (const a of PACK) await writeFile(join(pack, 'catalog', 'assets', 'acme', a.file), a.body);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: PACK.map(({ file, body: _b, ...a }) => ({ ...a, formats: [{ format: 'svg', url: `assets/acme/${file}` }] })),
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    policy: { catalog: { partnerRights: 'gate' } },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin', 'owner', 'marketing'] }, { email: 'mia@test', groups: ['marketing'] }] },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'si', link: 'li' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const admin = await login('admin@test');
  staff = await login('mia@test');
  const call = async (method: string, path: string, body?: unknown, raw?: Buffer) => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie: admin, 'content-type': raw ? 'application/octet-stream' : 'application/json' },
      ...(raw ? { body: new Uint8Array(raw) } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
  };
  assert.equal((await call('PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: [] })).status, 201);
  assert.ok((await call('PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status < 300);
  await store.putGrant({ principal: 'group:programme-resellers', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putGrant({ principal: 'group:marketing', action: 'export.server', resource: '*', effect: 'allow' });
  // Both photos reach the programme in a collection; the gate then holds back the one with no licence recorded.
  await store.putCollection({ id: 'kit', name: 'Kit', members: PACK.map((p) => p.id), groups: ['programme-resellers'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  for (const [id, src] of [['sheet-held', 'acme/photo/unrecorded'], ['sheet-open', 'acme/photo/open']] as const) {
    const published = await call('POST', '/api/v1/catalog/submit?type=rules-tool&groups=programme-resellers,marketing', undefined, lollyFile(definition(id, src)));
    assert.equal(published.status, 201, JSON.stringify(published.body));
  }
  const made = await call('POST', '/api/v1/programmes/resellers/tokens', { label: 'Northwind agent', scopes: ['render', 'catalog.read'], company: 'northwind' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  northwind = made.body.token;
});
after(() => server.close());

async function render(auth: { token?: string; cookie?: string }, toolId: string, inputs: Record<string, unknown>) {
  const res = await fetch(`${base}/api/v1/render`, {
    method: 'POST', body: JSON.stringify({ toolId, format: 'svg', inputs }),
    headers: { 'content-type': 'application/json', ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}), ...(auth.cookie ? { cookie: auth.cookie } : {}) },
  });
  const text = await res.text();
  return { status: res.status, text, error: (() => { try { return (JSON.parse(text) as { error?: { code?: string; message?: string; details?: { assets?: string[] } } }).error; } catch { return undefined; } })() };
}

test('a Northwind token\'s render of a rules tool that draws a held file is refused at once, naming the file', async () => {
  const held = await render({ token: northwind }, 'sheet-held', { price: '€ 99' });
  assert.equal(held.status, 422, held.text);
  assert.equal(held.error?.code, 'ASSET_HELD');
  assert.match(held.error?.message ?? '', /acme\/photo\/unrecorded/);
  const named = await render({ token: northwind }, 'sheet-open', { price: '€ 99', photo: 'acme/photo/unrecorded' });
  assert.equal(named.error?.code, 'ASSET_HELD', 'so does the caller\'s own value');
  // The rules tool's own rules still answer first.
  const ruledOut = await render({ token: northwind }, 'sheet-held', { price: '€'.repeat(60) });
  assert.equal(ruledOut.error?.code, 'INPUT_NOT_ALLOWED', ruledOut.text);
  // A file the feed holds goes ahead to the worker gate, picked over a held default too.
  const picked = await render({ token: northwind }, 'sheet-held', { price: '€ 99', photo: 'acme/photo/open' });
  assert.equal(picked.error?.code, 'HOOKED_TOOL_NEEDS_CHROMIUM', picked.text);
  const open = await render({ token: northwind }, 'sheet-open', { price: '€ 99' });
  assert.equal(open.error?.code, 'HOOKED_TOOL_NEEDS_CHROMIUM', open.text);
});

test('staff render the same rules tool as before: the gate is for partners', async () => {
  const mine = await render({ cookie: staff }, 'sheet-held', { price: '€ 99' });
  assert.equal(mine.error?.code, 'HOOKED_TOOL_NEEDS_CHROMIUM', mine.text);
});
