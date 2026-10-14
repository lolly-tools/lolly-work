// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';
import { activateRelease, retireRelease, rollbackRelease, stageRelease } from '../scripts/publish-shell-release.ts';
import { shellManifest } from '../scripts/shell-update-files.ts';
import { parseReleaseManifest, readShellPointer, releaseHash, releaseJson, shellDirectories } from '../server/src/lib/shell-release.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';

function cleanup(root: string): void {
  if (lstatSync(root).isDirectory()) { chmodSync(root, 0o755); for (const name of readdirSync(root)) { const path = join(root, name); if (lstatSync(path).isDirectory()) cleanup(path); } }
  rmSync(root, { recursive: true, force: true });
}
function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'lw-shell-pointer-'))), root = join(directory, 'store'); mkdirSync(root);
  t.after(() => cleanup(directory));
  const candidate = (label: string, extra: Record<string, string> = {}) => {
    const source = join(directory, label); mkdirSync(source);
    const files = { 'index.html': `<title>${label}</title>`, [`_app/${label}.js`]: `/* org-config */ ${label.repeat(1500)}`, 'sw.js': `// ${label}`,
      'info/index.html': `<h1>${label}</h1>`, 'catalog/tools/index.json': 'SHELL DECOY', 'api/v1/projects': 'SHELL DECOY', ...extra };
    for (const [name, bytes] of Object.entries(files)) { mkdirSync(dirname(join(source, name)), { recursive: true }); writeFileSync(join(source, name), bytes); }
    const manifest = shellManifest(source), manifestPath = join(directory, label + '.json'), bytes = releaseJson(manifest); writeFileSync(manifestPath, bytes);
    return { source, manifest, manifestPath, manifestSha256: releaseHash(bytes), stage: () => stageRelease(root, source, manifestPath, releaseHash(bytes)).release };
  };
  return { directory, root, candidate };
}

test('stage, compare-and-swap, rollback and retention preserve immutable releases', t => {
  const f = fixture(t), a = f.candidate('a'), aId = a.stage(), bId = f.candidate('b').stage();
  assert.equal(existsSync(join(f.root, 'current.json')), false, 'staging does not publish');
  const first = activateRelease(f.root, aId, 'absent');
  assert.throws(() => activateRelease(f.root, bId, 'absent'), /pointer changed/);
  assert.throws(() => retireRelease(f.root, aId, first.sha256), /cannot be retired/);
  const second = activateRelease(f.root, bId, first.sha256);
  assert.deepEqual(shellDirectories({ shellDir: f.root, shellReleasePointer: true }).map(dirname), [bId, aId].map(id => join(f.root, 'releases', id)));
  const restored = rollbackRelease(f.root, second.sha256);
  assert.equal(restored.pointer.current, aId); assert.equal(restored.pointer.previous, bId);
  assert.equal(restored.pointer.revision, 3); assert.throws(a.stage, /already exists/);
  assert.equal(lstatSync(join(f.root, 'releases', aId, 'files', 'index.html')).mode & 0o222, 0);
});

test('grace assets have an explicit expiry and current/rollback cannot be collected', t => {
  const f = fixture(t), ids = ['a', 'b', 'c'].map(label => f.candidate(label).stage()), now = Date.now();
  let p = activateRelease(f.root, ids[0]!, 'absent'); p = activateRelease(f.root, ids[1]!, p.sha256);
  p = activateRelease(f.root, ids[2]!, p.sha256, 60, now);
  assert.deepEqual(p.pointer.retained, [{ id: ids[0], expiresAt: now + 60_000 }]);
  assert.throws(() => retireRelease(f.root, ids[0]!, p.sha256, now), /cannot be retired/);
  assert.throws(() => retireRelease(f.root, ids[1]!, p.sha256, now + 61_000), /cannot be retired/);
  retireRelease(f.root, ids[0]!, p.sha256, now + 61_000);
  assert.equal(existsSync(join(f.root, 'releases', ids[0]!)), false);
  assert.equal(readShellPointer(f.root).sha256, p.sha256, 'collection does not switch current');
});

