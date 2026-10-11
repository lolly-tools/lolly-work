// SPDX-License-Identifier: MPL-2.0
/** Real signed miniature releases exercise the mounted pack's identity closure. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { completeToolFileDigests, toolDirectoryDigests } from '../server/src/catalog/signing.ts';
import { verifyToolCoding } from '../server/src/catalog/tool-codings.ts';
import { catalogPublication } from '../server/src/catalog/publication.ts';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { registerProjectionRoots, regularSourceFile } from '../server/src/api/file-delivery.ts';
const ENGINE_SPECIFIER: string = '@lolly/engine';
interface UnsignedEnvelope {
  alg: string; keyId: string; signedAt: string; indexHash: string; files: Record<string, string>;
  seq: number; assetIndexHash: string; slimHash: string; toolDirs: Record<string, string>;
}
// The server's Node-only type program does not walk the engine's DOM types.
const { CATALOG_SIG_ALG, jwkThumbprint, signCatalogEnvelope } = await import(ENGINE_SPECIFIER) as {
  CATALOG_SIG_ALG: string;
  jwkThumbprint(key: webcrypto.JsonWebKey): Promise<string>;
  signCatalogEnvelope(envelope: UnsignedEnvelope, key: webcrypto.CryptoKey): Promise<UnsignedEnvelope & { signature: string }>;
};

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function put(root: string, rel: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(join(root, rel)), { recursive: true }); await writeFile(join(root, rel), bytes);
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'lolly-tool-codings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = Buffer.from('{"tools":[{"id":"probe"}]}'), assets = Buffer.from('{"assets":[]}');
  await put(root, 'catalog/tools/index.json', index); await put(root, 'catalog/tools/index.slim.json', index);
  await put(root, 'catalog/assets/index.json', assets);
  const content = Buffer.from('<svg>' + 'x'.repeat(4096) + '</svg>');
  await put(root, 'tools/probe/tool.json', '{"id":"probe","name":"Probe"}');
  await put(root, 'tools/probe/template.html', content); await put(root, 'tools/probe/empty', Buffer.alloc(0));
  await put(root, 'tools/probe/i18n/en.json', '{"name":"Probe"}');
  await put(root, 'tools/probe/i18n/README.txt', 'outside the signed sidecar grammar');
  for (const rel of ['template.html', 'empty', 'i18n/en.json', 'i18n/README.txt']) {
    const bytes = await readFile(join(root, 'tools/probe', rel));
    await put(root, `tools/probe/${rel}.gz`, gzipSync(bytes)); await put(root, `tools/probe/${rel}.br`, brotliCompressSync(bytes));
  }
  const files = await completeToolFileDigests(root), keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ format: 'jwk' });
  const privateKey = await webcrypto.subtle.importKey('jwk', keys.privateKey.export({ format: 'jwk' }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const envelope = await signCatalogEnvelope({ alg: CATALOG_SIG_ALG, keyId: await jwkThumbprint(publicKey),
    signedAt: '2026-10-11T11:00:00Z', indexHash: hash(index), files, seq: 7,
    assetIndexHash: hash(assets), slimHash: hash(index), toolDirs: toolDirectoryDigests(files) }, privateKey);
  await put(root, 'catalog/tools/index.sig.json', JSON.stringify(envelope));
  return { root, publicKey, content, files, material: JSON.stringify(keys.privateKey.export({ format: 'jwk' })) };
}

test('valid gzip/brotli, empty identities and sidecars preserve the exact signed publication closure', async t => {
  const { root, publicKey, files } = await fixture(t);
  assert.equal(Object.keys(files).length, 4);
  assert.ok(files['probe/i18n/en.json']); assert.equal(files['probe/i18n/README.txt'], undefined);
  assert.equal(Object.keys(files).some(path => /\.(gz|br)$/.test(path)), false);
  const publication = await catalogPublication({ pack: root, publicKey, signing: null });
  assert.equal(publication.generation, 7); assert.match(publication.digest, /^[a-f0-9]{64}$/);
  // Transport bytes remain in the immutable source digest, without becoming tool identity.
  await put(root, 'tools/probe/template.html.gz', gzipSync(await readFile(join(root, 'tools/probe/template.html')), { level: 1 }));
  const changed = await catalogPublication({ pack: root, publicKey, signing: null });
  assert.equal(changed.generation, 7); assert.notEqual(changed.digest, publication.digest);
  assert.deepEqual(await completeToolFileDigests(root), files);
});

test('the signed mounted shell serves a usable envelope and compressed hash-directory bytes over HTTP', async t => {
  const { root, content, files, material } = await fixture(t);
  const config = parseConfig(JSON.stringify({ instance: { name: 'Coding proof', baseUrl: 'http://localhost', pack: root },
    policy: { defaultAccessMode: 'open' }, rateLimit: { enabled: false } }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'coding-test-session', link: 'coding-test-link', catalogSigningKey: material } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const response = await fetch(origin + '/catalog/tools/index.sig.json'), raw = await response.text();
    assert.equal(response.status, 200, raw);
    const envelope = JSON.parse(raw) as { files: Record<string, string>; seq: number; toolDirs: Record<string, string> };
    assert.deepEqual(envelope.files, files); assert.equal(envelope.seq, 1);
    const tool = await fetch(`${origin}/tools/probe@${envelope.toolDirs.probe!.slice(0, 16)}/template.html`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(tool.status, 200); assert.equal(tool.headers.get('content-encoding'), 'br');
    assert.equal(tool.headers.get('cache-control'), 'private, no-cache, no-transform');
    assert.deepEqual(Buffer.from(await tool.arrayBuffer()), content);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('registered directory and per-file projections work while source links, escapes and cycles fail closed', async t => {
  const { root, content } = await fixture(t), source = join(root, 'tools');
  const projection = await mkdtemp(join(tmpdir(), 'lolly-tool-projection-'));
  t.after(() => rm(projection, { recursive: true, force: true }));
  await mkdir(join(projection, 'tools/probe'), { recursive: true });
  for (const suffix of ['', '.gz', '.br']) await symlink(join(source, `probe/template.html${suffix}`), join(projection, `tools/probe/template.html${suffix}`));
  await symlink(join(source, 'probe'), join(projection, 'tools/whole'));
  const expected = { sha256: hash(content), size: content.length };
  await assert.rejects(verifyToolCoding(join(projection, 'tools'), 'probe/template.html.gz', expected));
  await registerProjectionRoots(projection, [source]);
  await verifyToolCoding(join(projection, 'tools'), 'probe/template.html.gz', expected);
  await verifyToolCoding(join(projection, 'tools'), 'whole/template.html.br', expected);
  await symlink(join(root, 'catalog/tools/index.json'), join(projection, 'tools/probe/escape.gz'));
  assert.equal(await regularSourceFile(join(projection, 'tools'), 'probe/escape.gz'), null);
  await symlink('.', join(source, 'probe/cycle'));
  assert.equal(await regularSourceFile(join(projection, 'tools'), 'whole/cycle/template.html.gz'), null);
  await writeFile(join(source, 'probe/copy.gz'), gzipSync(content));
  await rm(join(source, 'probe/template.html.gz')); await symlink('copy.gz', join(source, 'probe/template.html.gz'));
  await assert.rejects(verifyToolCoding(join(projection, 'tools'), 'probe/template.html.gz', expected));
  await assert.rejects(verifyToolCoding(join(projection, 'tools'), 'whole/template.html.gz', expected));
});

test('malformed, truncated, wrong identity, trailing bytes and expansion are refused', async t => {
  const { root, content } = await fixture(t);
  const rel = 'probe/template.html', expected = { sha256: hash(content), size: content.length };
  const variants: [string, Uint8Array][] = [
    ['gz', Buffer.from('invalid')], ['gz', gzipSync(content).subarray(0, 12)],
    ['gz', Buffer.concat([gzipSync(content), Buffer.from('trailer')])],
    ['gz', gzipSync(Buffer.alloc(content.length, 65))], ['gz', gzipSync(Buffer.alloc(2 * 1024 * 1024, 65))],
    ['br', Buffer.from('invalid')], ['br', brotliCompressSync(content).subarray(0, 3)],
    ['br', brotliCompressSync(Buffer.alloc(content.length, 65))], ['br', brotliCompressSync(Buffer.alloc(2 * 1024 * 1024, 65))],
    ['br', Buffer.concat([brotliCompressSync(content), Buffer.from('trailer')])],
  ];
  for (const [ext, bytes] of variants) {
    await put(root, `tools/${rel}.${ext}`, bytes);
    await assert.rejects(verifyToolCoding(join(root, 'tools'), `${rel}.${ext}`, expected));
  }
});

test('orphan, nested and symbolic coding paths cannot disappear from signature closure', async t => {
  const { root, content } = await fixture(t);
  const target = join(root, 'tools/probe/orphan.gz');
  await writeFile(target, gzipSync(content)); await assert.rejects(completeToolFileDigests(root)); await rm(target);
  const nested = join(root, 'tools/probe/template.html.gz.br');
  await writeFile(nested, brotliCompressSync(gzipSync(content))); await assert.rejects(completeToolFileDigests(root)); await rm(nested);
  const coding = join(root, 'tools/probe/template.html.gz'), identity = join(root, 'tools/probe/template.html');
  const expected = { sha256: hash(content), size: content.length };
  await rm(coding); await symlink('/definitely-unavailable-coding', coding);
  await assert.rejects(completeToolFileDigests(root)); await rm(coding); await writeFile(coding, gzipSync(content));
  await rm(identity); await symlink('i18n/en.json', identity);
  await assert.rejects(verifyToolCoding(join(root, 'tools'), 'probe/template.html.gz', expected));
  await assert.rejects(completeToolFileDigests(root));
});

test('changing a signed identity still fails the actual signature/publication verification', async t => {
  const { root, publicKey } = await fixture(t);
  await put(root, 'tools/probe/template.html', 'authored mutation');
  await put(root, 'tools/probe/template.html.gz', gzipSync(Buffer.from('authored mutation')));
  await put(root, 'tools/probe/template.html.br', brotliCompressSync(Buffer.from('authored mutation')));
  await assert.rejects(catalogPublication({ pack: root, publicKey, signing: null }), error => (error as { status?: number }).status === 503);
});
