// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('complete public root adapter preserves guarded writes, real crypto, memory and in-root model links', () => {
  const result = spawnSync('python3', ['-B', 'tests/test_public_delivery_runtime.py'], {
    cwd: import.meta.dirname + '/..', env: { ...process.env, LOLLY_TEST_NODE: process.execPath },
    encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Ran \d+ tests/);
  assert.match(result.stderr, /OK/);
});
