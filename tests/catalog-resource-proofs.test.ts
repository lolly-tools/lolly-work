// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { publisherResourceDigests, scopedResourceDigests, catalogResourcePath } from '../server/src/catalog/resource-proofs.ts';
import { completeToolFileDigests, createCatalogSigning, servedToolIndexBytes, type CatalogCaller } from '../server/src/catalog/signing.ts';
import { servedToolSidecar } from '../server/src/catalog/tool-sidecars.ts';
import { canonicalJson, sha256Hex } from '../server/src/lib/crypto.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';

const specifier: string = '@lolly/engine';
const engine = await import(specifier) as {
  CATALOG_SIG_ALG: string;
  jwkThumbprint(jwk: webcrypto.JsonWebKey): Promise<string>;
  signCatalogEnvelope(value: Record<string, unknown>, key: webcrypto.CryptoKey): Promise<Record<string, unknown>>;
  verifyCatalogEnvelope(envelope: unknown, index: Uint8Array, key: webcrypto.CryptoKey): Promise<{ ok: boolean }>;
};

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const pack = await mkdtemp(join(tmpdir(), 'resource-proof-')), shell = await mkdtemp(join(tmpdir(), 'resource-shell-'));
  t.after(async () => { await rm(pack, { force: true, recursive: true }); await rm(shell, { force: true, recursive: true }); });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const key = await webcrypto.subtle.exportKey('jwk', pair.publicKey), privateKey = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const index = { tools: [{ id: 'open', preview: '/catalog/previews/open.svg', looks: [{ thumb: '/info/shots/open.png' }] },
    { id: 'hidden', preview: '/catalog/previews/hidden.svg' }] };
  const originalBundle = Buffer.from(JSON.stringify({ 'open:0': { src: '/catalog/previews/open.look0.svg' }, 'hidden:0': { src: '/catalog/previews/hidden.look0.svg' },
    'retired:0': { src: '/catalog/previews/unreferenced.svg' } }, null, 2));
  const bytes: Record<string, Buffer> = {
    '/catalog/previews/bundle.json': originalBundle, '/catalog/previews/open.svg': Buffer.from('open-preview'),
    '/catalog/previews/hidden.svg': Buffer.from('hidden-preview'), '/catalog/previews/open.look0.svg': Buffer.from('open-look'),
    '/catalog/previews/hidden.look0.svg': Buffer.from('hidden-look'), '/info/shots/open.png': Buffer.from('open-shot'),
    '/catalog/og/open.png': Buffer.from('open-card'), '/catalog/previews/unreferenced.svg': Buffer.from('not-referenced'),
  };
  for (const [path, value] of Object.entries(bytes)) {
    const root = path.startsWith('/info/') || path.startsWith('/catalog/og/') ? shell : pack;
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), value);
  }
  await mkdir(join(pack, 'catalog/tools'), { recursive: true });
  await writeFile(join(pack, 'catalog/tools/index.json'), JSON.stringify(index));
  await writeFile(join(pack, 'catalog/tools/index.slim.json'), JSON.stringify(index));
  for (const id of ['open', 'hidden']) {
    await mkdir(join(pack, 'tools', id), { recursive: true }); await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify({ id }));
  }
  const resources = Object.fromEntries(Object.entries(bytes).map(([path, value]) => [path, sha256Hex(value)]));
  const envelope = await engine.signCatalogEnvelope({ alg: engine.CATALOG_SIG_ALG, keyId: await engine.jwkThumbprint(key), signedAt: new Date().toISOString(),
    indexHash: sha256Hex(JSON.stringify(index)), files: await completeToolFileDigests(pack), seq: 1, resources }, pair.privateKey);
  await writeFile(join(pack, 'catalog/tools/index.sig.json'), JSON.stringify(envelope));
  const caller: CatalogCaller = { groups: [], overlays: new Map([['hidden', { toolId: 'hidden', version: 1, visibility: { groups: ['allowed'] } }]]) };
  return { pack, shell, key, privateKey, pair, resources, index, envelope, caller };
}

