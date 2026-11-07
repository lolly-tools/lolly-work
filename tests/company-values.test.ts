// SPDX-License-Identifier: MPL-2.0
/**
 * Company values in tools (plans/82 M3, W-M3-3). A published template or a
 * tool overlay binds inputs to company fields; one resolver fills them for
 * people and agents alike, from the caller's company profile.
 *
 * What this suite pins:
 *   - the pure rules: which company, which value for which mode, which bound
 *     inputs lock, and how group defaults stack;
 *   - a server render starts from the company's logo and contact, locks what
 *     the template fixes (422 INPUT_LOCKED for a caller who sends one), and
 *     takes the dark logo in dark mode;
 *   - someone in two companies gets no company values and open inputs; a
 *     company with nothing set keeps the template's value;
 *   - an overlay binding fills a tool opened directly, and locks it when the
 *     overlay's rule locks that input; overlay defaults apply per group, most
 *     specific first;
 *   - org-config carries `partner` and each tool's starting values, the feed
 *     carries `meta.bindings`, the agents' schema shows the locked value, and
 *     Preview says where each value comes from, for admins only.
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
import { normalizeOverlay } from '../server/src/policy/overlay.ts';
import {
  defaultsFor, fieldValue, legacyDefaults, normalizeBindings, pickCompany, pickProgramme, planBindings, themeOf, type CompanyContext,
} from '../server/src/programmes/company-values.ts';

// ── the pure rules ─────────────────────────────────────────────────────────

const companies = [
  { id: 'northwind-it', programmeId: 'resellers', name: 'Northwind IT', createdBy: 'x', createdAt: 'x', updatedAt: 'x' },
  { id: 'globex', programmeId: 'resellers', name: 'Globex', createdBy: 'x', createdAt: 'x', updatedAt: 'x' },
  { id: 'initech', programmeId: 'isvs', name: 'Initech', createdBy: 'x', createdAt: 'x', updatedAt: 'x' },
];
const ctx: CompanyContext = {
  company: companies[0]!, programme: { id: 'resellers', name: 'Resellers' }, revision: 3,
  profile: { logoLight: 'inst/light', logoDark: 'inst/dark', contact: { name: 'Rita Ortiz', email: 'rita@n.test', phone: '+49 30 1' }, currency: 'EUR' },
};

test('bindings name declared inputs and company fields only', () => {
  assert.deepEqual(normalizeBindings({ logo: 'logo', line: 'contact' }, ['logo', 'line', 'price']), { bindings: { logo: 'logo', line: 'contact' } });
  assert.deepEqual(normalizeBindings(null), { bindings: undefined });
  assert.deepEqual(normalizeBindings({}), { bindings: undefined });
  assert.ok('error' in normalizeBindings({ nope: 'logo' }, ['logo']));
  assert.ok('error' in normalizeBindings({ logo: 'colour' }, ['logo']));
  assert.ok('error' in normalizeBindings(['logo']));
});

test('which company: the one the template reached, else the only one, and never a guess', () => {
  assert.equal(pickCompany(['company-northwind-it'], companies).company?.id, 'northwind-it');
  assert.deepEqual(pickCompany(['programme-resellers'], companies), { ambiguous: false });
  assert.deepEqual(pickCompany(['company-northwind-it', 'company-globex'], companies), { ambiguous: true });
  assert.equal(pickCompany(['company-northwind-it', 'company-initech'], companies, ['programme-isvs']).company?.id, 'initech', 'reached through its programme');
  assert.equal(pickCompany(['company-northwind-it', 'company-globex'], companies, ['company-globex']).company?.id, 'globex');
  assert.deepEqual(pickCompany(['company-northwind-it', 'company-globex'], companies, ['programme-resellers']), { ambiguous: true }, 'both reached: no guess');
  assert.equal(pickProgramme(['programme-resellers', 'programme-isvs'], companies, ['company-initech']), undefined, 'not in that company');
  assert.equal(pickProgramme(['programme-resellers', 'programme-isvs', 'company-initech'], companies, ['company-initech']), 'isvs');
  assert.equal(pickProgramme(['programme-resellers'], companies), 'resellers');
  assert.equal(pickProgramme(['programme-resellers', 'programme-isvs'], companies), undefined);
});

test('a field\'s value: the logo follows the mode, falling back to the other surface\'s', () => {
  assert.equal(themeOf({ '': 'dark' }), 'dark');
  assert.equal(themeOf({ mode: 'Light' }), 'light');
  assert.equal(themeOf(null), 'light');
  assert.equal(fieldValue('logo', ctx, 'light'), 'inst/light');
  assert.equal(fieldValue('logo', ctx, 'dark'), 'inst/dark');
  assert.equal(fieldValue('logo', { ...ctx, profile: { logoLight: 'inst/light' } }, 'dark'), 'inst/light');
  assert.equal(fieldValue('contact', ctx, 'light'), 'Rita Ortiz, rita@n.test, +49 30 1');
  assert.equal(fieldValue('name', ctx, 'light'), 'Northwind IT');
  assert.equal(fieldValue('taxNote', ctx, 'light'), undefined);
});

test('which bound inputs lock: outside a template\'s editable list, every one a rules tool binds, and where the overlay locks', () => {
  const base = { ctx, ambiguous: false, theme: 'light' as const, overlayLocks: (id: string) => id === 'title' };
  const tpl = planBindings({ ...base, templateBindings: { logo: 'logo', line: 'contact', price: 'currency' }, templateEditable: ['price'] });
  assert.deepEqual(tpl.values, { logo: 'inst/light', line: 'Rita Ortiz, rita@n.test, +49 30 1', price: 'EUR' });
  assert.deepEqual(tpl.locked, ['logo', 'line'], 'an editable bound input is pre-filled and free');
  assert.deepEqual(planBindings({ ...base, templateBindings: { logo: 'logo' } }).locked, [], 'no rules: nothing locks');
  assert.deepEqual(planBindings({ ...base, templateBindings: { logo: 'logo' }, rulesTool: true }).locked, ['logo']);
  const overlay = planBindings({ ...base, overlayBindings: { title: 'name', footer: 'website' } });
  assert.deepEqual(overlay.locked, ['title']);
  assert.deepEqual(overlay.values, { title: 'Northwind IT' }, 'a field the company lacks gives nothing');
  const two = planBindings({ ...base, ctx: null, ambiguous: true, templateBindings: { logo: 'logo' } });
  assert.deepEqual([two.ambiguous, two.values, two.locked], [true, {}, []]);
  assert.equal(planBindings({ ...base, ctx: null, ambiguous: true }).ambiguous, false, 'nothing bound, nothing to open');
});

test('group defaults stack least specific first, and the old flat shape is kept but applies to nothing', () => {
  const overlay = normalizeOverlay('card', { defaults: [
    { groups: ['company-northwind-it'], values: { bg: '#333333' } },
    { groups: ['*'], values: { bg: '#111111', title: 'Everyone' } },
    { groups: ['programme-resellers'], values: { bg: '#222222', price: 'Ask' } },
    { groups: ['marketing'], values: { title: 'Staff' } },
  ], bindings: { title: 'name' } })!;
  assert.deepEqual(defaultsFor(overlay, ['programme-resellers', 'company-northwind-it']), { bg: '#333333', title: 'Everyone', price: 'Ask' });
  assert.deepEqual(defaultsFor(overlay, ['programme-resellers', 'company-globex']), { bg: '#222222', title: 'Everyone', price: 'Ask' });
  assert.deepEqual(defaultsFor(overlay, ['marketing']), { bg: '#111111', title: 'Staff' });
  const legacy = normalizeOverlay('card', { defaults: { bg: '#000000' } })!;
  assert.deepEqual(legacy.defaults, { bg: '#000000' }, 'stored as it was');
  assert.deepEqual(defaultsFor(legacy, ['anyone']), {}, 'and not applied: an upgrade changes nothing partners get');
  assert.equal(legacyDefaults(legacy), true);
  assert.equal(legacyDefaults(overlay), false);
  assert.deepEqual(overlay.bindings, { title: 'name' });
  assert.equal(normalizeOverlay('card', { bindings: { title: 'nickname' } }), null);
  assert.equal(normalizeOverlay('card', { defaults: [{ groups: [], values: {} }] }), null);
});

// ── over HTTP ──────────────────────────────────────────────────────────────

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const blobs = createMemoryBlobStore();
let templateId = '';
const light = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><path d="M0 0H100V40H0Z" fill="#0b3d91"/><title>NW-LIGHT</title></svg>';
const dark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><path d="M0 0H100V40H0Z" fill="#f5f5f5"/><title>NW-DARK</title></svg>';

const CARD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
  '<rect width="400" height="200" fill="{{bg}}"/><image href="{{asset logo}}" width="100" height="40"/>' +
  '<text x="20" y="80">{{title}}</text><text x="20" y="120">{{contact}}</text><text x="20" y="160">{{price}}</text></svg>';
const manifest = {
  id: 'data-sheet', name: 'Data sheet', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
  render: { width: 400, height: 200, formats: ['svg'] },
  inputs: [
    { id: 'title', label: 'Product', type: 'text', default: 'Product' },
    { id: 'price', label: 'Your price', type: 'text', default: '' },
    { id: 'contact', label: 'Details line', type: 'text', default: 'Tool default line' },
    { id: 'logo', label: 'Logo', type: 'asset' },
    { id: 'bg', label: 'Background', type: 'color', default: '#ffffff' },
  ],
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-company-values-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'data-sheet'), { recursive: true });
  await writeFile(join(pack, 'tools', 'data-sheet', 'tool.json'), JSON.stringify(manifest));
  await writeFile(join(pack, 'tools', 'data-sheet', 'template.html'), CARD);
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'data-sheet' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'bruno@brand.test', groups: ['admin'] },
      { email: 'rita@northwind.test', groups: [] },
      { email: 'pat@both.test', groups: [] },
      { email: 'gus@globex.test', groups: [] },
      { email: 'mia@brand.test', groups: ['marketing'] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs, secrets: { session: 'scv', link: 'lcv' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const bruno = await login('bruno@brand.test');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA', tools: ['data-sheet'] })).status, 201);
  for (const [id, name] of [['northwind-it', 'Northwind IT'], ['globex', 'Globex']]) {
    assert.equal((await call(bruno, 'PUT', `/api/v1/programmes/resellers-emea/companies/${id}`, { name })).status, 201);
  }
  await store.putGrant({ principal: 'group:programme-resellers-emea', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putGrant({ principal: 'group:marketing', action: 'export.server', resource: '*', effect: 'allow' });
  for (const email of ['rita@northwind.test', 'pat@both.test', 'gus@globex.test']) await login(email);
  assert.equal((await call(bruno, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [
    { email: 'rita@northwind.test', company: 'northwind-it' }, { email: 'pat@both.test', company: 'northwind-it' }, { email: 'gus@globex.test', company: 'globex' },
  ], apply: true })).status, 200);
  // Pat is in Globex too, through a second line: two companies.
  const pat = (await store.listUsers()).find((u) => u.email === 'pat@both.test')!;
  await store.setLocalGroups(pat.id, [...pat.localGroups, 'company-globex']);

  const P = '/api/v1/programmes/resellers-emea/companies/northwind-it/profile';
  assert.equal((await call(bruno, 'PUT', P, { contact: { name: 'Rita Ortiz', email: 'rita@northwind.test', phone: '+49 30 1234' }, currency: 'EUR' })).status, 200);
  for (const [surface, svg] of [['light', light], ['dark', dark]]) {
    const res = await fetch(`${base}${P}/logo?surface=${surface}`, { method: 'POST', headers: { cookie: bruno, 'content-type': 'image/svg+xml' }, body: svg });
    assert.equal(res.status, 200, await res.text());
  }

  const submitted = await fetch(`${base}/api/v1/catalog/submit?type=template&toolId=data-sheet&groups=programme-resellers-emea`, {
    method: 'POST', headers: { cookie: bruno, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'data-sheet', name: 'Partner data sheet', values: { title: 'SLES 16', contact: 'Ask your reseller', price: '' } }),
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
const render = (cookie: string, inputs: Record<string, unknown>) => call(cookie, 'POST', '/api/v1/render', { toolId: 'data-sheet', format: 'svg', inputs });
const b64 = (s: string) => Buffer.from(s).toString('base64');
const T = () => `/api/v1/programmes/resellers-emea/templates/${templateId.slice('inst/'.length)}`;

test('the brand team binds a template\'s inputs to company fields, and unknown inputs or fields are refused', async () => {
  const bruno = await login('bruno@brand.test');
  assert.equal((await call(bruno, 'PUT', T(), { bindings: { nope: 'logo' } })).status, 400);
  assert.equal((await call(bruno, 'PUT', T(), { bindings: { logo: 'colour' } })).status, 400);
  const set = await call(bruno, 'PUT', T(), { editable: ['price'], bindings: { logo: 'logo', contact: 'contact' } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body.bindings, { logo: 'logo', contact: 'contact' });
  const listed = await call(bruno, 'GET', '/api/v1/programmes/resellers-emea/templates');
  assert.deepEqual(listed.body.templates.find((t: { id: string }) => t.id === templateId).bindings, { logo: 'logo', contact: 'contact' });
  assert.ok(listed.body.companyFields.some((f: { id: string; label: string }) => f.id === 'logo' && f.label === 'Logo (by mode)'));
  const audit = (await store.listAudit()).filter((e) => e.action === 'programme.template.update').at(-1) as { payload?: Record<string, any> };
  assert.deepEqual(audit.payload?.after.bindings, { logo: 'logo', contact: 'contact' });
});

test('Rita\'s render starts from her company\'s logo and contact, fixed, with the dark logo in dark mode', async () => {
  const rita = await login('rita@northwind.test');
  const out = await render(rita, { template: templateId, price: '€ 99' });
  assert.equal(out.status, 200, out.text);
  assert.match(out.text, /Rita Ortiz, rita@northwind\.test, \+49 30 1234/);
  assert.match(out.text, /€ 99/);
  assert.ok(out.text.includes(b64(light).slice(0, 40)), 'the light logo for light mode');
  const night = await render(rita, { template: templateId, price: '€ 99', _themes: '{"":"dark"}' });
  assert.equal(night.status, 200, night.text);
  assert.ok(night.text.includes(b64(dark).slice(0, 40)), 'the dark logo for dark mode');
  const refused = await render(rita, { template: templateId, price: '€ 99', contact: 'Call Globex' });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, 'INPUT_LOCKED');
  assert.equal(refused.body.error.input, 'contact');
  assert.equal(refused.body.error.by, 'Northwind IT details', 'an agent reads why');
  const entry = ((await call(rita, 'GET', '/catalog/assets/index.json')).body.assets as Array<{ id: string; meta?: Record<string, unknown> }>).find((a) => a.id === templateId);
  assert.deepEqual(entry?.meta?.bindings, { logo: 'logo', contact: 'contact' });
});

test('someone in two companies gets no company values, and the bound inputs open with the tool\'s default', async () => {
  const pat = await login('pat@both.test');
  const open = await render(pat, { template: templateId, price: '1' });
  assert.equal(open.status, 200, open.text);
  assert.match(open.text, /Tool default line/);
  assert.doesNotMatch(open.text, /Rita Ortiz/);
  assert.equal((await render(pat, { template: templateId, contact: 'Pat at both', price: '1' })).status, 200, 'open, not locked');
  const config = (await call(pat, 'GET', '/api/v1/org-config')).body;
  assert.equal(config.partner?.company, undefined, 'no company is named');
  assert.equal(config.partner?.programme?.id, 'resellers-emea');
});

test('a company with nothing set keeps the template\'s value, fixed as before', async () => {
  const gus = await login('gus@globex.test');
  const out = await render(gus, { template: templateId, price: '2' });
  assert.equal(out.status, 200, out.text);
  assert.match(out.text, /Ask your reseller/);
  assert.equal((await render(gus, { template: templateId, contact: 'x', price: '2' })).status, 422);
});

test('org-config carries the partner block for programme members, and moves when the profile does', async () => {
  const rita = await login('rita@northwind.test');
  const config = (await call(rita, 'GET', '/api/v1/org-config')).body;
  assert.equal(config.partner.company.id, 'northwind-it');
  assert.equal(config.partner.company.name, 'Northwind IT');
  assert.ok(config.partner.company.revision >= 3);
  assert.match(config.partner.company.logos.light, /^inst\//);
  assert.match(config.partner.company.logos.dark, /^inst\//);
  assert.deepEqual(config.partner.company.contact, { name: 'Rita Ortiz', email: 'rita@northwind.test', phone: '+49 30 1234' });
  assert.equal(config.partner.company.currency, 'EUR');
  assert.deepEqual(config.partner.programme, { id: 'resellers-emea', name: 'Resellers, EMEA' });
  const bruno = await login('bruno@brand.test');
  assert.equal((await call(bruno, 'GET', '/api/v1/org-config')).body.partner, undefined, 'internal people get none');
  await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it/profile', { taxNote: 'Prices exclude VAT' });
  const after = (await call(rita, 'GET', '/api/v1/org-config')).body;
  assert.equal(after.partner.company.taxNote, 'Prices exclude VAT');
  assert.notEqual(after.policyVersion, config.policyVersion, 'a polling app sees the change');
});

test('an overlay binding fills a tool opened directly, locks it where the rule locks, and group defaults apply', async () => {
  const bruno = await login('bruno@brand.test');
  const put = await call(bruno, 'PUT', '/api/v1/policy/overlays/data-sheet', {
    inputAccess: { title: [{ groups: ['programme-resellers-emea'], level: 'locked' }] },
    bindings: { title: 'name', contact: 'contact' },
    defaults: [
      { groups: ['*'], values: { bg: '#111111' } },
      { groups: ['programme-resellers-emea'], values: { bg: '#222222' } },
      { groups: ['company-northwind-it'], values: { bg: '#333333' } },
    ],
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal((await call(bruno, 'PUT', '/api/v1/policy/overlays/data-sheet', { bindings: { nope: 'name' } })).status, 400);
  const rita = await login('rita@northwind.test');
  const out = await render(rita, { price: '3' });
  assert.equal(out.status, 200, out.text);
  assert.match(out.text, /Northwind IT/);
  assert.match(out.text, /Rita Ortiz/, 'a bound input the rule leaves open is pre-filled');
  assert.match(out.text, /#333333/, 'the company\'s default is the most specific');
  assert.equal((await render(rita, { title: 'Other' })).status, 422, 'the locked, bound title');
  assert.match((await render(rita, { contact: 'Mine' })).text, /Mine/, 'the open one is free');
  const gus = await render(await login('gus@globex.test'), { price: '3' });
  assert.match(gus.text, /Globex/);
  assert.match(gus.text, /#222222/);
  const mia = await render(await login('mia@brand.test'), { price: '3' });
  assert.match(mia.text, /#111111/);

  const tool = (await call(rita, 'GET', '/api/v1/org-config')).body.tools['data-sheet'];
  assert.equal(tool.defaults.title, 'Northwind IT');
  assert.equal(tool.defaults.bg, '#333333');
  assert.deepEqual(tool.bindings, { title: 'name', contact: 'contact' });
  assert.deepEqual(tool.inputs.find((i: { id: string }) => i.id === 'title').access, { level: 'locked', value: 'Northwind IT' }, 'no rule name or reason on the app\'s wire');

  const schema = (await call(rita, 'GET', '/api/v1/schema/data-sheet')).body;
  const props = (schema.schema ?? schema.input ?? schema).properties ?? schema.contract?.schema?.properties;
  assert.ok(props, JSON.stringify(schema).slice(0, 400));
  assert.equal(props.title.const, 'Northwind IT', 'an agent reads the locked company value');
  assert.equal(props.contact.default, 'Rita Ortiz, rita@northwind.test, +49 30 1234', 'and the starting one');
  await call(bruno, 'PUT', '/api/v1/policy/overlays/data-sheet', {});
});

test('Preview says where each value comes from, for the admin only', async () => {
  const bruno = await login('bruno@brand.test');
  const preview = (await call(bruno, 'GET', '/api/v1/org-config/preview?groups=programme-resellers-emea,company-northwind-it')).body.preview;
  const row = preview.templates.find((t: { id: string }) => t.id === templateId);
  assert.ok(row.why.some((line: string) => line === 'Details line: set from Northwind IT’s details (contact), and fixed.'), JSON.stringify(row.why));
  assert.ok(row.why.some((line: string) => line.startsWith('Logo: set from Northwind IT’s details')));
  assert.deepEqual(row.canChange, ['Your price']);
  const both = (await call(bruno, 'GET', '/api/v1/org-config/preview?groups=programme-resellers-emea,company-northwind-it,company-globex')).body.preview;
  assert.ok(both.templates.find((t: { id: string }) => t.id === templateId).why.some((line: string) => /more than one company/.test(line)));
  const programmeOnly = (await call(bruno, 'GET', '/api/v1/org-config/preview?groups=programme-resellers-emea')).body.preview;
  assert.ok(programmeOnly.templates.find((t: { id: string }) => t.id === templateId).why.some((line: string) => line === 'Details line takes contact from each company’s details.'));
  const rita = await login('rita@northwind.test');
  const config = (await call(rita, 'GET', '/api/v1/org-config')).body;
  assert.ok(!JSON.stringify(config).includes('set from'), 'no why line reaches the app');
});

test('defaults saved in the old flat shape leave a render byte for byte as it was; the new shape seeds it', async () => {
  const bruno = await login('bruno@brand.test');
  const mia = await login('mia@brand.test');
  await call(bruno, 'PUT', '/api/v1/policy/overlays/data-sheet', {});
  const before = await render(mia, { price: '4' });
  assert.equal(before.status, 200, before.text);
  // A legacy overlay, as an older release stored it: written straight to the store.
  const current = (await store.listOverlays()).get('data-sheet')!;
  await store.putOverlay({ ...current, version: current.version + 1, defaults: { bg: '#abcdef', title: 'Legacy title' } });
  const legacy = await render(mia, { price: '4' });
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(legacy.text, before.text, 'byte for byte as before');
  assert.equal((await call(mia, 'GET', '/api/v1/org-config')).body.tools['data-sheet']?.defaults, undefined);
  const saved = await call(bruno, 'PUT', '/api/v1/policy/overlays/data-sheet', { defaults: [{ groups: ['*'], values: { bg: '#abcdef', title: 'New title' } }] });
  assert.equal(saved.status, 200);
  const seeded = await render(mia, { price: '4' });
  assert.match(seeded.text, /#abcdef/);
  assert.match(seeded.text, /New title/);
  assert.deepEqual((await call(mia, 'GET', '/api/v1/org-config')).body.tools['data-sheet'].defaults, { bg: '#abcdef', title: 'New title' });
  await call(bruno, 'PUT', '/api/v1/policy/overlays/data-sheet', {});
});
