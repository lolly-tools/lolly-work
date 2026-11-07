// SPDX-License-Identifier: MPL-2.0
/**
 * The Lolly record in a server render's Content Credential (plans/82 M3,
 * section 6, approved 2026-11-07). A signed server render now writes the
 * design system, its theme choices and the partner, as flat scalar keys in the
 * credential's `environment`, where Verify reads them:
 *
 *   partnerCompany, partnerCompanyLabel, partnerProfileRevision,
 *   partnerProgramme, partnerProgrammeLabel
 *
 * and nothing else about the partner: never the person, a token, an agent, the
 * contact's email or phone, the address or the currency.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
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

test('the theme choices: the colourway that drew it, canonical when nobody chose, and never the mode', () => {
  assert.deepEqual(recordedThemes(engine, TOKENS, null), [{ group: 'colourway', kind: 'colourway', id: 'spearmint', name: 'Spearmint' }]);
  assert.deepEqual(recordedThemes(engine, TOKENS, { colourway: 'morning', '': 'dark' }).map((t) => t.id), ['morning']);
  assert.deepEqual(recordedThemes(engine, null, null), []);
});

// ── a signed server render, over HTTP ──────────────────────────────────────

let server: Server;
let base = '';
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
    ] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'spr', link: 'lpr', c2paSigningKey: keyPem },
    onRenderRunner: (r: RenderRunner) => { runner = r; r.kick = () => {}; } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA', tools: ['data-sheet'] })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  await store.putGrant({ principal: 'group:programme-resellers-emea', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putGrant({ principal: 'group:marketing', action: 'export.server', resource: '*', effect: 'allow' });
  await login('rita@northwind.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
  for (const taxNote of ['Prices exclude VAT', 'Prices exclude VAT and shipping', 'Prices exclude VAT, shipping and set-up']) {
    assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it/profile', { taxNote, contact: { email: 'rita@northwind.test', phone: '+49 30 1' }, address: 'Unter den Linden 1', currency: 'EUR' })).status, 200);
  }
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
};

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
  const res = await fetch(`${base}/api/v1/renders`, { method: 'POST', headers: { cookie: rita, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'data-sheet', format: 'svg', inputs: { price: '€ 7' } }) });
  const queued = await res.json() as { id: string };
  assert.ok(res.status === 201 || res.status === 202, JSON.stringify(queued));
  await runner!.tick();
  let record: { state?: string; output?: { partner?: string } } = {};
  for (let i = 0; i < 50 && record.state !== 'succeeded'; i++) {
    record = await (await fetch(`${base}/api/v1/renders/${queued.id}`, { headers: { cookie: rita } })).json() as typeof record;
    if (record.state !== 'succeeded') await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(record.state, 'succeeded', JSON.stringify(record));
  assert.equal(record.output?.partner, 'Partner: Northwind IT');
});
