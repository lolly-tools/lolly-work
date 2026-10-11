// SPDX-License-Identifier: MPL-2.0
/** Small physical repositories exercise the real signer without rebuilding an application. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { authoredCatalog, finishQualificationSource, prepareQualificationSource, verifyGeneratedRelease, verifyGeneratedSignature } from '../scripts/qualify-render-worker-image.ts';

const VENDOR = resolve(dirname(fileURLToPath(import.meta.url)), '../vendor/lolly');
const SIGNATURE = 'brands/lolly-start/catalog/tools/index.sig.json';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function put(root: string, path: string, bytes: string | Uint8Array): void {
  const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
}
function key(): { privateMaterial: string; publicMaterial: string } {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateMaterial: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicMaterial: JSON.stringify(keys.publicKey.export({ format: 'jwk' })) };
}
function sign(root: string, keys: ReturnType<typeof key>, args: string[] = []): void {
  execFileSync(process.execPath, ['scripts/sign-catalog.ts', ...args], { cwd: root, timeout: 15000, maxBuffer: 65536,
    env: { ...process.env, LOLLY_ROOT: root, LOLLY_PROFILE: 'lolly-start', LOLLY_CATALOG_SIGNING_KEY: keys.privateMaterial,
      VITE_CATALOG_PUBLIC_KEY_JWK: keys.publicMaterial } });
}
function fixture(t: TestContext): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worker-lineage-fixture-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  put(root, 'package.json', '{"type":"module"}');
  put(root, '.gitignore', 'node_modules/\n**/node_modules/\nshells/web/dist/\n');
  put(root, 'profiles.json', JSON.stringify({ default: 'lolly-start', profiles: { 'lolly-start': {
    tools: ['community', 'brands/lolly-start/tools'], catalog: 'brands/lolly-start/catalog' } } }));
  put(root, 'brands/lolly-start/tools/.gitkeep', '');
  put(root, 'packages/node-shell/package.json', JSON.stringify({ name: '@lolly-tools/node-shell', type: 'module',
    exports: { './content-roots': './src/content-roots.ts' } }));
  for (const path of ['packages/node-shell/src/content-roots.ts', 'packages/node-shell/src/repo-root.ts',
    'engine/src/catalog-integrity.ts', 'engine/src/canonical-json.ts', 'engine/src/x509.ts', 'engine/src/bytes.ts',
    'engine/src/der-read.ts', 'scripts/sign-catalog.ts', 'scripts/materialize-catalog-delivery.ts', 'scripts/verify-release-catalog.ts']) {
    const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(VENDOR, path), target);
  }
  mkdirSync(join(root, 'node_modules/@lolly-tools'), { recursive: true });
  symlinkSync(join(root, 'packages/node-shell'), join(root, 'node_modules/@lolly-tools/node-shell'), 'dir');
  put(root, 'community/probe/tool.json', '{"id":"probe","name":"Probe"}\n');
  put(root, 'community/probe/template.html', '<img src="/catalog/previews/probe.svg">');
  put(root, 'community/probe/card.html', '<script src="/tools/probe/lib/demo.js"></script>');
  put(root, 'community/probe/hooks.js', 'export const ready=true;');
  put(root, 'community/probe/lib/demo.js', 'export const demo=true;');
  put(root, 'community/probe/assets/icon.svg', '<svg/>');
  put(root, 'community/probe/__proto__', 'ordinary filename');
  put(root, 'community/probe/empty', '');
  put(root, 'community/probe/i18n/README.txt', 'outside the signed sidecar grammar');
  put(root, 'community/probe/templates/notes.txt', 'outside the signed template grammar');
  put(root, 'brands/lolly-start/catalog/tools/index.json', '{"tools":[{"id":"probe","manifest":"/tools/probe/tool.json","preview":"/catalog/previews/probe.svg"}]}\n');
  put(root, 'brands/lolly-start/catalog/tools/index.slim.json', '{"tools":[{"id":"probe","preview":"/catalog/previews/probe.svg"}]}\n');
  put(root, 'brands/lolly-start/catalog/assets/index.json', '{"assets":[]}\n');
  put(root, 'brands/lolly-start/catalog/previews/probe.svg', '<svg viewBox="0 0 1 1"/>');
  return root;
}

test('a fresh test identity removes only its copied historical signature and remaps workspace aliases into the exact clone', async t => {
  const root = fixture(t), previous = key(), fresh = key(); sign(root, previous);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'], { cwd: root });
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const old = readFileSync(join(root, SIGNATURE)), original = lstatSync(join(root, SIGNATURE));
  const owned = await prepareQualificationSource(root, source, fresh.publicMaterial);
  t.after(() => rmSync(owned.owned, { recursive: true, force: true }));
  assert.equal(existsSync(join(owned.root, SIGNATURE)), false);
  assert.equal(realpathSync(join(owned.root, 'node_modules/@lolly-tools/node-shell')), join(owned.root, 'packages/node-shell'));
  assert.deepEqual(readFileSync(join(owned.owned, 'historical-envelope.json')), old);
  assert.equal(lstatSync(join(owned.owned, 'historical-envelope.json')).mode & 0o777, 0o600);
  const custody = JSON.parse(readFileSync(join(owned.owned, 'lineage-custody.json'), 'utf8'));
  assert.equal(custody.historicalEnvelope.sha256, sha(old)); assert.equal(custody.productionAcceptance, false);
  assert.equal(custody.historicalEnvelope.trustedForNewLineage, false);
  assert.deepEqual(custody.workspaceAliases, ['node_modules/@lolly-tools/node-shell']);
  sign(owned.root, fresh);
  const expected = await authoredCatalog(owned.root), envelope = readFileSync(join(owned.root, SIGNATURE));
  assert.equal(await verifyGeneratedSignature(envelope, envelope, expected, fresh.publicMaterial), 8);
  assert.equal(JSON.parse(envelope.toString()).seq, 1);
  assert.deepEqual(readFileSync(join(root, SIGNATURE)), old);
  assert.equal(lstatSync(join(root, SIGNATURE)).ino, original.ino);
  finishQualificationSource(owned);
  assert.equal(existsSync(owned.root), false); assert.equal(existsSync(join(owned.owned, 'lineage-custody.json')), true);
  await assert.rejects(prepareQualificationSource(root, source, previous.publicMaterial));
  put(root, 'community/probe/hooks.js', 'authored edit');
  await assert.rejects(prepareQualificationSource(root, source, fresh.publicMaterial));
});

