// SPDX-License-Identifier: MPL-2.0
/**
 * The catalog public key route (server/src/catalog/signing.ts, CATALOG_PUBLIC_KEY_ROUTE)
 * over real HTTP. The Lolly web app this server hosts reads the route from its own
 * origin and accepts the key only for envelopes that carry its keyId. These tests pin
 * what the route may say: only the public half, the same keyId the envelopes carry, a
 * new key after a restart with a new key, 404 without a key and 503 for a key that
 * does not load, with no key material in any answer.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { CATALOG_PUBLIC_KEY_ROUTE, catalogPublicKeyDocument } from '../server/src/catalog/signing.ts';

const ENGINE_SPECIFIER: string = '@lolly/engine';
interface Envelope { alg: string; keyId: string; indexHash: string; files: Record<string, string>; signature: string }
const engine = await import(ENGINE_SPECIFIER) as {
  CATALOG_SIG_ALG: string;
  jwkThumbprint(jwk: webcrypto.JsonWebKey): Promise<string>;
  verifyCatalogEnvelope(env: Envelope, bytes: Uint8Array, key: webcrypto.CryptoKey): Promise<{ ok: boolean; reason?: string }>;
};

const EC = { name: 'ECDSA', namedCurve: 'P-256' } as const;
interface KeyMaterial { pem: string; jwk: webcrypto.JsonWebKey; publicJwk: webcrypto.JsonWebKey }
async function newKey(): Promise<KeyMaterial> {
  // Node writes the PKCS#8 PEM itself, so no key text appears in this file.
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    jwk: privateKey.export({ format: 'jwk' }) as webcrypto.JsonWebKey,
    publicJwk: publicKey.export({ format: 'jwk' }) as webcrypto.JsonWebKey,
  };
}

let pack = '';
const servers: Server[] = [];

async function start(catalogSigningKey?: string): Promise<string> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Public key', baseUrl: 'http://localhost', pack },
    policy: { defaultAccessMode: 'gated' },
    dev: { enabled: true, users: [{ email: 'member@test', groups: ['design'] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'key-session', link: 'key-link', ...(catalogSigningKey ? { catalogSigningKey } : {}) } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

async function login(base: string): Promise<string> {
  const r = await fetch(`${base}/api/auth/dev?email=member%40test`, { redirect: 'manual' });
  return r.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}

/** The signed envelope and index this instance serves a signed-in member. */
async function servedCatalog(base: string): Promise<{ envelope: Envelope; index: Uint8Array }> {
  const cookie = await login(base);
  const index = new Uint8Array(await (await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie } })).arrayBuffer());
  const sig = await fetch(`${base}/catalog/tools/index.sig.json`, { headers: { cookie } });
  assert.equal(sig.status, 200);
  return { envelope: await sig.json() as Envelope, index };
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-public-key-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'open-tool', name: 'Open' }] }));
  await mkdir(join(pack, 'tools', 'open-tool'), { recursive: true });
  await writeFile(join(pack, 'tools', 'open-tool', 'tool.json'), '{"id":"open-tool"}');
  await writeFile(join(pack, 'tools', 'open-tool', 'template.html'), '<p>open</p>');
});

after(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
});

test('the route serves only the public half, under the keyId every envelope carries', async () => {
  const key = await newKey();
  const base = await start(key.pem);
  // Public: a signed-out caller of a gated instance can read the key.
  const res = await fetch(base + CATALOG_PUBLIC_KEY_ROUTE);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no cross-origin reader acts on this key');
  // Every reader revalidates, so a rotated key reaches them on their next sync.
  assert.match(String(res.headers.get('cache-control')), /\bmax-age=0\b.*\bmust-revalidate\b/);
  const text = await res.text();
  const document = JSON.parse(text) as { version: number; alg: string; keyId: string; publicKey: webcrypto.JsonWebKey };
  const keyId = await engine.jwkThumbprint(key.publicJwk);
  assert.deepEqual(document, {
    version: 1, alg: engine.CATALOG_SIG_ALG, keyId,
    publicKey: { kty: 'EC', crv: 'P-256', x: key.publicJwk.x, y: key.publicJwk.y },
  });
  assert.ok(!text.includes(key.jwk.d!), 'the private scalar never appears');
  // The envelope this instance serves names the same key and verifies under the served half.
  const { envelope, index } = await servedCatalog(base);
  assert.equal(envelope.keyId, document.keyId);
  const served = await webcrypto.subtle.importKey('jwk', document.publicKey, EC, false, ['verify']);
  assert.deepEqual(await engine.verifyCatalogEnvelope(envelope, index, served), { ok: true });
  // Revalidation costs a 304.
  const again = await fetch(base + CATALOG_PUBLIC_KEY_ROUTE, { headers: { 'if-none-match': String(res.headers.get('etag')) } });
  assert.equal(again.status, 304);
});

