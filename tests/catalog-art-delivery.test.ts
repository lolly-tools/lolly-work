// SPDX-License-Identifier: MPL-2.0
/** Real HTTP admission for inventory-addressed gallery art and retained aliases. */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { buildPathMap, type AssetIndexEntry } from '../server/src/catalog/lifecycle.ts';

const servers: Server[] = [], roots: string[] = [];
after(async () => {
  await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
});

async function instance(options: { ambiguous?: boolean; unsigned?: boolean; mismatchedFullSha?: boolean } = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-art-delivery-')); roots.push(pack);
  const inventory: Array<{ path: string; size: number; sha256: string }> = [];
  const paths: Record<string, string> = {};
  const put = async (path: string, body: string) => {
    await mkdir(join(pack, path, '..'), { recursive: true }); await writeFile(join(pack, path), body);
  };
  for (const [name, original, body] of [
    ['preview', 'catalog/previews/open.look2.svg', '<svg>open preview</svg>'],
    ['restrictedPreview', 'catalog/previews/staff.svg', '<svg>staff preview</svg>'],
    ['card', 'catalog/og/open.png', 'open card'],
    ['restrictedCard', 'catalog/og/staff.png', 'staff card'],
    ['view', 'catalog/og/views/a.png', 'view card'],
    ['unknown', 'catalog/previews/ghost.svg', '<svg>unknown tool</svg>'],
    ['badFullHash', 'catalog/previews/open.look3.svg', '<svg>bad full hash</svg>'],
    ['missingHash', 'catalog/previews/open.look4.svg', '<svg>missing inventory</svg>'],
    ['badPrefix', 'catalog/previews/open.look5.svg', '<svg>wrong short hash</svg>'],
    ['badCardFullHash', 'catalog/og/open.webp', 'bad full card hash'],
    ['missingCardHash', 'catalog/og/open.jpg', 'missing card inventory'],
    ['badCardPrefix', 'catalog/og/open.jpeg', 'wrong short card hash'],
  ]) {
    const digest = sha256Hex(body!);
    const path = original!.replace(/(\.[a-z]+)$/, `.${name!.endsWith('Prefix') ? '0'.repeat(16) : digest.slice(0, 16)}$1`);
    await put(original!, body!); await put(path, body!); paths[name!] = '/' + path;
    if (!name!.startsWith('missing')) inventory.push({ path, size: Buffer.byteLength(body!), sha256: name!.endsWith('FullHash') ? digest.slice(0, 16) + '0'.repeat(48) : digest });
  }
  const assets: AssetIndexEntry[] = [];
  for (const id of ['live', 'revoked', 'scheduled', 'expired', 'warning', 'localized', 'assetPreview', 'windowed']) {
    const body = `<svg>${id}</svg>`, digest = sha256Hex(body), legacy = id === 'assetPreview' ? 'catalog/previews/open.look7.svg' : `catalog/assets/${id}.svg`;
    const path = legacy.replace('.svg', `.${digest.slice(0, 16)}.svg`);
    await put(legacy, body); await put(path, body); paths[id] = '/' + legacy; paths[id + 'Hash'] = '/' + path;
    const expected = options.mismatchedFullSha && ['live', 'localized'].includes(id) ? digest.slice(0, 16) + '0'.repeat(48) : digest;
    const format = { format: 'svg', url: '/' + path, checksum: 'sha256-' + Buffer.from(expected, 'hex').toString('base64'), size: Buffer.byteLength(body) };
    assets.push({ id, type: 'image', ...(id === 'windowed' ? { availableFrom: '2999-01-01T00:00:00Z' } : {}), ...(id === 'localized' ? { formats: [], locales: { de: [format] } } : { formats: [format] }) });
    inventory.push({ path, size: Buffer.byteLength(body), sha256: digest });
  }
  if (options.ambiguous) assets.push({ id: 'conflicting-owner', type: 'image', formats: [{ format: 'svg', url: paths.live! }] });
  if (options.unsigned) assets[0]!.formats![0]!.checksum = 'sha256-invalid';
  await put('catalog/assets/index.json', JSON.stringify({ assets }));
  await put('catalog/tools/index.json', JSON.stringify({ tools: [{ id: 'open' }, { id: 'staff' }] }));
  await put('catalog/delivery-manifest.json', JSON.stringify({ version: 1, files: inventory }));
  const store = createMemoryStore();
  await store.putOverlay({ toolId: 'staff', version: 1, visibility: { groups: ['staff'] } });
  await store.putLifecycle({ assetId: 'revoked', revokedAt: '2020-01-01T00:00:00Z', onExpiry: 'hide' });
  await store.putLifecycle({ assetId: 'scheduled', validFrom: '2999-01-01T00:00:00Z', onExpiry: 'hide' });
  await store.putLifecycle({ assetId: 'expired', validUntil: '2020-01-01T00:00:00Z', onExpiry: 'hide' });
  await store.putLifecycle({ assetId: 'warning', validUntil: '2020-01-01T00:00:00Z', onExpiry: 'warn' });
  await store.putLifecycle({ assetId: 'assetPreview', revokedAt: '2020-01-01T00:00:00Z', onExpiry: 'hide' });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Art', baseUrl: 'http://localhost', pack },
    policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'staff@test', groups: ['staff'] }, { email: 'member@test', groups: ['members'] }] } }));
  const app = buildApp({ config, store, secrets: { session: 'art-session', link: 'art-link' } });
  const server = createServer((req, res) => void app(req, res)); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => {
    const response = await fetch(base + '/api/auth/dev?email=' + encodeURIComponent(email), { redirect: 'manual' });
    assert.equal(response.status, 302);
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('lw_session='))?.split(';')[0]; assert.ok(cookie); return cookie;
  };
  return { pack, paths, store, base, staff: await login('staff@test'), member: await login('member@test') };
}

