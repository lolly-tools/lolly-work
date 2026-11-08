// SPDX-License-Identifier: MPL-2.0
/**
 * The licence gate on the routes M6's #353 closed for partner scope (plans/82
 * M4 with M6): a DAM file reached by `cms://` through /optimize, a compile, a
 * render or a batch's data binding, and the hosted instance pack.
 *
 * Pinned here: with the gate on, a partner programme member reaching a DAM
 * file their programme's folder grant covers but whose licence the gate holds
 * back gets no bytes and no rows by any of those routes, while a file whose
 * licence travels goes through; staff reach both; and the instance pack is
 * never a partner's to download.
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

const SVG = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`;
const PHOTO_CARD = {
  id: 'photo-card', name: 'Photo card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
  render: { width: 10, height: 10, formats: ['svg'] },
  inputs: [{ id: 'photo', label: 'Photo', type: 'asset' }, { id: 'title', label: 'Title', type: 'text', default: 'x' }],
};
const TEMPLATE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><image href="{{asset photo}}" width="10" height="10"/><text>{{title}}</text></svg>';
const ROWS = JSON.stringify([{ title: 'confidential price' }]);
const file = (remoteId: string, format: string) => ({
  remoteId, name: `File ${remoteId}`, nativeType: 'file', sections: [], folder: 'event-photos', tags: [], approved: true,
  formats: [{ format, remoteRef: format, size: 100 }], updatedAt: '2026-11-01T00:00:00.000Z',
});

let base = '';
let server: Server;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-gate-routes-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'photo-card'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'photo-card' }] }));
  await writeFile(join(pack, 'tools', 'photo-card', 'tool.json'), JSON.stringify(PHOTO_CARD));
  await writeFile(join(pack, 'tools', 'photo-card', 'template.html'), TEMPLATE);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'SUSE', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    policy: { catalog: { partnerRights: 'gate' } },
    dev: { enabled: true, users: [
      { email: 'bruno@test', groups: ['admin'] }, { email: 'owner@test', groups: ['owner'] },
      { email: 'mia@test', groups: ['marketing'] }, { email: 'rita@northwind.test', groups: [] },
    ] },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sq', link: 'lq', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const bruno = await login('bruno@test');
  const blob = (s: string) => Buffer.from(s).toString('base64');
  assert.ok([200, 201].includes((await call(bruno, 'POST', '/api/v1/catalog/providers', {
    id: 'dam', kind: 'mock', label: 'Brandfolder', exposure: { groups: ['marketing'] },
    options: {
      assets: [file('held', 'svg'), file('open', 'svg'), file('rows', 'json'), file('open-rows', 'json')],
      blobBase64: { held: blob(SVG('#a00')), open: blob(SVG('#0a0')), rows: blob(ROWS), 'open-rows': blob(ROWS) },
      blobContentType: { held: 'image/svg+xml', open: 'image/svg+xml', rows: 'application/json', 'open-rows': 'application/json' },
    },
  })).status));
  assert.equal((await call(await login('owner@test'), 'POST', '/api/v1/catalog/providers/dam/enable')).status, 200);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA', tools: ['photo-card'] })).status, 201);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  await login('rita@northwind.test');
  assert.equal((await call(bruno, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/folders', { provider: 'dam', path: 'event-photos' })).status, 201);
  // Two of the folder's files record a licence that travels; the other two record none.
  // The provider's files reach the catalog after its first sync.
  for (const id of ['ext/dam/open', 'ext/dam/open-rows']) {
    let put = await call(bruno, 'PUT', '/api/v1/catalog/rights/licences', { assetId: id, declaration: 'CC-BY-4.0', attribution: 'Northwind events team' });
    for (let i = 0; put.status === 404 && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      put = await call(bruno, 'PUT', '/api/v1/catalog/rights/licences', { assetId: id, declaration: 'CC-BY-4.0', attribution: 'Northwind events team' });
    }
    assert.ok([200, 201].includes(put.status), put.text);
  }
  await store.putGrant({ principal: 'group:programme-resellers-emea', action: 'export.server', resource: '*', effect: 'allow' });
  await store.putGrant({ principal: 'group:marketing', action: 'export.server', resource: '*', effect: 'allow' });
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
}

test('a held DAM file reached by cms:// yields no bytes to a partner by /optimize, a compile or a render', async () => {
  const rita = await login('rita@northwind.test');
  const optimized = await call(rita, 'POST', '/api/v1/optimize', { source: 'cms://dam/held' });
  assert.notEqual(optimized.status, 200, optimized.text);
  assert.doesNotMatch(optimized.text, /bytesBase64/);
  const compiled = await call(rita, 'POST', '/api/v1/compile', { toolId: 'photo-card', inputs: { photo: 'cms://dam/held' } });
  assert.equal(compiled.status, 422, compiled.text);
  const rendered = await call(rita, 'POST', '/api/v1/render', { toolId: 'photo-card', format: 'svg', inputs: { photo: 'cms://dam/held' } });
  assert.equal(rendered.status, 422, rendered.text);
  assert.doesNotMatch(rendered.text, /data:image\/svg\+xml;base64/);

  // A file whose licence travels goes through the same routes.
  assert.equal((await call(rita, 'POST', '/api/v1/optimize', { source: 'cms://dam/open' })).status, 200);
  assert.equal((await call(rita, 'POST', '/api/v1/compile', { toolId: 'photo-card', inputs: { photo: 'cms://dam/open' } })).status, 200);
  // Staff reach both.
  const mia = await login('mia@test');
  assert.equal((await call(mia, 'POST', '/api/v1/optimize', { source: 'cms://dam/held' })).status, 200);
});

test('a batch bound to a held DAM file gives a partner no rows; one whose licence travels does', async () => {
  const rita = await login('rita@northwind.test');
  const held = await call(rita, 'POST', '/api/v1/batch', { toolId: 'photo-card', format: 'svg', bind: { source: 'cms://dam/rows' } });
  assert.equal(held.status, 400, held.text);
  assert.equal(held.body.error.code, 'DATA_BINDING_ERROR');
  assert.doesNotMatch(held.text, /confidential price/);
  const open = await call(rita, 'POST', '/api/v1/batch', { toolId: 'photo-card', format: 'svg', bind: { source: 'cms://dam/open-rows' } });
  assert.notEqual(open.body?.error?.code, 'DATA_BINDING_ERROR', open.text);
  const mia = await call(await login('mia@test'), 'POST', '/api/v1/batch', { toolId: 'photo-card', format: 'svg', bind: { source: 'cms://dam/rows' } });
  assert.notEqual(mia.body?.error?.code, 'DATA_BINDING_ERROR', `staff read the rows: ${mia.text}`);
});

test('the instance pack is never a partner\'s to download, at its name or its checksum address', async () => {
  const rita = await login('rita@northwind.test');
  for (const path of ['/connect/pack.lolly', '/connect/pack.0123456789abcdef.lolly']) {
    const res = await fetch(`${base}${path}`, { headers: { cookie: rita } });
    assert.equal(res.status, 403, path);
  }
  assert.notEqual((await fetch(`${base}/connect/pack.lolly`, { headers: { cookie: await login('mia@test') } })).status, 403, 'staff are not refused');
});