test('a private JWK carrying extra members still serves only the four public ones', async () => {
  const key = await newKey();
  const material = JSON.stringify({ ...key.jwk, kid: 'operator-label', ext: true, key_ops: ['sign'], p: 'extra', q: 'extra', dp: 'extra' });
  const base = await start(material);
  const text = await (await fetch(base + CATALOG_PUBLIC_KEY_ROUTE)).text();
  const document = JSON.parse(text) as { publicKey: Record<string, unknown> };
  assert.deepEqual(Object.keys(document.publicKey).sort(), ['crv', 'kty', 'x', 'y']);
  for (const secret of [key.jwk.d!, 'operator-label', 'extra']) assert.ok(!text.includes(secret), secret);
  // The builder copies by name, so a private JWK handed to it directly loses `d` too.
  const built = catalogPublicKeyDocument(key.jwk, await engine.jwkThumbprint(key.publicJwk), engine.CATALOG_SIG_ALG);
  assert.ok(!JSON.stringify(built).includes(key.jwk.d!));
  assert.throws(() => catalogPublicKeyDocument({ kty: 'RSA', n: 'x', e: 'AQAB' }, 'k'.repeat(43), engine.CATALOG_SIG_ALG), /P-256/);
  assert.throws(() => catalogPublicKeyDocument(key.publicJwk, 'not-a-thumbprint', engine.CATALOG_SIG_ALG), /P-256/);
});

test('a new key after a restart is served at once, and the old key no longer verifies', async () => {
  const first = await newKey(), second = await newKey();
  const before = await start(first.pem);
  const after = await start(second.pem);
  const oldDocument = await (await fetch(before + CATALOG_PUBLIC_KEY_ROUTE)).json() as { keyId: string; publicKey: webcrypto.JsonWebKey };
  const newDocument = await (await fetch(after + CATALOG_PUBLIC_KEY_ROUTE)).json() as { keyId: string; publicKey: webcrypto.JsonWebKey };
  assert.notEqual(oldDocument.keyId, newDocument.keyId);
  assert.equal(newDocument.keyId, await engine.jwkThumbprint(second.publicJwk));
  const { envelope, index } = await servedCatalog(after);
  assert.equal(envelope.keyId, newDocument.keyId);
  const oldKey = await webcrypto.subtle.importKey('jwk', oldDocument.publicKey, EC, false, ['verify']);
  const newKeyHalf = await webcrypto.subtle.importKey('jwk', newDocument.publicKey, EC, false, ['verify']);
  assert.equal((await engine.verifyCatalogEnvelope(envelope, index, oldKey)).ok, false);
  assert.deepEqual(await engine.verifyCatalogEnvelope(envelope, index, newKeyHalf), { ok: true });
});

test('without a key the route answers 404, like a server that predates the route', async () => {
  const base = await start();
  const res = await fetch(base + CATALOG_PUBLIC_KEY_ROUTE);
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'CATALOG_SIGNING_OFF');
  assert.match(String(res.headers.get('cache-control')), /\bprivate\b/);
});

test('a key that does not load answers 503 and never quotes the material', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    for (const material of ['SECRET-MARKER', '{"kty":"EC","crv":"P-256","x":"SECRET-MARKER","y":"SECRET-MARKER","d":"SECRET-MARKER"}']) {
      const base = await start(material);
      const res = await fetch(base + CATALOG_PUBLIC_KEY_ROUTE);
      assert.equal(res.status, 503);
      const text = await res.text();
      assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'CATALOG_SIGNING_UNAVAILABLE');
      assert.ok(!text.includes('SECRET-MARKER'));
    }
  } finally {
    console.error = original;
  }
  assert.ok(errors.every((e) => !e.includes('SECRET-MARKER')));
});
