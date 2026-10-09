// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('offline application release preparation binds existing CI artifacts without deployment', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./test_prepare_paired_release.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
