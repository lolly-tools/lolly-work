// SPDX-License-Identifier: MPL-2.0
/**
 * Published templates (plans/82 M2, W1): a brand team's template for one tool,
 * published to a partner programme, with its own rules.
 *
 * What this suite pins:
 *   - the served feed carries the template's version, the inputs people may
 *     change, and its retirement, and nothing that names a rule;
 *   - a server render that names the template starts from its values, takes
 *     the caller's own values only for inputs the template leaves editable, and
 *     answers 422 INPUT_LOCKED for any other;
 *   - the template can narrow the tool's own rules but never widen them;
 *   - only someone whose feed carries the template can render from it, and only
 *     with the tool it starts;
 *   - a retired template answers 410 with what replaced it;
 *   - a template with no rules leaves every input editable, as before.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { resolveInputAccess, type ToolOverlay } from '../server/src/policy/overlay.ts';
import { isPublishedTemplateRef, normalizeEditable, templateOverlay, templateSeed } from '../server/src/catalog/templates.ts';
import { applyVersionToRecord } from '../server/src/catalog/versions.ts';

// ── the rules, without a server ─────────────────────────────────────────────

const sheet = { toolId: 'price-card', name: 'Partner price sheet', values: { title: 'SLES 16', price: '€ 1,240', bg: '#0c322c' }, editable: ['price'] };
const IDS = ['title', 'price', 'bg'];

test('a template fixes every input it does not leave editable, to its own value', () => {
  const o = templateOverlay(undefined, sheet, ['programme-resellers'], IDS)!;
  assert.deepEqual(resolveInputAccess(o, 'title', []), { level: 'locked', value: 'SLES 16', by: 'Partner price sheet', reason: 'Fixed by the template' });
  assert.equal(resolveInputAccess(o, 'price', []).level, 'editable');
  assert.equal(resolveInputAccess(o, 'bg', []).value, '#0c322c');
  assert.equal(resolveInputAccess(o, 'undeclared', []).level, 'locked', 'what the tool does not declare stays shut');
});

test('a template narrows the tool\'s own rules and never widens them', () => {
  const tool: ToolOverlay = { toolId: 'price-card', version: 3, name: 'Brand guardrails', inputAccess: {
    price: [{ groups: ['programme-resellers'], level: 'locked', value: '€ 999' }],
    bg: [{ groups: ['*'], level: 'choice', allow: ['#0c322c', '#30ba78'] }],
  }, enforce: { formats: ['svg'] } };
  const o = templateOverlay(tool, sheet, ['programme-resellers', 'partner'], IDS)!;
  // The tool locks price for resellers; the template leaving it editable does not open it.
  assert.deepEqual(resolveInputAccess(o, 'price', []), { level: 'locked', value: '€ 999', by: 'Brand guardrails' });
  // The tool offers a choice of colours; the template fixes the colour, which is stricter.
  assert.equal(resolveInputAccess(o, 'bg', []).level, 'locked');
  assert.deepEqual(o.enforce, { formats: ['svg'] }, 'the tool\'s format rule carries over');
  // Someone the tool rule does not name keeps the template's answer.
  assert.equal(resolveInputAccess(templateOverlay(tool, sheet, ['marketing'], IDS), 'price', []).level, 'editable');
});

test('no rules means the tool\'s overlay stands unchanged and every input stays editable', () => {
  const tool: ToolOverlay = { toolId: 'price-card', version: 1 };
  assert.equal(templateOverlay(tool, { ...sheet, editable: undefined }, [], IDS), tool);
  assert.equal(templateOverlay(undefined, { ...sheet, editable: undefined }, [], IDS), undefined);
});

test('editable lists are checked against the tool, refs are instance ids, seeds are declared inputs', () => {
  assert.deepEqual(normalizeEditable(['price', 'price'], IDS), { editable: ['price'] });
  assert.deepEqual(normalizeEditable(null, IDS), { editable: undefined });
  assert.deepEqual(normalizeEditable(['prise'], IDS), { error: 'the tool has no input "prise"' });
  assert.ok('error' in normalizeEditable('price', IDS));
  assert.ok(isPublishedTemplateRef('inst/AbC_12-x'));
  for (const ref of ['poster', 'inst/', 'inst/../x', 'user:abc', 'ext/drive/x']) assert.equal(isPublishedTemplateRef(ref), false, ref);
  assert.deepEqual(templateSeed({ title: 'a', __label: 'mine', stray: 1 }, IDS), { title: 'a' });
});

// ── over HTTP ───────────────────────────────────────────────────────────────

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const blobs = createMemoryBlobStore();
let templateId = '';

const CARD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
  '<rect width="400" height="200" fill="{{bg}}"/><text x="20" y="80">{{title}}</text><text x="20" y="150">{{price}}</text></svg>';
const manifest = (id: string) => ({
  id, name: id, version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
  render: { width: 400, height: 200, formats: ['svg', 'png'] },
  inputs: [
    { id: 'title', label: 'Product', type: 'text', default: 'Product' },
    { id: 'price', label: 'Price', type: 'text', default: '' },
    { id: 'bg', label: 'Background', type: 'color', default: '#204080' },
  ],
});

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-templates-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  for (const id of ['price-card', 'other-card']) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify(manifest(id)));
    await writeFile(join(pack, 'tools', id, 'template.html'), CARD);
  }
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-card' }, { id: 'other-card' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'rita@acme.test', groups: [] },
      { email: 'mia@test', groups: ['marketing'] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs, secrets: { session: 'si', link: 'li' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: ['price-card', 'other-card'] })).status, 201);
  // Server renders need export.server; a programme gets it like anyone else, by a grant.
  await store.putGrant({ principal: 'group:programme-resellers', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putGrant({ principal: 'group:marketing', action: 'export.server', resource: '*', effect: 'allow' });
  await login('rita@acme.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@acme.test' }], apply: true })).status, 200);
  const submitted = await fetch(`${base}/api/v1/catalog/submit?type=template&toolId=price-card&groups=programme-resellers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'price-card', name: 'Partner price sheet', values: sheet.values }),
  });
  const body = await submitted.json() as { assetId: string };
  assert.equal(submitted.status, 201, JSON.stringify(body));
  templateId = body.assetId;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* bytes */ }
  return { status: res.status, body: json, text };
};
const render = (cookie: string, inputs: Record<string, unknown>, toolId = 'price-card') =>
  call(cookie, 'POST', '/api/v1/render', { toolId, format: 'svg', inputs });
