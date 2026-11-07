// SPDX-License-Identifier: MPL-2.0
/**
 * Server renders and the licence gate (plans/82 M4, W-M4-8).
 *
 * Pinned here: the programme report lists the published templates that seed
 * files one of the programme's audiences will not receive, and why (held back
 * by the licence gate, or never shared with that audience), so the brand team
 * sees it before a partner's render is refused.
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

const SVG = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`;
const PACK = [
  { id: 'acme/tokens', name: 'Acme tokens', type: 'tokens', file: 'tokens.json', body: '{}' },
  { id: 'acme/photo/open', name: 'Open photo', type: 'vector', file: 'open.svg', body: SVG('#0a0'), license: 'CC-BY-4.0' },
  { id: 'acme/photo/unrecorded', name: 'Unrecorded photo', type: 'vector', file: 'unrecorded.svg', body: SVG('#a00') },
  { id: 'acme/photo/internal', name: 'Internal photo', type: 'vector', file: 'internal.svg', body: SVG('#00a') },
];

let server: Server;
let base = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-render-licence-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  for (const a of PACK) await writeFile(join(pack, 'catalog', 'assets', 'acme', a.file), a.body);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: PACK.map(({ file, body: _b, ...a }) => ({ ...a, formats: [{ format: file.split('.').pop(), url: `/catalog/assets/acme/${file}` }] })),
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'SUSE', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'bruno@test', groups: ['admin'], name: 'Bruno Marsh' }, { email: 'rita@northwind.test', groups: [] }] },
  }));
  const store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  const values = { values: { photo: { source: 'library', id: 'acme/photo/unrecorded' }, backdrop: 'acme/photo/internal', badge: 'acme/photo/open', title: 'EMEA price list' } };
  const stat = await blobs.put('inst/tpl-price/json', Buffer.from(JSON.stringify(values)), 'application/json');
  await store.putInstanceAsset({
    id: 'inst/tpl-price',
    entry: { ...instanceAssetEntry('inst/tpl-price', { name: 'Partner price sheet', type: 'template' }, [{ format: 'json', size: stat.size, checksum: stat.checksum }]), meta: { toolId: 'price-sheet', version: 1 } },
    blobs: { json: 'inst/tpl-price/json' }, groups: ['programme-resellers-emea'], createdAt: new Date().toISOString(),
  });
  await store.putCollection({ id: 'kit', name: 'Kit', members: ['acme/photo/open', 'acme/photo/unrecorded'], groups: ['programme-resellers-emea'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs, secrets: { session: 'sr', link: 'lr', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA' })).status, 201);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
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
