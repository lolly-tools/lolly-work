// SPDX-License-Identifier: MPL-2.0
// Synthetic public content; actual Vite and maintained catalog crypto. No production/private pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { preparePublicShellUpdate, publicShellArguments, PUBLIC_SETTINGS } from '../scripts/prepare-public-shell-update.ts';
import type { PublicShellOptions } from '../scripts/prepare-public-shell-update.ts';
import { sha256, shellManifest, writeShellJson } from '../scripts/shell-update-files.ts';
const work = realpathSync(join(import.meta.dirname,'..'));
const installed = process.env.LOLLY_SHELL_TEST_DEPENDENCIES ?? join(work,'qualification-lolly/node_modules');
const hasVite = existsSync(join(installed,'vite/dist/node/index.js'));
const engineIntegrity = join(work,'vendor/@lolly/engine/src/catalog-integrity.ts');
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
  put(source, 'shells/web/vite.config.js', `import { writeFileSync, existsSync, mkdirSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; let out;\nexport default { plugins: [{name:'test-maintained-static', configResolved(c){out=c.build.outDir}, buildStart(){if(process.env.LOLLY_PROFILE!=='lolly-start'||process.env.VITE_REQUIRE_AI_POLICY!=='false'||process.env.VITE_CATALOG_TRUST_MODE!=='verified'||process.env.VITE_LIVE_RELAY!=='https://lolly.tools/live'||process.env.LOLLY_SITE_URL!=='https://lolly.tools')throw new Error('Incorrect public settings');if(!existsSync(fileURLToPath(new URL('./public/ort/ort-wasm-test.wasm',import.meta.url))))throw new Error('Fixture source-runtime cache required')}, closeBundle(){writeFileSync(out+'/precache.json','{"version":"test"}');mkdirSync(out+'/portable',{recursive:true});writeFileSync(out+'/portable/player.js','synthetic maintained public player')}}], worker:{plugins:()=>[]},build:{assetsDir:'_app',minify:false}};\n`);
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
  put(previous, 'sw.js', 'accepted public service worker'); put(previous, 'precache.json', '{"version":"old"}'); put(previous, 'font.woff2', 'accepted static font'); put(previous, 'portable/player.js', 'old portable player');
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
  const previousAcceptance = writeShellJson(join(root, 'acceptance.json'), { status: 'READ_ONLY_PUBLIC647_PROMOTION_ACCEPTANCE_PASSED', fixtureOnly: true, originAuthenticated: false });
  const ci = writeShellJson(join(root, 'ci.json'), { fixtureOnly: true, originAuthenticated: false });
  const publicCatalog = { indexSha256: sha256(index), envelopeSha256: sha256(readFileSync(join(previous, 'catalog/tools/index.sig.json'))), pinCanonicalSha256: sha256(canonical({crv:pin.crv,kty:pin.kty,x:pin.x,y:pin.y})), keyId, signedFiles: 1 };
  const custody = writeShellJson(join(root, 'custody.json'), { version: 1, artifactClass:'public-shell-overlay', imageSource:base, previousShellSource:base, image:'ghcr.io/example/public@sha256:'+ 'a'.repeat(64), profile:'lolly-start', settings:PUBLIC_SETTINGS, previousManifest, previousAcceptance, ci, publicKeySha256:sha256(readFileSync(publicKey)), publicCatalog });
  const options: PublicShellOptions = { source, base, candidate, previousShell:previous, publicKey, custody:custody.path, custodySha256:custody.sha256, out:join(root,'output') };
  return { root, source, previous, options };
}

test('public CLI executes maintained Vite and real catalog crypto, retaining only the five public overlay paths', { skip: !hasVite && 'Requires existing qualified Vite dependency cache.' }, t => {
  const f = fixture(t), before = shellManifest(f.previous);
  const args = ['--source', f.source, '--base', f.options.base, '--candidate', f.options.candidate, '--previous-shell', f.previous, '--public-key', f.options.publicKey,
    '--custody', f.options.custody, '--custody-sha256', f.options.custodySha256, '--out', f.options.out];
  const r = spawnSync(process.execPath, [join(work, 'scripts/prepare-public-shell-update.ts'), ...args], { encoding: 'utf8', timeout: 90_000 });
  if (r.status !== 0) assert.fail(`${r.stderr}\n${['public-shell-update.refused.json','vite-build.original.json'].map(path => existsSync(join(f.options.out,path)) ? readFileSync(join(f.options.out,path),'utf8') : '').join('\n')}`);
  const p = JSON.parse(readFileSync(join(f.options.out, 'public-shell-update.prepared.json'), 'utf8'));
  assert.equal(p.status, 'LOCAL_PUBLIC_SHELL_UPDATE_PREPARED_UNQUALIFIED'); assert.equal(p.profile, 'lolly-start'); assert.deepEqual(p.settings, PUBLIC_SETTINGS);
  for (const field of ['originAuthenticatedByThisCommand','normalCIQualified','runtimeQualified','promotionAttempted']) assert.equal(p[field], false);
  assert.equal(p.catalog.newSigning, false); assert.equal(p.catalog.signatureReused, true); assert.equal(p.imageSource, f.options.base);
  assert.deepEqual(shellManifest(f.previous), before); assert.equal(git(f.source,'status','--porcelain'), '');
  const overlay = shellManifest(p.overlay.root);
  assert.ok(overlay.files.some(row => row.path === '_app/old-lazy.js'));
  assert.deepEqual(overlay.files.filter(row => !row.path.startsWith('_app/')).map(row => row.path), ['index.html','portable/player.js','precache.json','sw.js']);
  assert.equal(overlay.files.some(row => row.path.startsWith('catalog/') || row.path.startsWith('tools/') || row.path.startsWith('models/')), false);
  assert.deepEqual(readFileSync(join(p.shell.root,'catalog/tools/index.sig.json')), readFileSync(join(f.previous,'catalog/tools/index.sig.json')));
  assert.equal(readFileSync(join(p.overlay.root,'sw.js'),'utf8'), 'accepted public service worker');
  const report = JSON.parse(readFileSync(p.originalReport.path,'utf8')); assert.equal(report.exitCode,0); assert.match(report.stdout,/Vite|vite|built/);
});

