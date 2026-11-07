// SPDX-License-Identifier: MPL-2.0
/**
 * Templates only (plans/82 M2 W5, Andy 2026-11-07): "Partners use <tool> only
 * through its published templates", a switch per programme and per tool.
 *
 * What this suite pins:
 *   - off by default, so nothing changes for a programme that never sets it;
 *   - on, the tool leaves the gallery and search (unlisted in the served index) and
 *     is marked, while its files are still served for the templates;
 *   - a server render that names no template from the caller's feed answers
 *     422 TEMPLATE_REQUIRED with the templates they may use, and one that names a
 *     template still renders;
 *   - across programmes the stricter rule wins, Preview says which programme set it,
 *     and an admin is never scoped, in the gallery or in a render;
 *   - the switch is audited, only a programme manager may set it, and the
 *     Templates card stops saying the programme can open the tool on its own.
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
import { templatesOnlyFor, withTemplatesOnly } from '../server/src/programmes/templates-only.ts';
import type { ProgrammeRecord } from '../server/src/programmes/types.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let templateId = '';

const CARD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
  '<rect width="400" height="200" fill="{{bg}}"/><text x="20" y="80">{{title}}</text><text x="20" y="150">{{price}}</text></svg>';
const manifest = (id: string) => ({
  id, name: id === 'price-card' ? 'Price card' : id, version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
  render: { width: 400, height: 200, formats: ['svg'] },
  inputs: [
    { id: 'title', label: 'Product', type: 'text', default: 'Product' },
    { id: 'price', label: 'Price', type: 'text', default: '' },
    { id: 'bg', label: 'Background', type: 'color', default: '#204080' },
  ],
});

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-templates-only-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  for (const id of ['price-card', 'other-card']) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify(manifest(id)));
    await writeFile(join(pack, 'tools', id, 'template.html'), CARD);
  }
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-card', name: 'Price card' }, { id: 'other-card', name: 'other-card' }] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.slim.json'), JSON.stringify({ tools: [{ id: 'price-card', name: 'Price card' }, { id: 'other-card', name: 'other-card' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'bruno@test', groups: ['brand'] },
      { email: 'rita@acme.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'si', link: 'li' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: ['price-card', 'other-card'] })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/distributors', { name: 'Distributors', tools: ['price-card'] })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/companies/acme', { name: 'Acme Distribution' })).status, 201);
  await store.putGrant({ principal: 'group:programme-resellers', action: 'export.server', resource: '*', effect: 'allow' });
  await login('rita@acme.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@acme.test', company: 'acme' }], apply: true })).status, 200);
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/distributors/people', { rows: [{ email: 'rita@acme.test' }], apply: true })).status, 200);
  const submitted = await fetch(`${base}/api/v1/catalog/submit?type=template&toolId=price-card`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'price-card', name: 'Partner price sheet', values: { title: 'SLES 16', price: '€ 1,240', bg: '#0c322c' } }),
  });
  const source = (await submitted.json() as { assetId: string }).assetId;
  const out = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: source, groups: ['programme-resellers'], editable: ['price'] });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  templateId = out.body.id;
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
const setSwitch = async (on: boolean, programme = 'resellers') =>
  call(await login('admin@test'), 'PUT', `/api/v1/programmes/${programme}/templates-only/price-card`, { on });
const ritaTool = async (rel = 'tools/index.json') => {
  const index = (await call(await login('rita@acme.test'), 'GET', `/catalog/${rel}`)).body as { tools: Array<{ id: string; listed?: boolean; templatesOnly?: boolean }> };
  return index.tools.find((t) => t.id === 'price-card');
};
const render = async (inputs: Record<string, unknown>) =>
  call(await login('rita@acme.test'), 'POST', '/api/v1/render', { toolId: 'price-card', format: 'svg', inputs });

test('off by default: the tool is listed and renders without a template', async () => {
  const entry = await ritaTool();
  assert.ok(entry, 'the programme can open the tool');
  assert.equal(entry!.listed, undefined);
  assert.equal(entry!.templatesOnly, undefined);
  assert.equal((await render({ title: 'Anything' })).status, 200);
  const list = (await call(await login('admin@test'), 'GET', '/api/v1/programmes/resellers/templates')).body;
  assert.deepEqual(list.templatesOnly, []);
  assert.ok(list.templates[0].toolOpenTo.includes('Resellers'), 'the card says they can open it on its own');
});

test('on: the tool leaves the gallery, its files stay, and a plain render is refused with the templates to use', async () => {
  const on = await setSwitch(true);
  assert.equal(on.status, 200, on.text);
  for (const rel of ['tools/index.json', 'tools/index.slim.json']) {
    const entry = await ritaTool(rel);
    assert.equal(entry?.listed, false, `${rel}: unlisted, so out of the gallery and search`);
    assert.equal(entry?.templatesOnly, true, `${rel}: marked for the Start chooser`);
  }
  assert.equal((await call(await login('rita@acme.test'), 'GET', '/tools/price-card/tool.json')).status, 200, 'the templates still need the files');

  const refused = await render({ title: 'Anything' });
  assert.equal(refused.status, 422, refused.text);
  assert.equal(refused.body.error.code, 'TEMPLATE_REQUIRED');
  assert.deepEqual(refused.body.error.templates, [{ id: templateId, name: 'Partner price sheet' }]);
  const ok = await render({ template: templateId, price: '€ 99' });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /€ 99/);

  const other = await call(await login('rita@acme.test'), 'POST', '/api/v1/render', { toolId: 'other-card', format: 'svg', inputs: {} });
  assert.equal(other.status, 200, 'one tool at a time');

  const list = (await call(await login('admin@test'), 'GET', '/api/v1/programmes/resellers/templates')).body;
  assert.deepEqual(list.templatesOnly, ['price-card']);
  assert.deepEqual(list.templatesOnlyTools, [{ id: 'price-card', name: 'Price card' }]);
  assert.equal(list.templates[0].toolOpenTo, undefined, 'the card no longer says they can open it on its own');
  const audit = await store.listAudit();
  assert.ok(audit.some((e) => e.action === 'programme.template.only' && e.subject === 'programme:resellers' && e.payload?.on === true && e.payload?.toolId === 'price-card'));
});

test('the stricter rule wins across programmes, Preview says who set it, and an admin is never scoped', async () => {
  const admin = await login('admin@test');
  const preview = (await call(admin, 'GET', '/api/v1/org-config/preview?groups=programme-resellers,programme-distributors,company-acme,partner')).body.preview;
  assert.deepEqual(preview.templatesOnly, [{ toolId: 'price-card', toolName: 'Price card', setBy: ['Resellers'] }]);
  const row = preview.templates.find((t: { id: string }) => t.id === templateId);
  assert.ok(row.why.includes('These groups use Price card only through its published templates, set by Resellers.'));
  assert.ok(!row.why.some((line: string) => /can also open/.test(line)));
  // Distributors leaves it open, and Rita is in both: Resellers' switch still holds.
  assert.equal((await ritaTool())?.templatesOnly, true);

  const programmes = await store.listProgrammes();
  const companies = await store.listCompanies();
  assert.deepEqual([...templatesOnlyFor(programmes, companies, ['company-acme', 'partner']).keys()], ['price-card'], 'through the company alone');
  assert.equal(templatesOnlyFor(programmes, companies, ['programme-resellers'], 'admin').size, 0, 'an admin is never scoped');
  assert.equal(templatesOnlyFor(programmes, companies, ['programme-distributors', 'partner']).size, 0, 'only the programme that set it');
});

test('an admin in the programme is never scoped: the gallery and every render agree', async () => {
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'admin@test' }], apply: true })).status, 200);
  const adminIn = await login('admin@test');
  const index = (await call(adminIn, 'GET', '/catalog/tools/index.json')).body as { tools: Array<{ id: string; templatesOnly?: boolean; listed?: boolean }> };
  const entry = index.tools.find((t) => t.id === 'price-card');
  assert.equal(entry?.templatesOnly, undefined, 'the gallery leaves an admin unscoped');
  const plain = await call(adminIn, 'POST', '/api/v1/render', { toolId: 'price-card', format: 'svg', inputs: { title: 'Admin' } });
  assert.equal(plain.status, 200, `and so does a render: ${plain.text}`);
  assert.equal((await render({ title: 'Rita' })).status, 422, 'while the partner beside them is still held to the templates');
});

test('off again lists the tool and renders without a template, and only a programme manager may switch', async () => {
  assert.equal((await setSwitch(false)).status, 200);
  assert.equal((await ritaTool())?.templatesOnly, undefined);
  assert.equal((await render({ title: 'Anything' })).status, 200);
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers/templates-only/price-card', { on: true })).status, 403);
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/templates-only/no-such-tool', { on: true })).status, 404);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/templates-only/price-card', { on: 'yes' })).status, 400);
});

test('the record keeps a sorted list, and turning a tool off removes it', () => {
  const base: ProgrammeRecord = { id: 'p', name: 'P', createdBy: 'u', createdAt: '', updatedAt: '', version: 1 };
  const one = withTemplatesOnly(withTemplatesOnly(base, 'zeta', true), 'alpha', true);
  assert.deepEqual(one.templatesOnly, ['alpha', 'zeta']);
  assert.equal(withTemplatesOnly(withTemplatesOnly(one, 'alpha', false), 'zeta', false).templatesOnly, undefined);
});
