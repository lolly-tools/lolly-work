// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyDocsPin, sha256 } from '../scripts/verify-docs-pin.ts';

test('the shipped offline documentation matches its canonical source pin', () => {
  assert.ok(Object.keys(verifyDocsPin().files).length > 100);
});

test('bundle verification rejects changed bytes, missing files and unpinned additions', () => {
  const root = mkdtempSync(join(tmpdir(), 'lolly-docs-pin-'));
  try {
    mkdirSync(join(root, 'docs'));
    const bytes = Buffer.from('# Work guide\n');
    writeFileSync(join(root, 'docs', 'guide.md'), bytes);
    writeFileSync(join(root, 'docs-pin.json'), JSON.stringify({ version: 1, repository: 'https://github.com/lolly-tools/lolly', commit: 'a'.repeat(40), manifestSha256: 'b'.repeat(64), files: { 'guide.md': { sha256: sha256(bytes), source: 'docs/work/guide.md' } } }));
    verifyDocsPin(root);
    writeFileSync(join(root, 'docs', 'guide.md'), '# Local edit\n');
    assert.throws(() => verifyDocsPin(root), /bundle changed/);
    rmSync(join(root, 'docs', 'guide.md'));
    assert.throws(() => verifyDocsPin(root), /file set/);
    writeFileSync(join(root, 'docs', 'guide.md'), bytes);
    writeFileSync(join(root, 'docs', 'extra.md'), '# Extra\n');
    assert.throws(() => verifyDocsPin(root), /file set/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