test('activation refuses reuse of an immutable URL and leaves the pointer exact', t => {
  const f = fixture(t), a = f.candidate('a', { '_app/shared.js': 'one' }).stage(), b = f.candidate('b', { '_app/shared.js': 'two' }).stage();
  const p = activateRelease(f.root, a, 'absent');
  assert.throws(() => activateRelease(f.root, b, p.sha256), /Immutable URL/);
  assert.equal(readShellPointer(f.root).sha256, p.sha256);
});

test('staged corruption or writable content cannot be activated', t => {
  const f = fixture(t), a = f.candidate('a').stage(), b = f.candidate('b').stage(), p = activateRelease(f.root, a, 'absent');
  const file = join(f.root, 'releases', b, 'files/index.html'), original = readFileSync(file);
  chmodSync(file, 0o644); assert.throws(() => activateRelease(f.root, b, p.sha256), /writable/);
  writeFileSync(file, 'changed'); chmodSync(file, 0o444); assert.throws(() => activateRelease(f.root, b, p.sha256), /inventory differs/);
  chmodSync(file, 0o644); writeFileSync(file, original); chmodSync(file, 0o444);
  assert.equal(readShellPointer(f.root).sha256, p.sha256);
});

test('grace and stored release counts stay bounded without forced collection', t => {
  const f = fixture(t), ids = Array.from({ length: 10 }, (_, index) => f.candidate('release' + index).stage());
  let p = activateRelease(f.root, ids[0]!, 'absent');
  for (let index = 1; index < 8; index++) p = activateRelease(f.root, ids[index]!, p.sha256, 3600);
  assert.equal(p.pointer.retained.length, 6);
  assert.throws(() => activateRelease(f.root, ids[8]!, p.sha256, 3600), /retention is full/);
  assert.throws(f.candidate('overflow').stage, /storage bound/);
  assert.equal(readShellPointer(f.root).sha256, p.sha256);
});

test('unsafe source, manifest, pointer, release symlinks and stale locks refuse', t => {
  const f = fixture(t), a = f.candidate('a'), id = a.stage(), p = activateRelease(f.root, id, 'absent');
  const outside = join(f.directory, 'private'); writeFileSync(outside, 'private');
  symlinkSync(outside, join(a.source, 'escape'));
  assert.throws(() => stageRelease(f.root, a.source, a.manifestPath, a.manifestSha256), /regular|changed|differs/);
  const malformed = structuredClone(a.manifest); malformed.files[0]!.path = '../private'; assert.throws(() => parseReleaseManifest(malformed), /Invalid/);
  const duplicate = structuredClone(a.manifest); duplicate.files.push(duplicate.files[0]!); assert.throws(() => parseReleaseManifest(duplicate), /Invalid/);
  const pointer = join(f.root, 'current.json'), original = readFileSync(pointer);
  writeFileSync(pointer, releaseJson({ ...p.pointer, current: '../private' })); assert.throws(() => shellDirectories({ shellDir: f.root, shellReleasePointer: true }), /Invalid/);
  writeFileSync(pointer, original); rmSync(pointer); symlinkSync(outside, pointer); assert.throws(() => readShellPointer(f.root), /Unsafe/); rmSync(pointer); writeFileSync(pointer, original);
  mkdirSync(join(f.root, '.publication-lock')); assert.throws(() => rollbackRelease(f.root, p.sha256), /EEXIST/);
});

test('pointer mode is explicit and requires a physical absolute root', () => {
  const policy = { defaultAccessMode: 'open' };
  assert.equal(parseConfig(JSON.stringify({ policy, instance: { shellDir: '/app/releases', shellReleasePointer: true } })).instance.shellReleasePointer, true);
  for (const shellDir of [undefined, '', 'relative', '/app/../secret', '/app//shell', '/app/']) assert.throws(() => parseConfig(JSON.stringify({ policy, instance: { shellDir, shellReleasePointer: true } })), /shellReleasePointer/);
  assert.throws(() => parseConfig(JSON.stringify({ policy, instance: { shellReleasePointer: 'true' } })), /boolean/);
  assert.deepEqual(shellDirectories({ shellDir: './legacy' }), ['./legacy']);
});

