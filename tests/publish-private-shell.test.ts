// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const optimized of [false, true]) {
  test(`private shell publication (${optimized ? 'optimized' : 'normal'} Python)`, () => {
    const args = [...(optimized ? ['-O'] : []), '-B', fileURLToPath(new URL('./test_publish_private_shell.py', import.meta.url))];
    const result = spawnSync('python3', args, { encoding: 'utf8', timeout: 90_000, env: { ...process.env, LOLLY_TEST_NODE: process.execPath } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}