test('hashed preview and social-card bytes follow current tool grants and cache privacy', async () => {
  const { paths, base, staff, member, store } = await instance();
  const get = (path: string, cookie?: string, method = 'GET', extra: Record<string, string> = {}) => fetch(base + path, { method, headers: { ...(cookie ? { cookie } : {}), ...extra } });
  const preview = await get(paths.preview!, member); assert.equal(preview.status, 200); assert.equal(await preview.text(), '<svg>open preview</svg>');
  assert.equal(preview.headers.get('cache-control'), 'private, no-cache, no-transform'); assert.equal(preview.headers.get('cdn-cache-control'), 'no-store');
  const ranged = await get(paths.preview!, member, 'GET', { range: 'bytes=0-4' }); assert.equal(ranged.status, 206); assert.equal(await ranged.text(), '<svg>');
  assert.equal((await get(paths.preview!)).status, 401);
  assert.equal((await get(paths.restrictedPreview!, member)).status, 404);
  assert.equal((await get(paths.restrictedPreview!, staff)).status, 200);
  const card = await get(paths.card!); assert.equal(card.status, 200); assert.equal(await card.text(), 'open card');
  assert.equal(card.headers.get('cache-control'), 'public, max-age=3600, s-maxage=3600, no-transform');
  assert.equal((await get(paths.card!, member)).headers.get('cdn-cache-control'), 'no-store', 'credentials downgrade even globally visible cards');
  assert.equal((await get(paths.view!)).status, 200);
  assert.equal((await get(paths.restrictedCard!)).status, 404); assert.equal((await get(paths.restrictedCard!, member)).status, 404);
  const restricted = await get(paths.restrictedCard!, staff); assert.equal(restricted.status, 200); assert.equal(restricted.headers.get('cdn-cache-control'), 'no-store');
  const etag = preview.headers.get('etag')!;
  assert.equal((await get(paths.preview!, member, 'HEAD')).headers.get('etag'), etag);
  assert.equal((await get(paths.preview!, member, 'GET', { 'if-none-match': etag })).status, 304);
  await store.putOverlay({ toolId: 'open', version: 1, visibility: { groups: ['staff'] } });
  const denied = await get(paths.preview!, member, 'GET', { 'if-none-match': etag }); assert.equal(denied.status, 404); assert.equal(denied.headers.get('cdn-cache-control'), 'no-store');
  assert.equal((await get(paths.card!)).status, 404);
});

test('tool art requires the precise namespace, current tool and full inventory digest', async () => {
  const { paths, pack, base, member } = await instance();
  for (const name of ['unknown', 'badFullHash', 'missingHash', 'badPrefix', 'badCardFullHash', 'missingCardHash', 'badCardPrefix']) {
    const response = await fetch(base + paths[name], { headers: { cookie: member } }); assert.equal(response.status, 404, name);
  }
  assert.equal((await fetch(base + '/catalog/previews/open/nested.0000000000000000.svg', { headers: { cookie: member } })).status, 404);
  const path = paths.card!.slice(1); await writeFile(join(pack, path), 'corrupt card');
  assert.equal((await fetch(base + paths.card)).status, 404, 'a cached public card cannot survive changed bytes');
});

