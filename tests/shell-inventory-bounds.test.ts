// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

for (const optimized of [false, true]) {
  test(`shell inventory bounds${optimized ? ' optimized' : ''}`, () => {
    const args = [...(optimized ? ['-O'] : []), '-B', fileURLToPath(new URL('./test_shell_inventory_bounds.py', import.meta.url))];
    const result = spawnSync('python3', args, { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
