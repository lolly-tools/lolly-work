// SPDX-License-Identifier: MPL-2.0
/**
 * scripts/build-instance-pack.ts against a throwaway Lolly checkout whose
 * resolver writes a small pack. Pins three things a deploy depends on: an
 * excluded path takes its asset index entries with it (the boot check stats
 * every /catalog/ format URL, so a dangling one refuses the pack in production),
 * the pack's build-time catalog signature is not carried, and a rebuild that
 * fails never leaves the previous build's provenance describing new bytes.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { SOURCE_FILE, incompletePackReason, main, parseArgs, pruneAssetIndex } from '../scripts/build-instance-pack.ts';
import { verifyReleasePack } from '../scripts/lib/release-pack.ts';
import type { ReleasePackOptions } from '../scripts/lib/release-pack.ts';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'lw-build-pack-')));
const CHECKOUT = join(ROOT, 'lolly');

// The resolver the script runs inside the checkout. Plain JavaScript in a .ts
// file, so Node needs no type stripping for it. FAKE_RESOLVER_FAIL makes it fail
// halfway, after it has already replaced the pack's files.
const RESOLVER = `
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export function contentRoots({ profile }) { return { profile }; }
export function materializeInto(out) {
  rmSync(join(out, 'tools'), { recursive: true, force: true });
  rmSync(join(out, 'catalog'), { recursive: true, force: true });
  const files = {
    'tools/t1/tool.json': '{"id":"t1"}',
    'catalog/tools/index.json': JSON.stringify({ version: 1, tools: [{ id: 't1' }] }),
    'catalog/tools/index.sig.json': JSON.stringify({ indexHash: 'x', files: { 't1/tool.json': 'y' } }),
    'catalog/tools/index.slim.json': JSON.stringify({ version: '1', tools: [{ id: 't1' }] }),
    'catalog/assets/a1.svg': '<svg/>',
    'catalog/assets/m.svg': '<svg/>',
    'catalog/packs/emoji/e1.json': '{}',
    'catalog/packs/emoji/m.json': '{}',
    'catalog/og/t1.png': 'png',
    'catalog/assets/index.json': JSON.stringify({ version: '1', assets: [
      { id: 'a1', formats: [{ format: 'svg', url: '/catalog/assets/a1.svg' }] },
      { id: 'e1', formats: [{ format: 'json', url: '/catalog/packs/emoji/e1.json' }] },
      { id: 'm1', formats: [{ format: 'json', url: '/catalog/packs/emoji/m.json' }, { format: 'svg', url: '/catalog/assets/m.svg' }] },
      { id: 'r1', formats: [{ format: 'svg', url: 'https://cdn.example.test/r1.svg' }] },
      { id: 'p1', formats: [{ format: 'svg', url: '/catalog/packsuffix/p1.svg' }] },
    ] }, null, 2),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), text);
    if (process.env.FAKE_RESOLVER_FAIL && rel.startsWith('catalog/')) throw new Error('resolver failed halfway');
  }
}
`;

const git = (...args: string[]): string => {
  const r = spawnSync('git', ['-C', CHECKOUT, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

before(() => {
  mkdirSync(join(CHECKOUT, 'packages', 'node-shell', 'src'), { recursive: true });
  writeFileSync(join(CHECKOUT, 'packages', 'node-shell', 'src', 'content-roots.ts'), RESOLVER);
  writeFileSync(join(CHECKOUT, 'package.json'), '{"type":"module"}');
  spawnSync('git', ['init', '-q', CHECKOUT]);
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** Run the script quietly; the inspection step's verdict is not under test here. */
async function build(out: string, ...extra: string[]): Promise<number> {
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await main(['--lolly', CHECKOUT, '--profile', 'p', '--out', out, ...extra]);
  } finally {
    Object.assign(console, original);
  }
}

test('pruneAssetIndex drops formats under excluded paths and assets left with none', () => {
  const { index, pruned } = pruneAssetIndex({ version: '1', assets: [
    { id: 'a', formats: [{ url: '/catalog/og/a.png' }] },
    { id: 'b', formats: [{ url: '/catalog/og/b.png' }, { url: '/catalog/assets/b.svg' }] },
    { id: 'c', formats: [{ url: '/catalog/ogre/c.png' }] },
    { id: 'd', formats: [{ url: '/catalog/og' }] },
  ] }, ['og']);
  assert.deepEqual((index.assets as Array<{ id: string }>).map((a) => a.id), ['b', 'c']);
  assert.deepEqual(pruned, [{ id: 'a', removed: true }, { id: 'b', removed: false }, { id: 'd', removed: true }]);
});

