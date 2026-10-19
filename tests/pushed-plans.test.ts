// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { pushedTips } from '../scripts/check-pushed-plans.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/check-pushed-plans.ts');
const HOOKS = 'scripts/git-hooks';
const HOOK = `${HOOKS}/pre-push`;
const ZERO = '0'.repeat(40);

function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lolly-work-pushed-plans-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const work = join(root, 'work');
  const config = ['-c', 'commit.gpgsign=false', '-c', 'user.name=Plans check test', '-c', 'user.email=test@example.invalid'];
  const git = (...args: string[]): string => {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...config, ...args], { cwd: work, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (name: string, contents: string): void => {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), contents);
  };
  // `git add -f` is how a private file gets past the ignore rule.
  const commit = (message: string, ...paths: string[]): string => {
    git('add', '-f', '--', ...(paths.length ? paths : ['.']));
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const run = (input: string, args = ['--pre-push']) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, encoding: 'utf8', input });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  // A real push through the checked-in hook, the way a contributor runs it.
  const push = (node: string, ...args: string[]) => {
    const result = spawnSync('git', ['-c', `core.hooksPath=${HOOKS}`, ...config, 'push', ...args],
      { cwd: work, encoding: 'utf8', env: { ...process.env, LOLLY_NODE: node } });
    assert.ifError(result.error);
    return { status: result.status, output: result.stdout + result.stderr };
  };
  mkdirSync(work);
  spawnSync('git', ['init', '-q', '--bare', join(root, 'remote.git')]);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  write('.gitignore', 'plans/\n');
  write('README.md', 'fixture\n');
  const base = commit('base');
  return { root, work, git, write, commit, run, push, base };
}

const update = (sha: string, ref = 'refs/heads/topic', old = ZERO): string => `${ref} ${sha} ${ref} ${old}\n`;

test('pre-push input keeps created and updated refs and drops deletes and unchanged refs', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(64);
  assert.deepEqual(pushedTips(update(a) + update(ZERO, 'refs/heads/gone', a) + update(a, 'refs/heads/same', a) +
    update(b, 'refs/tags/v1', '0'.repeat(64)) + '\n'), [
    { object: a, ref: 'refs/heads/topic' },
    { object: b, ref: 'refs/tags/v1' },
  ]);
  assert.deepEqual(pushedTips(''), []);
  assert.throws(() => pushedTips('refs/heads/topic not-a-sha refs/heads/topic ' + ZERO), /Malformed pre-push update on line 1/);
  assert.throws(() => pushedTips(update(a) + 'refs/heads/topic ' + a), /line 2/);
});

test('a pushed commit that adds a plans/ file fails and reports the commit and path', t => {
  const f = fixture(t);
  f.write('plans/312-private-notes.md', 'private\n');
  const added = f.commit('add notes', 'plans/312-private-notes.md');
  f.write('README.md', 'later\n');
  const tip = f.commit('later change');
  const result = f.run(update(tip));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /would publish private plans\/ files/);
  assert.match(result.output, new RegExp(`${added.slice(0, 9)} plans/312-private-notes\\.md`));
  assert.match(result.output, /git rm --cached/);
});

test('editing a tracked plan or renaming a file into plans/ is caught, deleting a plan is allowed', t => {
  const f = fixture(t);
  f.write('plans/old.md', 'already tracked\n');
  f.commit('tracked plan', 'plans/old.md');
  f.git('push', '-q', 'origin', 'main');
  f.write('plans/old.md', 'edited\n');
  const edited = f.commit('edit plan', 'plans/old.md');
  assert.equal(f.run(update(edited)).status, 1);

  f.git('reset', '-q', '--hard', 'origin/main');
  f.write('docs/note.md', 'public note\n');
  f.commit('public note');
  f.git('push', '-q', 'origin', 'main');
  f.git('mv', 'docs/note.md', 'plans/note.md');
  const renamed = f.commit('rename into plans');
  const result = f.run(update(renamed));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /plans\/note\.md/);

  f.git('reset', '-q', '--hard', 'origin/main');
  // Untracking keeps the file on disk, as this repository did for its own plans.
  f.git('rm', '-q', '--cached', 'plans/old.md');
  f.git('commit', '-qm', 'untrack plan');
  const removal = f.run(update(f.git('rev-parse', 'HEAD')));
  assert.equal(removal.status, 0, removal.output);
  assert.match(removal.output, /no plans\/ files in 1 pushed tip\(s\)/);
});

test('plans/ files that a remote-tracking ref already reaches are not reported again', t => {
  const f = fixture(t);
  f.write('plans/published.md', 'already public\n');
  f.commit('published plan', 'plans/published.md');
  f.git('push', '-q', 'origin', 'main');
  f.write('README.md', 'unrelated\n');
  const tip = f.commit('unrelated change');
  const result = f.run(update(tip, 'refs/heads/main', f.git('rev-parse', 'origin/main')));
  assert.equal(result.status, 0, result.output);
});