test('publisher media maps require a valid signature and safe exact paths', async t => {
  const f = await fixture(t);
  assert.deepEqual(await publisherResourceDigests({ pack: f.pack, publicKey: { ...f.key }, signing: null }), f.resources);
  await writeFile(join(f.pack, 'catalog/tools/index.sig.json'), JSON.stringify({ ...f.envelope, resources: { ...f.resources, '/catalog/previews/changed.svg': '0'.repeat(64) } }));
  assert.deepEqual(await publisherResourceDigests({ pack: f.pack, publicKey: { ...f.key }, signing: null }), {});
  assert.deepEqual(await publisherResourceDigests({ pack: f.pack, signing: null }), {});
  for (const path of ['/catalog/previews/a%2e.svg', '/catalog/previews/../a.svg', '/catalog/previews//a.svg', '/catalog/previews/a.svg?x', '/catalog/previews/a.svg#x', '/tools/open/hooks.js', '/catalog/assets/private.svg']) assert.equal(catalogResourcePath(path), false, path);
});

test('scoped media proofs filter the verified original bundle, preserve exact shell proofs and omit hidden media', async t => {
  const f = await fixture(t);
  const served = await servedToolIndexBytes(f.pack, f.caller); assert.ok(served);
  const visible = JSON.parse(served.bytes.toString());
  visible.tools[0].og = '/catalog/og/open.png';
  const resources = await scopedResourceDigests({ pack: f.pack, shellDir: f.shell, publisher: f.resources, caller: f.caller, visibleToolIds: new Set(['open']), visibleValues: [visible] });
  assert.deepEqual(Object.keys(resources).sort(), ['/catalog/og/open.png', '/catalog/previews/bundle.json', '/catalog/previews/open.look0.svg', '/catalog/previews/open.svg', '/info/shots/open.png']);
  const bundle = await servedToolSidecar(f.pack, 'previews/bundle.json', f.caller); assert.equal(bundle.kind, 'json');
  if (bundle.kind === 'json') {
    assert.equal(resources['/catalog/previews/bundle.json'], sha256Hex(bundle.bytes));
    assert.notEqual(resources['/catalog/previews/bundle.json'], f.resources['/catalog/previews/bundle.json']);
    assert.doesNotMatch(bundle.bytes.toString(), /hidden|retired/);
  }
  const signing = createCatalogSigning(JSON.stringify(f.privateKey));
  const signed = JSON.parse((await signing.envelopeFor(f.pack, served, { seq: 1, catalogScope: sha256Hex('visible'), resources })).toString());
  assert.equal((await engine.verifyCatalogEnvelope(signed, served.bytes, f.pair.publicKey)).ok, true);
  assert.equal(canonicalJson(signed.resources), canonicalJson(resources));
  signed.resources['/catalog/previews/open.svg'] = '0'.repeat(64);
  assert.equal((await engine.verifyCatalogEnvelope(signed, served.bytes, f.pair.publicKey)).ok, false);
});

test('missing or changed optional original bytes have no preview proof or filtered bundle trust', async t => {
  const f = await fixture(t);
  await writeFile(join(f.pack, 'catalog/previews/open.svg'), 'changed-preview');
  await writeFile(join(f.pack, 'catalog/previews/bundle.json'), JSON.stringify({ 'open:0': { src: '/catalog/previews/open.look0.svg', added: 'changed' } }));
  const resources = await scopedResourceDigests({ pack: f.pack, publisher: f.resources, caller: f.caller, visibleToolIds: new Set(['open']),
    visibleValues: [{ preview: '/catalog/previews/open.svg', thumb: '/info/shots/open.png' }] });
  assert.deepEqual(resources, {});
  assert.deepEqual(await scopedResourceDigests({ pack: f.pack, publisher: {}, caller: f.caller, visibleToolIds: new Set(['open']), visibleValues: [f.index] }), {});
});

test('retained shells prove only immutable media whose bytes match the signed publisher map', async t => {
  const f = await fixture(t), current = await mkdtemp(join(tmpdir(), 'resource-current-'));
  t.after(() => rm(current, { recursive: true, force: true }));
  const bytes = Buffer.from('retained-shot'), path = `/info/shots/open.${sha256Hex(bytes).slice(0, 16)}.png`;
  await writeFile(join(f.shell, path), bytes);
  const resources = { ...f.resources, [path]: sha256Hex(bytes) };
  const envelope = await engine.signCatalogEnvelope({ alg: engine.CATALOG_SIG_ALG, keyId: await engine.jwkThumbprint(f.key), signedAt: new Date().toISOString(),
    indexHash: sha256Hex(JSON.stringify(f.index)), files: await completeToolFileDigests(f.pack), seq: 1, resources }, f.pair.privateKey);
  await writeFile(join(f.pack, 'catalog/tools/index.sig.json'), JSON.stringify(envelope));
  const publisher = await publisherResourceDigests({ pack: f.pack, publicKey: { ...f.key }, signing: null });
  const options = { pack: f.pack, shellDirectories: [current, f.shell], publisher, caller: f.caller, visibleToolIds: new Set(['open']), visibleValues: [{ thumb: path, mutable: '/info/shots/open.png' }] };
  const proof = await scopedResourceDigests(options);
  assert.equal(proof[path], sha256Hex(bytes)); assert.equal(proof['/info/shots/open.png'], undefined);
  await writeFile(join(f.shell, path), 'corrupted'); assert.equal((await scopedResourceDigests(options))[path], undefined);
});

