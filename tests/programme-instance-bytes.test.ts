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

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-inst-bytes-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Bytes Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@reseller.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  for (const [id, groups] of [['inst/internal', '*'], ['inst/kit', ['marketing']]] as const) {
    const stat = await blobs.put(`${id}/png`, Buffer.from(`png:${id}`), 'image/png');
    await store.putInstanceAsset({
      id, entry: instanceAssetEntry(id, { name: id, type: 'image' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]),
      blobs: { png: `${id}/png` }, groups: groups as never, createdAt: new Date().toISOString(),
    } as never);
  }
  await store.putCollection({ id: 'emea-kit', name: 'EMEA kit', members: ['inst/kit'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, blobs, secrets: { session: 'sb', link: 'lb' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  await fetch(`${base}/api/v1/programmes/resellers`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Resellers', tools: [], collections: ['emea-kit'] }) });
  await login('rita@reseller.test');
  const ritaId = (await store.getUserBySub('dev:rita@reseller.test'))!.id;
  await fetch(`${base}/api/v1/users/${ritaId}/local-groups`, { method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ groups: ['programme-resellers'] }) });
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
  assert.equal((await bytes(rita, 'inst/internal')).status, 403, 'published to everyone, but not to their programme');
  assert.equal((await bytes(rita, 'inst/internal', '?v=1')).status, 403, 'nor a prior version of it');
});

test('staff are unchanged: everyone means everyone inside the workspace', async () => {
  const staff = await login('staff@test');
  assert.equal((await bytes(staff, 'inst/internal')).status, 200);
  assert.equal((await bytes(staff, 'inst/kit')).status, 200);
});