test('a side branch that adds and then removes a plan is caught through its merge', t => {
  const f = fixture(t);
  f.git('push', '-q', 'origin', 'main');
  f.git('checkout', '-q', '-b', 'side');
  f.write('plans/brief.md', 'private\n');
  const added = f.commit('add brief', 'plans/brief.md');
  f.git('rm', '-q', 'plans/brief.md');
  f.commit('remove brief');
  f.git('checkout', '-q', 'main');
  f.write('README.md', 'main moves on\n');
  f.commit('main change');
  f.git('merge', '-q', '--no-edit', 'side');
  const result = f.run(update(f.git('rev-parse', 'HEAD')));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, new RegExp(`${added.slice(0, 9)} plans/brief\\.md`));
});

test('a merge counts for what it adds itself, not for remote history it brings in', t => {
  const f = fixture(t);
  f.git('checkout', '-q', '-b', 'shared');
  f.write('plans/shared.md', 'already public\n');
  f.commit('shared plan', 'plans/shared.md');
  f.git('push', '-q', 'origin', 'shared');
  f.git('checkout', '-q', 'main');
  f.write('README.md', 'local change\n');
  f.commit('local change');
  f.git('merge', '-q', '--no-edit', 'origin/shared');
  const clean = f.run(update(f.git('rev-parse', 'HEAD')));
  assert.equal(clean.status, 0, clean.output);

  f.git('checkout', '-q', '-b', 'other', f.base);
  f.write('docs/other.md', 'other\n');
  f.commit('other change');
  f.git('checkout', '-q', 'main');
  f.git('merge', '-q', '--no-commit', 'other');
  f.write('plans/merge-only.md', 'added while merging\n');
  const merged = f.commit('merge with a private file', 'plans/merge-only.md');
  const result = f.run(update(merged));
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, new RegExp(`${merged.slice(0, 9)} plans/merge-only\\.md`));
  assert.doesNotMatch(result.output, /plans\/shared\.md/);
});

test('every tip is checked, deletes and unchanged refs are skipped and a blob tag is ignored', t => {
  const f = fixture(t);
  f.git('push', '-q', 'origin', 'main');
  f.git('checkout', '-q', '-b', 'leak');
  f.write('plans/leak.md', 'private\n');
  const leak = f.commit('leak', 'plans/leak.md');
  f.git('checkout', '-q', 'main');
  const blob = f.git('rev-parse', `${f.base}:README.md`);
  f.git('tag', 'blob-tag', blob);
  const clean = update(f.base, 'refs/heads/same', f.base) + update(ZERO, 'refs/heads/gone', leak) +
    update(blob, 'refs/tags/blob-tag');
  const passed = f.run(clean);
  assert.equal(passed.status, 0, passed.output);
  assert.match(passed.output, /no plans\/ files in 1 pushed tip\(s\)/);
  const failed = f.run(clean + update(leak, 'refs/heads/leak'));
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /plans\/leak\.md/);
});

test('empty input passes, malformed input fails and refs work as arguments', t => {
  const f = fixture(t);
  const empty = f.run('');
  assert.equal(empty.status, 0, empty.output);
  assert.match(empty.output, /no plans\/ files in 0 pushed tip\(s\)/);
  const malformed = f.run('refs/heads/topic not-a-sha refs/heads/topic ' + ZERO + '\n');
  assert.equal(malformed.status, 1, malformed.output);
  assert.match(malformed.output, /Malformed pre-push update/);
  f.write('plans/manual.md', 'private\n');
  f.commit('manual', 'plans/manual.md');
  const manual = f.run('', ['HEAD']);
  assert.equal(manual.status, 1, manual.output);
  assert.match(manual.output, /plans\/manual\.md/);
  assert.equal(f.run('', []).status, 1);
});

test('the checked-in pre-push hook refuses a plans/ push, lets a clean one through and needs a current Node', t => {
  const f = fixture(t);
  for (const file of ['.nvmrc', 'scripts/check-pushed-plans.ts', HOOK]) f.write(file, readFileSync(join(ROOT, file), 'utf8'));
  chmodSync(join(f.work, HOOK), 0o755);
  f.commit('guard');
  const clean = f.push(process.execPath, '-q', 'origin', 'main');
  assert.equal(clean.status, 0, clean.output);
  assert.match(clean.output, /no plans\/ files in 1 pushed tip\(s\)/);
  const published = f.git('rev-parse', 'origin/main');

  f.write('plans/private.md', 'private\n');
  const leak = f.commit('leak', 'plans/private.md');
  const refused = f.push(process.execPath, '-q', 'origin', 'main');
  assert.notEqual(refused.status, 0, refused.output);
  assert.match(refused.output, new RegExp(`${leak.slice(0, 9)} plans/private\\.md`));
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], published);

  const oldNode = join(f.root, 'old-node');
  writeFileSync(oldNode, '#!/bin/sh\necho 1\n');
  chmodSync(oldNode, 0o755);
  f.git('reset', '-q', '--hard', published);
  f.write('README.md', 'clean change\n');
  f.commit('clean change');
  const outdated = f.push(oldNode, '-q', 'origin', 'main');
  assert.notEqual(outdated.status, 0, outdated.output);
  assert.match(outdated.output, /needs Node \d+ or later from \.nvmrc \(found 1\)/);
});
