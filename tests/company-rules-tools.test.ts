// SPDX-License-Identifier: MPL-2.0
/**
 * A Share with rules file that takes company values (plans/82 M3, W-M3-3b).
 * It has no overlay and no tool grant, so org-config lists it for the people
 * whose feed carries it, with each bound input locked to their company's
 * value through the same lock path an overlay takes. The app then shows the
 * company's logo and details and offers only what is left open.
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
const RENDERER = 'var LollyDesignRules = {};';
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

const definition = {
  schemaVersion: 1, id: 'partner-data-sheet', name: 'Partner data sheet', description: 'Add your price.', version: '1.1.0',
  presentation: 'sidebar', formats: ['png', 'svg', 'pdf'],
  inputs: [
    { input: { id: 'price', label: 'Your price', type: 'text', default: '€ 1,240' }, targets: [{ variantId: 'a4', layerId: 'price', property: 'text' }] },
    { input: { id: 'logo', label: 'Partner logo', type: 'asset', assetType: 'image' }, targets: [{ variantId: 'a4', layerId: 'logo', property: 'image' }] },
    { input: { id: 'details', label: 'Details line', type: 'text', default: 'Ask your reseller' }, targets: [{ variantId: 'a4', layerId: 'details', property: 'text' }] },
  ],
  variants: [{ id: 'a4', label: 'A4', width: 595, height: 842, background: '#ffffff', boxes: [
    { id: 'logo', kind: 'image' }, { id: 'price', kind: 'text', text: '€ 1,240' }, { id: 'details', kind: 'text', text: 'Ask your reseller' },
  ] }],
  defaultVariant: 'a4', choices: [], recipes: [], compilerVersion: 1, rendererDigest: sha256(RENDERER), css: '', dependencies: [],
};

function lollyFile(def: Record<string, unknown>): Buffer {
  const compiled = compileDesignTool(def, { source: RENDERER, styles: '' }, {});
  const files: Record<string, Buffer> = {};
  for (const [path, value] of Object.entries(compiled.files)) files[`tool/${path}`] = Buffer.from(value as string);
  const integrity = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha256(bytes)]));
  const manifest = { format: 'lolly-share', kind: 'tool', minReader: 2, tool: { id: def.id, version: def.version },
    bundledTool: { id: def.id, version: def.version, trust: 'custom', files: Object.keys(files).map((path) => ({ path })) }, integrity };
  const zip = new ZipBuilder();
  const parts = [zip.add('manifest.json', Buffer.from(JSON.stringify(manifest)))];
  for (const [path, bytes] of Object.entries(files)) parts.push(zip.add(path, bytes));
  parts.push(zip.end());
  return Buffer.concat(parts);
}

let server: Server;
let base = '';
let rulesId = '';
let logoId = '';
const store = createMemoryStore();

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-company-rules-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'design', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design', name: 'Design', version: '1.0.0', inputs: [] }));
  await writeFile(join(pack, 'tools', 'design', 'assets', 'rules-renderer.js'), RENDERER);
  await writeFile(join(pack, 'tools', 'design', 'styles.css'), '.design{}');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'design' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'rita@northwind.test', groups: [] },
      { email: 'pat@both.test', groups: [] },
    ] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'scr', link: 'lcr' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: [] })).status, 201);
  for (const [id, name] of [['northwind-it', 'Northwind IT'], ['globex', 'Globex']]) {
    assert.equal((await call(admin, 'PUT', `/api/v1/programmes/resellers/companies/${id}`, { name })).status, 201);
  }
  for (const e of ['rita@northwind.test', 'pat@both.test']) await login(e);
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [
    { email: 'rita@northwind.test', company: 'northwind-it' }, { email: 'pat@both.test', company: 'northwind-it' }], apply: true })).status, 200);
  const pat = (await store.listUsers()).find((u) => u.email === 'pat@both.test')!;
  await store.setLocalGroups(pat.id, [...pat.localGroups, 'company-globex']);
  const P = '/api/v1/programmes/resellers/companies/northwind-it/profile';
  assert.equal((await call(admin, 'PUT', P, { contact: { name: 'Rita Ortiz', email: 'rita@northwind.test' } })).status, 200);
  const logo = await fetch(`${base}${P}/logo?surface=light`, { method: 'POST', headers: { cookie: admin, 'content-type': 'image/svg+xml' },
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 4"><path d="M0 0H10V4H0Z" fill="#0b3d91"/></svg>' });
  assert.equal(logo.status, 200, await logo.text());
  logoId = (await call(admin, 'GET', P)).body.profile.logoLight;
  const res = await fetch(`${base}/api/v1/programmes/resellers/templates/rules-file?groups=programme-resellers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/octet-stream' }, body: new Uint8Array(lollyFile(definition)) });
  const out = await res.json() as { id: string };
  assert.equal(res.status, 201, JSON.stringify(out));
  rulesId = out.id;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
};

test('without bindings, a rules tool is not on org-config, as before', async () => {
  const config = (await call(await login('rita@northwind.test'), 'GET', '/api/v1/org-config')).body;
  assert.equal(config.tools['partner-data-sheet'], undefined);
});

test('a rules tool that takes company values locks each bound input to the company\'s value on org-config', async () => {
  const admin = await login('admin@test');
  const set = await call(admin, 'PUT', `/api/v1/programmes/resellers/templates/${rulesId.slice('inst/'.length)}`, { bindings: { logo: 'logo', details: 'contact' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const config = (await call(await login('rita@northwind.test'), 'GET', '/api/v1/org-config')).body;
  const tool = config.tools['partner-data-sheet'];
  assert.ok(tool, JSON.stringify(Object.keys(config.tools)));
  assert.deepEqual(tool.inputs, [
    { id: 'logo', access: { level: 'locked', value: logoId } },
    { id: 'details', access: { level: 'locked', value: 'Rita Ortiz, rita@northwind.test' } },
  ], 'no rule name or reason on the app\'s wire');
  assert.deepEqual(tool.bindings, { logo: 'logo', details: 'contact' });
  assert.deepEqual(tool.defaults, { logo: logoId, details: 'Rita Ortiz, rita@northwind.test' });
  assert.equal(tool.inputs.some((i: { id: string }) => i.id === 'price'), false, 'the price stays open');
});

test('someone in two companies gets the rules tool with nothing locked', async () => {
  const config = (await call(await login('pat@both.test'), 'GET', '/api/v1/org-config')).body;
  const tool = config.tools['partner-data-sheet'];
  assert.equal(tool?.inputs, undefined);
  assert.equal(tool?.defaults, undefined);
});
