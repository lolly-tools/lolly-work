// SPDX-License-Identifier: MPL-2.0
/**
 * Rules tools (plans/82 M2, W2): a Share with rules file published to a
 * partner programme through Work.
 *
 * What this suite pins:
 *   - only the file's DATA is kept: its hooks.js is read to find the definition
 *     and then dropped, and the served tool is this workspace's own build with
 *     its own pack's Design renderer;
 *   - a file that would load anything from outside itself, a damaged file, a
 *     file made from another tool's session and an id the pack already uses
 *     are refused at upload;
 *   - the rebuilt tool reaches exactly the people whose feed carries it, through
 *     the same tool index and file routes as the pack's tools;
 *   - a server render answers 422 INPUT_LOCKED for anything the designer fixed
 *     and 422 INPUT_NOT_ALLOWED for a value outside the designer's rules;
 *   - a new version must be a newer version of the same tool.
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
import { outsideReference, readRulesToolFile } from '../server/src/catalog/rules-tools.ts';

const ENGINE: string = '@lolly/engine';
const { compileDesignTool } = await import(ENGINE) as {
  compileDesignTool(d: Record<string, unknown>, r: { source: string; styles: string }, a: Record<string, Uint8Array>): { files: Record<string, string | Uint8Array> };
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

// ── reading the file ────────────────────────────────────────────────────────

test('only the data is kept: the definition and its facts, never the file\'s code', () => {
  const read = readRulesToolFile(lollyFile(definition()));
  assert.equal(read.ok, true, JSON.stringify(read));
  if (!read.ok) return;
  assert.equal(read.data.kind, 'design');
  assert.equal(read.data.definition.id, 'partner-data-sheet');
  assert.ok(!JSON.stringify(read.data).includes('LollyDesignRules'), 'no renderer code in the stored data');
  assert.deepEqual(read.facts.inputs, [{ id: 'price', label: 'Price', type: 'text' }]);
  assert.equal(read.facts.version, '1.0.1');
});

test('a file that reaches outside itself, a damaged file and a session file are refused', () => {
  const linked = definition({ variants: [{ id: 'a4', label: 'A4', width: 595, height: 842, background: '#fff', boxes: [
    { id: 'price', kind: 'text', text: '€ 1' }, { id: 'logo', kind: 'image', image: { id: 'x', url: 'https://tracker.example/x.png' } },
  ] }] });
  const refused = (bytes: Buffer, why: RegExp) => {
    const r = readRulesToolFile(bytes);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail, why);
  };
  refused(lollyFile(linked), /linked rather than embedded/);
  refused(lollyFile(definition({ css: '@import url(https://x.example/a.css);' })), /style rules reach outside/);
  refused(lollyFile(definition(), { corrupt: true }), /damaged/);
  refused(lollyFile(definition(), { session: true }), /another tool's session/);
  refused(Buffer.from('not a zip at all'), /not a \.lolly file/);
  assert.equal(outsideReference({ image: { url: 'data:image/png;base64,AAAA' } }), null);
  assert.equal(outsideReference({ text: 'a link <a href="https://lolly.example">here</a>' }), null, 'a link is not a load');
  assert.match(outsideReference({ text: '<img src="https://x.example/p.png">' }) ?? '', /linked/);
  assert.match(outsideReference({ text: '<script>alert(1)</script>' }) ?? '', /markup/);
});

// ── over HTTP ───────────────────────────────────────────────────────────────

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let assetId = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-rules-tools-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'design', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'price-card'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design', name: 'Design', version: '1.0.0', inputs: [] }));
  await writeFile(join(pack, 'tools', 'design', 'assets', 'rules-renderer.js'), WORKSPACE_RENDERER);
  await writeFile(join(pack, 'tools', 'design', 'styles.css'), '.design{}');
  await writeFile(join(pack, 'tools', 'price-card', 'tool.json'), JSON.stringify({ id: 'price-card', name: 'Price card', version: '1.0.0', inputs: [{ id: 'price' }] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'design' }, { id: 'price-card' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'rita@acme.test', groups: [] },
      { email: 'mia@test', groups: ['marketing'] },
      { email: 'pat@test', groups: ['partner-team'] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'si', link: 'li' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: [] })).status, 201);
  await store.putGrant({ principal: 'group:programme-resellers', action: 'export.server', resource: '*', effect: 'allow' });
  await login('rita@acme.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@acme.test' }], apply: true })).status, 200);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const call = async (cookie: string, method: string, path: string, body?: unknown, raw?: Buffer) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': raw ? 'application/octet-stream' : 'application/json' },
    ...(raw ? { body: new Uint8Array(raw) } : body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* bytes */ }
  return { status: res.status, body: json, text };
};
const publish = (cookie: string, file: Buffer, query = 'type=rules-tool&groups=programme-resellers') =>
  call(cookie, 'POST', `/api/v1/catalog/submit?${query}`, undefined, file);

