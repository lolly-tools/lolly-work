// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('private shell staging protects storage, admission, custody and no-replay boundaries', () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./test_stage_private_shell.py', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, LOLLY_TEST_NODE: process.execPath }, timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