test('retained asset aliases enforce revocation, scheduling, hidden expiry and caller admission', async () => {
  const { paths, base, member, store } = await instance();
  const get = (name: string, method = 'GET', extra: Record<string, string> = {}) => fetch(base + paths[name], { method, headers: { cookie: member, ...extra } });
  for (const name of ['live', 'liveHash', 'warning', 'warningHash', 'localized', 'localizedHash']) assert.equal((await get(name)).status, 200, name);
  for (const name of ['revoked', 'scheduled', 'expired', 'assetPreview']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await get(name, method, { range: 'bytes=0-4', 'if-none-match': '*' });
      assert.equal(response.status, 410, `${name} ${method}`); assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
    }
    assert.equal((await get(name + 'Hash')).status, 404, 'the hashed address also requires the current feed');
  }
  assert.equal((await fetch(base + paths.live)).status, 401);
  for (const name of ['windowed', 'windowedHash']) assert.equal((await get(name)).status, 404, 'upstream availability remains an access restriction');
  const live = await get('live'), etag = live.headers.get('etag')!;
  await store.putLifecycle({ assetId: 'live', revokedAt: '2020-01-01T00:00:00Z', onExpiry: 'hide' });
  assert.equal((await get('live', 'GET', { 'if-none-match': etag })).status, 410);
});

test('alias ownership rejects ambiguous paths and unsigned short hashes', () => {
  const digest = sha256Hex('asset'), checksum = 'sha256-' + Buffer.from(digest, 'hex').toString('base64');
  const format = { format: 'svg', url: `/catalog/assets/a.${digest.slice(0, 16)}.svg`, checksum };
  const map = buildPathMap({ assets: [{ id: 'a', formats: [format] }] });
  assert.equal(map.get('assets/a.svg'), 'a');
  assert.throws(() => buildPathMap({ assets: [{ id: 'a', formats: [format] }, { id: 'b', formats: [{ format: 'svg', url: '/catalog/assets/a.svg' }] }] }), /ambiguous/);
  assert.throws(() => buildPathMap({ assets: [{ id: 'a', formats: [{ ...format, checksum: 'sha256-invalid' }] }] }), /checksum/);
});

test('malformed source ownership fails closed on retained aliases over HTTP', async () => {
  for (const options of [{ ambiguous: true }, { unsigned: true }]) {
    const { base, paths, member } = await instance(options);
    const response = await fetch(base + paths.live, { headers: { cookie: member, 'if-none-match': '*' } });
    assert.equal(response.status, 503); assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /<svg>/);
  }
});

test('hashed assets require the full current or localized SRI before conditional or range delivery', async () => {
  const valid = await instance();
  for (const name of ['liveHash', 'localizedHash']) {
    const path = valid.paths[name]!, headers = { cookie: valid.member };
    const original = await fetch(valid.base + path, { headers }); assert.equal(original.status, 200);
    const etag = original.headers.get('etag')!; await original.arrayBuffer();
    assert.equal((await fetch(valid.base + path, { headers: { ...headers, range: 'bytes=0-4' } })).status, 206);
    await writeFile(join(valid.pack, path.slice(1)), '<svg>corrupt release</svg>');
    for (const method of ['GET', 'HEAD']) {
      const denied = await fetch(valid.base + path, { method, headers: { ...headers, 'if-none-match': etag, range: 'bytes=0-4' } });
      assert.equal(denied.status, 404); assert.equal(denied.headers.get('cdn-cache-control'), 'no-store');
    }
  }
  // The URL prefix still agrees with these claimed checksums; only the full SHA differs.
  const mismatch = await instance({ mismatchedFullSha: true });
  for (const name of ['liveHash', 'localizedHash']) {
    for (const method of ['GET', 'HEAD']) {
      const denied = await fetch(mismatch.base + mismatch.paths[name], { method, headers: { cookie: mismatch.member, 'if-none-match': '*', range: 'bytes=0-4' } });
      assert.equal(denied.status, 404); assert.equal(denied.headers.get('cdn-cache-control'), 'no-store');
    }
  }
  const unsigned = await instance({ unsigned: true });
  assert.equal((await fetch(unsigned.base + unsigned.paths.liveHash, { headers: { cookie: unsigned.member } })).status, 404);
});