test('one live HTTP server switches shell bytes while retaining sessions, auth gates and lazy assets', async t => {
  const f = fixture(t), aId = f.candidate('a').stage(), bId = f.candidate('b').stage(); let pointer = activateRelease(f.root, aId, 'absent');
  const pack = join(f.directory, 'pack'); mkdirSync(join(pack, 'catalog/tools'), { recursive: true }); writeFileSync(join(pack, 'catalog/tools/index.json'), '{"version":1,"tools":[]}');
  const config = parseConfig(JSON.stringify({ instance: { name: 'Pointer test', pack, shellDir: f.root, shellReleasePointer: true }, policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false }, dev: { enabled: true, users: [{ email: 'fixture@example.test', sub: 'fixture', groups: ['member'] }] } }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'fixture-session', link: 'fixture-link' }, backgroundPollMs: 0 });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(base + '/api/auth/dev?email=fixture%40example.test', { redirect: 'manual' }); assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  const before = await (await fetch(base + '/api/auth/session', { headers: { cookie } })).json();
  assert.equal(await (await fetch(base + '/')).text(), '<title>a</title>');
  pointer = activateRelease(f.root, bId, pointer.sha256);
  assert.equal(await (await fetch(base + '/')).text(), '<title>b</title>');
  assert.equal(await (await fetch(base + '/info/')).text(), '<h1>b</h1>');
  assert.deepEqual(await (await fetch(base + '/api/auth/session', { headers: { cookie } })).json(), before);
  for (const path of ['/catalog/tools/index.json', '/api/v1/projects', '/tools/private/tool.json']) {
    const response = await fetch(base + path); assert.ok(response.status >= 400, path); assert.notEqual(await response.text(), 'SHELL DECOY');
  }
  assert.equal((await fetch(base + '/catalog/tools/index.json', { headers: { cookie } })).status, 200);
  const lazy = await fetch(base + '/_app/a.js'); assert.equal(lazy.status, 200); assert.match(lazy.headers.get('cache-control')!, /immutable/);
  const range = await fetch(base + '/_app/a.js', { headers: { range: 'bytes=0-3' } }); assert.equal(range.status, 206); assert.equal(await range.text(), '/* o');
  const sw = await fetch(base + '/sw.js'); assert.equal(await sw.text(), '// b'); assert.match(sw.headers.get('cache-control')!, /no-cache/);
  pointer = rollbackRelease(f.root, pointer.sha256);
  assert.equal(await (await fetch(base + '/')).text(), '<title>a</title>'); assert.equal((await fetch(base + '/_app/b.js')).status, 200);
  assert.deepEqual(server.address(), address, 'the same server remains active');
});

const helm = spawnSync('helm', ['version', '--short']);
test('Helm pointer mode requires explicit config and a stable read-only persistent mount', { skip: helm.status === 0 ? false : 'helm unavailable' }, () => {
  const args = ['template', 'pointer', 'deploy/helm', '--set', 'existingSecret=fixture', '--set', 'shell.enabled=true', '--set', 'shell.releasePointer=true', '--set', 'shell.existingClaim=stable-shell', '--set', 'config.instance.shellDir=/app/shell', '--set', 'config.instance.shellReleasePointer=true'];
  const result = spawnSync('helm', args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  const docs = parseAllDocuments(result.stdout).map(doc => doc.toJSON()), deployment = docs.find(doc => doc.kind === 'Deployment');
  assert.equal(deployment.spec.template.spec.containers[0].volumeMounts.find((mount: { name: string }) => mount.name === 'shell').readOnly, true);
  assert.equal(JSON.parse(docs.find(doc => doc.kind === 'ConfigMap').data['instance.json']).instance.shellReleasePointer, true);
  for (const override of ['shell.readOnly=false', 'shell.type=emptyDir', 'shell.image=example.invalid/shell:latest', 'config.instance.shellReleasePointer=false', 'config.instance.shellDir=/wrong']) {
    const bad = spawnSync('helm', [...args, '--set', override], { encoding: 'utf8' }); assert.notEqual(bad.status, 0, override); assert.match(bad.stderr, /releasePointer/);
  }
});