test('the physical modern release proves the full authored safe tree, exact materialization, hash aliases and decoded coding siblings', async t => {
  const root = fixture(t), keys = key(); sign(root, keys);
  const expected = await authoredCatalog(root), source = readFileSync(join(root, SIGNATURE));
  assert.equal(Object.keys(expected.files).length, 8);
  assert.equal(expected.files['probe/__proto__'], sha(Buffer.from('ordinary filename')));
  assert.equal(expected.files['probe/empty'], sha(Buffer.alloc(0)));
  assert.equal(expected.files['probe/lib/demo.js'], sha(Buffer.from('export const demo=true;')));
  assert.equal(expected.files['probe/i18n/README.txt'], undefined);
  const dist = join(root, 'shells/web/dist');
  cpSync(join(root, 'community/probe'), join(dist, 'tools/probe'), { recursive: true });
  cpSync(join(root, 'brands/lolly-start/catalog'), join(dist, 'catalog'), { recursive: true });
  const args = ['--tools', join(dist, 'tools'), '--index', join(dist, 'catalog/tools/index.json'), '--out', join(dist, 'catalog/tools/index.sig.json'), '--materialize'];
  sign(root, keys, args);
  assert.notDeepEqual(readFileSync(join(dist, 'tools/probe/card.html')), readFileSync(join(root, 'community/probe/card.html')));
  for (const extension of ['gz', 'br']) {
    const identity = readFileSync(join(dist, 'tools/probe/template.html'));
    put(dist, `tools/probe/template.html.${extension}`, extension === 'gz' ? gzipSync(identity) : brotliCompressSync(identity));
  }
  assert.equal(await verifyGeneratedRelease(root, expected, keys.publicMaterial, source), 8);
  const envelope = readFileSync(join(dist, 'catalog/tools/index.sig.json'));
  const privateKey = await webcrypto.subtle.importKey('jwk', createPrivateKey(keys.privateMaterial).export({ format: 'jwk' }),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const engineModule: string = '../vendor/@lolly/engine/src/catalog-integrity.ts';
  const engine = await import(engineModule) as { signCatalogEnvelope(value: Record<string, unknown>, privateKey: webcrypto.CryptoKey): Promise<unknown> };
  for (const field of ['toolDirs', 'assetIndexHash', 'slimHash']) {
    const unsigned = JSON.parse(envelope.toString()); delete unsigned.signature;
    unsigned[field] = field === 'toolDirs' ? { probe: 'a'.repeat(64) } : 'a'.repeat(64);
    put(dist, 'catalog/tools/index.sig.json', JSON.stringify(await engine.signCatalogEnvelope(unsigned, privateKey)));
    await assert.rejects(verifyGeneratedRelease(root, expected, keys.publicMaterial, source));
  }
  put(dist, 'catalog/tools/index.sig.json', envelope);
  const changed = JSON.parse(envelope.toString()); changed.unknown = true;
  put(dist, 'catalog/tools/index.sig.json', JSON.stringify(changed));
  await assert.rejects(verifyGeneratedRelease(root, expected, keys.publicMaterial, source));
  put(dist, 'catalog/tools/index.sig.json', envelope);
  put(dist, 'tools/probe/template.html.br', Buffer.concat([brotliCompressSync(readFileSync(join(dist, 'tools/probe/template.html'))), Buffer.from('trailer')]));
  await assert.rejects(verifyGeneratedRelease(root, expected, keys.publicMaterial, source));
  put(dist, 'tools/probe/template.html.br', brotliCompressSync(Buffer.alloc(100000, 65)));
  await assert.rejects(verifyGeneratedRelease(root, expected, keys.publicMaterial, source));
  rmSync(join(dist, 'tools/probe/template.html.br')); rmSync(join(dist, 'tools/probe/template.html.gz'));
  put(dist, 'tools/probe/orphan.gz', gzipSync(Buffer.from('orphan')));
  await assert.rejects(verifyGeneratedRelease(root, expected, keys.publicMaterial, source));
  rmSync(join(dist, 'tools/probe/orphan.gz'));
  put(dist, 'tools/probe/lib/extra.js', 'not authored');
  await assert.rejects(verifyGeneratedRelease(root, expected, keys.publicMaterial, source));
  rmSync(join(dist, 'tools/probe/lib/extra.js'));
  // A valid new signature cannot authorize arbitrary changes in the fixture build.
  put(dist, 'tools/probe/card.html', '<script>unreviewed change</script>');
  // A second materialization retains the old tree and creates a different hash tree.
  sign(root, keys, args);
  await assert.rejects(verifyGeneratedRelease(root, expected, keys.publicMaterial, source));
});
