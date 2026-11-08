// SPDX-License-Identifier: MPL-2.0
/**
 * The Lolly record in a server render's Content Credential (plans/82 M3 and M8,
 * section 6, approved 2026-11-07). A signed server render now writes the
 * design system, its theme choices and the partner, as flat scalar keys in the
 * credential's `environment`, where Verify reads them:
 *
 *   partnerCompany, partnerCompanyLabel, partnerProfileRevision,
 *   partnerProgramme, partnerProgrammeLabel, partnerKit, partnerKitRevision
 *
 * and nothing else about the partner: never the person, a token, an agent, the
 * contact's email or phone, the address or the currency.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { IncomingMessage, type ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { ResponseCapture } from '../server/src/agents/project-requests.ts';
import { recordEnvironment, recordedThemes, partnerLine } from '../server/src/render/record.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';

const ENGINE: string = '@lolly/engine';
const engine = await import(ENGINE) as {
  generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
  issueLeafCert: (o: object) => Promise<Uint8Array>;
  derToPem: (der: Uint8Array, label: string) => string;
  verifyC2pa: (b: Uint8Array, f: string) => Promise<{ found: boolean; state: string; environment?: Record<string, unknown> | null }>;
  designRecordEnvironment(meta: unknown): Record<string, string>;
  readTokenAxes(doc: unknown): never;
  modeAxis(axes: unknown[]): unknown;
  resolveTokenSelection(doc: unknown, opts?: unknown): never;
};

const TOKENS = {
  $themes: [
    { name: 'light', selectedTokenSets: { base: 'enabled', light: 'enabled' }, $extensions: { 'com.suse.lolly': { axis: { kind: 'mode' } } } },
    { name: 'dark', selectedTokenSets: { base: 'enabled', dark: 'enabled' }, $extensions: { 'com.suse.lolly': { axis: { kind: 'mode' } } } },
    { id: 'spearmint', name: 'Spearmint', group: 'colourway', selectedTokenSets: { 'colourway/spearmint': 'enabled' }, $extensions: { 'com.suse.lolly': { axis: { kind: 'colourway', canonical: true } } } },
    { id: 'morning', name: 'Morning', group: 'colourway', selectedTokenSets: { 'colourway/morning': 'enabled' }, $extensions: { 'com.suse.lolly': { axis: { kind: 'colourway' } } } },
  ],
  base: { color: { brand: { sugar: { $type: 'color', $value: '#fdfcf8' } } } },
  light: { color: { semantic: { surface: { $type: 'color', $value: '{color.brand.sugar}' } } } },
  dark: { color: { semantic: { surface: { $type: 'color', $value: '#0a101f' } } } },
  'colourway/spearmint': { color: { colourway: { lead: { $type: 'color', $value: '#30ba78' } } } },
  'colourway/morning': { color: { colourway: { lead: { $type: 'color', $value: '#ffcc00' } } } },
};

test('the record\'s keys: the design system as the app writes it, and exactly the five partner keys', () => {
  const env = recordEnvironment({
    designSystem: { id: 'lolly-demo', label: 'Lolly Demo' },
    themes: [{ group: 'colourway', kind: 'colourway', id: 'spearmint', name: 'Spearmint' }],
    partner: { company: { id: 'northwind-it', name: 'Northwind IT', revision: 3 }, programme: { id: 'resellers-emea', name: 'Resellers, EMEA' } },
    designRecordEnvironment: (meta) => engine.designRecordEnvironment(meta),
  });
  assert.deepEqual(Object.keys(env).sort(), ['designSystem', 'designSystemLabel', 'partnerCompany', 'partnerCompanyLabel', 'partnerProfileRevision', 'partnerProgramme', 'partnerProgrammeLabel', 'themes'].sort());
  assert.equal(env.partnerCompany, 'northwind-it');
  assert.equal(env.partnerCompanyLabel, 'Northwind IT');
  assert.equal(env.partnerProfileRevision, '3');
  assert.equal(env.partnerProgramme, 'resellers-emea');
  assert.equal(env.partnerProgrammeLabel, 'Resellers, EMEA');
  assert.deepEqual(JSON.parse(env.themes!), [{ group: 'colourway', id: 'spearmint', kind: 'colourway', name: 'Spearmint' }]);
  assert.deepEqual(recordEnvironment({ designRecordEnvironment: (meta) => engine.designRecordEnvironment(meta) }), {}, 'nothing to record, nothing written');
  assert.equal(partnerLine({ company: { id: 'n', name: 'Northwind IT', revision: 1 } }), 'Partner: Northwind IT');
  assert.equal(partnerLine(null), null);
});

test('a company kit adds exactly two scalar keys and the kit revision to the partner line', () => {
  const partner = {
    company: { id: 'northwind-it', name: 'Northwind IT', revision: 3 },
    programme: { id: 'resellers-emea', name: 'Resellers, EMEA' },
    kit: { id: 'inst/northwind-kit', revision: 2, colours: ['#0b3d91'], rules: { minSize: 40 }, bytes: 'private kit bytes' },
    person: 'Rita', token: 'private token', agent: 'private agent',
  };
  const env = recordEnvironment({ partner, designRecordEnvironment: (meta) => engine.designRecordEnvironment(meta) });
  assert.deepEqual(env, {
    partnerCompany: 'northwind-it', partnerCompanyLabel: 'Northwind IT', partnerProfileRevision: '3',
    partnerProgramme: 'resellers-emea', partnerProgrammeLabel: 'Resellers, EMEA',
    partnerKit: 'inst/northwind-kit', partnerKitRevision: '2',
  });
  assert.equal(partnerLine(partner), 'Partner: Northwind IT, kit revision 2');
});

test('a server render records no kit without the company it belongs to', () => {
  const kit = { id: 'inst/northwind-kit', revision: 2 };
  const programme = { id: 'resellers-emea', name: 'Resellers, EMEA' };
  const record = (partner: Parameters<typeof recordEnvironment>[0]['partner']) => recordEnvironment({ partner, designRecordEnvironment: (meta) => engine.designRecordEnvironment(meta) });
  assert.deepEqual(record({ programme, kit }), { partnerProgramme: 'resellers-emea', partnerProgrammeLabel: 'Resellers, EMEA' });
  assert.equal(partnerLine({ programme, kit }), null);
  // A hostile kit id or revision is never written, whatever else holds.
  const company = { id: 'northwind-it', name: 'Northwind IT', revision: 3 };
  for (const bad of [{ id: 'https://example.test/kit', revision: 2 }, { id: 'inst/k', revision: 0 }, { id: 'inst/k', revision: 1.5 }]) {
    const env = record({ company, programme, kit: bad });
    assert.equal(env.partnerKit, undefined, JSON.stringify(bad));
    assert.equal(env.partnerKitRevision, undefined);
  }
});

test('the theme choices: the colourway that drew it, canonical when nobody chose, and never the mode', () => {
  assert.deepEqual(recordedThemes(engine, TOKENS, null), [{ group: 'colourway', kind: 'colourway', id: 'spearmint', name: 'Spearmint' }]);
  assert.deepEqual(recordedThemes(engine, TOKENS, { colourway: 'morning', '': 'dark' }).map((t) => t.id), ['morning']);
  assert.deepEqual(recordedThemes(engine, null, null), []);
});

// Run the HTTP handlers in process, without opening a network socket.

let app: ReturnType<typeof buildApp>;
let runner: RenderRunner | undefined;
const store = createMemoryStore();

async function mintIdentity(): Promise<{ certPem: string; keyPem: string }> {
  const root = await engine.generateCaRoot({ commonName: 'Test Root', organization: 'Test', days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await engine.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'lolly@test.invalid', organization: 'Test', days: 365 });
  return { certPem: engine.derToPem(leaf, 'CERTIFICATE') + engine.derToPem(root.certDer, 'CERTIFICATE'), keyPem: engine.derToPem(keyDer, 'PRIVATE KEY') };
}

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-partner-record-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'demo', 'tokens'), { recursive: true });
  await mkdir(join(pack, 'tools', 'data-sheet'), { recursive: true });
  await writeFile(join(pack, 'tools', 'data-sheet', 'tool.json'), JSON.stringify({ id: 'data-sheet', name: 'Data sheet', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 200, height: 100, formats: ['svg', 'png'] }, inputs: [{ id: 'price', label: 'Your price', type: 'text', default: '' }] }));
  await writeFile(join(pack, 'tools', 'data-sheet', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200" height="100"><text x="10" y="50">{{price}}</text></svg>');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'data-sheet' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'demo', 'tokens', 'brand.json'), JSON.stringify(TOKENS));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [
    { id: 'demo/tokens/brand', name: 'Demo', type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/demo/tokens/brand.json' }] }] }));
  const { certPem, keyPem } = await mintIdentity();
  const certFile = join(pack, 'c2pa.pem');
  await writeFile(certFile, certPem);
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    render: { c2pa: { certFile, claimGenerator: 'Partner Hub' } },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'rita@northwind.test', groups: [] },
      { email: 'mia@test', groups: ['marketing'] },
      { email: 'pat@partner.test', groups: [] },
    ] },
  }));
  app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'spr', link: 'lpr', c2paSigningKey: keyPem },
    onRenderRunner: (r: RenderRunner) => { runner = r; r.kick = () => {}; } });
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA', tools: ['data-sheet'] })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  await store.putGrant({ principal: 'group:programme-resellers-emea', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putGrant({ principal: 'group:marketing', action: 'export.server', resource: '*', effect: 'allow' });
  await login('rita@northwind.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
  await login('pat@partner.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'pat@partner.test' }], apply: true })).status, 200);
  for (const taxNote of ['Prices exclude VAT', 'Prices exclude VAT and shipping', 'Prices exclude VAT, shipping and set-up']) {
    assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it/profile', { taxNote, contact: { email: 'rita@northwind.test', phone: '+49 30 1' }, address: 'Unter den Linden 1', currency: 'EUR' })).status, 200);
  }
});

after(async () => { await runner?.stop(); });

async function request(path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const req = new IncomingMessage(new Socket());
  const bytes = Buffer.from(options.body ?? '');
  req.method = options.method ?? 'GET'; req.url = path;
  req.headers = { host: 'localhost', 'content-length': String(bytes.length), ...options.headers };
  req.push(bytes); req.push(null);
  const res = new ResponseCapture();
  const finished = new Promise<void>((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await app(req, res as unknown as ServerResponse);
  await finished;
  const headers = new Headers();
  for (const [key, value] of Object.entries(res.getHeaders())) {
    for (const part of Array.isArray(value) ? value : [value]) headers.append(key, String(part));
  }
  return new Response(new Uint8Array(Buffer.concat(res.chunks)), { status: res.statusCode, headers });
}

async function login(email: string): Promise<string> {
  const res = await request(`/api/auth/dev?email=${encodeURIComponent(email)}`);
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await request(path, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
};

async function signedEnvironment(cookie: string): Promise<Record<string, unknown>> {
  const out = await call(cookie, 'POST', '/api/v1/render', { toolId: 'data-sheet', format: 'png', inputs: { price: '€ 99' } });
  assert.equal(out.status, 200, new TextDecoder().decode(out.bytes).slice(0, 300));
  const report = await engine.verifyC2pa(out.bytes, 'png');
  assert.equal(report.found, true, 'the fixture must sign the render');
  assert.equal(report.state, 'valid');
  return report.environment ?? {};
}

async function waitForRender(headers: Record<string, string>, id: string) {
  await runner!.tick();
  let record: { state?: string; output?: { partner?: string } } = {};
  for (let i = 0; i < 50 && record.state !== 'succeeded'; i++) {
    record = await (await request(`/api/v1/renders/${id}`, { headers })).json() as typeof record;
    if (record.state !== 'succeeded') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(record.state, 'succeeded', JSON.stringify(record));
  return record;
}

test('a partner\'s signed server render records the design system, the colourway and the partner, and nothing more', async (t) => {
  const rita = await login('rita@northwind.test');
  const out = await call(rita, 'POST', '/api/v1/render', { toolId: 'data-sheet', format: 'png', inputs: { price: '€ 99' } });
  assert.equal(out.status, 200, new TextDecoder().decode(out.bytes).slice(0, 300));
  const report = await engine.verifyC2pa(out.bytes, 'png');
  if (!report.found) { t.skip('this deployment signs nothing'); return; }
  assert.equal(report.state, 'valid');
  const env = report.environment ?? {};
  assert.equal(env.partnerCompany, 'northwind-it');
  assert.equal(env.partnerCompanyLabel, 'Northwind IT');
  assert.equal(env.partnerProfileRevision, '3');
  assert.equal(env.partnerProgramme, 'resellers-emea');
  assert.equal(env.partnerProgrammeLabel, 'Resellers, EMEA');
  assert.ok(env.designSystemLabel, 'the design system that drew it');
  assert.match(String(env.themes ?? ''), /Spearmint/);
  const text = JSON.stringify(env);
  for (const never of ['rita@northwind.test', '+49 30 1', 'Unter den Linden', 'EUR', 'Rita']) assert.ok(!text.includes(never), `never recorded: ${never}`);
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('partner')).sort(), ['partnerCompany', 'partnerCompanyLabel', 'partnerProfileRevision', 'partnerProgramme', 'partnerProgrammeLabel']);
});

test('someone outside every programme gets no partner keys', async (t) => {
  const mia = await login('mia@test');
  const out = await call(mia, 'POST', '/api/v1/render', { toolId: 'data-sheet', format: 'png', inputs: { price: '€ 1' } });
  assert.equal(out.status, 200);
  const report = await engine.verifyC2pa(out.bytes, 'png');
  if (!report.found) { t.skip('this deployment signs nothing'); return; }
  assert.equal(Object.keys(report.environment ?? {}).some((k) => k.startsWith('partner')), false);
});

test('a durable render\'s record carries the partner, so an agent reads back what the file says', async () => {
  const rita = await login('rita@northwind.test');
  const res = await request('/api/v1/renders', { method: 'POST', headers: { cookie: rita, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'data-sheet', format: 'svg', inputs: { price: '€ 7' } }) });
  const queued = await res.json() as { id: string };
  assert.ok(res.status === 201 || res.status === 202, JSON.stringify(queued));
  const record = await waitForRender({ cookie: rita }, queued.id);
  assert.equal(record.output?.partner, 'Partner: Northwind IT');
  const user = (await store.listUsers()).find((u) => u.email === 'rita@northwind.test')!;
  assert.deepEqual((await store.getRender(queued.id, `user:${user.id}`))?.output?.partner, {
    company: 'northwind-it', programme: 'resellers-emea', line: 'Partner: Northwind IT',
  });
});

test('server renders attach only the live kit served to their partner company', async (t) => {
  const admin = await login('admin@test');
  const rita = await login('rita@northwind.test');
  const path = '/api/v1/programmes/resellers-emea/companies/northwind-it/kit';
  const kit = { schemaVersion: 1, id: 'northwind-it', label: 'Northwind IT', logos: {},
    colours: [{ role: 'primary', name: 'Private blue', value: '#0b3d91' }],
    rules: { minSize: { px: 40 } }, source: { kind: 'manual' } };
  const save = async (value: unknown) => {
    const res = await call(admin, 'PUT', path, value);
    assert.equal(res.status, 200, new TextDecoder().decode(res.bytes));
    return JSON.parse(new TextDecoder().decode(res.bytes)) as { assetId: string; revision: number };
  };
  const first = await save(kit);
  t.after(async () => { await store.putCompanyKit('northwind-it', null, first.assetId); });
  const env1 = await signedEnvironment(rita);
  assert.equal(env1.partnerKit, first.assetId);
  assert.equal(env1.partnerKitRevision, '1');
  const second = await save({ ...kit, rules: { minSize: { px: 48 } } });
  assert.equal(second.assetId, first.assetId);
  assert.equal(second.revision, 2);
  const env2 = await signedEnvironment(rita);
  assert.deepEqual(env2, { ...env1, partnerKitRevision: '2' });
  assert.deepEqual(Object.keys(env2).sort(), ['designSystem', 'designSystemLabel', 'themes',
    'partnerCompany', 'partnerCompanyLabel', 'partnerProfileRevision', 'partnerProgramme', 'partnerProgrammeLabel', 'partnerKit', 'partnerKitRevision'].sort());

  const rec = (await store.getInstanceAsset(first.assetId))!;
  const withoutKit = async () => {
    assert.equal((await call(rita, 'GET', '/api/v1/me/company/kit')).status, 404);
    const env = await signedEnvironment(rita);
    const expected = Object.fromEntries(Object.entries(env2).filter(([key]) => key !== 'partnerKit' && key !== 'partnerKitRevision'));
    assert.deepEqual(env, expected);
  };
  await t.test('no kit records neither kit key', async (t) => {
    assert.equal(await store.putCompanyKit('northwind-it', null, first.assetId), true);
    t.after(async () => { await store.putCompanyKit('northwind-it', { assetId: first.assetId }, null); });
    await withoutKit();
  });
  await t.test('a revoked kit records neither kit key', async (t) => {
    const life = await store.getLifecycle(rec.id);
    await store.putLifecycle({ ...(life ?? { assetId: rec.id, onExpiry: 'hide' }), revokedAt: new Date().toISOString() });
    t.after(async () => { if (life) await store.putLifecycle(life); else await store.deleteLifecycle(rec.id); });
    await withoutKit();
  });
  await t.test('a kit outside the caller feed records neither kit key', async (t) => {
    await store.putInstanceAsset({ ...rec, groups: ['company-globex'] });
    t.after(async () => { await store.putInstanceAsset(rec); });
    await withoutKit();
  });
  await t.test('a kit owned by another company records neither kit key even when visible', async (t) => {
    await store.putInstanceAsset({ ...rec, entry: { ...rec.entry, meta: { company: 'globex' } } });
    t.after(async () => { await store.putInstanceAsset(rec); });
    const feed = await call(rita, 'GET', '/catalog/assets/index.json');
    assert.equal(feed.status, 200);
    assert.ok((JSON.parse(new TextDecoder().decode(feed.bytes)) as { assets: Array<{ id: string }> }).assets.some((a) => a.id === rec.id));
    await withoutKit();
  });
  await t.test('a programme-only partner records neither kit key', async () => {
    const env = await signedEnvironment(await login('pat@partner.test'));
    assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('partner'))), {
      partnerProgramme: 'resellers-emea', partnerProgrammeLabel: 'Resellers, EMEA',
    });
  });
  await t.test('the durable record and MCP result carry the same kit revision', async () => {
    const minted = await call(admin, 'POST', '/api/v1/programmes/resellers-emea/tokens', { label: 'Private render agent', company: 'northwind-it', scopes: ['render'] });
    assert.equal(minted.status, 201);
    const token = JSON.parse(new TextDecoder().decode(minted.bytes)) as { id: string; token: string };
    const headers = { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' };
    const mcp = async (name: string, args: unknown) => {
      const res = await request('/api/v1/mcp', { method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      assert.equal(res.status, 200);
      const body = await res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
      assert.ok(body.result && !body.result.isError, JSON.stringify(body));
      return JSON.parse(body.result.content[0]!.text) as { id: string; output?: { partner?: string } };
    };
    const args = { toolId: 'data-sheet', format: 'png', inputs: { price: '€ 7' }, idempotencyKey: 'kit-render' };
    const queued = await mcp('render_tool', args);
    const record = await waitForRender(headers, queued.id);
    assert.equal(record.output?.partner, 'Partner: Northwind IT, kit revision 2');
    assert.equal((await mcp('get_render', { renderId: queued.id })).output?.partner, record.output?.partner);
    assert.equal((await mcp('render_tool', args)).output?.partner, record.output?.partner);
    const stored = await store.getRender(queued.id, `service:svc_${token.id}`);
    assert.deepEqual(stored?.output?.partner, {
      company: 'northwind-it', programme: 'resellers-emea', kit: rec.id, kitRevision: 2, line: record.output?.partner,
    });
    const output = await request(`/api/v1/renders/${queued.id}/output/default`, { headers });
    assert.equal(output.status, 200);
    const report = await engine.verifyC2pa(new Uint8Array(await output.arrayBuffer()), 'png');
    assert.equal(report.state, 'valid');
    assert.deepEqual(report.environment, env2);
  });
});
