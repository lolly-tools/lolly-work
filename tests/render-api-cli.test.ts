// SPDX-License-Identifier: MPL-2.0
/**
 * `lw render-api` against a local stub that serves each vendor's public schema, read
 * 2026-11-05, and a real Work app for check and compare. The stub stands in for a
 * vendor account: this has never been run against a live one.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { mintServiceSecret } from '../server/src/iam/service-tokens.ts';
import { parseRenderApiMappings } from '../server/src/render-api/mapping.ts';
import { imageFacts } from '../cli/render-api.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');
const VENDOR_TOKEN = 'vendor-secret-do-not-print';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==', 'base64');

let stub: Server;
let stubBase = '';
let home = '';
let work: Server;
let workBase = '';
let workToken = '';
let pack = '';
const previewAuth: Array<string | undefined> = [];
const created: unknown[] = [];
let polls = 0;

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const bodyOf = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

function vendor(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url!, stubBase);
  if (url.pathname.startsWith('/files/')) {
    previewAuth.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'image/png' });
    return void res.end(PNG);
  }
  if (req.headers.authorization !== `Bearer ${VENDOR_TOKEN}`) return json(res, 401, {});
  const page = Number(url.searchParams.get('page') ?? 1);
  if (url.pathname === '/v5/image_templates') {
    return json(res, 200, page > 1 ? [] : [{
      uid: 'bbfive', name: 'Launch Card', description: null, tags: ['launch'], width: 1200, height: 630, responsive: false, preview: `${stubBase}/files/bbfive.png`,
      ui_write_access: 'team', api_write_access: 'team', created_at: '2026-03-15T04:51:17.550Z',
      config: { objects: [
        { id: 'l1', type: 'text', name: 'title', left: 40, top: 40, width: 800, height: 120, text: 'Hello', 'font-family': 'Inter', 'font-size': 64, color: '#111111' },
        { id: 'l2', type: 'rectangle_image_container', name: 'photo', left: 0, top: 200, width: 1200, height: 430, 'background-image': 'https://example.com/a.jpg' },
        { id: 'l3', type: 'group', name: 'wrap' },
      ] },
    }]);
  }
  if (url.pathname === '/v2/templates') {
    return json(res, 200, page > 1 ? [] : [{ uid: 'bbtwo', name: 'Old Card', self: `${stubBase}/v2/templates/bbtwo`, preview_url: `${stubBase}/files/bbtwo.png`, tags: [], width: 1000, height: 1000, created_at: '2026-03-15T04:51:17.550Z',
      available_modifications: [{ name: 'avatar', image_url: null }, { name: 'name', text: null }] }]);
  }
  if (url.pathname === '/templates') {
    if (url.searchParams.get('cursor') === 'away') return json(res, 200, { data: [], links: { next: 'https://elsewhere.invalid/templates' } });
    if (url.searchParams.get('cursor') === '2') return json(res, 200, { data: [{ uuid: 'plctwo', title: 'Second', thumbnail: null, tags: [], layers: [{ name: 'shot', type: 'browserframe' }] }], meta: { per_page: 20 }, links: { next: null, prev: `${stubBase}/templates` } });
    return json(res, 200, { data: [{ uuid: 'plcone', title: 'First', thumbnail: `${stubBase}/files/plcone.png`, tags: ['a'], layers: [{ name: 'title', type: 'text' }, { name: 'img', type: 'picture' }, { name: 'box', type: 'mystery' }] }], meta: { per_page: 20 }, links: { next: `${stubBase}/templates?cursor=2`, prev: null } });
  }
  if (req.method === 'POST' && ['/v5/images', '/v2/images', '/images'].includes(url.pathname)) {
    return void bodyOf(req).then((body) => {
      created.push(body);
      polls = 0;
      if (url.pathname === '/images') return json(res, 200, { id: 7, status: 'queued', image_url: null, polling_url: `${stubBase}/images/7` });
      if (url.pathname === '/v5/images') return json(res, 202, { uid: 'img5', status: 'pending', template: 'bbfive', files: { png: null }, self: `${stubBase}/v5/images/img5` });
      json(res, 202, { uid: 'img2', status: 'pending', image_url: null, pdf_url: null, self: `${stubBase}/v2/images/img2` });
    });
  }
  if (url.pathname === '/images/7') return json(res, 200, { id: 7, status: ++polls > 0 ? 'finished' : 'queued', image_url: `${stubBase}/files/out.png` });
  if (url.pathname === '/v5/images/img5') return json(res, 200, { uid: 'img5', status: 'completed', files: { png: `${stubBase}/files/out5.png` } });
  if (url.pathname === '/v2/images/img2') return json(res, 200, { uid: 'img2', status: 'completed', image_url: `${stubBase}/files/out2.png`, pdf_url: null });
  json(res, 404, {});
}

interface Run { code: number; stdout: string; stderr: string }
function lw(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, LW_BASE: workBase, LW_TOKEN: workToken, VENDOR_KEY: VENDOR_TOKEN, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

async function allText(folder: string): Promise<string> {
  let text = '';
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += await readFile(join(entry.parentPath, entry.name), 'latin1');
  }
  return text;
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'lw-render-api-cli-'));
  stub = createServer(vendor);
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address(); assert.ok(address && typeof address === 'object');
  stubBase = `http://127.0.0.1:${address.port}`;
  pack = join(home, 'pack');
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }] }));
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify({
    id: 'card', name: 'Card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 64, height: 32, formats: ['svg', 'png'] },
    inputs: [{ id: 'bg', type: 'color', label: 'Background', default: '#112233' }, { id: 'badge', type: 'color', label: 'Badge', default: '#ffffff' }, { id: 'locked', type: 'text', label: 'Locked', default: 'x' }],
  }));
  await writeFile(join(pack, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32" viewBox="0 0 64 32"><rect width="64" height="32" fill="{{bg}}"/><rect x="40" y="8" width="16" height="16" fill="{{badge}}"/></svg>');
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({ instance: { name: 'Move', baseUrl: 'http://localhost', pack }, policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false }, dev: { enabled: true, users: [] } }));
  const token = mintServiceSecret();
  workToken = token.secret;
  await store.putApiToken({ id: 'ci', label: 'CI', role: 'admin', tokenHash: token.tokenHash, createdBy: 'system', createdAt: new Date().toISOString() });
  await store.putOverlay({ toolId: 'card', version: 1, inputAccess: { locked: [{ groups: ['*'], level: 'locked', value: 'held' }] } });
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'test-session', link: 'test-link' }, onRenderRunner: () => {} });
  work = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => work.listen(0, '127.0.0.1', resolve));
  const workAddress = work.address(); assert.ok(workAddress && typeof workAddress === 'object');
  workBase = `http://127.0.0.1:${workAddress.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await new Promise<void>((resolve) => { work.closeAllConnections(); work.close(() => resolve()); });
  await rm(home, { recursive: true, force: true });
});

const inventoryArgs = (from: string, out: string): string[] => ['render-api', 'inventory', '--from', from, '--token-env', 'VENDOR_KEY', '--out', out, '--source-url', stubBase];

test('inventory reads Bannerbear V5 with no server, keeps the raw design and never prints the token', async () => {
  const out = join(home, 'bb5');
  const run = await lw(inventoryArgs('bannerbear-v5', out), { LW_BASE: 'http://127.0.0.1:1', LW_TOKEN: '' });
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /1 template read from bannerbear-v5\. Nothing was changed/);
  assert.match(run.stdout, /has not been run against a live account/);
  const inventory = JSON.parse(await readFile(join(out, 'inventory.json'), 'utf8'));
  assert.equal(inventory.source, 'bannerbear-v5');
  assert.equal(inventory.templates[0].design, 'importable');
  assert.equal(inventory.templates[0].width, 1200);
  assert.deepEqual(inventory.templates[0].layers[0], { name: 'title', type: 'text', properties: ['text'] });
  assert.deepEqual(inventory.templates[0].layers[1], { name: 'photo', type: 'rectangle_image_container', properties: ['background-image'] });
  assert.deepEqual(inventory.templates[0].layers[2].properties, [], 'a layer type with no confirmed property is listed, not guessed');
  const raw = JSON.parse(await readFile(join(out, 'templates', 'bbfive.json'), 'utf8'));
  assert.equal(raw.config.objects[0]['font-family'], 'Inter', 'the raw design is kept for lolly import');
  const draft = parseRenderApiMappings(JSON.parse(await readFile(join(out, 'mappings.draft.json'), 'utf8')).templates);
  assert.deepEqual(draft[0], { source: 'bannerbear-v5', template: 'bbfive', toolId: 'launch-card', format: 'png', layers: { title: { text: 'title' }, photo: { 'background-image': 'photo' } }, ignore: [], fixed: {} });
  assert.deepEqual([...(await readFile(join(out, 'previews', 'bbfive.png')))], [...PNG]);
  assert.ok(previewAuth.length && previewAuth.every((value) => value === undefined), 'the token never goes to a preview host');
  const coverage = await readFile(join(out, 'coverage.md'), 'utf8');
  assert.match(coverage, /can be imported/);
  assert.match(coverage, /has not been run against a live account/);
  assert.match(coverage, /\| wrap \| group \| nothing yet \|/);
  for (const text of [run.stdout, run.stderr, await allText(out)]) assert.equal(text.includes(VENDOR_TOKEN), false);
});

test('inventory reads Bannerbear V2 and says the design must be rebuilt', async () => {
  const out = join(home, 'bb2');
  const run = await lw(inventoryArgs('bannerbear-v2', out));
  assert.equal(run.code, 0, run.stderr);
  const inventory = JSON.parse(await readFile(join(out, 'inventory.json'), 'utf8'));
  assert.equal(inventory.templates[0].design, 'rebuild');
  assert.deepEqual(inventory.templates[0].layers, [{ name: 'avatar', type: null, properties: ['image_url'] }, { name: 'name', type: null, properties: ['text'] }]);
  assert.match(await readFile(join(out, 'coverage.md'), 'utf8'), /field names and a preview only/);
});

test('inventory follows Placid pagination, on the API host only', async () => {
  const out = join(home, 'placid');
  const run = await lw(inventoryArgs('placid', out));
  assert.equal(run.code, 0, run.stderr);
  const inventory = JSON.parse(await readFile(join(out, 'inventory.json'), 'utf8'));
  assert.deepEqual(inventory.templates.map((item: { id: string }) => item.id), ['plcone', 'plctwo']);
  assert.equal(inventory.templates[0].width, null, 'Placid returns no size');
  assert.equal(inventory.templates[0].design, 'rebuild');
  assert.deepEqual(inventory.templates[0].layers.map((layer: { properties: string[] }) => layer.properties), [['text'], ['image'], []]);
  const draft = parseRenderApiMappings(JSON.parse(await readFile(join(out, 'mappings.draft.json'), 'utf8')).templates);
  assert.deepEqual(draft[0]!.layers, { title: { text: 'title' }, img: { image: 'img' } });
});

test('inventory refuses a missing token, a plain HTTP host and a bad token, and prints no secret', async () => {
  const missing = await lw(['render-api', 'inventory', '--from', 'placid', '--token-env', 'NOT_SET_HERE', '--out', join(home, 'x')]);
  assert.equal(missing.code, 1); assert.match(missing.stderr, /NOT_SET_HERE is not set/);
  const plain = await lw(['render-api', 'inventory', '--from', 'placid', '--token-env', 'VENDOR_KEY', '--out', join(home, 'x'), '--source-url', 'http://api.example.com']);
  assert.equal(plain.code, 1); assert.match(plain.stderr, /must use HTTPS/);
  const refused = await lw(inventoryArgs('placid', join(home, 'x')), { VENDOR_KEY: 'wrong-key' });
  assert.equal(refused.code, 1); assert.match(refused.stderr, /answered 401/); assert.equal(refused.stderr.includes('wrong-key'), false);
  const unknown = await lw(['render-api', 'inventory', '--from', 'canva', '--token-env', 'VENDOR_KEY', '--out', join(home, 'x')]);
  assert.equal(unknown.code, 1); assert.match(unknown.stderr, /--from must be one of/);
});

test('sample needs an explicit choice to spend credits, then keeps the reference', async () => {
  const values = join(home, 'values.json');
  await writeFile(values, JSON.stringify({ layers: { title: { text: 'Sample' } } }));
  const out = join(home, 'references');
  const args = ['render-api', 'sample', '--from', 'placid', '--template', 'plcone', '--token-env', 'VENDOR_KEY', '--values', values, '--out', out, '--source-url', stubBase];
  const refused = await lw(args);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /spends credits/);
  assert.equal(created.length, 0, 'nothing was sent');
  const run = await lw([...args, '--spend-credits']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /used credits on your placid account/);
  assert.deepEqual(created[0], { layers: { title: { text: 'Sample' } }, template_uuid: 'plcone' });
  assert.deepEqual([...(await readFile(join(out, 'plcone.png')))], [...PNG]);
  const receipt = JSON.parse(await readFile(join(out, 'plcone.reference.json'), 'utf8'));
  assert.equal(receipt.files[0].size, PNG.length);
  for (const text of [run.stdout, await allText(out)]) assert.equal(text.includes(VENDOR_TOKEN), false);
  for (const [from, template] of [['bannerbear-v5', 'bbfive'], ['bannerbear-v2', 'bbtwo']] as const) {
    await writeFile(values, JSON.stringify(from === 'bannerbear-v5' ? { modifications: { objects: [] } } : { modifications: [] }));
    const other = await lw(['render-api', 'sample', '--from', from, '--template', template, '--token-env', 'VENDOR_KEY', '--values', values, '--out', join(home, from), '--source-url', stubBase, '--spend-credits']);
    assert.equal(other.code, 0, other.stderr);
    assert.deepEqual([...(await readFile(join(home, from, `${template}.png`)))], [...PNG]);
  }
});

test('check reads a mapping against the effective schema and refuses what cannot work', async () => {
  const mapping = join(home, 'mapping.json');
  await writeFile(mapping, JSON.stringify({ templates: [
    { source: 'placid', template: 'good', toolId: 'card', format: 'png', layers: { box: { background_color: 'bg' } } },
    { source: 'placid', template: 'bad', toolId: 'card', format: 'pdf', layers: { title: { text: 'missing' }, held: { text: 'locked' } } },
    { source: 'placid', template: 'gone', toolId: 'no-such-tool', format: 'png', layers: {} },
  ] }));
  const run = await lw(['render-api', 'check', '--mapping', mapping]);
  assert.equal(run.code, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /ok +placid good -> card/);
  assert.match(run.stdout, /format pdf is not available/);
  assert.match(run.stdout, /title\.text: the tool has no input missing/);
  assert.match(run.stdout, /held\.text: input locked is locked by policy/);
  assert.match(run.stdout, /tool no-such-tool: 40\d/);
  assert.match(run.stdout, /1 of 3 mapped templates can run here/);
  const asJson = JSON.parse((await lw(['render-api', 'check', '--mapping', mapping, '--json'])).stdout);
  assert.equal(asJson.withProblems, 2);
  await writeFile(mapping, JSON.stringify({ templates: [{ source: 'placid', template: 'good', toolId: 'card', format: 'png', layers: { box: { background_color: 'bg' } } }] }));
  assert.equal((await lw(['render-api', 'check', '--mapping', mapping])).code, 0);
  await writeFile(mapping, JSON.stringify({ templates: [{ source: 'canva' }] }));
  assert.equal((await lw(['render-api', 'check', '--mapping', mapping])).code, 1);
});

test('compare measures a render here against a reference and names the region that moved', async () => {
  const rendered = await fetch(`${workBase}/api/v1/render`, { method: 'POST', headers: { authorization: `Bearer ${workToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'card', format: 'png', inputs: { bg: '#112233', badge: '#ffffff' } }) });
  assert.equal(rendered.status, 200, await rendered.clone().text());
  const reference = join(home, 'reference.png');
  const bytes = Buffer.from(await rendered.arrayBuffer());
  await writeFile(reference, bytes);
  assert.deepEqual(imageFacts(bytes), { format: 'png', width: 64, height: 32 });
  const mapping = join(home, 'compare-mapping.json');
  await writeFile(mapping, JSON.stringify({ templates: [{ source: 'placid', template: 'plc', toolId: 'card', format: 'png', layers: { background: { background_color: 'bg' }, badge: { background_color: 'badge' } } }] }));
  const regions = join(home, 'regions.json');
  await writeFile(regions, JSON.stringify([{ id: 'badge', x: 40, y: 8, width: 16, height: 16, minSsim: 0.9, maxInkDelta: 0.05 }]));
  const same = join(home, 'same.json');
  await writeFile(same, JSON.stringify({ layers: { background: { background_color: '#112233' }, badge: { background_color: '#ffffff' } } }));
  const base = ['render-api', 'compare', '--from', 'placid', '--mapping', mapping, '--template', 'plc', '--reference', reference, '--regions', regions];
  const pass = await lw([...base, '--values', same]);
  assert.equal(pass.code, 0, pass.stdout + pass.stderr);
  assert.match(pass.stdout, /^matches {2}placid plc -> card/);
  assert.match(pass.stdout, /pass +appearance\.whole/);
  assert.match(pass.stdout, /not an approval of the design/);
  const moved = join(home, 'moved.json');
  await writeFile(moved, JSON.stringify({ layers: { background: { background_color: '#112233' }, badge: { background_color: '#000000' } } }));
  const fail = await lw([...base, '--values', moved]);
  assert.equal(fail.code, 2, fail.stdout + fail.stderr);
  assert.match(fail.stdout, /^differs {2}placid plc -> card/);
  assert.match(fail.stdout, /fail +appearance\.badge\./, 'the moved region is named');
  const asJson = JSON.parse((await lw([...base, '--values', moved, '--json'])).stdout);
  assert.equal(asJson.passed, false);
  assert.ok(asJson.checks.some((check: { id: string; state: string }) => check.id.startsWith('appearance.badge') && check.state === 'fail'));
  const unmapped = join(home, 'unmapped.json');
  await writeFile(unmapped, JSON.stringify({ layers: { other: { text: 'x' } } }));
  const refused = await lw([...base, '--values', unmapped]);
  assert.equal(refused.code, 1); assert.match(refused.stderr, /not mapped for this template: other\.text/);
  await writeFile(join(home, 'notimage.png'), 'not an image');
  const notImage = await lw(['render-api', 'compare', '--from', 'placid', '--mapping', mapping, '--template', 'plc', '--reference', join(home, 'notimage.png')]);
  assert.equal(notImage.code, 1); assert.match(notImage.stderr, /must be a PNG or JPEG/);
});
