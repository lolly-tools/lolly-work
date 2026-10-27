// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

for (const fixture of ['test_public_delivery_overlay.py', 'test_public_delivery_assembly.py', 'test_public_serving_continuation.py', 'test_public_memory_health.py', 'test_public_build_sources.py', 'test_public_observation_continuation.py', 'test_public_stage_model_reuse.py', 'test_public_release_measurement.py', 'test_public_release_end_to_end.py']) {
  test(`public delivery preserves immutable bytes, validates codings and guards the selected root: ${fixture}`, () => {
    const result = spawnSync('python3', ['-B', `tests/${fixture}`], {
      cwd: import.meta.dirname + '/..',
      env: { ...process.env, LOLLY_TEST_NODE: process.execPath },
      // The observation continuation builds a fresh lifecycle fixture per case and takes
      // 90 to 110 s on a GitHub runner (measured 2026-10-27), so 120 s timed out under
      // load on main and on pull requests. The others finish within 3 s.
      encoding: 'utf8', timeout: fixture === 'test_public_observation_continuation.py' ? 300_000 : 120_000,
    });
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Ran \d+ tests/);
    assert.match(result.stderr, /OK/);
  });
}
