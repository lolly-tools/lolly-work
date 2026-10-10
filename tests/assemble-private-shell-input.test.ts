// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const optimized of [false, true]) {
  test(`private shell input adapter (${optimized ? 'optimized' : 'normal'} Python)`, () => {
    const result = spawnSync('python3', [...(optimized ? ['-O'] : []), fileURLToPath(new URL('./test_assemble_private_shell_input.py', import.meta.url))],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, LOLLY_TEST_NODE: process.execPath } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}