test('a published rules file reaches exactly the programme, as this workspace\'s own build', async () => {
  const admin = await login('admin@test');
  const out = await publish(admin, lollyFile(definition()));
  assert.equal(out.status, 201, out.text);
  assetId = out.body.assetId;

  const rita = await login('rita@acme.test');
  const index = (await call(rita, 'GET', '/catalog/tools/index.json')).body as { tools: Array<Record<string, unknown>> };
  const entry = index.tools.find((tool) => tool.id === 'partner-data-sheet');
  assert.ok(entry, 'in the partner\'s tool index');
  assert.equal(entry.templateId, assetId);
  assert.equal(entry.version, '1.0.1');
  const hooks = await call(rita, 'GET', '/tools/partner-data-sheet/hooks.js');
  assert.equal(hooks.status, 200);
  assert.match(hooks.text, /this workspace's Design renderer/);
  assert.ok(!hooks.text.includes('the author\'s own Design renderer'), 'the file\'s code is never served');

  const feed = (await call(rita, 'GET', '/catalog/assets/index.json')).body as { assets: Array<{ id: string; type: string; meta: Record<string, unknown> }> };
  const asset = feed.assets.find((a) => a.id === assetId)!;
  assert.equal(asset.type, 'rules-tool');
  assert.deepEqual(asset.meta.editable, ['price']);
  assert.equal(asset.meta.rebuilt, true, 'made with another Design renderer, and the record says so');
  assert.equal(asset.meta.version, 1);

  const mia = await login('mia@test');
  assert.ok(!(await call(mia, 'GET', '/catalog/tools/index.json')).body.tools.some((t: { id: string }) => t.id === 'partner-data-sheet'));
  assert.equal((await call(mia, 'GET', '/tools/partner-data-sheet/tool.json')).status, 404);
});

test('a server render answers 422 for anything the designer fixed or ruled out', async () => {
  const rita = await login('rita@acme.test');
  const render = (inputs: Record<string, unknown>) => call(rita, 'POST', '/api/v1/render', { toolId: 'partner-data-sheet', format: 'svg', inputs });
  const fixed = await render({ price: '€ 99', title: 'Cheaper' });
  assert.equal(fixed.status, 422);
  assert.equal(fixed.body.error.code, 'INPUT_LOCKED');
  assert.equal(fixed.body.error.input, 'title');
  const tooLong = await render({ price: '€'.repeat(60) });
  assert.equal(tooLong.status, 422);
  assert.equal(tooLong.body.error.code, 'INPUT_NOT_ALLOWED');
  // Within the rules the render goes ahead: a rules tool runs Design's renderer,
  // so with no browser worker configured it stops at the worker gate.
  const allowed = await render({ price: '€ 99' });
  assert.equal(allowed.body?.error?.code, 'HOOKED_TOOL_NEEDS_CHROMIUM', allowed.text);
});

test('an id the pack or another rules tool uses is refused; a version must be newer', async () => {
  const admin = await login('admin@test');
  const packId = await publish(admin, lollyFile(definition({ id: 'price-card' })));
  assert.equal(packId.status, 422);
  assert.match(packId.body.error.message, /already has a tool with the id "price-card"/);
  const twice = await publish(admin, lollyFile(definition({ name: 'Another sheet', css: '' })));
  assert.equal(twice.status, 422);
  assert.match(twice.body.error.message, /already published/);

  const same = await publish(admin, lollyFile(definition({ css: '.v{}' })), `assetId=${assetId}`);
  assert.equal(same.status, 422);
  assert.match(same.body.error.message, /1\.0\.1 is already published/);
  const other = await publish(admin, lollyFile(definition({ id: 'another-sheet', version: '2.0.0' })), `assetId=${assetId}`);
  assert.equal(other.status, 422);
  const newer = await publish(admin, lollyFile(definition({ version: '1.0.2', name: 'Partner data sheet' })), `assetId=${assetId}`);
  assert.equal(newer.status, 201, newer.text);

  const rita = await login('rita@acme.test');
  const feed = (await call(rita, 'GET', '/catalog/assets/index.json')).body as { assets: Array<{ id: string; meta: Record<string, unknown> }> };
  const asset = feed.assets.find((a) => a.id === assetId)!;
  assert.equal(asset.meta.version, 2);
  assert.equal(asset.meta.toolVersion, '1.0.2');
  const index = (await call(rita, 'GET', '/catalog/tools/index.json')).body as { tools: Array<Record<string, unknown>> };
  assert.equal(index.tools.find((tool) => tool.id === 'partner-data-sheet')?.version, '1.0.2');
});

test('a retired rules tool leaves the gallery and still opens for a saved copy', async () => {
  const rec = (await store.getInstanceAsset(assetId))!;
  await store.putInstanceAsset({ ...rec, publication: { retiredAt: new Date().toISOString(), retiredBy: 'user:admin' } });
  const rita = await login('rita@acme.test');
  const entry = (await call(rita, 'GET', '/catalog/tools/index.json')).body.tools.find((t: { id: string }) => t.id === 'partner-data-sheet');
  assert.equal(entry.listed, false);
  assert.equal((await call(rita, 'GET', '/tools/partner-data-sheet/tool.json')).status, 200);
});

test('someone who manages programmes publishes a rules file and its new version from the programme', async () => {
  await store.putGrant({ principal: 'group:partner-team', action: 'programme.manage', resource: '*', effect: 'allow' });
  const pat = await login('pat@test');
  // No catalog.submit: publishing into a programme is the programme manager's right.
  assert.equal((await publish(pat, lollyFile(definition({ id: 'reseller-card', name: 'Reseller card' })))).status, 403);
  const path = '/api/v1/programmes/resellers/templates/rules-file?groups=programme-resellers';
  const out = await call(pat, 'POST', path, undefined, lollyFile(definition({ id: 'reseller-card', name: 'Reseller card' })));
  assert.equal(out.status, 201, out.text);
  const bare = String(out.body.id).replace(/^inst\//, '');
  const listed = (await call(pat, 'GET', '/api/v1/programmes/resellers/templates')).body.templates;
  assert.ok(listed.some((t: { id: string; kind: string }) => t.id === out.body.id && t.kind === 'rules-tool'));
  const stale = await call(pat, 'POST', `/api/v1/programmes/resellers/templates/${bare}/versions`, undefined, lollyFile(definition({ id: 'reseller-card', name: 'Reseller card' })));
  assert.equal(stale.status, 422, 'the same version again');
  const next = await call(pat, 'POST', `/api/v1/programmes/resellers/templates/${bare}/versions`, undefined, lollyFile(definition({ id: 'reseller-card', name: 'Reseller card', version: '1.1.0' })));
  assert.equal(next.status, 201, next.text);
  assert.equal(next.body.version, 2);
  assert.equal((await call(pat, 'POST', '/api/v1/programmes/resellers/templates/rules-file?groups=marketing', undefined, lollyFile(definition({ id: 'other-card' })))).status, 400);
});

test('someone who manages programmes previews a programme, and nothing else', async () => {
  const pat = await login('pat@test');
  const preview = await call(pat, 'GET', '/api/v1/org-config/preview?groups=programme-resellers,partner');
  assert.equal(preview.status, 200, preview.text);
  assert.ok(Array.isArray(preview.body.preview.templates));
  const sheet = preview.body.preview.templates.find((t: { kind: string }) => t.kind === 'rules-tool');
  if (sheet) assert.ok(sheet.canChange.includes('Colourway and mode'), 'Design\u2019s rules leave colourway and mode open, as the app offers them');
  assert.equal((await call(pat, 'GET', '/api/v1/org-config/preview?groups=marketing')).status, 403);
  assert.equal((await call(pat, 'GET', '/api/v1/org-config/preview?groups=programme-resellers,admin')).status, 403);
});
