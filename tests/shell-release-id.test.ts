// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellReleaseId } from '../scripts/shell-release-id.ts';

test('release identity includes static bytes even when index.html is unchanged', t => {
  const root = mkdtempSync(join(tmpdir(), 'lw-shell-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'index.html'), '<main>Lolly</main>');
  mkdirSync(join(root, 'info'));
  writeFileSync(join(root, 'info', 'ask-vectors.bin'), 'first');
  const first = shellReleaseId(root);
  writeFileSync(join(root, 'info', 'ask-vectors.bin'), 'second');
  assert.notEqual(shellReleaseId(root), first);
  assert.equal(shellReleaseId(root), shellReleaseId(root));
});

test('identical releases have the same identity across directories and creation order', t => {
  const root = mkdtempSync(join(tmpdir(), 'lw-shell-order-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  for (const [dir, names] of [[a, ['index.html', 'font.woff2']], [b, ['font.woff2', 'index.html']]] as const) {
    for (const name of names) writeFileSync(join(dir, name), name);
  }
  assert.equal(shellReleaseId(a), shellReleaseId(b));
});

test('release input refuses symlinks that could read outside the qualified directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'lw-shell-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'index.html'), 'Lolly');
  symlinkSync('../outside', join(root, 'escape'));
  assert.throws(() => shellReleaseId(root), /non-regular file/);
});
