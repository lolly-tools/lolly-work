// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

for (const optimized of [false, true]) {
  test(`captured private cohort plan (${optimized ? 'optimized' : 'normal'} Python)`, () => {
    const args = [...(optimized ? ['-O'] : []), fileURLToPath(new URL('./test_plan_private_cohort.py', import.meta.url))];
    const result = spawnSync('python3', args, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, LOLLY_TEST_NODE: process.execPath } });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
}
