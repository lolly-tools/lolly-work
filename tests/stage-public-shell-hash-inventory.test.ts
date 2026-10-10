// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const optimized of [false, true]) test(`batched public inventory preserves strict hashes using local utility shims${optimized ? ' (optimized Python)' : ''}`, () => {
  const r = spawnSync('python3', ['-B', ...(optimized ? ['-O'] : []), 'tests/test_stage_public_shell_hash_inventory.py'], {
    cwd: import.meta.dirname + '/..', encoding: 'utf8', timeout: 180_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /Ran \d+ tests/);
  assert.match(r.stderr, /OK/);
});
