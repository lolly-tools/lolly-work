// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { prepareShellUpdate, shellUpdateArguments, shellUpdateDelta } from '../scripts/prepare-shell-update.ts';
import type { ShellUpdateOptions } from '../scripts/prepare-shell-update.ts';
import { cloneShellFiles, sha256, shellFileCustody, shellFileStamp, shellId, shellManifest, writeShellJson } from '../scripts/shell-update-files.ts';
import { shellReleaseId } from '../scripts/shell-release-id.ts';

const work = realpathSync(join(import.meta.dirname, '..'));
const installed = process.env.LOLLY_SHELL_TEST_DEPENDENCIES ?? join(work, 'qualification-lolly/node_modules');
const hasVite = existsSync(join(installed, 'vite/dist/node/index.js'));
const engineIntegrity = join(work, 'vendor/@lolly/engine/src/catalog-integrity.ts');
function put(root: string, relative: string, value: string): void { mkdirSync(dirname(join(root, relative)), { recursive: true }); writeFileSync(join(root, relative), value); }
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Shell update test', '-c', 'user.email=test@example.invalid', ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lw-shell-update-'))), source = join(root, 'source'), previous = join(root, 'previous');
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(source); mkdirSync(previous);
  put(source, 'package.json', JSON.stringify({ name: 'lolly', type: 'module' })); put(source, '.gitignore', 'node_modules/\nshells/web/public/ort/\nshells/web/public/ort-hf/\n');
  for (const [name, dir] of Object.entries({ '@lolly/engine': 'engine', '@lolly-tools/core': 'packages/core', '@lolly-tools/node-shell': 'packages/node-shell', '@lolly-tools/rondo': 'packages/rondo', '@lolly-tools/audio-dock': 'packages/audio-dock' })) {
    put(source, `${dir}/package.json`, JSON.stringify({ name, type: 'module', exports: { '.': './src/index.ts' } })); put(source, `${dir}/src/index.ts`, 'export const number = 17;\n');
  }
  put(source, 'engine/src/version.ts', 'export const version = "test";\n'); put(source, 'packages/core/src/host-v1.ts', 'export const host = "test";\n');
  put(source, 'schemas/tool.schema.json', '{}\n'); put(source, 'profiles.json', '{}\n');
  put(source, 'shells/web/index.html', '<body><script type="module" src="./src/main.ts"></script></body>');
  put(source, 'shells/web/src/main.ts', 'import { number } from "@lolly/engine"; document.body.textContent = String(number) + "base";\n');
  put(source, 'shells/web/vite.config.js', `import { writeFileSync, existsSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; let out;\nexport default { plugins: [{name:'test-maintained-static', configResolved(c){out=c.build.outDir}, buildStart(){if(!existsSync(fileURLToPath(new URL('./public/ort/ort-wasm-test.wasm',import.meta.url))))throw new Error('Fixture source-runtime cache required')}, closeBundle(){writeFileSync(out+'/precache.json','{"version":"test"}')}}], worker:{plugins:()=>[]},build:{assetsDir:'_app',minify:false}};\n`);
  put(source, 'scripts/webgpu-release-gate.ts', 'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["--scope", "web"])) throw new Error("Fixture requires explicit web scope"); console.log("Fixture web gate passed; no physical qualification claimed");\n');
  // The fixture invokes the repository's real vendored catalog crypto, while the
  // producer invokes its supplied Lolly source's maintained release verifier.
  put(source, 'scripts/verify-release-catalog.ts', `import { readFileSync } from 'node:fs'; import { join } from 'node:path';
import { importSpkiOrJwkPublicKey, verifyCatalogEnvelope, verifyToolFile } from ${JSON.stringify(engineIntegrity)};
const args = new Map(); for(let i=2;i<process.argv.length;i+=2) args.set(process.argv[i],process.argv[i+1]);
const root=args.get('--root'), pin=JSON.parse(readFileSync(args.get('--public-key'),'utf8'));
const envelope=JSON.parse(readFileSync(join(root,'catalog/tools/index.sig.json'),'utf8'));
const index=readFileSync(join(root,'catalog/tools/index.json'));
if(!(await verifyCatalogEnvelope(envelope,index,await importSpkiOrJwkPublicKey(pin))).ok) throw new Error('Signature refused');
for(const path of Object.keys(envelope.files)){const [tool,...parts]=path.split('/');if(!(await verifyToolFile(envelope,tool,parts.join('/'),readFileSync(join(root,'tools',path)))).ok)throw new Error('Signed bytes refused');}
console.log(JSON.stringify({verified:true,files:Object.keys(envelope.files).length}));\n`);
  if (hasVite) symlinkSync(installed, join(source, 'node_modules'), 'dir');
  git(source, 'init', '-q'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'test base'); const base = git(source, 'rev-parse', 'HEAD');
  put(source, 'shells/web/src/main.ts', 'import { number } from "@lolly/engine"; document.body.textContent = String(number) + "candidate";\n');
  git(source, 'add', 'shells/web/src/main.ts'); git(source, 'commit', '-qm', 'test shell change'); const candidate = git(source, 'rev-parse', 'HEAD');
  put(previous, 'index.html', '<body><script src="/_app/old-lazy.js"></script></body>'); put(previous, '_app/old-lazy.js', 'export const previous = true;');
  put(previous, 'precache.json', '{"version":"old"}'); put(previous, 'font.woff2', 'accepted static font'); put(previous, 'portable/player.js', 'old portable player');
  // The real ORT plugin checks source cache paths despite publicDir overrides.
  // Mirror that constraint with ignored, exact accepted bytes; never regenerate.
  put(previous, 'ort/ort-wasm-test.wasm', 'accepted synthetic runtime');
  put(previous, 'ort-hf/test/runtime.wasm', 'accepted synthetic speech runtime');
  put(previous, 'viz-presets/test.json', '{"fixture":true}');
  put(source, 'shells/web/public/ort/ort-wasm-test.wasm', 'accepted synthetic runtime');
  put(source, 'shells/web/public/ort-hf/test/runtime.wasm', 'accepted synthetic speech runtime');
  // Test-only ephemeral signing demonstrates the real maintained P-256 verifier.
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), pin = pair.publicKey.export({ format: 'jwk' });
  const publicKey = join(root, 'public.json'); writeShellJson(publicKey, pin);
  const index = '{"tools":[]}\n', tool = '{"id":"demo"}\n'; put(previous, 'catalog/tools/index.json', index); put(previous, 'tools/demo/tool.json', tool);
  const keyId = Buffer.from(sha256(canonical({ crv: pin.crv, kty: pin.kty, x: pin.x, y: pin.y })), 'hex').toString('base64url');
  const unsigned = { alg: 'ECDSA-P256-SHA256', keyId, signedAt: '2026-10-10T00:00:00.000Z', indexHash: sha256(index), files: { 'demo/tool.json': sha256(tool) } };
  put(previous, 'catalog/tools/index.sig.json', JSON.stringify({ ...unsigned, signature: sign('sha256', Buffer.from(canonical(unsigned)), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') }));
  // Historical Python receipts use canonical key order, independent of Node's
  // insertion order. The real CLI must still bind every entry and exact bytes.
  const previousManifest = writeShellJson(join(root, 'previous.json'), JSON.parse(canonical(shellManifest(previous))));
  const previousAcceptance = writeShellJson(join(root, 'acceptance.json'), { fixtureOnly: true, originAuthenticated: false });
  const ci = writeShellJson(join(root, 'ci.json'), { fixtureOnly: true, originAuthenticated: false });
  const custody = writeShellJson(join(root, 'custody.json'), { version: 1, engineSource: base, workSource: '1'.repeat(40), brandCommit: '2'.repeat(40), enginePinSha256: '3'.repeat(64), profile: 'suse',
    settings: { catalogTrustMode: 'verified', requireAiPolicy: true, liveRelay: 'https://example.invalid/live', siteUrl: 'https://example.invalid' }, previousManifest, previousAcceptance, ci, publicKeySha256: sha256(readFileSync(publicKey)) });
  const options: ShellUpdateOptions = { source, base, candidate, previousShell: previous, publicKey, custody: custody.path, custodySha256: custody.sha256, out: join(root, 'output') };
  return { root, source, previous, options };
}

test('real CLI builds with Vite and catalog crypto, retains lazy assets, and leaves the baseline exact', { skip: !hasVite && 'Requires the qualified Lolly dependency cache (LOLLY_SHELL_TEST_DEPENDENCIES).' }, t => {
  const f = fixture(t), before = shellManifest(f.previous);
  const args = ['--source', f.source, '--base', f.options.base, '--candidate', f.options.candidate, '--previous-shell', f.previous, '--public-key', f.options.publicKey,
    '--custody', f.options.custody, '--custody-sha256', f.options.custodySha256, '--out', f.options.out];
  const result = spawnSync(process.execPath, [join(work, 'scripts/prepare-shell-update.ts'), ...args], { encoding: 'utf8', timeout: 90_000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) assert.fail(`${result.stderr}\n${existsSync(join(f.options.out, 'shell-update.refused.json')) ? readFileSync(join(f.options.out, 'shell-update.refused.json'), 'utf8') : ''}\n${existsSync(join(f.options.out, 'vite-build.original.json')) ? readFileSync(join(f.options.out, 'vite-build.original.json'), 'utf8') : ''}`);
  const prepared = JSON.parse(readFileSync(join(f.options.out, 'shell-update.prepared.json'), 'utf8'));
  assert.equal(prepared.status, 'LOCAL_PRIVATE_SHELL_UPDATE_PREPARED_UNQUALIFIED');
  assert.equal(prepared.normalCIQualified, false); assert.equal(prepared.runtimeQualified, false); assert.equal(prepared.promotionAttempted, false); assert.equal(prepared.originAuthenticatedByThisCommand, false);
  assert.equal(prepared.catalog.signatureReused, true); assert.equal(prepared.catalog.newSigning, false);
  assert.equal(readFileSync(join(prepared.shell.root, '_app/old-lazy.js'), 'utf8'), 'export const previous = true;');
  assert.equal(readFileSync(join(prepared.shell.root, 'font.woff2'), 'utf8'), 'accepted static font'); assert.deepEqual(shellManifest(f.previous), before);
  assert.ok(prepared.delta.files > 0); assert.ok(prepared.delta.totalBytes < 100_000);
  assert.equal(shellId(shellManifest(prepared.shell.root)), shellReleaseId(prepared.shell.root));
  const modules = JSON.parse(readFileSync(prepared.workspaceModules.path, 'utf8'));
  assert.ok(modules.modules.some((row: { path: string }) => row.path === join(f.source, 'engine/src/index.ts')));
  assert.equal(git(f.source, 'status', '--porcelain'), '');
  const previousEnvelope = readFileSync(join(f.previous, 'catalog/tools/index.sig.json'));
  assert.deepEqual(readFileSync(join(prepared.shell.root, 'catalog/tools/index.sig.json')), previousEnvelope);
});

test('genuine clone receipts bind full target metadata and descriptor-verified content', t => {
  const f = fixture(t), destination = join(f.root, 'clone-custody'); mkdirSync(destination);
  const files = shellManifest(f.previous).files;
  const rows = cloneShellFiles(f.previous, destination, files, join(f.root, 'clone-input.json'));
  assert.equal(rows.length, files.length);
  for (const row of rows) {
    const path = join(destination, row.path), actual = shellFileCustody(path);
    const stat = lstatSync(path, { bigint: true });
    assert.deepEqual(Object.keys(row).sort(), ['ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'path', 'sha256', 'size']);
    assert.equal(`${row.dev}:${row.ino}:${row.mode}:${row.size}:${row.mtimeNs}:${row.ctimeNs}`, shellFileStamp(stat));
    assert.equal(actual.stamp, shellFileStamp(stat)); assert.equal(actual.sha256, row.sha256); assert.equal(actual.size, row.size);
    assert.notEqual(stat.ino, lstatSync(join(f.previous, row.path), { bigint: true }).ino);
  }
});

test('dirty candidate and shared-contract changes refuse before output creation', t => {
  for (const path of ['shells/web/src/main.ts', 'engine/src/version.ts']) {
    const f = fixture(t); put(f.source, path, 'changed local source');
    if (path.startsWith('engine/')) { git(f.source, 'add', path); git(f.source, 'commit', '-qm', 'test incompatible change'); f.options.candidate = git(f.source, 'rev-parse', 'HEAD'); }
    assert.throws(() => prepareShellUpdate(f.options), /changes|source|qualify|contract|shell/i); assert.equal(existsSync(f.options.out), false);
  }
});

test('custody or complete previous bytes mismatches refuse before creating output', t => {
  for (const tamper of ['custody', 'previous']) {
    const f = fixture(t);
    if (tamper === 'custody') writeFileSync(f.options.custody, '{}'); else put(f.previous, 'font.woff2', 'changed accepted bytes');
    assert.throws(() => prepareShellUpdate(f.options), /custody|manifest/i); assert.equal(existsSync(f.options.out), false);
  }
});

test('existing source runtime caches must match accepted external assets exactly', t => {
  const f = fixture(t); put(f.source, 'shells/web/public/ort/ort-wasm-test.wasm', 'different generated runtime');
  assert.throws(() => prepareShellUpdate(f.options), /Cached generated prerequisite/); assert.equal(existsSync(f.options.out), false);
});

test('the maintained source plugin can refuse absent ignored runtime cache without source generation', { skip: !hasVite }, t => {
  const f = fixture(t); rmSync(join(f.source, 'shells/web/public/ort'), { recursive: true });
  assert.throws(() => prepareShellUpdate(f.options), /Maintained vite-build refused/);
  assert.equal(existsSync(join(f.source, 'shells/web/public/ort')), false);
  assert.ok(existsSync(join(f.options.out, 'shell-update.refused.json')));
});

test('generated static changes/removals refuse; only explicit UI paths enter the delta', () => {
  const file = (path: string, value: string) => ({ path, size: value.length, sha256: sha256(value) });
  const previous = { version: 1 as const, files: [file('font.woff2', 'safe')], totalBytes: 4 };
  assert.throws(() => shellUpdateDelta({ version: 1, files: [file('font.woff2', 'bad')], totalBytes: 3 }, previous), /non-shell/);
  assert.throws(() => shellUpdateDelta({ version: 1, files: [], totalBytes: 0 }, previous), /removed/);
  const candidate = { version: 1 as const, files: [file('font.woff2', 'safe'), file('portable/player.js', 'new')], totalBytes: 7 };
  assert.deepEqual(shellUpdateDelta(candidate, previous).files.map(row => row.path), ['portable/player.js']);
});

test('exact workspace guard refuses an escaped cached workspace path and permits its exact source', async t => {
  const f = fixture(t), runner: string = pathToFileURL(join(work, 'scripts/shell-update-vite.mjs')).href;
  const { workspaceModule } = await import(runner);
  assert.equal(workspaceModule(join(f.source, 'engine/src/index.ts'), f.source), join(f.source, 'engine/src/index.ts'));
  assert.throws(() => workspaceModule(join(f.root, 'outside/engine/src/index.ts'), f.source), /escaped/);
});

test('CLI input options are exact and help does not build', () => {
  assert.throws(() => shellUpdateArguments(['--source', '/tmp']), /every/);
  const result = spawnSync(process.execPath, [join(work, 'scripts/prepare-shell-update.ts'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.match(result.stdout, /never installs dependencies/);
});