const setPublication = async (publication: Record<string, unknown> | undefined) => {
  const rec = (await store.getInstanceAsset(templateId))!;
  await store.putInstanceAsset({ ...rec, ...(publication ? { publication } : { publication: undefined }) });
};
const feedEntry = async (cookie: string) => {
  const feed = (await call(cookie, 'GET', '/catalog/assets/index.json')).body as { assets: Array<{ id: string; meta?: Record<string, unknown> }> };
  return feed.assets.find((a) => a.id === templateId);
};

test('a template with no rules starts the render and leaves every input to the caller', async () => {
  await setPublication(undefined);
  const rita = await login('rita@acme.test');
  const out = await render(rita, { template: templateId, title: 'Rita\'s own' });
  assert.equal(out.status, 200, out.text);
  assert.match(out.text, /Rita's own/);
  assert.match(out.text, /€ 1,240/, 'the template\'s price is where the render starts');
  const entry = await feedEntry(rita);
  assert.equal(entry?.meta?.version, 1);
  assert.equal(entry?.meta?.editable, undefined, 'no rules, nothing listed');
});

test('with rules, the caller changes only what the template leaves editable', async () => {
  await setPublication({ editable: ['price'] });
  const rita = await login('rita@acme.test');
  const ok = await render(rita, { template: templateId, price: '€ 99' });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /€ 99/);
  assert.match(ok.text, /SLES 16/, 'the fixed title is the template\'s');
  assert.match(ok.text, /#0c322c/i);

  const refused = await render(rita, { template: templateId, price: '€ 99', title: 'Cheaper SLES' });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, 'INPUT_LOCKED');
  assert.equal(refused.body.error.input, 'title');

  const entry = await feedEntry(rita);
  assert.deepEqual(entry?.meta?.editable, ['price']);
  assert.ok(!JSON.stringify(entry).includes('Fixed by the template'), 'the feed names no rule');
});

