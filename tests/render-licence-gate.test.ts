// SPDX-License-Identifier: MPL-2.0
/**
 * Server renders and the licence gate (plans/82 M4, W-M4-8).
 *
 * Pinned here: with the gate on, a programme-scoped caller's server render
 * draws only files their own feed holds, and answers 422 ASSET_HELD naming the
 * file otherwise, whether the file comes from the tool's default, the caller's
 * own value or a template; a compile answers the same way (package and the
 * document verbs compile through the same verb); staff renders and report
 * mode are unchanged; and the programme report lists the published templates
 * that seed files one of the programme's audiences will not receive, and why,
 * so the brand team sees them before a partner's render is refused.
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
import { instanceAssetEntry } from '../server/src/catalog/instance-assets.ts';
import { seededAssetIds } from '../server/src/programmes/rights-routes.ts';
import { renderTool, type RenderRequest } from '../server/src/render/pipeline.ts';

const SVG = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`;
const PACK = [
  { id: 'acme/photo/open', name: 'Open photo', type: 'vector', file: 'open.svg', body: SVG('#0a0'), license: 'CC-BY-4.0' },
  { id: 'acme/photo/unrecorded', name: 'Unrecorded photo', type: 'vector', file: 'unrecorded.svg', body: SVG('#a00') },
  { id: 'acme/photo/internal', name: 'Internal photo', type: 'vector', file: 'internal.svg', body: SVG('#00a') },
];

let server: Server;
let base = '';
let gateServer: Server;
let gateBase = '';
let packDir = '';
const PHOTO_CARD = {
  id: 'photo-card', name: 'Photo card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
  render: { width: 10, height: 10, formats: ['svg'] },
  inputs: [{ id: 'photo', label: 'Photo', type: 'asset', default: 'acme/photo/unrecorded' }, { id: 'title', label: 'Title', type: 'text', default: 'x' }],
};
const PHOTO_TEMPLATE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><image href="{{asset photo}}" width="10" height="10"/><text>{{title}}</text></svg>';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-render-licence-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  packDir = pack;
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'photo-card' }] }));
  await mkdir(join(pack, 'tools', 'photo-card'), { recursive: true });
  await writeFile(join(pack, 'tools', 'photo-card', 'tool.json'), JSON.stringify(PHOTO_CARD));
  await writeFile(join(pack, 'tools', 'photo-card', 'template.html'), PHOTO_TEMPLATE);
  for (const a of PACK) await writeFile(join(pack, 'catalog', 'assets', 'acme', a.file), a.body);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: PACK.map(({ file, body: _b, ...a }) => ({ ...a, formats: [{ format: file.split('.').pop(), url: `assets/acme/${file}` }] })),
  }));
  const configFor = (partnerRights?: 'gate') => parseConfig(JSON.stringify({
    instance: { name: 'SUSE', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    ...(partnerRights ? { policy: { catalog: { partnerRights } } } : {}),
    dev: { enabled: true, users: [{ email: 'bruno@test', groups: ['admin'], name: 'Bruno Marsh' }, { email: 'rita@northwind.test', groups: [] }, { email: 'mia@test', groups: ['marketing'] }] },
  }));
  const config = configFor();
  const store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  const values = { values: { photo: { source: 'library', id: 'acme/photo/unrecorded' }, backdrop: 'acme/photo/internal', badge: 'acme/photo/open', title: 'EMEA price list' } };
  const stat = await blobs.put('inst/tpl-price/json', Buffer.from(JSON.stringify(values)), 'application/json');
  await store.putInstanceAsset({
    id: 'inst/tpl-price',
    entry: { ...instanceAssetEntry('inst/tpl-price', { name: 'Partner price sheet', type: 'template' }, [{ format: 'json', size: stat.size, checksum: stat.checksum }]), meta: { toolId: 'price-sheet', version: 1 } },
    blobs: { json: 'inst/tpl-price/json' }, groups: ['programme-resellers-emea'], createdAt: new Date().toISOString(),
  });
  await store.putGrant({ principal: 'group:programme-resellers-emea', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putGrant({ principal: 'group:marketing', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putCollection({ id: 'kit', name: 'Kit', members: ['acme/photo/open', 'acme/photo/unrecorded'], groups: ['programme-resellers-emea'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs, secrets: { session: 'sr', link: 'lr', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const gateApp = buildApp({ config: configFor('gate'), store, blobs, secrets: { session: 'sr', link: 'lr', credential: 'a-32-byte-or-longer-master-secret!' } });
  gateServer = createServer((req, res) => void gateApp(req, res));
  await new Promise<void>((r) => gateServer.listen(0, () => r()));
  const gateAddr = gateServer.address();
  gateBase = `http://127.0.0.1:${typeof gateAddr === 'object' && gateAddr ? gateAddr.port : 0}`;
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA', tools: ['photo-card'] })).status, 201);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  await login('rita@northwind.test');
  assert.equal((await call(bruno, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
});

after(() => { server.close(); gateServer.close(); });

async function login(email: string, at = base): Promise<string> {
  const res = await fetch(`${at}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

test('the asset ids a template\'s values name: bare ids and references, known ids only', () => {
  const known = new Set(['acme/a', 'acme/b', 'ext/dam/c']);
  assert.deepEqual(seededAssetIds({ x: 'acme/a', y: { source: 'library', id: 'acme/b' }, z: ['ext/dam/c', 'not/an/asset'], t: 'hello' }, known).sort(), ['acme/a', 'acme/b', 'ext/dam/c']);
  assert.deepEqual(seededAssetIds(null, known), []);
});

test('the report names a template that seeds files an audience will not receive, and why', async () => {
  const r = (await call(await login('bruno@test'), 'GET', '/api/v1/programmes/resellers-emea/rights-report')).body;
  assert.equal(r.templates.length, 1);
  const [t] = r.templates;
  assert.equal(t.name, 'Partner price sheet');
  assert.deepEqual(t.audiences.map((a: { kind: string; name: string }) => [a.kind, a.name]), [['programme', 'Resellers, EMEA'], ['company', 'Northwind IT']]);
  const files = t.audiences[1].files.map((f: { id: string; why: string }) => [f.id, f.why]).sort();
  assert.deepEqual(files, [['acme/photo/internal', 'not-shared'], ['acme/photo/unrecorded', 'licence']], 'the open photo reaches them and is not listed');
  assert.equal(t.audiences[1].files.find((f: { why: string }) => f.why === 'licence').reason, 'licence not recorded');
});

test('the pipeline: a gated caller\'s render draws only files their feed holds, and says which it would not', async () => {
  const config = parseConfig(JSON.stringify({ instance: { name: 'SUSE', baseUrl: 'http://localhost', pack: packDir }, dev: { enabled: true } }));
  const request: RenderRequest = { toolId: 'photo-card', format: 'svg', query: '', principal: { groups: ['programme-resellers-emea', 'partner'] }, profile: {}, overlays: new Map() };
  const catalogIds = new Set(PACK.map((a) => a.id));
  const assetGate = async () => ({ allows: (id: string) => id !== 'acme/photo/unrecorded' && id !== 'acme/photo/internal', catalogIds });
  await assert.rejects(renderTool({ config, assetGate }, request), (e: { code?: string; status?: number; details?: { assets?: string[] } }) =>
    e.code === 'ASSET_HELD' && e.status === 422 && e.details?.assets?.[0] === 'acme/photo/unrecorded', 'the tool\'s own default names a held file');
  await assert.rejects(renderTool({ config, assetGate }, { ...request, query: 'photo=acme%2Fphoto%2Finternal' }), (e: { code?: string }) => e.code === 'ASSET_HELD', 'so does the caller\'s own value');
  const open = await renderTool({ config, assetGate }, { ...request, query: 'photo=acme%2Fphoto%2Fopen' });
  assert.match(Buffer.from(open.bytes).toString(), /<image[^>]*href="data:image\/svg\+xml;base64,/, 'a file their feed holds is drawn');
  const before = await renderTool({ config }, request);
  const ungated = await renderTool({ config, assetGate: async () => null }, request);
  assert.equal(Buffer.from(ungated.bytes).toString(), Buffer.from(before.bytes).toString(), 'with no gate, the same bytes as before');
});

test('over HTTP: Rita\'s render is refused with the gate on, and nothing changes in report mode or for staff', async () => {
  const gated = await fetch(`${gateBase}/render/photo-card.svg`, { headers: { cookie: await login('rita@northwind.test', gateBase) } });
  assert.equal(gated.status, 422, await gated.clone().text());
  const body = await gated.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'ASSET_HELD');
  assert.match(body.error.message, /acme\/photo\/unrecorded/);
  const reporting = await fetch(`${base}/render/photo-card.svg`, { headers: { cookie: await login('rita@northwind.test') } });
  assert.equal(reporting.status, 200, 'report mode changes nothing a partner receives');
  const staffGate = await (await fetch(`${gateBase}/render/photo-card.svg`, { headers: { cookie: await login('mia@test', gateBase) } })).text();
  const staffReport = await (await fetch(`${base}/render/photo-card.svg`, { headers: { cookie: await login('mia@test') } })).text();
  assert.equal(staffGate, staffReport, 'staff renders are byte-identical with the gate on');
});


test('a compile is gated the same way: a partner\'s document never carries a file the gate holds back', async () => {
  const compile = async (email: string, at: string, inputs: Record<string, unknown>) => {
    const res = await fetch(`${at}/api/v1/compile`, { method: 'POST', headers: { cookie: await login(email, at), 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'photo-card', inputs }) });
    return { status: res.status, text: await res.text() };
  };
  const held = await compile('rita@northwind.test', gateBase, {});
  assert.equal(held.status, 422, held.text);
  const body = JSON.parse(held.text) as { error: { code: string; message: string; assets?: string[] } };
  assert.equal(body.error.code, 'ASSET_HELD');
  assert.match(body.error.message, /^This document uses a file that is not available to you: acme\/photo\/unrecorded\.$/);
  const open = await compile('rita@northwind.test', gateBase, { photo: 'acme/photo/open' });
  assert.equal(open.status, 200, open.text);
  assert.match(open.text, /data:image\/svg\+xml;base64,/, 'a file their feed holds is in the document');
  const reporting = await compile('rita@northwind.test', base, {});
  assert.equal(reporting.status, 200, 'report mode changes nothing a partner receives');
  const staffGate = await compile('mia@test', gateBase, {});
  const staffReport = await compile('mia@test', base, {});
  assert.equal(staffGate.status, 200, staffGate.text);
  assert.equal(staffGate.text, staffReport.text, 'staff compiles are byte-identical with the gate on');
});