test('an excluded path takes its asset index entries with it, and the build-time signature is dropped', async () => {
  const out = join(ROOT, 'pack-exclude');
  await build(out, '--exclude', 'packs', '--exclude', 'og');
  assert.ok(!existsSync(join(out, 'catalog', 'packs')) && !existsSync(join(out, 'catalog', 'og')));
  const index = JSON.parse(readFileSync(join(out, 'catalog', 'assets', 'index.json'), 'utf8')) as { assets: Array<{ id: string; formats: Array<{ url: string }> }> };
  assert.deepEqual(index.assets.map((a) => a.id), ['a1', 'm1', 'r1', 'p1']);
  assert.deepEqual(index.assets.find((a) => a.id === 'm1')!.formats.map((f) => f.url), ['/catalog/assets/m.svg']);
  // Every /catalog/ URL left in the index names a file the pack holds.
  for (const asset of index.assets) for (const f of asset.formats) {
    if (f.url.startsWith('/catalog/') && asset.id !== 'p1') assert.ok(existsSync(join(out, f.url.slice(1))), f.url);
  }
  // The pack's build-time signature can never match the index the server
  // serves per caller, and its files map names every tool.
  assert.ok(!existsSync(join(out, 'catalog', 'tools', 'index.sig.json')));
  assert.ok(existsSync(join(out, 'catalog', 'tools', 'index.slim.json')), 'the slim index stays: the server filters it');
  const source = JSON.parse(readFileSync(join(out, SOURCE_FILE), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(source.excluded, ['catalog/packs', 'catalog/og']);
  assert.deepEqual(source.prunedAssets, [{ id: 'e1', removed: true }, { id: 'm1', removed: false }]);
  assert.deepEqual(source.removed, ['catalog/tools/index.sig.json']);
  assert.equal(source.commit, git('rev-parse', 'HEAD'));
  assert.equal(source.incomplete, undefined);
});

test('a rebuild that fails leaves no provenance describing the earlier build', async () => {
  const out = join(ROOT, 'pack-rebuild');
  await build(out);
  const first = JSON.parse(readFileSync(join(out, SOURCE_FILE), 'utf8')) as { commit: string; incomplete?: boolean };
  assert.equal(first.incomplete, undefined);

  writeFileSync(join(CHECKOUT, 'README.md'), 'second commit');
  git('add', '.');
  git('commit', '-q', '-m', 'second');
  process.env.FAKE_RESOLVER_FAIL = '1';
  try {
    assert.equal(await build(out), 1);
  } finally {
    delete process.env.FAKE_RESOLVER_FAIL;
  }
  const after = JSON.parse(readFileSync(join(out, SOURCE_FILE), 'utf8')) as { commit: string; incomplete?: boolean };
  assert.equal(after.incomplete, true, 'the record says the pack is incomplete');
  assert.notEqual(after.commit, first.commit, 'the earlier commit no longer describes these bytes');

  // The marker still lets the script rebuild into the same directory.
  await build(out);
  const rebuilt = JSON.parse(readFileSync(join(out, SOURCE_FILE), 'utf8')) as { commit: string; incomplete?: boolean };
  assert.equal(rebuilt.incomplete, undefined);
  assert.equal(rebuilt.commit, git('rev-parse', 'HEAD'));
});

test('a pack whose build did not finish is named as such for the function build', async () => {
  const out = join(ROOT, 'pack-incomplete');
  process.env.FAKE_RESOLVER_FAIL = '1';
  try {
    await build(out);
  } finally {
    delete process.env.FAKE_RESOLVER_FAIL;
  }
  assert.match(incompletePackReason(out) ?? '', /did not finish/);
  await build(out);
  assert.equal(incompletePackReason(out), null);
  assert.equal(incompletePackReason(join(ROOT, 'no-such-pack')), null);
});

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_, child: unknown) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

// A committed fixture verifier really checks P-256 signatures and exact signed
// files. The operator's reviewed source/pin determines which verifier runs.
const RELEASE_VERIFIER = `
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { join } from 'node:path';
const args = process.argv.slice(2), root = args[args.indexOf('--root') + 1], pin = args[args.indexOf('--public-key') + 1];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, child) => child && typeof child === 'object' && !Array.isArray(child)
  ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
try {
  const key = JSON.parse(readFileSync(pin)), envPin = JSON.parse(process.env.VITE_CATALOG_PUBLIC_KEY_JWK);
  if (canonical(key) !== canonical(envPin)) throw new Error('ambient pin was not overridden');
  const envelope = JSON.parse(readFileSync(join(root, 'catalog/tools/index.sig.json'))), { signature, ...unsigned } = envelope;
  if (!verify('sha256', Buffer.from(canonical(unsigned)), { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))) throw new Error('signature');
  const indexSha256 = hash(readFileSync(join(root, 'catalog/tools/index.json')));
  if (indexSha256 !== envelope.indexHash) throw new Error('index');
  for (const [path, sha] of Object.entries(envelope.files)) {
    if (hash(readFileSync(join(root, 'tools', path))) !== sha) throw new Error('tool');
    const [id, ...rest] = path.split('/');
    if (hash(readFileSync(join(root, 'tools', id + '@' + envelope.toolDirs[id].slice(0, 16), ...rest))) !== sha) throw new Error('alias');
  }
  console.log(JSON.stringify({ verified: true, files: Object.keys(envelope.files).length, indexSha256 }));
} catch { process.exitCode = 1; }
`;

interface ReleaseFixture {
  release: string;
  out: string;
  source: string;
  pin: string;
  manifest: string;
  custody: string;
  template: Buffer;
  options: ReleasePackOptions;
  refresh(): void;
  args(): string[];
}
function fullManifest(root: string): { version: 1; files: Array<{ path: string; size: number; sha256: string }>; totalBytes: number } {
  const paths: string[] = [];
  function walk(path = ''): void {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const leaf = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(leaf); else paths.push(leaf);
    }
  }
  walk();
  const files = paths.sort().map(path => { const bytes = readFileSync(join(root, path)); return { path, size: bytes.length, sha256: hash(bytes) }; });
  return { version: 1, files, totalBytes: files.reduce((total, row) => total + row.size, 0) };
}
function releaseFixture(name: string): ReleaseFixture {
  const base = join(ROOT, name), source = join(base, 'source'), release = join(base, 'release'), out = join(base, 'raw');
  function put(root: string, path: string, bytes: Uint8Array | string): void {
    mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes, { mode: 0o644 });
  }
  put(source, 'package.json', '{"type":"module"}');
  put(source, 'packages/node-shell/src/content-roots.ts', 'throw new Error("release mode must not run the source resolver");');
  put(source, 'scripts/verify-release-catalog.ts', RELEASE_VERIFIER);
  spawnSync('git', ['init', '-q', source]);
  for (const args of [['add', '.'], ['commit', '-q', '-m', 'fixture']]) {
    const result = spawnSync('git', ['-C', source, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test', ...args]);
    assert.equal(result.status, 0);
  }
  const commit = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const template = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>{{title}}</text></svg>');
  const tool = JSON.stringify({ id: 't1', name: 'Test', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg'] }, inputs: [{ id: 'title', type: 'text', label: 'Title', default: 'Welcome' }] });
  const directoryFiles = { 'template.html': hash(template), 'tool.json': hash(tool) }, directoryHash = hash(canonical(directoryFiles));
  const files = Object.fromEntries(Object.entries(directoryFiles).map(([path, sha]) => [`t1/${path}`, sha]));
  const index = JSON.stringify({ version: '1', tools: [{ id: 't1', name: 'Test', version: '1.0.0', status: 'official' }] });
  const slim = JSON.stringify({ version: '1', tools: [{ id: 't1' }] });
  const assetPath = `catalog/assets/a.${hash(template).slice(0, 16)}.svg`, shotPath = `info/shots/a.${hash(template).slice(0, 16)}.svg`;
  const assets = JSON.stringify({ version: '1', assets: [{ id: 'a', name: 'Asset', kind: 'image', formats: [{ format: 'svg', mime: 'image/svg+xml',
    url: '/' + assetPath, checksum: 'sha256-' + Buffer.from(hash(template), 'hex').toString('base64'), size: template.length }] }] });
  const indexRows = [['tools/index', index], ['tools/index.slim', slim], ['assets/index', assets]] as const;
  for (const [prefix, bytes] of indexRows) { put(release, `catalog/${prefix}.json`, bytes); put(release, `catalog/${prefix}.${hash(bytes).slice(0, 16)}.json`, bytes); }
  for (const prefix of ['tools/t1', `tools/t1@${directoryHash.slice(0, 16)}`]) {
    put(release, `${prefix}/tool.json`, tool); put(release, `${prefix}/template.html`, template);
  }
  put(release, assetPath, template); put(release, 'catalog/assets/a.svg', template); put(release, shotPath, template);
  put(release, 'catalog/og/keep.svg', template); put(release, 'index.html', '<html>shell</html>'); put(release, '_app/app.js', 'export {};');
  put(release, 'tools/t1/template.html.gz', gzipSync(template));
  put(release, `tools/t1@${directoryHash.slice(0, 16)}/template.html.br`, brotliCompressSync(template));
  put(release, 'catalog/tools/index.json.gz', gzipSync(index)); put(release, 'index.html.br', brotliCompressSync('<html>shell</html>'));
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicJwk = publicKey.export({ format: 'jwk' }), keyId = createHash('sha256').update(canonical(publicJwk)).digest('base64url');
  const pin = join(base, 'public.jwk.json'); writeFileSync(pin, JSON.stringify(publicJwk), { mode: 0o600 });
  const unsigned = { alg: 'ECDSA-P256-SHA256', keyId, signedAt: '2026-10-11T00:00:00.000Z', seq: 1,
    indexHash: hash(index), assetIndexHash: hash(assets), slimHash: hash(slim), files, toolDirs: { t1: directoryHash } };
  put(release, 'catalog/tools/index.sig.json', JSON.stringify({ ...unsigned,
    signature: sign('sha256', Buffer.from(canonical(unsigned)), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }));
  const addressed = [assetPath, shotPath, ...Object.keys(directoryFiles).map(path => `tools/t1@${directoryHash.slice(0, 16)}/${path}`),
    ...indexRows.map(([prefix, bytes]) => `catalog/${prefix}.${hash(bytes).slice(0, 16)}.json`)];
  put(release, 'catalog/delivery-manifest.json', JSON.stringify({ version: 1, files: addressed.sort().map(path => {
    const bytes = readFileSync(join(release, path)); return { path, size: bytes.length, sha256: hash(bytes) };
  }) }));
  const manifest = join(base, 'manifest.json'), custody = join(base, 'custody.json');
  const options: ReleasePackOptions = { root: release, custody, custodySha256: '', lolly: source, commit, profile: 'p', node: process.execPath };
  function refresh(): void {
    writeFileSync(manifest, JSON.stringify(fullManifest(release)), { mode: 0o600 });
    writeFileSync(custody, JSON.stringify({ version: 1, status: 'SIGNED_LOLLY_RELEASE_REVIEWED', lollySource: commit, profile: 'p',
      manifest: { path: 'manifest.json', sha256: hash(readFileSync(manifest)) }, publicPin: { path: 'public.jwk.json', sha256: hash(readFileSync(pin)) },
      verifier: { path: 'scripts/verify-release-catalog.ts', sha256: hash(RELEASE_VERIFIER) } }), { mode: 0o600 });
    options.custodySha256 = hash(readFileSync(custody));
  }
  refresh();
  return { source, release, out, pin, custody, manifest, template, options, refresh, args: () => ['--lolly', source, '--profile', 'p', '--out', out,
    '--release-root', release, '--release-custody', custody, '--release-custody-sha256', options.custodySha256] };
}

test('signed release mode preserves exact indexes, assets and global inventory bytes without the source resolver', async () => {
  const fixture = releaseFixture('release-exact');
  const ambient = process.env.VITE_CATALOG_PUBLIC_KEY_JWK;
  process.env.VITE_CATALOG_PUBLIC_KEY_JWK = '{"bad":"ambient"}';
  try { assert.equal(await main(fixture.args()), 0); }
  finally { if (ambient === undefined) delete process.env.VITE_CATALOG_PUBLIC_KEY_JWK; else process.env.VITE_CATALOG_PUBLIC_KEY_JWK = ambient; }
  const verified = verifyReleasePack(fixture.options);
  for (const path of verified.paths) assert.deepEqual(readFileSync(join(fixture.out, path)), readFileSync(join(fixture.release, path)), path);
  assert.ok(!existsSync(join(fixture.out, 'index.html')) && !existsSync(join(fixture.out, '_app')));
  assert.ok(!existsSync(join(fixture.out, 'catalog/tools/index.sig.json')));
  assert.ok(!existsSync(join(fixture.out, 'tools/t1/template.html.gz')));
  assert.ok(existsSync(join(fixture.out, 'catalog/og/keep.svg')), 'no post-signing exclusions');
  assert.ok(verified.paths.some(path => path.startsWith('info/shots/')));
  const stamp = JSON.parse(readFileSync(join(fixture.out, SOURCE_FILE), 'utf8'));
  assert.equal(stamp.version, 2); assert.deepEqual(stamp.excluded, []);
  assert.deepEqual(stamp.removed, ['catalog/tools/index.sig.json']);
  assert.deepEqual(stamp.derivation, verified.derivation); assert.equal(stamp.derivation.omittedCodingSidecars, 4);
  const rawManifest = join(dirname(fixture.out), 'raw.manifest.json');
  writeFileSync(rawManifest, JSON.stringify(fullManifest(fixture.out)), { mode: 0o600 });
  const ref = (path: string) => ({ path, sha256: hash(readFileSync(path)) });
  const evidence = { lolly: { source: fixture.options.commit }, profile: 'p', publicPin: ref(fixture.pin),
    candidateShell: { root: fixture.release, manifest: ref(fixture.manifest) }, rawPack: { root: fixture.out, manifest: ref(rawManifest) },
    rawDerivation: { custody: ref(fixture.custody) } };
  const accepted = spawnSync('python3', ['-B', '-c', `
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('cohort',Path('scripts/prepare-private-cohort.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
value=json.load(sys.stdin);inputs=m.Inputs(Path(value['candidateShell']['root']).parent)
candidate=m.Tree(value['candidateShell'],inputs);raw=m.Tree(value['rawPack'],inputs)
public_pin=inputs.file(value['publicPin']);m.catalog(candidate,raw,public_pin,m.digest(public_pin),sys.argv[2])
result=m.raw_source_stamp(value,inputs,raw,candidate,Path(sys.argv[1]),m.git_command)
inputs.unchanged();print(json.dumps(result))
`, fixture.source, process.execPath], { cwd: fileURLToPath(new URL('..', import.meta.url)), input: JSON.stringify(evidence), encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.deepEqual(JSON.parse(accepted.stdout), stamp.derivation, 'independent Work preparer admits the exact producer receipt');
  await assert.rejects(main(fixture.args()), /empty output directory/);
});

test('release mode refuses incomplete flags, dirty overrides and post-signing exclusions', () => {
  const fixture = releaseFixture('release-args');
  assert.throws(() => parseArgs([...fixture.args(), '--exclude', 'og']), /does not allow/);
  assert.throws(() => parseArgs([...fixture.args(), '--allow-dirty']), /does not allow/);
  assert.throws(() => parseArgs([...fixture.args(), '--out', join(fixture.release, 'raw')]), /overlap/);
  assert.throws(() => parseArgs([...fixture.args(), '--out', join(fixture.source, '..within-checkout')]), /outside/);
  assert.throws(() => parseArgs(['--lolly', fixture.source, '--profile', 'p', '--out', fixture.out, '--release-root', fixture.release]), /together/);
});

test('release mode retains an earlier immutable tool and index with their actual addressed bytes', async () => {
  const fixture = releaseFixture('release-retained');
  const oldTool = readFileSync(join(fixture.release, 'tools/t1/tool.json'), 'utf8').replace('"Test"', '"Earlier"');
  const entries = { 'template.html': hash(fixture.template), 'tool.json': hash(oldTool) }, address = hash(canonical(entries));
  const prefix = `tools/t1@${address.slice(0, 16)}`, oldIndex = '{"version":"1","tools":[{"id":"t1","name":"Earlier"}]}';
  mkdirSync(join(fixture.release, prefix));
  writeFileSync(join(fixture.release, prefix, 'tool.json'), oldTool); writeFileSync(join(fixture.release, prefix, 'template.html'), fixture.template);
  const oldIndexPath = `catalog/tools/index.${hash(oldIndex).slice(0, 16)}.json`;
  writeFileSync(join(fixture.release, oldIndexPath), oldIndex);
  const inventoryPath = join(fixture.release, 'catalog/delivery-manifest.json'), inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  for (const path of [prefix + '/tool.json', prefix + '/template.html', oldIndexPath]) {
    const bytes = readFileSync(join(fixture.release, path)); inventory.files.push({ path, size: bytes.length, sha256: hash(bytes) });
  }
  inventory.files.sort((a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  writeFileSync(inventoryPath, JSON.stringify(inventory)); fixture.refresh();
  assert.equal(await main(fixture.args()), 0);
  assert.equal(readFileSync(join(fixture.out, prefix, 'tool.json'), 'utf8'), oldTool);
  assert.equal(readFileSync(join(fixture.out, oldIndexPath), 'utf8'), oldIndex);
  writeFileSync(join(fixture.release, prefix, 'template.html'), 'different');
  const changed = inventory.files.find((row: { path: string }) => row.path === prefix + '/template.html');
  changed.size = 9; changed.sha256 = hash('different'); writeFileSync(inventoryPath, JSON.stringify(inventory)); fixture.refresh();
  assert.throws(() => verifyReleasePack(fixture.options), /content address/);
});

test('release mode refuses changed complete-manifest bytes, an unsigned extra tool and a false source binding', () => {
  const changed = releaseFixture('release-changed');
  writeFileSync(join(changed.release, '_app/app.js'), 'changed');
  assert.throws(() => verifyReleasePack(changed.options), /reviewed manifest/);
  const unsigned = releaseFixture('release-unsigned');
  writeFileSync(join(unsigned.release, 'tools/t1/injected.js'), 'injected'); unsigned.refresh();
  assert.throws(() => verifyReleasePack(unsigned.options), /signed closure/);
  const bound = releaseFixture('release-source');
  const custody = JSON.parse(readFileSync(bound.custody, 'utf8')); custody.lollySource = 'a'.repeat(40);
  writeFileSync(bound.custody, JSON.stringify(custody)); bound.options.custodySha256 = hash(readFileSync(bound.custody));
  assert.throws(() => verifyReleasePack(bound.options), /source or profile/);
});

test('release mode refuses wrong public pins and tampered signatures despite reviewed tree hashes', () => {
  const pin = releaseFixture('release-wrong-pin');
  writeFileSync(pin.pin, JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }))); pin.refresh();
  assert.throws(() => verifyReleasePack(pin.options), /verification failed/);
  const signed = releaseFixture('release-bad-signature');
  const envelope = JSON.parse(readFileSync(join(signed.release, 'catalog/tools/index.sig.json'), 'utf8')); envelope.signature = 'A'.repeat(86);
  writeFileSync(join(signed.release, 'catalog/tools/index.sig.json'), JSON.stringify(envelope)); signed.refresh();
  assert.throws(() => verifyReleasePack(signed.options), /verification failed/);
});

test('release mode rejects corrupt, orphaned, oversized and trailing coding bytes', () => {
  for (const variant of ['corrupt', 'orphan', 'oversized', 'trailing']) {
    const fixture = releaseFixture('release-coding-' + variant), file = join(fixture.release, 'index.html.br');
    if (variant === 'corrupt') writeFileSync(file, 'not brotli');
    if (variant === 'orphan') writeFileSync(join(fixture.release, 'orphan.json.gz'), gzipSync('{}'));
    if (variant === 'oversized') writeFileSync(file, brotliCompressSync('expanded'.repeat(10000)));
    if (variant === 'trailing') writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from('junk')]));
    fixture.refresh();
    assert.throws(() => verifyReleasePack(fixture.options), /coding sidecar/);
  }
});

test('release mode rejects symlinked trees, writable inputs and source changes without creating output', async () => {
  const link = releaseFixture('release-link'); symlinkSync(join(link.release, 'index.html'), join(link.release, 'alias.html')); link.refresh();
  assert.throws(() => verifyReleasePack(link.options), /link or special file/);
  const writable = releaseFixture('release-writable'); chmodSync(join(writable.release, 'index.html'), 0o666);
  assert.throws(() => verifyReleasePack(writable.options), /not writable by others/);
  const dirty = releaseFixture('release-dirty'); writeFileSync(join(dirty.source, 'dirty.txt'), 'dirty');
  assert.equal(await main(dirty.args()), 1); assert.ok(!existsSync(dirty.out));
});

test('release copy refuses a tree changed after verification and never replaces an existing destination', () => {
  const changed = releaseFixture('release-copy-change'), verified = verifyReleasePack(changed.options);
  mkdirSync(changed.out); writeFileSync(join(changed.release, '_app/app.js'), 'changed');
  assert.throws(() => verified.copyTo(changed.out), /changed during/);
  const collision = releaseFixture('release-copy-collision'), copy = verifyReleasePack(collision.options);
  mkdirSync(join(collision.out, 'catalog/assets'), { recursive: true }); writeFileSync(join(collision.out, 'catalog/assets/a.svg'), 'original');
  assert.throws(() => copy.copyTo(collision.out), /raw output must be empty/);
  assert.equal(readFileSync(join(collision.out, 'catalog/assets/a.svg'), 'utf8'), 'original');
});