test('the tool\'s own rule still holds inside a template', async () => {
  await setPublication({ editable: ['price'] });
  await store.putOverlay({ toolId: 'price-card', version: 1, name: 'Brand guardrails', inputAccess: { price: [{ groups: ['programme-resellers'], level: 'locked', value: '€ 1,000' }] } });
  try {
    const rita = await login('rita@acme.test');
    const refused = await render(rita, { template: templateId, price: '€ 99' });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.error.input, 'price');
    const baked = await render(rita, { template: templateId });
    assert.equal(baked.status, 200, baked.text);
    assert.match(baked.text, /€ 1,000/, 'the tool\'s locked value wins over the template\'s');
  } finally {
    await store.putOverlay({ toolId: 'price-card', version: 2 });
  }
});

test('only someone whose feed carries the template renders from it, with its own tool', async () => {
  await setPublication({ editable: ['price'] });
  const mia = await login('mia@test');
  const hidden = await render(mia, { template: templateId, price: '1' });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.body.error.code, 'TEMPLATE_NOT_FOUND');
  const rita = await login('rita@acme.test');
  const wrongTool = await render(rita, { template: templateId }, 'other-card');
  assert.equal(wrongTool.status, 422);
  assert.equal(wrongTool.body.error.code, 'TEMPLATE_TOOL_MISMATCH');
  const unknown = await render(rita, { template: 'inst/nope0000' });
  assert.equal(unknown.status, 404);
});

test('a new version moves the version the feed shows and the values a render starts from', async () => {
  await setPublication({ editable: ['price'] });
  const rec = (await store.getInstanceAsset(templateId))!;
  const bytes = Buffer.from(JSON.stringify({ toolId: 'price-card', name: 'Partner price sheet', values: { ...sheet.values, title: 'SLES 16 SP1' } }));
  // Land version 2 the way the submit pipeline does: the bytes, a version row, then the head.
  const blobId = `${templateId}/v2/json`;
  const stat = await blobs.put(blobId, bytes, 'application/json');
  const row = { assetId: templateId, version: 2, formats: [{ format: 'json', blobId, size: stat.size, checksum: stat.checksum, contentType: 'application/json' }], by: 'user:admin', at: new Date().toISOString() };
  await store.putAssetVersion(row);
  await store.putInstanceAsset(applyVersionToRecord(rec, row));
  const rita = await login('rita@acme.test');
  assert.equal((await feedEntry(rita))?.meta?.version, 2);
  const out = await render(rita, { template: templateId, price: '€ 99' });
  assert.equal(out.status, 200, out.text);
  assert.match(out.text, /SLES 16 SP1/);
});

test('a retired template answers 410 with what replaced it, and the feed says so', async () => {
  await setPublication({ editable: ['price'], retiredAt: new Date().toISOString(), retiredBy: 'user:admin', replacedBy: 'inst/next0001' });
  const rita = await login('rita@acme.test');
  const gone = await render(rita, { template: templateId, price: '€ 99' });
  assert.equal(gone.status, 410);
  assert.equal(gone.body.error.code, 'TEMPLATE_RETIRED');
  assert.equal(gone.body.error.replacedBy, 'inst/next0001');
  const entry = await feedEntry(rita);
  assert.equal(entry?.meta?.retired, true, 'still in the feed, so a saved copy can say what happened');
  assert.equal(entry?.meta?.replacedBy, 'inst/next0001');
});

test('a template travels in the inputs of validate and durable renders, as agents send it', async () => {
  await setPublication({ editable: ['price'] });
  const rita = await login('rita@acme.test');
  const checked = await call(rita, 'POST', '/api/v1/validate', { toolId: 'price-card', inputs: { template: templateId, price: '€ 99' } });
  assert.equal(checked.status, 200, checked.text);
  assert.equal(checked.body.ok, true, JSON.stringify(checked.body));
  const queued = await call(rita, 'POST', '/api/v1/renders', { toolId: 'price-card', format: 'svg', inputs: { template: templateId, price: '€ 99' } });
  // This test server runs no durable render runner; what matters is that the
  // template no longer fails the input check every durable render passes first.
  assert.notEqual(queued.body?.error?.code, 'INPUT_VALIDATION_FAILED', queued.text);
});
