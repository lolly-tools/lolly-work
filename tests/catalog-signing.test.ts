// SPDX-License-Identifier: MPL-2.0
/**
 * Per-caller catalog signing (server/src/catalog/signing.ts) over real HTTP:
 * two callers whose groups see different tools each get a tool index and an
 * envelope that verifies against the EXACT bytes that caller was served, with
 * the engine's own verifier, and the envelope names only the tools that caller
 * may fetch. Without a key the routes behave as before.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import {
  SIGNED_I18N_SIDECAR, SIGNED_TEMPLATE_FILE, computeToolFileDigests, importCatalogSigningKey,
} from '../server/src/catalog/signing.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_SPECIFIER: string = '@lolly/engine';
interface Envelope { alg: string; keyId: string; indexHash: string; files: Record<string, string>; signature: string }
type Result = { ok: boolean; reason?: string };
const engine = await import(ENGINE_SPECIFIER) as {
  CATALOG_SIGNED_TOOL_FILES: readonly string[];
  jwkThumbprint(jwk: webcrypto.JsonWebKey): Promise<string>;
  verifyCatalogEnvelope(env: Envelope, bytes: Uint8Array, key: webcrypto.CryptoKey): Promise<Result>;
  verifyToolFile(env: Envelope, toolId: string, filename: string, bytes: Uint8Array): Promise<Result>;
};

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const pair = await webcrypto.subtle.generateKey(EC, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
const PEM = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
const PUBLIC_JWK = await webcrypto.subtle.exportKey('jwk', pair.publicKey);

let pack = '';
const servers: Server[] = [];

async function start(secrets: { session: string; link: string; catalogSigningKey?: string }): Promise<string> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Signing', baseUrl: 'http://localhost', pack },
    policy: { defaultAccessMode: 'gated' },
    dev: { enabled: true, users: [
      { email: 'brand@test', groups: ['brand'] },
      { email: 'marketer@test', groups: ['marketing'] },
    ] },
  }));
  const store = createMemoryStore();
  await store.putOverlay({ toolId: 'secret-tool', version: 1, visibility: { groups: ['brand'] } });
  const app = buildApp({ config, store, secrets });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

async function login(base: string, email: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return r.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-signing-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({
    version: 1, tools: [{ id: 'open-tool', name: 'Open' }, { id: 'secret-tool', name: 'Secret' }],
  }, null, 2));
  const files: Record<string, string> = {
    'open-tool/tool.json': '{"id":"open-tool"}',
    'open-tool/template.html': '<p>{{title}}</p>',
    'open-tool/hooks.js': 'export default {}',
    'open-tool/i18n/de.json': '{"title":"Titel"}',
    'open-tool/i18n/README.txt': 'not a sidecar',
    'open-tool/templates/launch.json': '{"values":{}}',
    'open-tool/notes.txt': 'never fetched by the loader',
    'secret-tool/tool.json': '{"id":"secret-tool"}',
    'secret-tool/template.html': '<p>secret</p>',
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(pack, 'tools', rel)), { recursive: true });
    await writeFile(join(pack, 'tools', rel), text);
  }
  // A directory without tool.json is not a tool and contributes nothing.
  await mkdir(join(pack, 'tools', '_shared'), { recursive: true });
  await writeFile(join(pack, 'tools', '_shared', 'hooks.js'), 'shared');
  // The sidecars a pack built from a Lolly checkout carries beside the index,
  // each of which names every tool in the profile.
  const catalogFiles: Record<string, string> = {
    'tools/index.slim.json': JSON.stringify({ version: '1', tools: [{ id: 'open-tool', name: 'Open' }, { id: 'secret-tool', name: 'Secret' }] }),
    'tools/index.sig.json': JSON.stringify({ alg: 'ES256', keyId: 'build', indexHash: 'x', files: { 'open-tool/tool.json': 'a', 'secret-tool/tool.json': 'b' }, signature: 'y' }),
    'tools/notes.json': JSON.stringify({ tools: ['secret-tool'] }),
    'previews/bundle.json': JSON.stringify({
      'open-tool:0': { src: '/catalog/previews/open-tool.look0.svg' },
      'secret-tool:0': { src: '/catalog/previews/secret-tool.look0.svg' },
    }),
    'previews/open-tool.look0.svg': '<svg>open</svg>',
    'previews/secret-tool.look0.svg': '<svg>secret</svg>',
    'previews/Secret-Tool.svg': '<svg>secret</svg>',
    'previews/blank-report.json': '{}',
    'og/secret-tool.png': 'png',
    'og/open-tool.png': 'png',
    'og/views/tools.png': 'png',
    'og/.og-sigs.json': JSON.stringify({ 'open-tool': 'a', 'secret-tool': 'b' }),
  };
  for (const [rel, text] of Object.entries(catalogFiles)) {
    await mkdir(dirname(join(pack, 'catalog', rel)), { recursive: true });
    await writeFile(join(pack, 'catalog', rel), text);
  }
});

after(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

test('the sidecar patterns match the vendored engine source', async () => {
  const source = await readFile(join(ROOT, 'vendor/@lolly/engine/src/catalog-integrity.ts'), 'utf8');
  assert.ok(source.includes(`CATALOG_SIGNED_I18N_SIDECAR = ${String(SIGNED_I18N_SIDECAR)};`));
  assert.ok(source.includes(`CATALOG_SIGNED_TEMPLATE_FILE = ${String(SIGNED_TEMPLATE_FILE)};`));
});

test('file digests follow the OSS signer rules for a plain tools/ tree', async () => {
  const digests = await computeToolFileDigests(join(pack, 'tools'), engine.CATALOG_SIGNED_TOOL_FILES);
  assert.deepEqual(Object.keys(digests), [
    'open-tool/tool.json', 'open-tool/template.html', 'open-tool/hooks.js',
    'open-tool/i18n/de.json', 'open-tool/templates/launch.json',
    'secret-tool/tool.json', 'secret-tool/template.html',
  ]);
});

test('each caller gets an envelope bound to exactly the bytes it was served', async () => {
  const base = await start({ session: 'sign-session', link: 'sign-link', catalogSigningKey: PEM });
  const publicKey = await webcrypto.subtle.importKey('jwk', PUBLIC_JWK, EC, true, ['verify']);
  const keyId = await engine.jwkThumbprint(PUBLIC_JWK);
  const served: Record<string, { index: Uint8Array; envelope: Envelope }> = {};
  for (const email of ['brand@test', 'marketer@test']) {
    const cookie = await login(base, email);
    const indexRes = await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie } });
    assert.equal(indexRes.status, 200);
    assert.equal(indexRes.headers.get('cache-control'), 'private, no-cache');
    const index = new Uint8Array(await indexRes.arrayBuffer());
    const sigRes = await fetch(`${base}/catalog/tools/index.sig.json`, { headers: { cookie } });
    assert.equal(sigRes.status, 200);
    assert.equal(sigRes.headers.get('cache-control'), 'private, no-cache');
    const envelope = await sigRes.json() as Envelope;
    assert.equal(envelope.keyId, keyId);
    assert.deepEqual(await engine.verifyCatalogEnvelope(envelope, index, publicKey), { ok: true });
    // A tool file fetched through the same route the shell uses verifies too.
    const hooks = new Uint8Array(await (await fetch(`${base}/tools/open-tool/hooks.js`, { headers: { cookie } })).arrayBuffer());
    assert.deepEqual(await engine.verifyToolFile(envelope, 'open-tool', 'hooks.js', hooks), { ok: true });
    assert.equal((await engine.verifyToolFile(envelope, 'open-tool', 'hooks.js', new TextEncoder().encode('tampered'))).ok, false);
    assert.equal((await engine.verifyToolFile(envelope, 'open-tool', 'notes.txt', new Uint8Array())).ok, false);
    served[email] = { index, envelope };
  }
  const brand = served['brand@test']!;
  const marketer = served['marketer@test']!;
  assert.deepEqual(JSON.parse(Buffer.from(marketer.index).toString()).tools.map((t: { id: string }) => t.id), ['open-tool']);
  assert.deepEqual(JSON.parse(Buffer.from(brand.index).toString()).tools.map((t: { id: string }) => t.id), ['open-tool', 'secret-tool']);
  assert.notEqual(brand.envelope.indexHash, marketer.envelope.indexHash);
  // A hidden tool's files are not named to a caller who cannot fetch them.
  assert.ok(Object.keys(brand.envelope.files).includes('secret-tool/tool.json'));
  assert.ok(!Object.keys(marketer.envelope.files).some((k) => k.startsWith('secret-tool/')));
  assert.ok(Object.keys(marketer.envelope.files).includes('open-tool/i18n/de.json'));
  // One caller's envelope never vouches for another caller's index.
  assert.equal((await engine.verifyCatalogEnvelope(marketer.envelope, brand.index, publicKey)).ok, false);
  // A signed-out caller of a gated instance gets neither.
  assert.equal((await fetch(`${base}/catalog/tools/index.sig.json`)).status, 401);
});

test('a private JWK works as the key, and the keyId is its thumbprint', async () => {
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const fromJwk = await importCatalogSigningKey(JSON.stringify(jwk));
  const fromPem = await importCatalogSigningKey(PEM);
  assert.deepEqual(fromJwk.publicJwk, fromPem.publicJwk);
  assert.equal(await engine.jwkThumbprint(fromJwk.publicJwk), await engine.jwkThumbprint(PUBLIC_JWK));
});

test('a malformed key is refused without echoing the material', async () => {
  for (const material of ['{"kty":"EC","marker":"SECRET-MARKER"', '-----BEGIN PRIVATE KEY-----\nSECRET-MARKER\n-----END PRIVATE KEY-----', 'SECRET-MARKER']) {
    await assert.rejects(importCatalogSigningKey(material), (err: Error) => !err.message.includes('SECRET-MARKER') && /LW_CATALOG_SIGNING_KEY/.test(err.message));
  }
  const rsa = (await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  await assert.rejects(importCatalogSigningKey(rsa), /P-256/);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    const base = await start({ session: 'bad-session', link: 'bad-link', catalogSigningKey: 'SECRET-MARKER' });
    const cookie = await login(base, 'brand@test');
    const sig = await fetch(`${base}/catalog/tools/index.sig.json`, { headers: { cookie } });
    assert.equal(sig.status, 503);
    assert.ok(!(await sig.text()).includes('SECRET-MARKER'));
    assert.equal((await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie } })).status, 200);
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((e) => e.includes('catalog signing unavailable')));
  assert.ok(errors.every((e) => !e.includes('SECRET-MARKER')));
});

test('without a key the index is served as before and no signature is invented', async () => {
  const base = await start({ session: 'plain-session', link: 'plain-link' });
  const cookie = await login(base, 'marketer@test');
  const index = await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie } });
  assert.equal(index.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(await index.text(), JSON.stringify({ version: 1, tools: [{ id: 'open-tool', name: 'Open' }] }));
  assert.equal((await fetch(`${base}/catalog/tools/index.sig.json`, { headers: { cookie } })).status, 404);
});

test('catalog sidecars keyed by tool id follow the same visibility as the index', async () => {
  for (const secrets of [{ session: 'side-session', link: 'side-link' }, { session: 'side-key-session', link: 'side-key-link', catalogSigningKey: PEM }]) {
    const base = await start(secrets);
    const get = async (cookie: string, rel: string): Promise<Response> => fetch(`${base}/catalog/${rel}`, { headers: { cookie } });
    const marketer = await login(base, 'marketer@test');
    const brand = await login(base, 'brand@test');

    // The slim index is filtered like the full one.
    const slim = await get(marketer, 'tools/index.slim.json');
    assert.equal(slim.status, 200);
    assert.equal(slim.headers.get('cache-control'), 'private, no-cache');
    assert.deepEqual((await slim.json() as { tools: Array<{ id: string }> }).tools.map((t) => t.id), ['open-tool']);
    assert.deepEqual((await (await get(brand, 'tools/index.slim.json')).json() as { tools: Array<{ id: string }> }).tools.map((t) => t.id), ['open-tool', 'secret-tool']);
    // No other file under catalog/tools/ reaches a caller, in any spelling.
    for (const rel of ['tools/notes.json', 'TOOLS/index.slim.json', 'tools/INDEX.json']) {
      assert.equal((await get(marketer, rel)).status, 404, rel);
    }
    // The pack's build-time signature names every tool; without a key it is never served.
    if (!secrets.catalogSigningKey) assert.equal((await get(brand, 'tools/index.sig.json')).status, 404);

    // Preview art and social cards for a hidden tool answer 404.
    for (const rel of ['previews/secret-tool.look0.svg', 'previews/Secret-Tool.svg', 'PREVIEWS/secret-tool.look0.svg', 'og/secret-tool.png']) {
      assert.equal((await get(marketer, rel)).status, 404, rel);
    }
    for (const rel of ['previews/open-tool.look0.svg', 'previews/blank-report.json', 'og/open-tool.png', 'og/views/tools.png']) {
      assert.equal((await get(marketer, rel)).status, 200, rel);
    }
    assert.equal((await get(brand, 'previews/secret-tool.look0.svg')).status, 200);

    // Manifests keyed by tool id lose the hidden tool's entries.
    assert.deepEqual(Object.keys(await (await get(marketer, 'previews/bundle.json')).json() as object), ['open-tool:0']);
    assert.deepEqual(Object.keys(await (await get(brand, 'previews/bundle.json')).json() as object), ['open-tool:0', 'secret-tool:0']);
    assert.deepEqual(Object.keys(await (await get(marketer, 'og/.og-sigs.json')).json() as object), ['open-tool']);
  }
});
