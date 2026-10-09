// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageArguments, matchedShell, ownsContainer, generatedChanges, verifyGeneratedDocs, verifyGeneratedSignature, imageRefusal } from '../scripts/qualify-render-worker-image.ts';

test('image preparation refuses wrong source and engine without any build or browser', () => {
  const source = 'a'.repeat(40), pin = { generatedFrom: source, engine: { version: '1.248.0' } };
  assert.equal(matchedShell(pin, source, '1.248.0'), source);
  for (const args of [[pin, 'b'.repeat(40), '1.248.0'], [pin, source, '1.245.0'], [{ ...pin, generatedFrom: 'main' }, 'main', '1.248.0'], [null, source, '1.248.0']]) {
    assert.throws(() => matchedShell(...args as [unknown, string, string]));
  }
  for (const args of [[], ['--image', 'x'], ['--image', '--privileged', '--lolly-root', '.'], ['--image', 'x', '--image', 'y', '--lolly-root', '.'], ['--image', 'x;echo', '--lolly-root', '.'], ['--unsafe', 'x']]) {
    assert.throws(() => imageArguments(args));
  }
});

test('cleanup authorizes only the exact created container identity/image/label', () => {
  const id = 'a'.repeat(64), image = `sha256:${'b'.repeat(64)}`, label = 'owned';
  const inspect = { Id: id, Image: image, Config: { Labels: { 'org.lolly.qualification': label } } };
  assert.equal(ownsContainer(inspect, id, image, label), true);
  for (const value of [null, { ...inspect, Id: 'c'.repeat(64) }, { ...inspect, Image: `sha256:${'c'.repeat(64)}` }, { ...inspect, Config: { Labels: {} } }]) {
    assert.equal(ownsContainer(value, id, image, label), false);
  }
});