test('guest tool index, slim, files and media proofs include only the shared tool', async t => {
  const f = await fixture(t), caller = { ...f.caller, guestToolId: 'hidden' };
  const served = await servedToolIndexBytes(f.pack, caller); assert.ok(served);
  assert.deepEqual(JSON.parse(served.bytes.toString()).tools.map((row: { id: string }) => row.id), ['hidden']);
  const slim = await servedToolSidecar(f.pack, 'tools/index.slim.json', caller); assert.equal(slim.kind, 'json');
  if (slim.kind === 'json') assert.deepEqual(JSON.parse(slim.bytes.toString()).tools.map((row: { id: string }) => row.id), ['hidden']);
  const resources = await scopedResourceDigests({ pack: f.pack, publisher: f.resources, caller, visibleToolIds: new Set(['hidden']), visibleValues: [JSON.parse(served.bytes.toString())] });
  assert.deepEqual(Object.keys(resources).sort(), ['/catalog/previews/bundle.json', '/catalog/previews/hidden.look0.svg', '/catalog/previews/hidden.svg']);
  const signing = createCatalogSigning(JSON.stringify(f.privateKey));
  const envelope = JSON.parse((await signing.envelopeFor(f.pack, served, { seq: 1, catalogScope: sha256Hex('guest'), resources })).toString());
  assert.deepEqual(Object.keys(envelope.files), ['hidden/tool.json']);
  assert.equal((await engine.verifyCatalogEnvelope(envelope, served.bytes, f.pair.publicKey)).ok, true);
});

test('HTTP scoped envelopes bind the exact filtered preview bundle served to the caller', async t => {
  const f = await fixture(t), store = createMemoryStore(), secret = 'scoped-media-session';
  await store.putOverlay(f.caller.overlays.get('hidden')!);
  const app = buildApp({ store, config: parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, dev: { enabled: true }, rateLimit: { enabled: false },
    instance: { pack: f.pack, shellDir: f.shell, catalogPublicKey: f.key } })), secrets: { session: secret, link: 'scoped-media-link', catalogSigningKey: JSON.stringify(f.privateKey) }, backgroundPollMs: 0 });
  const user = await store.upsertUserBySub({ sub: 'dev:reader', email: 'reader@fixture.test', groups: [], role: 'member' });
  const cookie = mintSessionCookie({ sub: user.sub, email: user.email, groups: [], role: 'member', name: 'Reader' }, secret, false).split(';')[0]!;
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) => fetch(base + path, { headers: { cookie } });
  const index = await get('/catalog/tools/index.json'); assert.equal(index.status, 200, await index.clone().text());
  const envelope = await get('/catalog/tools/index.sig.json'); assert.equal(envelope.status, 200, await envelope.clone().text());
  const signed = await envelope.json() as { resources: Record<string, string> };
  assert.equal((await engine.verifyCatalogEnvelope(signed, new Uint8Array(await index.arrayBuffer()), f.pair.publicKey)).ok, true);
  const bundle = await get('/catalog/previews/bundle.json'); assert.equal(bundle.status, 200);
  const bytes = Buffer.from(await bundle.arrayBuffer());
  assert.equal(signed.resources['/catalog/previews/bundle.json'], sha256Hex(bytes));
  assert.doesNotMatch(bytes.toString(), /hidden/);
  assert.ok(signed.resources['/catalog/previews/open.svg']);
  assert.equal(signed.resources['/catalog/previews/hidden.svg'], undefined);
  assert.equal(signed.resources['/catalog/previews/unreferenced.svg'], undefined);
  assert.equal((await get('/tools/HIDDEN/tool.json')).status, 404);
  assert.equal((await get('/tools/OPEN/tool.json')).status, 200);
  await writeFile(join(f.pack, 'catalog/tools/index.json'), '{"tools":[{"id":"hidden"}');
  assert.equal((await get('/catalog/tools/index.json')).status, 404);
});
