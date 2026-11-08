// SPDX-License-Identifier: MPL-2.0
/**
 * Server renders and the licence gate (plans/82 M4, W-M4-8).
 *
 * Pinned here: with the gate on, a programme-scoped caller's server render
 * draws only files their own feed holds, and answers 422 ASSET_HELD naming the
 * file otherwise, whether the file comes from the tool's default, the caller's
 * own value or a template; a compile answers the same way (package and the
 * document verbs compile through the same verb), a cms:// file included by
 * its catalog id; staff renders and report
 * mode are unchanged; and the programme report lists the published templates
 * that seed files one of the programme's audiences will not receive, and why,
 * so the brand team sees them before a partner's render is refused.
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
import { instanceAssetEntry } from '../server/src/catalog/instance-assets.ts';
import { seededAssetIds } from '../server/src/programmes/rights-routes.ts';
import { renderTool, type RenderRequest } from '../server/src/render/pipeline.ts';
import { compileVerb } from '../server/src/automation/verbs.ts';
import { AssetHeldError, withRenderHost } from '../server/src/render/host.ts';
import { ASSET_SCAN_MAX_NODES, AssetScanBoundExceeded, referencedAssetIds } from '../server/src/catalog/rights.ts';

const ENGINE_SPEC: string = '@lolly/engine';
const readZip = async (bytes: Uint8Array): Promise<Array<{ name: string; bytes: Uint8Array }>> =>
  ((await import(ENGINE_SPEC)) as { readZip: (b: Uint8Array) => Array<{ name: string; bytes: Uint8Array }> }).readZip(bytes);

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
const BAKED_CARD = {
  ...PHOTO_CARD, id: 'baked-card', name: 'Baked card',
  inputs: [{ id: 'photo', label: 'Photo', type: 'asset', default: { source: 'library', id: 'acme/photo/unrecorded', type: 'vector', format: 'svg',
    url: `data:image/svg+xml;base64,${Buffer.from(SVG('#a00')).toString('base64')}`, meta: { baked: true } } }, { id: 'title', label: 'Title', type: 'text', default: 'x' }],
};
// A saved reference to a file the catalog no longer lists, its bytes still inline.
const GHOST_CARD = {
  ...PHOTO_CARD, id: 'ghost-card', name: 'Ghost card',
  inputs: [{ id: 'photo', label: 'Photo', type: 'asset', default: { source: 'library', id: 'acme/photo/gone', type: 'vector', format: 'svg',
    url: `data:image/svg+xml;base64,${Buffer.from(SVG('#0f0')).toString('base64')}`, meta: { baked: true } } }, { id: 'title', label: 'Title', type: 'text', default: 'x' }],
};
// A tool whose default is a DAM ref no resolver can answer.
const CMS_CARD = { ...PHOTO_CARD, id: 'cms-card', name: 'CMS card', inputs: [{ id: 'photo', label: 'Photo', type: 'asset', default: 'cms://dam/secret-default' }, { id: 'title', label: 'Title', type: 'text', default: 'x' }] };
const PHOTO_TEMPLATE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><image href="{{asset photo}}" width="10" height="10"/><text>{{title}}</text></svg>';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-render-licence-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  packDir = pack;
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'photo-card' }, { id: 'baked-card' }, { id: 'ghost-card' }, { id: 'cms-card' }] }));
  for (const tool of [GHOST_CARD, CMS_CARD]) {
    await mkdir(join(pack, 'tools', tool.id), { recursive: true });
    await writeFile(join(pack, 'tools', tool.id, 'tool.json'), JSON.stringify(tool));
    await writeFile(join(pack, 'tools', tool.id, 'template.html'), PHOTO_TEMPLATE);
  }
  await mkdir(join(pack, 'tools', 'photo-card'), { recursive: true });
  await writeFile(join(pack, 'tools', 'photo-card', 'tool.json'), JSON.stringify(PHOTO_CARD));
  await writeFile(join(pack, 'tools', 'photo-card', 'template.html'), PHOTO_TEMPLATE);
  // A tool whose default is a saved catalog reference carrying its bytes inline.
  await mkdir(join(pack, 'tools', 'baked-card'), { recursive: true });
  await writeFile(join(pack, 'tools', 'baked-card', 'tool.json'), JSON.stringify(BAKED_CARD));
  await writeFile(join(pack, 'tools', 'baked-card', 'template.html'), PHOTO_TEMPLATE);
  for (const a of PACK) await writeFile(join(pack, 'catalog', 'assets', 'acme', a.file), a.body);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: PACK.map(({ file, body, ...a }) => ({ ...a, formats: [{ format: file.split('.').pop(), url: `assets/acme/${file}`, checksum: `sha256-${createHash('sha256').update(body).digest('base64')}` }] })),
  }));
  const configFor = (partnerRights?: 'gate') => parseConfig(JSON.stringify({
    instance: { name: 'SUSE', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    ...(partnerRights ? { policy: { catalog: { partnerRights } } } : {}),
    dev: { enabled: true, users: [{ email: 'bruno@test', groups: ['admin'], name: 'Bruno Marsh' }, { email: 'rita@northwind.test', groups: [] }, { email: 'mia@test', groups: ['marketing'] }, { email: 'owner@test', groups: ['owner'] }] },
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
  // A template that seeds a DAM file its partner cannot see.
  const cms = await blobs.put('inst/tpl-cms/json', Buffer.from(JSON.stringify({ values: { photo: 'cms://dam/secret-photo' } })), 'application/json');
  await store.putInstanceAsset({
    id: 'inst/tpl-cms',
    entry: { ...instanceAssetEntry('inst/tpl-cms', { name: 'Partner photo card', type: 'template' }, [{ format: 'json', size: cms.size, checksum: cms.checksum }]), meta: { toolId: 'photo-card', version: 1 } },
    blobs: { json: 'inst/tpl-cms/json' }, groups: ['programme-resellers-emea'], createdAt: new Date().toISOString(),
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
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA', tools: ['photo-card', 'baked-card', 'ghost-card', 'cms-card'] })).status, 201);
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
  assert.deepEqual(r.templates.map((x: { name: string }) => x.name).sort(), ['Partner photo card', 'Partner price sheet']);
  const cms = r.templates.find((x: { name: string }) => x.name === 'Partner photo card');
  assert.deepEqual(cms.audiences[0].files.map((f: { id: string; why: string }) => [f.id, f.why]), [['ext/dam/secret-photo', 'not-shared']], 'a DAM file its audience cannot reach');
  const t = r.templates.find((x: { name: string }) => x.name === 'Partner price sheet');
  assert.deepEqual(t.audiences.map((a: { kind: string; name: string }) => [a.kind, a.name]), [['programme', 'Resellers, EMEA'], ['company', 'Northwind IT']]);
  const files = t.audiences[1].files.map((f: { id: string; why: string }) => [f.id, f.why]).sort();
  assert.deepEqual(files, [['acme/photo/internal', 'not-shared'], ['acme/photo/unrecorded', 'licence']], 'the open photo reaches them and is not listed');
  assert.equal(t.audiences[1].files.find((f: { why: string }) => f.why === 'licence').reason, 'licence not recorded');
});

test('the pipeline: a gated caller\'s render draws only files their feed holds, and says which it would not', async () => {
  const config = parseConfig(JSON.stringify({ instance: { name: 'SUSE', baseUrl: 'http://localhost', pack: packDir }, dev: { enabled: true } }));
  const request: RenderRequest = { toolId: 'photo-card', format: 'svg', query: '', principal: { groups: ['programme-resellers-emea', 'partner'] }, profile: {}, overlays: new Map() };
  const catalogIds = new Set(PACK.map((a) => a.id));
  const assetGate = async () => ({ allows: (id: string) => id !== 'acme/photo/unrecorded' && id !== 'acme/photo/internal', catalogIds, revision: 'r1' });
  // A default the caller never named is refused and counted, never named.
  await assert.rejects(renderTool({ config, assetGate }, request), (e: { code?: string; status?: number; message?: string; details?: { assets?: string[]; more?: number } }) =>
    e.code === 'ASSET_HELD' && e.status === 422 && e.details?.assets?.length === 0 && e.details?.more === 1 && e.message === 'This render uses a file that is not available to you.', 'the tool\'s own default');
  await assert.rejects(renderTool({ config, assetGate }, { ...request, query: 'photo=acme%2Fphoto%2Finternal' }), (e: { code?: string; details?: { assets?: string[] } }) =>
    e.code === 'ASSET_HELD' && e.details?.assets?.[0] === 'acme/photo/internal', 'the caller\'s own value is named back');
  await assert.rejects(renderTool({ config, assetGate }, { ...request, query: 'photo=catalog%3A%2F%2Facme%2Fphoto%2Finternal' }), (e: { code?: string }) => e.code === 'ASSET_HELD', 'and so is its catalog:// form');
  const open = await renderTool({ config, assetGate }, { ...request, query: 'photo=acme%2Fphoto%2Fopen' });
  assert.match(Buffer.from(open.bytes).toString(), /<image[^>]*href="data:image\/svg\+xml;base64,/, 'a file their feed holds is drawn');
  const before = await renderTool({ config }, request);
  const ungated = await renderTool({ config, assetGate: async () => null }, request);
  // The gate's revision is in the cache key, so a change to what the caller may draw is never answered from the cache.
  const allowAll = async (revision: string) => ({ allows: () => true, catalogIds, revision });
  const first = await renderTool({ config, assetGate: () => allowAll('r1') }, { ...request, query: 'photo=acme%2Fphoto%2Fopen' });
  const second = await renderTool({ config, assetGate: () => allowAll('r2') }, { ...request, query: 'photo=acme%2Fphoto%2Fopen' });
  assert.notEqual(first.cacheKey, second.cacheKey);
  assert.equal(Buffer.from(ungated.bytes).toString(), Buffer.from(before.bytes).toString(), 'with no gate, the same bytes as before');
});

test('over HTTP: Rita\'s render is refused with the gate on, and nothing changes in report mode or for staff', async () => {
  const gated = await fetch(`${gateBase}/render/photo-card.svg`, { headers: { cookie: await login('rita@northwind.test', gateBase) } });
  assert.equal(gated.status, 422, await gated.clone().text());
  const body = await gated.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'ASSET_HELD');
  assert.equal(body.error.message, 'This render uses a file that is not available to you.', 'a default she never named is counted, not named');
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
  assert.equal(body.error.message, 'This document uses a file that is not available to you.');
  const named = await compile('rita@northwind.test', gateBase, { photo: 'acme/photo/unrecorded' });
  assert.match(named.text, /This document uses a file that is not available to you: acme\/photo\/unrecorded\./, 'her own value is named back');
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

test('a cms:// file in a compile answers to the gate by its catalog id, as a library file does', async () => {
  const bruno = await login('bruno@test', gateBase);
  const post = (cookie: string, path: string, body?: unknown) => fetch(`${gateBase}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const svg = Buffer.from(SVG('#0aa')).toString('base64');
  const made = await post(bruno, '/api/v1/catalog/providers', {
    id: 'dam', kind: 'mock', label: 'Brandfolder', exposure: { groups: ['marketing'] },
    options: { assets: [{ remoteId: 'e1', name: 'Event photo', nativeType: 'file', sections: [], folder: 'event-photos', tags: [], approved: true, formats: [{ format: 'svg', remoteRef: 'svg', size: 100 }] }], blobBase64: { e1: svg } },
  });
  assert.ok([200, 201].includes(made.status), await made.text());
  assert.equal((await post(await login('owner@test', gateBase), '/api/v1/catalog/providers/dam/enable')).status, 200);
  const folder = await fetch(`${gateBase}/api/v1/programmes/resellers-emea/folders`, { method: 'PUT', headers: { cookie: bruno, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'dam', path: 'event-photos' }) });
  assert.equal(folder.status, 201, await folder.text());
  const compile = async (email: string) => {
    const res = await fetch(`${gateBase}/api/v1/compile`, { method: 'POST', headers: { cookie: await login(email, gateBase), 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'photo-card', inputs: { photo: 'cms://dam/e1' } }) });
    return { status: res.status, text: await res.text() };
  };
  const held = await compile('rita@northwind.test');
  assert.equal(held.status, 422, held.text);
  assert.match(held.text, /"ASSET_HELD"/);
  assert.match(held.text, /ext\/dam\/e1/, 'named by its catalog id');
  const staff = await compile('mia@test');
  assert.equal(staff.status, 200, staff.text);
});

test('the render host answers every lookup, read and listing from the caller\'s own feed', async () => {
  const gate = { allows: (id: string) => id === 'acme/photo/open', held: new Set<string>() };
  await withRenderHost({ pack: packDir, profile: {}, assetGate: gate }, async (_dom, host) => {
    assert.deepEqual((await host.assets.query({})).map((a) => a.id), ['acme/photo/open'], 'a listing holds only what the feed holds');
    assert.equal(await host.assets.isAvailable('acme/photo/internal'), false);
    await assert.rejects(host.assets.get('acme/photo/internal'), (e: Error) => e instanceof AssetHeldError);
    await assert.rejects(host.assets.resolveProvider!({ raw: 'library://acme/photo/internal', provider: 'library', scope: 'acme', path: 'photo/internal', query: {} }), (e: Error) => e instanceof AssetHeldError);
    assert.equal((await host.assets.get('acme/photo/open')).id, 'acme/photo/open');
  });
  assert.deepEqual([...gate.held].sort(), ['acme/photo/internal']);
});

test('in either mode a partner draws only files their own feed holds: report mode scopes, gate mode also gates', async () => {
  const compile = async (at: string, inputs: Record<string, unknown>) => {
    const res = await fetch(`${at}/api/v1/compile`, { method: 'POST', headers: { cookie: await login('rita@northwind.test', at), 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'photo-card', inputs }) });
    return { status: res.status, text: await res.text() };
  };
  for (const at of [base, gateBase]) {
    const outside = await compile(at, { photo: 'library://acme/photo/internal' });
    assert.equal(outside.status, 422, `${at === base ? 'report' : 'gate'}: ${outside.text}`);
    assert.match(outside.text, /acme\/photo\/internal/, 'her own value is named back');
    assert.equal((await compile(at, { photo: 'library://acme/photo/open' })).status, 200);
    const render = await fetch(`${at}/render/photo-card.svg?photo=${encodeURIComponent('catalog://acme/photo/internal')}`, { headers: { cookie: await login('rita@northwind.test', at) } });
    assert.equal(render.status, 422, 'the catalog:// form of a file outside her feed');
  }
  assert.equal((await compile(base, { photo: 'library://acme/photo/unrecorded' })).status, 200, 'report mode: in her feed');
  assert.equal((await compile(gateBase, { photo: 'library://acme/photo/unrecorded' })).status, 422, 'gate mode: held by its licence');
});

test('a compile never returns a held file carried in a default, inline or baked, and /package inherits that', async () => {
  const rita = await login('rita@northwind.test', gateBase);
  for (const path of ['/api/v1/compile', '/api/v1/package']) {
    const res = await fetch(`${gateBase}${path}`, { method: 'POST', headers: { cookie: rita, 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'baked-card', inputs: { photo: null } }) });
    assert.equal(res.status, 422, `${path}: ${await res.clone().text()}`);
    const body = await res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'ASSET_HELD');
    assert.doesNotMatch(body.error.message, /acme\/photo\/unrecorded/, 'a default she never named is not named');
  }
  const staff = await fetch(`${gateBase}/api/v1/compile`, { method: 'POST', headers: { cookie: await login('mia@test', gateBase), 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'baked-card', inputs: {} }) });
  assert.equal(staff.status, 200, 'staff unchanged');
});

test('a tool link a partner made draws only what that partner may draw now, and a cached render never outlives a withdrawn choice', async () => {
  const rita = await login('rita@northwind.test', gateBase);
  const bruno = await login('bruno@test', gateBase);
  const made = await fetch(`${gateBase}/api/v1/links`, { method: 'POST', headers: { cookie: rita, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'download', target: { toolId: 'photo-card', format: 'svg', params: { photo: 'acme/photo/unrecorded' } } }) });
  assert.equal(made.status, 201, await made.clone().text());
  const url = ((await made.json()) as { url: string }).url.replace('http://localhost', gateBase);
  assert.equal((await fetch(url)).status, 422, 'held for its maker, so held in the link');
  const direct = `${gateBase}/render/photo-card.svg?photo=${encodeURIComponent('catalog://acme/photo/unrecorded')}`;
  assert.equal((await fetch(direct, { headers: { cookie: rita } })).status, 422);
  const put = await fetch(`${gateBase}/api/v1/programmes/resellers-emea/rights/choices`, { method: 'PUT', headers: { cookie: bruno, 'content-type': 'application/json' },
    body: JSON.stringify({ assetIds: ['acme/photo/unrecorded'], company: 'northwind-it' }) });
  assert.equal(put.status, 200, await put.text());
  assert.equal((await fetch(url)).status, 200, 'shared anyway with her company, so the link draws it');
  assert.equal((await fetch(direct, { headers: { cookie: rita } })).status, 200);
  const withdraw = await fetch(`${gateBase}/api/v1/programmes/resellers-emea/rights/choices?assetId=${encodeURIComponent('acme/photo/unrecorded')}&company=northwind-it`, { method: 'DELETE', headers: { cookie: bruno } });
  assert.equal(withdraw.status, 200);
  assert.equal((await fetch(url)).status, 422, 'withdrawn: the link is held again on its next fetch');
  assert.equal((await fetch(direct, { headers: { cookie: rita } })).status, 422, 'and the cached render is not served');
});

test('a gate check reads every row of a value, and refuses values too large to read whole', () => {
  const known = new Set(['acme/held']);
  const rows = Array.from({ length: 501 }, (_, i) => ({ title: `row ${i}`, ...(i === 500 ? { image: { source: 'library', id: 'acme/held', url: 'data:image/png;base64,AA==', meta: { baked: true } } } : {}) }));
  assert.deepEqual(referencedAssetIds({ blocks: rows }, known, { strict: true }), ['acme/held'], 'row 501 is read');
  const huge = Array.from({ length: ASSET_SCAN_MAX_NODES + 1 }, () => 'x');
  assert.throws(() => referencedAssetIds({ blocks: huge }, known, { strict: true }), AssetScanBoundExceeded);
  let deep: unknown = 'acme/held';
  for (let i = 0; i < 80; i++) deep = [deep];
  assert.throws(() => referencedAssetIds(deep, known, { strict: true }), AssetScanBoundExceeded, 'and values too deep');
});

test('a compiled document and its package name no file the caller may not draw, defaults included', async () => {
  const rita = await login('rita@northwind.test', gateBase);
  const body = JSON.stringify({ toolId: 'photo-card', inputs: { photo: 'acme/photo/open' } });
  const compiled = await fetch(`${gateBase}/api/v1/compile`, { method: 'POST', headers: { cookie: rita, 'content-type': 'application/json' }, body });
  const text = await compiled.text();
  assert.equal(compiled.status, 200, text);
  assert.doesNotMatch(text, /acme\/photo\/unrecorded/, 'the manifest default she chose against is not named');
  const pkg = await fetch(`${gateBase}/api/v1/package`, { method: 'POST', headers: { cookie: rita, 'content-type': 'application/json' }, body });
  assert.equal(pkg.status, 200);
  const entries = await readZip(new Uint8Array(await pkg.arrayBuffer()));
  for (const e of entries) assert.doesNotMatch(new TextDecoder().decode(e.bytes), /acme\/photo\/unrecorded/, `${e.name} names no held file`);
  const staff = await (await fetch(`${gateBase}/api/v1/compile`, { method: 'POST', headers: { cookie: await login('mia@test', gateBase), 'content-type': 'application/json' }, body })).text();
  assert.match(staff, /acme\/photo\/unrecorded/, 'staff documents are unchanged');
});

test('a template\'s DAM ref the partner cannot reach is refused without being named', async () => {
  const res = await fetch(`${gateBase}/api/v1/render`, { method: 'POST', headers: { cookie: await login('rita@northwind.test', gateBase), 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'photo-card', format: 'svg', inputs: { template: 'inst/tpl-cms' } }) });
  const text = await res.text();
  assert.equal(res.status, 422, text);
  assert.doesNotMatch(text, /secret-photo/, 'the template\'s file is not named to the partner');
});

test('an inline file a reference says is a catalog file is gated whether or not the catalog still lists it', async () => {
  const rita = await login('rita@northwind.test', gateBase);
  for (const path of ['/api/v1/compile', '/api/v1/package']) {
    const res = await fetch(`${gateBase}${path}`, { method: 'POST', headers: { cookie: rita, 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'ghost-card', inputs: {} }) });
    const text = await res.text();
    assert.equal(res.status, 422, `${path}: ${text}`);
    assert.doesNotMatch(text, /acme\/photo\/gone/, 'and the default she never named is not named');
  }
});

test('a compile names a file it could not resolve only when the caller named it', async () => {
  const gate = { allows: () => true, held: new Set<string>(), catalogIds: new Set<string>() };
  const ctx = { pack: packDir, profile: {}, hostedResolver: async () => null, assetGate: gate };
  const own = await compileVerb(ctx, { toolId: 'cms-card', inputs: {} }) as { warnings: string[] };
  assert.ok(own.warnings.some((w) => w === 'a file for photo was not resolved'), JSON.stringify(own.warnings));
  assert.ok(!own.warnings.some((w) => w.includes('secret-default')), 'a default\'s ref is described, not named');
  const named = await compileVerb(ctx, { toolId: 'cms-card', inputs: { photo: 'cms://dam/mine' } }) as { warnings: string[] };
  assert.ok(named.warnings.some((w) => w.includes('cms://dam/mine')), 'her own ref is named back');
});