test('real image qualification is mandatory before its OCI transport is accepted', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const run = workflow.indexOf('node scripts/qualify-render-worker-image.ts');
  assert.ok(run > 0 && run < workflow.indexOf('- name: Bind the booted image to its offline transport'));
  assert.match(workflow, /repository: lolly-tools\/lolly/);
  assert.match(workflow, /ref: \$\{\{ steps\.matched-shell\.outputs\.source \}\}/);
  const runner = readFileSync(new URL('../scripts/qualify-render-worker-image.ts', import.meta.url), 'utf8');
  assert.match(runner, /\['run', 'build:web:release'\]/);
  assert.doesNotMatch(runner, /LOLLY_WEBGPU_QUALIFICATION|LOLLY_SKIP|--privileged|--ipc.?host|SYS_ADMIN/);
  assert.match(runner, /'--network', 'none'/);
  assert.match(runner, /'--env', 'LOLLY_RENDER_IMAGE_TEST=1'/);
  const imageTest = readFileSync(new URL('./render-worker-image.test.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(imageTest, /__setBrowserGetterForTests|chromium\.launch/);
  assert.match(imageTest, /worker\.getBrowser\(\)/);
});

test('only the maintained envelope and hashed docs are admitted as tracked build derivations', () => {
  const envelope = 'brands/lolly-start/catalog/tools/index.sig.json';
  const doc = `shells/web/public/info/docs.${'a'.repeat(16)}.css`;
  assert.deepEqual(generatedChanges(`M\0${envelope}\0D\0${doc}\0`), [{ status: 'M', path: envelope }, { status: 'D', path: doc }]);
  assert.deepEqual(generatedChanges(''), []);
  for (const raw of [`D\0${envelope}\0`, 'M\0engine/src/version.ts\0', 'M\0brands/lolly-start/catalog/tools/index.json\0',
    'M\0shells/web/public/info/docs.css\0', `A\0${doc}\0`, `M\0${doc}\0M\0${doc}\0`, `M\0${doc}`, `M\0shells/web/public/info/../src/docs.${'a'.repeat(16)}.css\0`]) {
    assert.throws(() => generatedChanges(raw));
  }
});

test('derived docs require exact fingerprint filenames and the same served bytes, without stale twins or symlinks', t => {
  const root = mkdtempSync(join(tmpdir(), 'worker-docs-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'shells/web/public/info'), dist = join(root, 'shells/web/dist/info');
  mkdirSync(source, { recursive: true }); mkdirSync(dist, { recursive: true });
  const content = [Buffer.from('body{color:green}'), Buffer.from('const ready=true;'), Buffer.from('const init=true;')];
  const names = content.map((bytes, i) => `docs.${createHash('sha256').update(bytes).digest('base64url').slice(0, 16)}.${i === 0 ? 'css' : 'js'}`);
  for (let i = 0; i < names.length; i++) {
    const name = names[i], bytes = content[i]; assert.ok(name && bytes);
    writeFileSync(join(source, name), bytes); writeFileSync(join(dist, name), bytes);
  }
  const changes = generatedChanges(`D\0shells/web/public/info/docs.${'a'.repeat(16)}.css\0`);
  assert.equal(verifyGeneratedDocs(root, changes), 3);
  const name = names[0], bytes = content[0]; assert.ok(name && bytes);
  writeFileSync(join(dist, name), 'different'); assert.throws(() => verifyGeneratedDocs(root, changes));
  writeFileSync(join(dist, name), bytes);
  writeFileSync(join(source, name), 'same filename, different bytes'); assert.throws(() => verifyGeneratedDocs(root, changes));
  writeFileSync(join(source, name), bytes);
  const extra = `docs.${'b'.repeat(16)}.js`; writeFileSync(join(source, extra), 'stale');
  assert.throws(() => verifyGeneratedDocs(root, changes)); rmSync(join(source, extra));
  rmSync(join(dist, name)); symlinkSync(join(source, name), join(dist, name));
  assert.throws(() => verifyGeneratedDocs(root, changes)); rmSync(join(dist, name)); writeFileSync(join(dist, name), bytes);
  writeFileSync(join(dist, `docs.${'a'.repeat(16)}.css`), 'stale deleted target');
  assert.throws(() => verifyGeneratedDocs(root, changes));
});

test('fresh catalog derivation binds the pre-build authored digest map and index as well as its test signature', async () => {
  const module: string = '../vendor/@lolly/engine/src/catalog-integrity.ts';
  const engine = await import(module) as {
    jwkThumbprint(jwk: webcrypto.JsonWebKey): Promise<string>;
    signCatalogEnvelope(unsigned: { alg: string; keyId: string; signedAt: string; indexHash: string; files: Record<string, string> }, key: webcrypto.CryptoKey): Promise<unknown>;
  };
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  const publicJwk = await webcrypto.subtle.exportKey('jwk', keys.publicKey), publicMaterial = JSON.stringify(publicJwk);
  const index = Buffer.from('{"tools":[{"id":"qr-code"}]}');
  const files = { 'qr-code/tool.json': createHash('sha256').update('authored manifest').digest('hex'),
    'qr-code/template.html': createHash('sha256').update('authored template').digest('hex') };
  const unsigned = { alg: 'ECDSA-P256-SHA256', keyId: await engine.jwkThumbprint(publicJwk), signedAt: new Date().toISOString(),
    indexHash: createHash('sha256').update(index).digest('hex'), files };
  const envelope = await engine.signCatalogEnvelope(unsigned, keys.privateKey);
  const bytes = Buffer.from(JSON.stringify(envelope));
  assert.equal(await verifyGeneratedSignature(bytes, bytes, { index, files }, publicMaterial), 2);
  await assert.rejects(verifyGeneratedSignature(bytes, Buffer.from('{}'), { index, files }, publicMaterial));
  await assert.rejects(verifyGeneratedSignature(bytes, bytes, { index: Buffer.from('other authored index'), files }, publicMaterial));
  await assert.rejects(verifyGeneratedSignature(bytes, bytes, { index, files: { ...files, 'qr-code/hooks.js': 'a'.repeat(64) } }, publicMaterial));
  await assert.rejects(verifyGeneratedSignature(bytes, bytes, { index, files: { ...files, 'qr-code/tool.json': 'b'.repeat(64) } }, publicMaterial));
  const forged = Buffer.from(JSON.stringify({ ...envelope as object, signature: 'a'.repeat(86) }));
  await assert.rejects(verifyGeneratedSignature(forged, forged, { index, files }, publicMaterial));
  const other = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
  await assert.rejects(verifyGeneratedSignature(bytes, bytes, { index, files }, JSON.stringify(await webcrypto.subtle.exportKey('jwk', other.publicKey))));
});

test('refusal diagnostics contain fixed phase and bounded counts, never arbitrary caught values', () => {
  assert.deepEqual(imageRefusal('TRACKED_SOURCE', 4), { status: 'WORKER_IMAGE_ACCEPTANCE_REFUSED', phase: 'TRACKED_SOURCE', trackedChangeCount: 4 });
  for (const count of [-1, 129, 1.5, NaN, Infinity]) assert.equal(imageRefusal('SIGNED_BUILD', count).trackedChangeCount, 0);
  assert.deepEqual(imageRefusal('private key or raw error', 0), { status: 'WORKER_IMAGE_ACCEPTANCE_REFUSED', phase: 'UNKNOWN', trackedChangeCount: 0 });
});
