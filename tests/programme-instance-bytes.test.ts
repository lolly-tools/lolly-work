/**
 * A partner programme member reads instance asset bytes only for what their own feed
 * holds (plans/82 M1, closed in M6). An internal asset the workspace published to
 * everyone (`*`) is not a partner's unless their programme includes it, the same rule
 * their federated bytes, links and asset records already follow. Staff are unchanged.
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
import { VIEW_AS_HEADER } from '../server/src/programmes/view-as.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-inst-bytes-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'fonts'), { recursive: true });
  await mkdir(join(pack, 'tools', 'qr-code'), { recursive: true });
  await writeFile(join(pack, 'tools', 'qr-code', 'tool.json'), JSON.stringify({ id: 'qr-code', inputs: [] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'qr-code' }] }));
  await writeFile(join(pack, 'catalog', 'fonts', 'sans.woff2'), 'font');
  await writeFile(join(pack, 'catalog', 'fonts', 'OFL.txt'), 'SIL Open Font License');
  await writeFile(join(pack, 'catalog', 'delivery-manifest.json'), JSON.stringify({ version: 1, files: [{ path: 'catalog/secret-roadmap.png' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [
    { id: 'acme/font', name: 'Acme Sans', type: 'font', formats: [{ format: 'woff2', url: '/catalog/fonts/sans.woff2' }], meta: { licenceFile: '/catalog/fonts/OFL.txt', notes: 'Release list: /catalog/delivery-manifest.json' } },
  ] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Bytes Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin', 'marketing'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@reseller.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  for (const [id, groups] of [['inst/internal', '*'], ['inst/kit', ['marketing']], ['inst/emea-only', ['emea-sales']], ['inst/sub1', '*']] as const) {
    const stat = await blobs.put(`${id}/png`, Buffer.from(`png:${id}`), 'image/png');
    await store.putInstanceAsset({
      id, entry: instanceAssetEntry(id, { name: id, type: 'image' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]),
      blobs: { png: `${id}/png` }, groups: groups as never, createdAt: new Date().toISOString(),
      ...(id === 'inst/sub1' ? { submission: { state: 'live', by: 'user:someone', at: new Date().toISOString(), checksum: stat.checksum, size: stat.size, contentType: 'image/png' } } : {}),
    } as never);
  }
  // The kit also holds an asset only the EMEA sales group sees: the programme includes
  // it, and the admin's own groups do not.
  await store.putCollection({ id: 'emea-kit', name: 'EMEA kit', members: ['inst/kit', 'inst/emea-only'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs, secrets: { session: 'sb', link: 'lb' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  await fetch(`${base}/api/v1/programmes/resellers`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Resellers', tools: [], collections: ['emea-kit'] }) });
  await login('rita@reseller.test');
  const ritaId = (await store.getUserBySub('dev:rita@reseller.test'))!.id;
  // Two of Rita's own submissions, shared with everyone inside the workspace but not
  // in her programme: one still waiting for its decision, one already live.
  for (const [id, state] of [['inst/rita-pending', 'submitted'], ['inst/rita-live', 'live']] as const) {
    const stat = await blobs.put(`${id}/png`, Buffer.from(`png:${id}`), 'image/png');
    await store.putInstanceAsset({
      id, entry: instanceAssetEntry(id, { name: id, type: 'image' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]),
      blobs: { png: `${id}/png` }, groups: '*' as never, createdAt: new Date().toISOString(),
      submission: { state, by: `user:${ritaId}`, at: new Date().toISOString(), checksum: stat.checksum, size: stat.size, contentType: 'image/png' },
    } as never);
  }
  // A staff member's own live submission, published only to another programme's
  // group they are not in: staff keep their relationship to what they submitted.
  await login('staff@test');
  const staffId = (await store.getUserBySub('dev:staff@test'))!.id;
  {
    const stat = await blobs.put('inst/staff-live/png', Buffer.from('png:inst/staff-live'), 'image/png');
    await store.putInstanceAsset({
      id: 'inst/staff-live', entry: instanceAssetEntry('inst/staff-live', { name: 'staff.txt', type: 'image' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]),
      blobs: { png: 'inst/staff-live/png' }, groups: ['programme-other'] as never, createdAt: new Date().toISOString(),
      submission: { state: 'live', by: `user:${staffId}`, at: new Date().toISOString(), checksum: stat.checksum, size: stat.size, contentType: 'image/png' },
    } as never);
  }
  await fetch(`${base}/api/v1/users/${ritaId}/local-groups`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ groups: ['programme-resellers'] }) });
  // A partner trusted to edit catalog metadata, and staff who may too.
  await store.putGrant({ principal: 'group:programme-resellers', action: 'catalog.edit', resource: '*', effect: 'allow' } as never);
  await store.putGrant({ principal: 'group:marketing', action: 'catalog.edit', resource: '*', effect: 'allow' } as never);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const bytes = (cookie: string, id: string, query = '') => fetch(`${base}/catalog/${id}/png${query}`, { headers: { cookie } });

test('a partner gets the bytes their programme includes and never an internal asset shared with everyone', async () => {
  const rita = await login('rita@reseller.test');
  assert.equal((await bytes(rita, 'inst/kit')).status, 200, 'their programme includes the kit');
  assert.equal((await bytes(rita, 'inst/internal')).status, 404, 'published to everyone, but not to their programme: not available');
  assert.equal((await bytes(rita, 'inst/internal', '?v=1')).status, 404, 'nor a prior version of it');
});

test('staff are unchanged: everyone means everyone inside the workspace', async () => {
  const staff = await login('staff@test');
  assert.equal((await bytes(staff, 'inst/internal')).status, 200);
  assert.equal((await bytes(staff, 'inst/kit')).status, 200);
});

test('a live internal submission shared with everyone is not a partner\'s to download', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/submissions/sub1/bytes`, { headers: { cookie: rita } })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/catalog/submissions/sub1/bytes`, { headers: { cookie: staff } })).status, 200);
});

test('a submitter reads their own upload while it waits, and only what their feed holds once it is live', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  const preview = (cookie: string, id: string) => fetch(`${base}/api/v1/catalog/submissions/${id}/bytes`, { headers: { cookie } });
  assert.equal((await preview(rita, 'rita-pending')).status, 200, 'their own upload, before the decision');
  assert.equal((await preview(staff, 'rita-pending')).status, 403, 'not staff\'s while it waits');
  assert.equal((await preview(rita, 'rita-live')).status, 404, 'live and shared with everyone, but not in their programme');
  assert.equal((await preview(staff, 'rita-live')).status, 200, 'live: the ordinary rule');
  assert.equal((await preview(staff, 'staff-live')).status, 200, 'staff keep their own live submission, published to a group they are not in');
});

test('a partner allowed to edit catalog metadata still sees only the records their feed holds', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/inst/internal`, { headers: { cookie: rita } })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/inst/kit`, { headers: { cookie: rita } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/inst/internal`, { headers: { cookie: staff } })).status, 200);
});

test('a pack file no asset owns answers a partner only when their own feed names it', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  assert.equal((await fetch(`${base}/catalog/delivery-manifest.json`, { headers: { cookie: rita } })).status, 404, 'the release inventory is not a partner\'s');
  assert.equal((await fetch(`${base}/catalog/fonts/OFL.txt`, { headers: { cookie: rita } })).status, 200, 'the licence text an essential font names');
  assert.equal((await fetch(`${base}/catalog/delivery-manifest.json`, { headers: { cookie: staff } })).status, 200, 'staff unchanged');
});

test('free text never opens a pack file, even text written into the partner\'s own feed', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  // A partner never edits catalog metadata (the partner action allowlist), even with a grant.
  const body = JSON.stringify({ description: '/catalog/delivery-manifest.json', tags: ['/catalog/delivery-manifest.json'] });
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/inst/kit/meta`, { method: 'PUT', headers: { cookie: rita, 'content-type': 'application/json' }, body })).status, 403);
  const edit = await fetch(`${base}/api/v1/catalog/assets/inst/kit/meta`, { method: 'PUT', headers: { cookie: staff, 'content-type': 'application/json' }, body });
  assert.equal(edit.status, 200, 'staff write the address into the kit their programme includes');
  assert.equal((await fetch(`${base}/catalog/delivery-manifest.json`, { headers: { cookie: rita } })).status, 404,
    'a description, a tag or a free-text meta field is not a file reference');
  assert.equal((await fetch(`${base}/catalog/fonts/OFL.txt`, { headers: { cookie: rita } })).status, 200, 'meta.licenceFile is one');
});

test('answers that depend on who asks make the browser ask again, and the check runs before any 304', async () => {
  const staff = await login('staff@test');
  const rita = await login('rita@reseller.test');
  for (const path of ['/catalog/inst/internal/png', '/catalog/fonts/sans.woff2', '/tools/qr-code/tool.json']) {
    const res = await fetch(`${base}${path}`, { headers: { cookie: staff } });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('cache-control'), 'private, no-cache, no-transform', path);
    assert.doesNotMatch(res.headers.get('vary') ?? '', /cookie/i, `${path}: a private answer is never keyed on a cookie`);
  }
  const first = await fetch(`${base}/catalog/inst/internal/png`, { headers: { cookie: staff } });
  const etag = first.headers.get('etag')!;
  const again = await fetch(`${base}/catalog/inst/internal/png`, { headers: { cookie: staff, 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('cache-control'), 'private, no-cache, no-transform');
  const borrowed = await fetch(`${base}/catalog/inst/internal/png`, { headers: { cookie: rita, 'if-none-match': etag } });
  assert.equal(borrowed.status, 404, 'a copy cached for someone else is never confirmed for a partner');
});

test('an admin viewing as the partner gets exactly the partner\'s bytes, records and files, and their own reads are unchanged', async () => {
  const admin = await login('admin@test');
  const started = await fetch(`${base}/api/v1/programmes/resellers/view-as`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 201);
  const { token } = await started.json() as { token: string };
  const viewed = (path: string) => fetch(`${base}${path}`, { headers: { cookie: admin, [VIEW_AS_HEADER]: token } });
  const own = (path: string) => fetch(`${base}${path}`, { headers: { cookie: admin } });
  assert.equal((await viewed('/catalog/inst/kit/png')).status, 200, 'the kit their programme includes');
  assert.equal((await viewed('/catalog/inst/internal/png')).status, 404, 'not an internal asset shared with everyone: not available');
  assert.equal((await viewed('/catalog/inst/internal/png?v=1')).status, 404, 'nor a prior version of it');
  assert.equal((await viewed('/api/v1/catalog/assets/inst/internal')).status, 404, 'nor its record');
  assert.equal((await viewed('/api/v1/catalog/assets/inst/kit')).status, 200);
  assert.equal((await viewed('/catalog/delivery-manifest.json')).status, 404, 'not the release inventory');
  assert.equal((await viewed('/catalog/fonts/OFL.txt')).status, 200, 'the licence text their font names');
  assert.equal((await viewed('/api/v1/catalog/submissions/sub1/bytes')).status, 403, 'and no submission preview at all');
  assert.equal((await own('/catalog/inst/internal/png')).status, 200, 'the admin\'s own read, without the header');
  assert.equal((await own('/catalog/delivery-manifest.json')).status, 200);
});

test('a view never shows the admin an asset their own groups would not: the partner gets it, the view refuses it', async () => {
  const admin = await login('admin@test');
  const rita = await login('rita@reseller.test');
  assert.equal((await bytes(rita, 'inst/emea-only')).status, 200, 'the programme includes it, so the partner gets it');
  assert.equal((await bytes(admin, 'inst/emea-only')).status, 403, 'the admin\'s own groups do not show it');
  const started = await fetch(`${base}/api/v1/programmes/resellers/view-as`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: '{}' });
  const { token } = await started.json() as { token: string };
  const viewed = (path: string) => fetch(`${base}${path}`, { headers: { cookie: admin, [VIEW_AS_HEADER]: token } });
  assert.equal((await viewed('/catalog/inst/emea-only/png')).status, 404, 'refused in the view, with the partner\'s plain answer');
  assert.equal((await viewed('/api/v1/catalog/assets/inst/emea-only')).status, 404);
  const feed = (await (await viewed('/catalog/assets/index.json')).json()) as { assets: Array<{ id: string }>; collections?: Array<{ id: string; members: string[] }> };
  assert.ok(!feed.assets.some((a) => a.id === 'inst/emea-only'), 'nor in the view\'s feed');
  assert.ok(feed.assets.some((a) => a.id === 'inst/kit'), 'what both see stays');
  assert.deepEqual(feed.collections?.find((c) => c.id === 'emea-kit')?.members, ['inst/kit'], 'the collection keeps only what both see');
});
