/**
 * Partner scope on the remaining routes (plans/82 M1, closed in M6).
 *
 * A partner programme member reads exactly what their own served feed holds. These
 * routes reached past the feed before: a cms:// source beyond sync.maxAssets, the
 * hosted pack, live search, the submit dedup answer, the live rows of the
 * submissions list, collections, lifecycle and scans under a delegated grant, and
 * the lifecycle wording of a pack file's refusal. Each case states what a partner
 * gets and what staff keep. Federated bytes answer a partner no-cache while staff
 * keep plan 80 D6's five minutes (Andy, 2026-11-07).
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
import { ZipBuilder } from '../server/src/links/zip.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const INTERNAL_BYTES = Buffer.from('internal-bytes-only-staff-hold');
const PNG = (text: string) => Buffer.from(text);
const TOKENS = JSON.stringify({ lolly: { foundation: { radius: { sm: { $type: 'dimension', $value: '8px' } } } } });

/** A hosted .lolly the instance offers at /connect/pack.lolly. */
function connectPack(): Buffer {
  const zb = new ZipBuilder(new Date('2026-08-24T00:00:00Z'));
  const parts = Object.entries({
    'manifest.json': JSON.stringify({ format: 'lolly-brand', formatVersion: 3 }),
    'instance.json': JSON.stringify({ kind: 'instance', name: 'Scope Brand', publisher: 'Acme', version: '1.0.0', instance: 'http://localhost' }),
    'tokens.json': TOKENS,
    'pack.sig': 'sig-bytes',
  }).map(([name, body]) => zb.add(name, Buffer.from(body)));
  parts.push(zb.end());
  return Buffer.concat(parts);
}

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-scope-routes-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  await writeFile(join(pack, 'catalog', 'assets', 'internal.png'), 'internal-pack-bytes');
  await writeFile(join(pack, 'catalog', 'assets', 'tokens.json'), TOKENS);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [
    { id: 'acme/tokens', type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/tokens.json' }] },
    { id: 'acme/internal', name: 'Internal roadmap', type: 'image', formats: [{ format: 'png', url: '/catalog/assets/internal.png' }] },
  ] }));
  await writeFile(join(pack, 'connect.lolly'), new Uint8Array(connectPack()));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Scope Hub', baseUrl: 'http://localhost', pack, connectPack: 'connect.lolly' },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@reseller.test', groups: [] },
    ] },
    catalogProviders: [{
      // The reseller programme is exposed to this DAM, but sync federates only its
      // first asset: the second exists upstream and is in nobody's feed.
      id: 'dam', kind: 'mock', label: 'DAM', enabled: true,
      exposure: { groups: ['marketing', 'programme-resellers'] },
      options: {
        assets: [
          { remoteId: 'd1', name: 'Northwind kit photo', nativeType: 'file', sections: [], tags: [], approved: true, updatedAt: '2026-05-01T00:00:00.000Z', formats: [{ format: 'json', remoteRef: 'f1', filename: 'kit.json' }] },
          { remoteId: 'd2', name: 'Unindexed roadmap', nativeType: 'file', sections: [], tags: ['secret'], approved: true, updatedAt: '2026-05-01T00:00:00.000Z', formats: [{ format: 'json', remoteRef: 'f2', filename: 'roadmap.json' }] },
        ],
        blobText: { d1: '{"kit":1}', d2: '{"roadmap":2}' },
        blobContentType: { d1: 'application/json', d2: 'application/json' },
      },
      mapping: { defaultType: 'image' }, sync: { maxAssets: 1 },
    }],
  }));
  store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  const put = async (id: string, bytes: Buffer, groups: string[] | '*', submission?: Record<string, unknown>) => {
    const stat = await blobs.put(`${id}/png`, bytes, 'image/png');
    await store.putInstanceAsset({
      id, entry: instanceAssetEntry(id, { name: id, type: 'image' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]),
      blobs: { png: `${id}/png` }, groups: groups as never, createdAt: new Date().toISOString(),
      ...(submission ? { submission: { at: new Date().toISOString(), checksum: stat.checksum, size: stat.size, contentType: 'image/png', ...submission } } : {}),
    } as never);
  };
  await put('inst/internal', INTERNAL_BYTES, '*');
  await put('inst/kit', PNG('kit'), ['marketing']);
  await store.putCollection({ id: 'emea-kit', name: 'EMEA kit', members: ['inst/kit'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  await store.putCollection({ id: 'internal-kit', name: 'Internal kit', members: ['inst/internal'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  await store.putLifecycle({ assetId: 'acme/internal', onExpiry: 'hide', revokedAt: new Date().toISOString() });
  const app = buildApp({ config, store, blobs, secrets: { session: 'ss', link: 'sl' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  await fetch(`${base}/api/v1/programmes/resellers`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Resellers', tools: [], collections: ['emea-kit'] }) });
  await login('rita@reseller.test');
  const ritaId = (await store.getUserBySub('dev:rita@reseller.test'))!.id;
  await fetch(`${base}/api/v1/users/${ritaId}/local-groups`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ groups: ['programme-resellers'] }) });
  // Rita's own live submission, published to everyone inside but outside her programme,
  // and one still waiting for its decision.
  await put('inst/rita-live', PNG('rita-live'), '*', { state: 'live', by: `user:${ritaId}` });
  await put('inst/rita-pending', PNG('rita-pending'), '*', { state: 'submitted', by: `user:${ritaId}` });
  // A partner trusted with the catalog's curation tools, delegated by grant.
  for (const action of ['catalog.submit', 'catalog.collection.manage', 'catalog.expire', 'catalog.hold', 'catalog.scan']) {
    await store.putGrant({ principal: 'group:programme-resellers', action, resource: '*', effect: 'allow' } as never);
  }
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const get = (cookie: string, path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { cookie, ...headers } });
const send = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('a cms:// source past the feed resolves for nobody in the programme, whichever verb names it', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  const inspect = async (cookie: string, source: string) => (await (await send(cookie, 'POST', '/api/v1/inspect', { source })).text());
  const unresolved = /could not resolve|source is not available/;
  assert.match(await inspect(rita, 'cms://dam/d2'), unresolved, 'past sync.maxAssets: not in the feed');
  const held = await inspect(rita, 'cms://dam/d1');
  assert.doesNotMatch(held, unresolved, `the asset their feed holds: ${held}`);
  const own = await inspect(staff, 'cms://dam/d2');
  assert.doesNotMatch(own, unresolved, `staff reach the provider as before: ${own}`);
});

test('the hosted pack is refused to a partner before any tag, HEAD or 304 answers', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  assert.equal((await get(rita, '/connect/pack.lolly')).status, 403);
  assert.equal((await fetch(`${base}/connect/pack.lolly`, { method: 'HEAD', headers: { cookie: rita } })).status, 403);
  const own = await get(staff, '/connect/pack.lolly');
  assert.equal(own.status, 200, 'staff unchanged');
  const tag = own.headers.get('etag')!;
  assert.equal((await get(staff, '/connect/pack.lolly', { 'if-none-match': tag })).status, 304);
  const revalidated = await get(rita, '/connect/pack.lolly', { 'if-none-match': tag });
  assert.equal(revalidated.status, 403, 'not even a 304 confirms the tag');
  assert.equal(revalidated.headers.get('etag'), null);
});

test('live search returns a partner only what their feed holds', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  const ids = async (cookie: string) => ((await (await get(cookie, '/api/v1/catalog/search?q=roadmap')).json()) as { results: Array<{ id: string }> }).results.map((r) => r.id);
  assert.ok(!(await ids(rita)).includes('ext/dam/d2'), 'an upstream asset sync left out');
  assert.ok((await ids(staff)).includes('ext/dam/d2'), 'staff keep the live pass');
});

test('submit dedup never names an asset outside the partner\'s feed', async () => {
  const rita = await login('rita@reseller.test');
  const res = await fetch(`${base}/api/v1/catalog/submit?name=internal.png`, { method: 'POST', headers: { cookie: rita, 'content-type': 'image/png' }, body: INTERNAL_BYTES });
  const body = await res.json() as { duplicate?: boolean; id?: string; record?: { id?: string }; asset?: { id?: string } };
  assert.notEqual(body.duplicate, true, 'the same bytes held as an internal asset are not confirmed to them');
  assert.ok(![body.id, body.record?.id, body.asset?.id].includes('inst/internal'), JSON.stringify(body));
  const sha = createHash('sha256').update(INTERNAL_BYTES).digest('hex');
  assert.ok(!JSON.stringify(body).includes('inst/internal'), `no internal id for ${sha.slice(0, 8)}`);
});

test('the submissions list shows a partner\'s live rows only while their feed holds them', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  const list = async (cookie: string, state: string) => ((await (await get(cookie, `/api/v1/catalog/submissions?state=${state}`)).json()) as { submissions: Array<{ id: string }> }).submissions.map((s) => s.id);
  assert.ok(!(await list(rita, 'live')).includes('inst/rita-live'), 'their own, but published outside their programme');
  assert.ok((await list(rita, 'submitted')).includes('inst/rita-pending'), 'a row waiting for its decision keeps the relationship');
  assert.ok(!(await list(staff, 'live')).includes('inst/rita-live'), 'staff see only their own and their inbox, as before');
});

test('collections under a delegated grant keep to the partner\'s programme', async () => {
  const rita = await login('rita@reseller.test');
  const admin = await login('admin@test');
  const listed = ((await (await get(rita, '/api/v1/catalog/collections')).json()) as { collections: Array<{ id: string }> }).collections.map((c) => c.id);
  assert.deepEqual(listed, ['emea-kit'], 'only the collection their programme sees');
  assert.equal((await get(rita, '/api/v1/catalog/collections/internal-kit')).status, 404);
  assert.equal((await send(rita, 'PUT', '/api/v1/catalog/collections/internal-kit', { name: 'Taken', members: [], groups: ['programme-resellers'] })).status, 404, 'not overwritten');
  assert.equal((await send(rita, 'DELETE', '/api/v1/catalog/collections/internal-kit')).status, 404, 'not deleted');
  assert.equal((await store.getCollection('internal-kit'))?.name, 'Internal kit');
  assert.equal((await send(rita, 'PUT', '/api/v1/catalog/collections/partner-picks', { name: 'Picks', members: ['inst/kit'], groups: ['marketing'] })).status, 403, 'a new collection names their programme');
  assert.equal((await send(rita, 'PUT', '/api/v1/catalog/collections/partner-picks', { name: 'Picks', members: ['inst/kit'], groups: ['programme-resellers'] })).status, 201);
  assert.equal(((await (await get(admin, '/api/v1/catalog/collections')).json()) as { collections: unknown[] }).collections.length, 3, 'staff see every collection');
});

test('lifecycle under a delegated grant shows and changes only what the partner\'s feed holds', async () => {
  const rita = await login('rita@reseller.test');
  const admin = await login('admin@test');
  const rows = ((await (await get(rita, '/api/v1/catalog/lifecycle')).json()) as { rows: Array<{ assetId: string }> }).rows.map((r) => r.assetId);
  assert.ok(!rows.includes('acme/internal'), 'not the lifecycle of an asset outside the feed');
  assert.ok(((await (await get(admin, '/api/v1/catalog/lifecycle')).json()) as { rows: Array<{ assetId: string }> }).rows.some((r) => r.assetId === 'acme/internal'));
  assert.equal((await send(rita, 'PUT', '/api/v1/catalog/lifecycle/inst/internal', { revoke: true })).status, 404, 'cannot stop sharing what is not theirs');
  assert.equal((await send(rita, 'PUT', '/api/v1/catalog/lifecycle/inst/internal', { hold: { note: 'x' } })).status, 404, 'nor hold it');
  assert.equal(await store.getLifecycle('inst/internal'), null);
});

test('a scan under a delegated grant reaches only what the partner\'s feed holds', async () => {
  const rita = await login('rita@reseller.test');
  const admin = await login('admin@test');
  assert.equal((await send(rita, 'POST', '/api/v1/catalog/scan/acme/internal')).status, 404, 'no scan of an asset outside the feed');
  assert.equal((await send(admin, 'POST', '/api/v1/catalog/scan/acme/internal')).status, 200, 'staff scan as before');
});

test('a pack file outside the feed is refused plainly, never with its lifecycle', async () => {
  const rita = await login('rita@reseller.test');
  const admin = await login('admin@test');
  const refused = await get(rita, '/catalog/assets/internal.png');
  assert.equal(refused.status, 404);
  assert.doesNotMatch(await refused.text(), /revoked|expired|not yet published/);
  assert.equal((await get(admin, '/catalog/assets/internal.png')).status, 410, 'staff are told it was revoked, as before');
});

test('federated bytes answer a partner no-cache, and staff keep five minutes', async () => {
  const rita = await login('rita@reseller.test');
  const staff = await login('staff@test');
  const feed = (await (await get(rita, '/catalog/assets/index.json')).json()) as { assets: Array<{ id: string; formats?: Array<{ url: string }> }> };
  const url = feed.assets.find((a) => a.id === 'ext/dam/d1')?.formats?.[0]?.url;
  assert.ok(url, 'their feed holds d1');
  const partner = await get(rita, url!);
  assert.equal(partner.status, 200);
  assert.equal(partner.headers.get('cache-control'), 'private, no-cache, no-transform');
  const own = await get(staff, url!);
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('cache-control'), 'private, max-age=300, no-transform', 'plan 80 D6, unchanged for staff');
});
