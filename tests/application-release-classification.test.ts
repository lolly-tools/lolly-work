// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classificationArguments, classifyApplicationRelease, parseApplicationReleaseInventory, permitsCommentBaselineUpdate, requiresFullShellCI } from '../scripts/classify-application-release.ts';

function git(repo: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function write(repo: string, path: string, content = 'export const value = 1;\n'): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content);
}
function commit(repo: string): string {
  git(repo, 'add', '--all'); git(repo, 'commit', '--quiet', '--allow-empty', '-m', 'Classifier fixture'); return git(repo, 'rev-parse', 'HEAD');
}
function fixture(run: (repo: string, base: string) => void, kind: 'lolly' | 'lolly-work' = 'lolly'): void {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'lolly-classifier-')));
  try {
    git(repo, 'init', '--quiet', '--initial-branch=main');
    git(repo, 'config', 'user.name', 'Release classifier fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
    write(repo, 'package.json', JSON.stringify({ name: kind, type: 'module' }));
    const paths = kind === 'lolly' ? ['engine/src/version.ts', 'packages/core/src/host-v1.ts', 'schemas/tool.schema.json',
      'profiles.json', 'shells/web/src/main.ts'] : ['engine-pin.json', 'server/src/main.ts', 'deploy/helm/Chart.yaml'];
    for (const path of paths) write(repo, path);
    run(repo, commit(repo));
  } finally { rmSync(repo, { recursive: true, force: true }); }
}
test('real committed web changes are advisory with immutable trees and complete raw inventory', () => fixture((repo, base) => {
  write(repo, 'shells/web/src/components/profile-menu.ts');
  write(repo, 'shells/web/src/README.md', 'Generated module counts.\n');
  write(repo, 'tests/profile-menu.browser.test.ts');
  const candidate = commit(repo), result = classifyApplicationRelease({ repo, base, candidate });
  assert.equal(result.classification, 'web-shell-only'); assert.equal(result.base, base); assert.equal(result.candidate, candidate);
  assert.equal(result.baseTree, git(repo, 'rev-parse', `${base}^{tree}`));
  assert.equal(result.candidateTree, git(repo, 'rev-parse', `${candidate}^{tree}`));
  assert.deepEqual(result.changedPaths.map(change => change.path), ['shells/web/src/README.md',
    'shells/web/src/components/profile-menu.ts', 'tests/profile-menu.browser.test.ts']);
  assert.ok(result.changedPaths.every(change => change.status === 'A' && change.beforeMode === '000000' && change.afterMode === '100644'));
  assert.match(result.changedPathsSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.advisory, true); assert.equal(result.normalCiRequired, true);
  assert.equal(result.privateCompatibilityReviewRequired, true); assert.equal(result.artifactReuseAuthorized, false);
  assert.equal(result.promotionAuthorized, false);
  assert.deepEqual(classifyApplicationRelease({ repo, base, candidate }), result);
}));
test('web updates may retain the runtime while deployment archive metadata changes', () => fixture((repo, base) => {
  write(repo, '.github/workflows/deployment-suse.yml', 'name: archive qualified images\n');
  const metadata = commit(repo);
  assert.equal(classifyApplicationRelease({ repo, base, candidate: metadata }).classification, 'full-or-paired-required');
  write(repo, 'shells/web/src/main.ts', 'export const web = 2;\n');
  const candidate = commit(repo), result = classifyApplicationRelease({ repo, base, candidate });
  assert.equal(result.classification, 'web-shell-only');
  assert.deepEqual(result.changedPaths.map(change => change.path), ['.github/workflows/deployment-suse.yml', 'shells/web/src/main.ts']);
  assert.equal(result.normalCiRequired, true); assert.equal(result.promotionAuthorized, false);
  write(repo, 'shells/web/vite.config.js', 'changed build input\n');
  assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
}));
for (const path of ['deploy/helm/profiles/sovereign/README.md', 'deploy/helm/profiles/sovereign/files/private.caddy', 'scripts/check-ui-performance.ts']) {
  test(`exact non-runtime companion ${path} requires a real web delta`, () => fixture((repo, base) => {
    write(repo, path, 'independent edge metadata\n');
    assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
    write(repo, 'shells/web/src/main.ts', 'export const web = 2;\n');
    assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'web-shell-only');
  }));
  test(`non-runtime companion ${path} refuses symlink content`, () => fixture((repo, base) => {
    write(repo, 'shells/web/src/main.ts', 'export const web = 2;\n');
    mkdirSync(dirname(join(repo, path)), { recursive: true }); symlinkSync('/outside/metadata', join(repo, path));
    assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
  }));
}
test('deployment metadata symlinks cannot enter the shell-only lane', () => fixture((repo, base) => {
  write(repo, 'shells/web/src/main.ts', 'export const web = 2;\n');
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  symlinkSync('../../engine/src/version.ts', join(repo, '.github/workflows/deployment-suse.yml'));
  assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
}));
for (const path of ['.github/workflows/ci.yml', '.github/workflows/shell-deployment-request.yml',
  'scripts/ci-qualification.ts', 'scripts/run-public-ready-ui.ts', 'docs/ci-qualification.md']) {
  test(`CI companion ${path} requires full CI and a real web delta`, () => fixture((repo, base) => {
    write(repo, path, 'operator CI metadata\n');
    const policy = commit(repo);
    assert.equal(classifyApplicationRelease({ repo, base, candidate: policy }).classification, 'full-or-paired-required');
    write(repo, 'shells/web/src/main.ts', 'export const web = 2;\n');
    const candidate = commit(repo), result = classifyApplicationRelease({ repo, base, candidate });
    assert.equal(result.classification, 'web-shell-only'); assert.equal(requiresFullShellCI(result.changedPaths), true);
    assert.match(result.reasons.join(' '), /release-ready full CI/); assert.equal(result.promotionAuthorized, false);
    // The subsequent UI change inherits this accepted policy without changing it.
    assert.equal(requiresFullShellCI(classifyApplicationRelease({ repo, base: policy, candidate }).changedPaths), false);
    rmSync(join(repo, path)); symlinkSync('/outside/ci-policy', join(repo, path));
    assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
  }));
}
for (const path of ['shells/web/design/chrome-tokens.json', 'shells/web/design/ui-semantics.json']) {
  test(`canonical web token source ${path} is a real shell change`, () => fixture((repo, base) => {
    write(repo, path, JSON.stringify({ shadow: { $type: 'shadow', $value: 'none' } }) + '\n');
    const result = classifyApplicationRelease({ repo, base, candidate: commit(repo) });
    assert.equal(result.classification, 'web-shell-only'); assert.equal(result.promotionAuthorized, false);
    write(repo, 'engine/src/version.ts', 'export const engine = 2;\n');
    assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
  }));
  test(`canonical web token source ${path} refuses symlinks`, () => fixture((repo, base) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true }); symlinkSync('/outside/ui-tokens', join(repo, path));
    assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
  }));
}
const baselineJson = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
test('comment baseline reductions and removal require matching changed web or test sources', () => {
  const before = { 'shells/web/src/main.ts': 4, 'tests/web.test.ts': 2, 'engine/src/version.ts': 3 };
  const changed = new Set(['shells/web/src/main.ts', 'tests/web.test.ts']);
  assert.equal(permitsCommentBaselineUpdate(baselineJson(before), baselineJson({ ...before, 'shells/web/src/main.ts': 1 }), changed), true);
  assert.equal(permitsCommentBaselineUpdate(baselineJson(before), baselineJson({ 'engine/src/version.ts': 3 }), changed), true);
  assert.equal(permitsCommentBaselineUpdate(baselineJson(before), baselineJson(before), new Set()), true);
});
test('comment baseline rejects inflation, new entries, unrelated reductions and malformed format', () => {
  const before = baselineJson({ 'shells/web/src/main.ts': 4, 'engine/src/version.ts': 3 });
  const changed = new Set(['shells/web/src/main.ts', 'engine/src/version.ts']);
  for (const value of [
    { 'shells/web/src/main.ts': 5, 'engine/src/version.ts': 3 },
    { 'shells/web/src/main.ts': 1, 'engine/src/version.ts': 2 },
    { 'shells/web/src/main.ts': 1, 'engine/src/version.ts': 3, 'tests/new.test.ts': 1 },
    { 'shells/web/src/main.ts': 0 }, { 'shells/web/src/main.ts': -1 }, { 'shells/web/src/main.ts': 1.5 },
    { 'shells/web/src/main.ts': true }, { '../escape.ts': 1 }, [], null,
  ]) assert.equal(permitsCommentBaselineUpdate(before, baselineJson(value), changed), false);
  for (const raw of ['{', '{"shells/web/src/main.ts":1}', '{\n  "shells/web/src/main.ts": 1,\n  "shells/web/src/main.ts": 1\n}\n']) {
    assert.equal(permitsCommentBaselineUpdate(before, raw, changed), false);
  }
  assert.equal(permitsCommentBaselineUpdate(before, baselineJson({ 'shells/web/src/main.ts': 1, 'engine/src/version.ts': 3 }), new Set()), false);
});
test('committed baseline is independently checked and cannot qualify without a web delta', () => fixture((repo) => {
  const path = 'scripts/vernacular-code-baseline.json';
  write(repo, path, baselineJson({ 'shells/web/src/main.ts': 4 })); const base = commit(repo);
  write(repo, path, baselineJson({ 'shells/web/src/main.ts': 1 }));
  assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
  write(repo, 'shells/web/src/main.ts', 'export const web = 2;\n');
  assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'web-shell-only');
  write(repo, path, baselineJson({ 'shells/web/src/main.ts': 5 }));
  assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
  rmSync(join(repo, path));
  assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
  symlinkSync('../engine/src/version.ts', join(repo, path));
  assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
}));
for (const path of ['engine/src/version.ts', 'packages/core/src/host-v1.ts', 'packages/node-shell/src/content-roots.ts',
  'schemas/tool.schema.json', 'community/design/tool.json', 'tools/qr-code/hooks.js', 'brands/suse/catalog/tools/index.json',
  'catalog/tools/index.json', 'profiles.json', 'pnpm-lock.yaml', 'shells/web/package.json', 'deploy/docker/web.Dockerfile',
  'deploy/helm/profiles/sovereign/files/public.caddy', 'deploy/helm/profiles/sovereign/files/private.caddy.bak',
  'deploy/helm/profiles/sovereign/readme.md', 'deploy/helm/profiles/sovereign/values.yaml',
  'services/mcp/src/http.ts', 'server/src/main.ts', 'scripts/webgpu-release-gate.ts', 'scripts/check-ui-performance.ts.bak',
  'scripts/check-ui-performance-gate.ts', 'scripts/lib/ui-performance.ts', 'docs/supported-environments.md',
  'shells/web/design/other.json', 'shells/web/design/chrome-tokens.json.bak', 'shells/web/src/other.json',
  'shells/web/src/browser-support.ts', 'tests/webgpu-release-gate.test.ts', 'tests/browser-support.browser.test.ts',
  '.github/workflows/ci.yaml', '.github/workflows/ci.yml.bak', '.github/workflows/shell-deployment-request.yaml',
  'scripts/ci-qualification.ts.bak', 'scripts/run-public-ready-ui-helper.ts', 'docs/ci-qualification.md.bak',
  '.github/workflows/deployment-suse.yaml', '.github/workflows/webgpu-release-gate.yml', 'unexpected/new.txt']) {
  test(`web plus ${path} refuses the narrow scope`, () => fixture((repo, base) => {
    write(repo, 'shells/web/src/main.ts', 'export const web = 2;\n'); write(repo, path, 'changed\n');
    const result = classifyApplicationRelease({ repo, base, candidate: commit(repo) });
    assert.equal(result.classification, 'full-or-paired-required'); assert.equal(result.promotionAuthorized, false);
    assert.ok(result.changedPaths.some(change => change.path === path));
  }));
}
for (const path of ['tests/only.browser.test.ts', 'docs/deployment.md', 'shells/web/src/README.md', 'shells/web/src/widget.test.ts']) {
  test(`${path} alone cannot request a web release`, () => fixture((repo, base) => {
    write(repo, path); const result = classifyApplicationRelease({ repo, base, candidate: commit(repo) });
    assert.equal(result.classification, 'full-or-paired-required'); assert.equal(result.promotionAuthorized, false);
  }));
}
test('identical tree commits report no-change without promotion authority', () => fixture((repo, base) => {
  const candidate = commit(repo), result = classifyApplicationRelease({ repo, base, candidate });
  assert.notEqual(base, candidate); assert.equal(result.baseTree, result.candidateTree);
  assert.equal(result.classification, 'no-change'); assert.deepEqual(result.changedPaths, []); assert.equal(result.promotionAuthorized, false);
}));
test('Work server changes stay broader until a maintained backend rule exists', () => fixture((repo, base) => {
  write(repo, 'server/src/main.ts', 'export const server = 2;\n');
  assert.equal(classifyApplicationRelease({ repo, base, candidate: commit(repo) }).classification, 'full-or-paired-required');
}, 'lolly-work'));
test('renaming web code into shared engine records both paths and requires broader qualification', () => fixture((repo, base) => {
  write(repo, 'shells/web/src/widget.ts'); const previous = commit(repo);
  assert.notEqual(previous, base); git(repo, 'mv', 'shells/web/src/widget.ts', 'engine/src/new.ts');
  const result = classifyApplicationRelease({ repo, base: previous, candidate: commit(repo) });
  assert.equal(result.classification, 'full-or-paired-required');
  assert.deepEqual(result.changedPaths.map(change => [change.path, change.status]), [['engine/src/new.ts', 'A'], ['shells/web/src/widget.ts', 'D']]);
}));
test('symlink web input cannot be classified as regular UI code', () => fixture((repo, base) => {
  symlinkSync('../../../engine/src/version.ts', join(repo, 'shells/web/src/widget.ts'));
  const result = classifyApplicationRelease({ repo, base, candidate: commit(repo) });
  assert.equal(result.classification, 'full-or-paired-required'); assert.equal(result.changedPaths[0]?.afterMode, '120000');
}));
for (const untracked of [false, true]) {
  test(`${untracked ? 'untracked' : 'tracked'} dirty inputs refuse`, () => fixture((repo, base) => {
    write(repo, untracked ? 'untracked.txt' : 'shells/web/src/main.ts', 'dirty\n');
    assert.throws(() => classifyApplicationRelease({ repo, base, candidate: base }), /changes refuse/);
  }));
}
test('moving refs, short hashes, trees, tags and checkout mismatch refuse', () => fixture((repo, base) => {
  for (const invalid of ['main', base.slice(0, 12), base.toUpperCase(), '--all', '0'.repeat(40)]) {
    assert.throws(() => classifyApplicationRelease({ repo, base, candidate: invalid }));
  }
  const tree = git(repo, 'rev-parse', `${base}^{tree}`);
  assert.throws(() => classifyApplicationRelease({ repo, base: tree, candidate: base }), /commit objects/);
  git(repo, 'tag', '-a', 'fixture-tag', '-m', 'Tag');
  assert.throws(() => classifyApplicationRelease({ repo, base: git(repo, 'rev-parse', 'fixture-tag'), candidate: base }), /commit objects/);
  write(repo, 'shells/web/src/main.ts', 'new\n'); const candidate = commit(repo);
  git(repo, 'checkout', '--quiet', '--detach', base);
  assert.throws(() => classifyApplicationRelease({ repo, base, candidate }), /exact candidate/);
}));
test('divergent immutable commits refuse rather than silently use a merge base', () => fixture((repo, base) => {
  write(repo, 'shells/web/src/main.ts', 'branch one\n'); const left = commit(repo);
  git(repo, 'checkout', '--quiet', '--detach', base);
  write(repo, 'shells/web/src/main.ts', 'branch two\n'); const right = commit(repo);
  assert.throws(() => classifyApplicationRelease({ repo, base: left, candidate: right }));
}));
for (const path of ['shells/web/src/bad\nname.ts', 'shells/web/src/bad\\name.ts', 'shells/web/src/bad\u202ename.ts']) {
  test('unsafe committed filename refuses the entire inventory', () => fixture((repo, base) => {
    write(repo, path); assert.throws(() => classifyApplicationRelease({ repo, base, candidate: commit(repo) }), /changed path/);
  }));
}
test('unknown package identity and absent contract layout refuse', () => fixture((repo, base) => {
  write(repo, 'package.json', '{"name":"unrelated"}'); let candidate = commit(repo);
  assert.throws(() => classifyApplicationRelease({ repo, base, candidate }), /repository layouts/);
  write(repo, 'package.json', '{"name":"lolly"}'); rmSync(join(repo, 'profiles.json')); candidate = commit(repo);
  assert.throws(() => classifyApplicationRelease({ repo, base, candidate }), /repository layout/);
}));
test('submodule gitlink changes cannot be classified as shell-only', () => fixture((repo, base) => {
  write(repo, 'shells/web/src/main.ts', 'web changed\n'); git(repo, 'add', '--all');
  mkdirSync(join(repo, 'brands/suse'), { recursive: true });
  git(repo, 'update-index', '--add', '--cacheinfo', `160000,${base},brands/suse`);
  git(repo, 'commit', '--quiet', '-m', 'Commit gitlink fixture');
  const result = classifyApplicationRelease({ repo, base, candidate: git(repo, 'rev-parse', 'HEAD') });
  assert.equal(result.classification, 'full-or-paired-required');
  assert.equal(result.changedPaths.find(change => change.path === 'brands/suse')?.afterMode, '160000');
}));
test('changed-path count and byte limits refuse without truncating advisory output', () => fixture((repo, base) => {
  for (let i = 0; i < 4097; i++) write(repo, `shells/web/src/part-${i}.ts`);
  assert.throws(() => classifyApplicationRelease({ repo, base, candidate: commit(repo) }), /oversized changed-path inventory/);
}));
test('raw invalid UTF-8 filename refuses on every host rather than replacement-decoding', () => {
  const header = `:000000 100644 ${'0'.repeat(40)} ${'1'.repeat(40)} A\0`;
  const invalid = Buffer.concat([Buffer.from(header + 'shells/web/src/bad-'), Buffer.from([0xff]), Buffer.from('.ts\0')]);
  assert.throws(() => parseApplicationReleaseInventory(invalid), /valid UTF-8/);
});
test('truncated, duplicate, oversized and ambiguous raw inventory refuses', () => {
  const record = `:000000 100644 ${'0'.repeat(40)} ${'1'.repeat(40)} A\0shells/web/src/widget.ts\0`;
  for (const malformed of [record.slice(0, -1), record + record, record.replace(' A\0', ' R100\0'),
    record.replace(' A\0', ' M\0'),
    record.replace('widget.ts', 'x'.repeat(1025))]) assert.throws(() => parseApplicationReleaseInventory(Buffer.from(malformed)));
  assert.throws(() => parseApplicationReleaseInventory(Buffer.alloc(2 * 1024 * 1024 + 1)), /byte bound/);
});
test('ambient Git relocation cannot redirect inspected objects or status', () => fixture((repo, base) => {
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = '/nonexistent/ambient-git-directory';
  try { assert.equal(classifyApplicationRelease({ repo, base, candidate: base }).classification, 'no-change'); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
}));
test('local graft metadata refuses and Git replacement objects cannot alter the immutable diff', () => fixture((repo, base) => {
  write(repo, 'shells/web/src/main.ts', 'actual web change\n'); const candidate = commit(repo);
  git(repo, 'replace', base, candidate);
  const result = classifyApplicationRelease({ repo, base, candidate });
  assert.equal(result.classification, 'web-shell-only'); assert.equal(result.changedPaths.length, 1);
  write(repo, '.git/info/grafts', `${base}\n`);
  assert.throws(() => classifyApplicationRelease({ repo, base, candidate }), /ancestry grafts/);
}));
test('repository subdirectories and symlink aliases refuse', () => fixture((repo, base) => {
  assert.throws(() => classifyApplicationRelease({ repo: join(repo, 'shells'), base, candidate: base }), /working-tree root/);
  const alias = `${repo}-alias`; symlinkSync(repo, alias);
  try { assert.throws(() => classifyApplicationRelease({ repo: alias, base, candidate: base }), /canonical directory/); }
  finally { rmSync(alias); }
}));
test('CLI refuses duplicate or unknown flags and emits no raw Git stderr', () => fixture((repo, base) => {
  assert.deepEqual(classificationArguments(['--base', base, '--candidate', base, '--repo', repo]), { repo, base, candidate: base });
  for (const args of [['--repo', repo, '--base', base, '--base', base], ['--repo', repo, '--base', base, '--unsafe', base], []]) {
    assert.throws(() => classificationArguments(args));
  }
  const script = fileURLToPath(new URL('../scripts/classify-application-release.ts', import.meta.url));
  const success = spawnSync(process.execPath, [script, '--repo', repo, '--base', base, '--candidate', base], { encoding: 'utf8' });
  assert.equal(success.status, 0); assert.equal(JSON.parse(success.stdout).classification, 'no-change');
  const refused = spawnSync(process.execPath, [script, '--repo', repo, '--base', base, '--candidate', 'secret-ref-input'], { encoding: 'utf8' });
  assert.equal(refused.status, 1); assert.equal(refused.stdout, ''); assert.equal(JSON.parse(refused.stderr).status, 'REFUSED');
  assert.ok(!refused.stderr.includes('secret-ref-input'));
}));
