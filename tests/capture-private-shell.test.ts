// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const optimized of [false, true]) {
  test(`bounded shell read captures (${optimized ? 'optimized' : 'normal'} Python)`, () => {
    const args = [...(optimized ? ['-O'] : []), '-B', fileURLToPath(new URL('./test_capture_private_shell.py', import.meta.url))];
    const result = spawnSync('python3', args, { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'Child process failed');
  });
}