test('public source/custody refuses changed profile, policy, pin, catalog, model payload and private acceptance', t => {
  const changes: Array<(f: ReturnType<typeof fixture>, c: any) => void> = [
    (_f,c) => { c.profile='suse'; }, (_f,c) => { c.settings.requireAiPolicy=true; }, (_f,c) => { c.settings.catalogTrustMode='unchecked'; },
    (_f,c) => { c.settings.liveRelay='https://lolly.ing/live'; }, (_f,c) => { c.settings.siteUrl='https://lolly.ing'; },
    (_f,c) => { c.publicKeySha256='0'.repeat(64); }, (_f,c) => { c.publicCatalog.indexSha256='0'.repeat(64); },
    (f,c) => { c.previousAcceptance=writeShellJson(join(f.root,'private.json'), {status:'MATCHED_PRIVATE_RUNTIME_AND_HTTPS_ACCEPTED'}); },
    (f,c) => { put(f.previous,'models/model.onnx','not a shell asset'); c.previousManifest=writeShellJson(join(f.root,'with-models.json'), shellManifest(f.previous)); },
  ];
  for (const change of changes) {
    const f=fixture(t), c=JSON.parse(readFileSync(f.options.custody,'utf8')); change(f,c);
    const ref=writeShellJson(join(f.root,'changed-custody.json'),c); f.options.custody=ref.path; f.options.custodySha256=ref.sha256;
    assert.throws(()=>preparePublicShellUpdate(f.options)); assert.equal(existsSync(f.options.out),false);
  }
});

test('public preparation rejects dirty source and committed non-shell/config/profile changes', t => {
  for (const path of ['shells/web/src/main.ts','shells/web/vite.config.js','profiles.json','engine/src/version.ts','package-lock.json']) {
    const f=fixture(t); put(f.source,path,'changed protected source');
    if (path!=='shells/web/src/main.ts') { git(f.source,'add',path);git(f.source,'commit','-qm','incompatible change');f.options.candidate=git(f.source,'rev-parse','HEAD'); }
    assert.throws(()=>preparePublicShellUpdate(f.options)); assert.equal(existsSync(f.options.out),false);
  }
});

test('maintained public signature verification refuses changed signed bytes even with a reviewed full snapshot', { skip: !hasVite }, t => {
  const f=fixture(t); put(f.previous,'tools/demo/tool.json','changed signed payload');
  const custody=JSON.parse(readFileSync(f.options.custody,'utf8'));
  custody.previousManifest=writeShellJson(join(f.root,'reviewed-altered-manifest.json'), shellManifest(f.previous));
  const ref=writeShellJson(join(f.root,'reviewed-altered-custody.json'),custody); f.options.custody=ref.path; f.options.custodySha256=ref.sha256;
  assert.throws(()=>preparePublicShellUpdate(f.options),/previous-catalog refused/);
  const original=JSON.parse(readFileSync(join(f.options.out,'previous-catalog.original.json'),'utf8'));
  assert.equal(original.exitCode,1); assert.match(original.stderr,/Signed bytes refused/);
  assert.equal(existsSync(join(f.options.out,'public-shell-update.prepared.json')),false);
});

test('public CLI requires every input and help does no build or deployment', () => {
  assert.throws(()=>publicShellArguments(['--source','/tmp']));
  const r=spawnSync(process.execPath,[join(work,'scripts/prepare-public-shell-update.ts'),'--help'],{encoding:'utf8'});
  assert.equal(r.status,0); assert.match(r.stdout,/Never installs dependencies/); assert.match(r.stdout,/contacts a cluster or deploys/);
});
