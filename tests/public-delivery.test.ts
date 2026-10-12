// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const fixture of ['test_public_delivery_overlay.py', 'test_public_delivery_assembly.py']) {
  test(`public delivery preserves immutable bytes, validates codings and guards the selected root: ${fixture}`, () => {
    const result = spawnSync('python3', ['-B', `tests/${fixture}`], {
      cwd: import.meta.dirname + '/..',
      env: { ...process.env, LOLLY_TEST_NODE: process.execPath },
      encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Ran \d+ tests/);
    assert.match(result.stderr, /OK/);
  });
}
