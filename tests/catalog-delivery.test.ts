// SPDX-License-Identifier: MPL-2.0
/** Two independent serving apps share revision/history storage but never share grants. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { canonicalJson, sha256Hex } from '../server/src/lib/crypto.ts';
import { completeToolFileDigests, createCatalogSigning, toolDirectoryDigests } from '../server/src/catalog/signing.ts';
import { catalogPublication } from '../server/src/catalog/publication.ts';
let pack: string, base: string, second: string, brand: string, marketing: string, retainedHash: string;
const servers: Server[] = [], store = createMemoryStore();
const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
const material = JSON.stringify(await webcrypto.subtle.exportKey('jwk', key.privateKey));
interface Envelope { seq: number; catalogScope: string; indexHash: string; assetIndexHash: string; slimHash: string; toolDirs: Record<string, string>; files: Record<string, string> }
async function start(generation?: number): Promise<string> {
  const config = parseConfig(JSON.stringify({ instance: { name: 'Delivery', baseUrl: 'http://localhost', pack, ...(generation === undefined ? {} : { catalogPublicationGeneration: generation }) }, policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false }, dev: { enabled: true, users: [{ email: 'brand@test', groups: ['brand'] }, { email: 'marketing@test', groups: ['marketing'] }] } }));
  const app = buildApp({ config, store, secrets: { session: 'delivery-session', link: 'delivery-link', catalogSigningKey: material } });
  const server = createServer((req, res) => void app(req, res)); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); return `http://127.0.0.1:${address.port}`;
}
const read = (origin: string, path: string, cookie: string) => fetch(origin + path, { headers: { cookie, 'accept-encoding': 'identity' } });
const envelope = async (origin: string, cookie: string) => { const res = await read(origin, '/catalog/tools/index.sig.json', cookie); assert.equal(res.status, 200); return res.json() as Promise<Envelope>; };
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-delivery-catalog-'));
  for (const id of ['open', 'secret']) { await mkdir(join(pack, 'tools', id, 'lib'), { recursive: true }); await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify({ id })); await writeFile(join(pack, 'tools', id, 'lib/helper.js'), `export const name='${id}'`); }
  await mkdir(join(pack, 'catalog/tools'), { recursive: true });
  const tools = [{ id: 'open', name: 'Open' }, { id: 'secret', name: 'Secret' }];
  for (const file of ['index.json', 'index.slim.json']) await writeFile(join(pack, 'catalog/tools', file), JSON.stringify({ tools }));
  await mkdir(join(pack, 'catalog/assets'), { recursive: true }); await writeFile(join(pack, 'catalog/assets/logo.svg'), '<svg>fixture</svg>');
  await writeFile(join(pack, 'catalog/assets/index.json'), JSON.stringify({ assets: [{ id: 'fixture/logo', type: 'image', version: '1', formats: [{ format: 'svg', url: '/catalog/assets/logo.svg', checksum: 'sha256-' + Buffer.from(sha256Hex('<svg>fixture</svg>'), 'hex').toString('base64') }] }] }));
  const retained = { 'tool.json': Buffer.from('{"id":"open"}'), 'lib/helper.js': Buffer.from('export const prior=1') };
  const digests = Object.fromEntries(Object.entries(retained).map(([path, bytes]) => [path, sha256Hex(bytes)]));
  retainedHash = sha256Hex(canonicalJson(digests)).slice(0, 16);
  await mkdir(join(pack, `tools/open@${retainedHash}/lib`), { recursive: true });
  for (const [path, bytes] of Object.entries(retained)) await writeFile(join(pack, `tools/open@${retainedHash}`, path), bytes);
  await writeFile(join(pack, 'catalog/delivery-manifest.json'), JSON.stringify({ version: 1, files: Object.entries(retained).map(([path, bytes]) => ({ path: `tools/open@${retainedHash}/${path}`, sha256: sha256Hex(bytes), size: bytes.length })) }));
  await store.putOverlay({ toolId: 'secret', version: 1, visibility: { groups: ['brand'] } }); base = await start();
  for (const [email, role] of [['brand@test', 'brand'], ['marketing@test', 'marketing']]) {
    const res = await fetch(base + '/api/auth/dev?email=' + encodeURIComponent(email!), { redirect: 'manual' }); assert.equal(res.status, 302, await res.text()); const cookie = res.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
    if (role === 'brand') brand = cookie; else marketing = cookie;
  }
});
after(async () => { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); await rm(pack, { recursive: true, force: true }); });

test('each signed hash names exactly its filtered byte stream and tool directory', async () => {
  const a = await envelope(base, brand), b = await envelope(base, marketing);
  assert.equal(a.seq, b.seq); assert.notEqual(a.catalogScope, b.catalogScope); assert.notEqual(a.indexHash, b.indexHash);
  for (const [cookie, env] of [[brand, a], [marketing, b]] as const) {
    for (const [hash, path] of [[env.indexHash, '/catalog/tools/index'], [env.assetIndexHash, '/catalog/assets/index'], [env.slimHash, '/catalog/tools/index.slim']]) {
      const res = await read(base, `${path}.${hash!.slice(0, 16)}.json`, cookie); assert.equal(res.status, 200);
      assert.equal(sha256Hex(Buffer.from(await res.arrayBuffer())), hash); assert.equal(res.headers.get('cdn-cache-control'), 'no-store');
    }
    const alias = await read(base, `/tools/open@${env.toolDirs.open!.slice(0, 16)}/lib/helper.js`, cookie); assert.equal(alias.status, 200); assert.equal(sha256Hex(Buffer.from(await alias.arrayBuffer())), env.files['open/lib/helper.js']);
    assert.equal((await read(base, '/tools/open@0000000000000000/lib/helper.js', cookie)).status, 404);
  }
  assert.equal((await read(base, `/catalog/tools/index.${a.indexHash.slice(0, 16)}.json`, marketing)).status, 404);
  assert.equal((await read(base, `/tools/secret@${a.toolDirs.secret!.slice(0, 16)}/tool.json`, marketing)).status, 404);
});

test('history survives a new app and revisions advance when an older state returns', async () => {
  const old = await envelope(base, brand);
  await store.putOverlay({ toolId: 'secret', version: 2, visibility: { groups: ['brand', 'marketing'] } });
  const changed = await envelope(base, brand); assert.ok(changed.seq > old.seq);
  second = await start(); const restarted = await envelope(second, brand); assert.equal(restarted.seq, changed.seq);
  const historic = await read(second, `/catalog/tools/index.${old.indexHash.slice(0, 16)}.json`, brand); assert.equal(historic.status, 200); assert.equal(sha256Hex(Buffer.from(await historic.arrayBuffer())), old.indexHash);
  await store.putOverlay({ toolId: 'secret', version: 3, visibility: { groups: ['brand'] } });
  const restored = await envelope(second, brand); assert.equal(restored.indexHash, old.indexHash); assert.ok(restored.seq > restarted.seq);
  await store.putOverlay({ toolId: 'secret', version: 4, visibility: { groups: ['restricted'] } });
  assert.equal((await read(second, `/catalog/tools/index.${old.indexHash.slice(0, 16)}.json`, brand)).status, 404);
  assert.equal((await read(second, `/tools/secret@${old.toolDirs.secret!.slice(0, 16)}/tool.json`, brand)).status, 404);
});

test('digest aliases require current asset lifecycle and refuse guessed or retired content', async () => {
  const hash = sha256Hex('<svg>fixture</svg>'), path = `/catalog/assets/logo.${hash.slice(0, 16)}.svg`;
  const res = await read(base, path, brand); assert.equal(res.status, 200); assert.equal(sha256Hex(Buffer.from(await res.arrayBuffer())), hash);
  assert.equal((await read(base, '/catalog/assets/logo.0000000000000000.svg', brand)).status, 404);
  const old = await envelope(base, brand);
  await store.putLifecycle({ assetId: 'fixture/logo', onExpiry: 'hide', revokedAt: new Date().toISOString() });
  assert.equal((await read(base, path, brand)).status, 404);
  assert.equal((await read(base, `/catalog/assets/index.${old.assetIndexHash.slice(0, 16)}.json`, brand)).status, 404);
});

test('the store retains promised history, refuses overflow, and expires without reopening access', async () => {
  const isolated = createMemoryStore(), bytes = Buffer.from('snapshot'), scope = 'a'.repeat(64), hash = sha256Hex(bytes);
  assert.equal(await isolated.putCatalogDeliverySnapshot({ scope, kind: 'tools', hash, bytes, until: 3600000, toolIds: [], assetIds: [] }, 0, bytes.length), true);
  assert.equal(await isolated.putCatalogDeliverySnapshot({ scope, kind: 'tools', hash: sha256Hex('other'), bytes: Buffer.from('other'), until: 3600000, toolIds: [], assetIds: [] }, 1, bytes.length), false);
  assert.deepEqual((await isolated.getCatalogDeliverySnapshot(scope, 'tools', hash.slice(0, 16), 3599999))?.bytes, bytes);
  assert.equal(await isolated.getCatalogDeliverySnapshot(scope, 'tools', hash.slice(0, 16), 3600000), null);
});


test('retained tool versions revalidate current grants even for conditional requests', async () => {
  const path = `/tools/open@${retainedHash}/lib/helper.js`, current = await read(base, path, brand);
  assert.equal(current.status, 200); assert.equal(await current.text(), 'export const prior=1');
  const etag = current.headers.get('etag')!;
  assert.equal((await fetch(base + path, { method: 'HEAD', headers: { cookie: brand } })).headers.get('etag'), etag);
  await store.putOverlay({ toolId: 'open', version: 1, visibility: { groups: ['restricted'] } });
  try {
    const denied = await fetch(base + path, { headers: { cookie: brand, 'if-none-match': etag } });
    assert.equal(denied.status, 404); assert.equal(denied.headers.get('cdn-cache-control'), 'no-store');
  } finally { await store.deleteOverlay('open'); }
  const prior = await readFile(join(pack, `tools/open@${retainedHash}/lib/helper.js`));
  await writeFile(join(pack, `tools/open@${retainedHash}/lib/helper.js`), 'corrupt');
  try { assert.equal((await read(base, path, brand)).status, 404); }
  finally { await writeFile(join(pack, `tools/open@${retainedHash}/lib/helper.js`), prior); }
});

test('different actual mounted bytes at one generation and old replicas cannot publish', async () => {
  const old = await envelope(base, brand);
  const path = join(pack, 'catalog/tools/index.json'), original = await readFile(path);
  try {
    await writeFile(path, JSON.stringify({ tools: [{ id: 'open', name: 'New release' }] }));
    const conflict = await start();
    const refused = await read(conflict, '/catalog/tools/index.sig.json', brand);
    assert.equal(refused.status, 503); assert.match(JSON.stringify(await refused.json()), /publication/i);
    const newer = await start(2); const accepted = await envelope(newer, brand); assert.ok(accepted.seq > old.seq);
    assert.equal((await read(base, '/catalog/tools/index.sig.json', brand)).status, 503);
  } finally { await writeFile(path, original); }
});

test('publication floors require verified source signatures and complete source bytes', async () => {
  const source = await mkdtemp(join(tmpdir(), 'lw-delivery-source-'));
  try {
    await mkdir(join(source, 'catalog/tools'), { recursive: true }); await mkdir(join(source, 'tools/open/lib'), { recursive: true });
    const index = Buffer.from(JSON.stringify({ tools: [{ id: 'open' }] }));
    await writeFile(join(source, 'catalog/tools/index.json'), index);
    await writeFile(join(source, 'tools/open/tool.json'), '{"id":"open"}');
    await writeFile(join(source, 'tools/open/lib/help.js'), 'export const help=1');
    const signer = createCatalogSigning(material), files = await completeToolFileDigests(source);
    const signed = await signer.envelopeFor(source, { bytes: index, json: true, visible: () => true }, { seq: 4, catalogScope: 'a'.repeat(64) });
    const envelopePath = join(source, 'catalog/tools/index.sig.json'); await writeFile(envelopePath, signed);
    assert.equal((await catalogPublication({ pack: source, signing: signer })).generation, 4);
    await assert.rejects(catalogPublication({ pack: source, signing: null }), /could not be verified/);
    const forged = JSON.parse(signed.toString()); forged.seq = 400; await writeFile(envelopePath, JSON.stringify(forged));
    await assert.rejects(catalogPublication({ pack: source, signing: signer, generation: 500 }), /could not be verified/);
    await writeFile(envelopePath, signed); await writeFile(join(source, 'tools/open/lib/help.js'), 'altered');
    assert.notEqual((await completeToolFileDigests(source))['open/lib/help.js'], files['open/lib/help.js']);
    await assert.rejects(catalogPublication({ pack: source, signing: signer }), /could not be verified/);
  } finally { await rm(source, { recursive: true, force: true }); }
});

test('the global fence advances rights A to B to A but never adopts a legacy source again', async () => {
  const isolated = createMemoryStore(), pub = { generation: 0, digest: 'a'.repeat(64) };
  assert.equal(await isolated.catalogDeliverySequence('b'.repeat(64), pub), 1);
  assert.equal(await isolated.catalogDeliverySequence('c'.repeat(64), pub), 2);
  assert.equal(await isolated.catalogDeliverySequence('b'.repeat(64), pub), 3);
  await assert.rejects(isolated.catalogDeliverySequence('b'.repeat(64), { ...pub, digest: 'd'.repeat(64) }), /publication/i);
  assert.equal(await isolated.catalogDeliverySequence('b'.repeat(64), { generation: 1, digest: pub.digest }), 4);
  await assert.rejects(isolated.catalogDeliverySequence('b'.repeat(64), pub), /publication/i);
});


test('directory identity includes prototype-named files as ordinary signed bytes', () => {
  const digest = sha256Hex('signed file'), expected = Object.fromEntries([['__proto__', digest], ['lib/help.js', digest]]);
  assert.equal(toolDirectoryDigests({ 'open/__proto__': digest, 'open/lib/help.js': digest }).open, sha256Hex(canonicalJson(expected)));
});

test('complete directory identity includes safe dotfiles and refuses URL-ambiguous names', async () => {
  const source = await mkdtemp(join(tmpdir(), 'lw-delivery-dotfiles-'));
  try {
    await mkdir(join(source, 'tools/open'), { recursive: true });
    await writeFile(join(source, 'tools/open/tool.json'), '{"id":"open"}');
    await writeFile(join(source, 'tools/open/.config.json'), '{"safe":true}');
    assert.equal((await completeToolFileDigests(source))['open/.config.json'], sha256Hex('{"safe":true}'));
    const original = await catalogPublication({ pack: source, signing: null });
    await writeFile(join(source, 'tools/open/.config.json'), '{"safe":"changed"}');
    assert.notEqual((await catalogPublication({ pack: source, signing: null })).digest, original.digest, 'the static publication fence covers signed dotfiles');
    await writeFile(join(source, 'tools/open/space name.txt'), 'unsafe URL');
    await assert.rejects(completeToolFileDigests(source), /unsafe file name/);
  } finally { await rm(source, { recursive: true, force: true }); }
});
