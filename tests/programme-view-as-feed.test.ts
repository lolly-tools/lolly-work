/**
 * A view as a partner is served the partner's feed AND the admin's own (plans/82 M6,
 * W-M6-3), whatever state the pack index is in, with paging built from that
 * intersection, and with the admin behind the view carried as request metadata: no
 * group name and no grant stands in for it.
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
import { intersectServed, type ServedIndex } from '../server/src/catalog/served-index.ts';

interface Hub { base: string; store: ReturnType<typeof createMemoryStore>; server: Server }
const hubs: Hub[] = [];
let missing: Hub;
let raw: Hub;

/** One instance. `packIndex` is the pack's assets/index.json, or null for none. */
async function boot(packIndex: string | null): Promise<Hub> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-view-feed-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }, { id: 'internal-deck' }] }));
  for (const id of ['price-sheet', 'internal-deck']) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify({ id, inputs: [] }));
  }
  if (packIndex !== null) await writeFile(join(pack, 'catalog', 'assets', 'index.json'), packIndex);
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Feed Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    catalogServing: { maxProviderAssets: 100000, pagedProviderThreshold: 1, extCache: { maxBytes: 1048576, maxItemBytes: 65536 } },
    catalogProviders: [{
      // Exposed to the reseller programme only: the admin's own groups do not show it.
      id: 'big', kind: 'mock', label: 'Big DAM', enabled: true, exposure: { groups: ['programme-resellers'] },
      options: { assets: ['b1', 'b2', 'b3'].map((remoteId) => ({ remoteId, name: `Asset ${remoteId}`, nativeType: 'file', sections: [], tags: [], approved: true, updatedAt: '2026-05-01T00:00:00.000Z', formats: [{ format: 'png', remoteRef: 'f1', filename: `${remoteId}.png` }] })) },
      mapping: { defaultType: 'image' },
    }],
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'rita@reseller.test', groups: [] },
    ] },
  }));
  const store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  const stat = await blobs.put('inst/emea-only/png', Buffer.from('png:emea'), 'image/png');
  await store.putInstanceAsset({
    id: 'inst/emea-only', entry: instanceAssetEntry('inst/emea-only', { name: 'EMEA only', type: 'image' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]),
    blobs: { png: 'inst/emea-only/png' }, groups: ['emea-sales'] as never, createdAt: new Date().toISOString(),
  } as never);
  await store.putCollection({ id: 'emea-kit', name: 'EMEA kit', members: ['inst/emea-only'], groups: ['emea-sales'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs, secrets: { session: 'vf', link: 'vl' } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const hub = { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store, server };
  hubs.push(hub);
  const admin = await login(hub, 'admin@test');
  await send(hub, admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: ['price-sheet'], collections: ['emea-kit'] });
  await login(hub, 'rita@reseller.test');
  const ritaId = (await store.getUserBySub('dev:rita@reseller.test'))!.id;
  await send(hub, admin, 'PUT', `/api/v1/users/${ritaId}/local-groups`, { groups: ['programme-resellers'] });
  return hub;
}

before(async () => {
  missing = await boot(null);
  raw = await boot(JSON.stringify({ version: 1, assets: 'not a list' }));
});
after(() => { for (const hub of hubs) hub.server.close(); });

async function login(hub: Hub, email: string): Promise<string> {
  const res = await fetch(`${hub.base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const send = (hub: Hub, cookie: string, method: string, path: string, body?: unknown) => fetch(`${hub.base}${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function view(hub: Hub): Promise<{ admin: string; get: (path: string) => Promise<Response> }> {
  const admin = await login(hub, 'admin@test');
  const { token } = await (await send(hub, admin, 'POST', '/api/v1/programmes/resellers/view-as', {})).json() as { token: string };
  return { admin, get: (path: string) => fetch(`${hub.base}${path}`, { headers: { cookie: admin, [VIEW_AS_HEADER]: token } }) };
}

test('with no pack index, or one in another shape, a view still serves only what both the partner and the admin see', async () => {
  for (const hub of [missing, raw]) {
    const rita = await login(hub, 'rita@reseller.test');
    assert.equal((await fetch(`${hub.base}/catalog/inst/emea-only/png`, { headers: { cookie: rita } })).status, 200, 'the programme includes it');
    const { get } = await view(hub);
    assert.equal((await get('/catalog/inst/emea-only/png')).status, 403, 'the admin\'s own groups do not show it');
    assert.equal((await get('/api/v1/catalog/assets/inst/emea-only')).status, 404);
  }
});

test('the admin behind a view is not a group: a grant on a look-alike group gives the view nothing', async () => {
  const { get } = await view(missing);
  const adminId = (await missing.store.getUserBySub('dev:admin@test'))!.id;
  const grant = { principal: `group:view-as-viewer:${adminId}`, action: 'tool.use', resource: 'tool:internal-deck', effect: 'allow' };
  await missing.store.putGrant(grant as never);
  try {
    assert.equal((await get('/tools/internal-deck/tool.json')).status, 404, 'the partner cannot open it, so neither can the view');
  } finally { await missing.store.deleteGrant(grant as never); }
});

test('an admin whose own groups include a look-alike name still gets their view, with no loop', async () => {
  await login(missing, 'admin@test');
  const adminId = (await missing.store.getUserBySub('dev:admin@test'))!.id;
  // As an identity provider or SCIM could set it: the route itself refuses such a name.
  await missing.store.setLocalGroups(adminId, [`view-as-viewer:${adminId}`]);
  try {
    const { get } = await view(missing);
    for (const path of ['/catalog/assets/index.json', '/catalog/assets/index.json?paged=1']) {
      const res = await get(path);
      assert.ok(res.status < 500, `${path}: answered, nothing looped (${res.status})`);
      assert.ok(!(await res.text()).includes('inst/emea-only'), path);
    }
    assert.equal((await get('/api/v1/catalog/assets/inst/emea-only')).status, 404);
  } finally { await missing.store.setLocalGroups(adminId, []); }
});

test('paging in a view names only providers both the partner and the admin see', async () => {
  const rita = await login(raw, 'rita@reseller.test');
  const own = await (await fetch(`${raw.base}/catalog/assets/index.json?paged=1`, { headers: { cookie: rita } })).json() as { pagedProviders?: Array<{ id: string }> };
  assert.ok(own.pagedProviders?.some((p) => p.id === 'big'), 'the partner\'s own paged feed names the large provider');
  const { get } = await view(raw);
  const viewed = await (await get('/catalog/assets/index.json?paged=1')).json() as { assets: Array<{ id: string }>; pagedProviders?: Array<{ id: string }>; pendingProviders?: string[] };
  assert.ok(!viewed.pagedProviders?.some((p) => p.id === 'big'), 'not a provider the admin cannot see');
  assert.ok(!viewed.pendingProviders?.includes('big'));
  assert.ok(!viewed.assets.some((a) => a.id.startsWith('ext/big/')));
});

test('the intersection holds in every state of the pack index, raw and missing included', () => {
  const served = (status: ServedIndex['status'], ids: string[], providers: string[]): ServedIndex => ({
    status, sourceFingerprint: status, bytes: Buffer.from('{"raw":"file on disk"}'), etag: '"x"', version: 'x',
    index: { assets: ids.map((id) => ({ id, type: 'image' })), collections: [{ id: 'kit', members: ids }] } as never,
    providers: providers.map((id) => ({ id, label: id, size: 1 })) as never, sorted: () => [],
  });
  const mine = served('composed', ['inst/shared'], ['dam']);
  for (const status of ['composed', 'raw', 'missing'] as const) {
    const both = intersectServed(served(status, ['inst/shared', 'inst/emea-only', 'ext/big/b1'], ['dam', 'big']), mine);
    assert.deepEqual((both.index.assets ?? []).map((a) => a.id), ['inst/shared'], status);
    assert.deepEqual((both.index.collections as Array<{ members: string[] }>)[0]!.members, ['inst/shared'], status);
    assert.deepEqual(both.providers.map((p) => p.id), ['dam'], status);
    assert.ok(!both.bytes.toString().includes('file on disk'), `${status}: never the partner's own bytes`);
  }
});
