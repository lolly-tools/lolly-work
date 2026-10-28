// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const optimized of [false, true]) {
  test(`private shell-only preparation (${optimized ? 'optimized' : 'normal'} Python)`, () => {
    const result = spawnSync('python3', [...(optimized ? ['-O'] : []), fileURLToPath(new URL('./test_prepare_private_shell.py', import.meta.url))],
      // The optimized-Python leg measured 54 to 84 s on GitHub runners (2026-10-27)
      // and timed out at 90 s on a pull request; 240 s leaves room under load.
      { encoding: 'utf8', timeout: 240_000, env: { ...process.env, LOLLY_TEST_NODE: process.execPath } });
    assert.equal(result.status, 0, result.stderr || result.error?.message || 'Child process failed');
  });
}
