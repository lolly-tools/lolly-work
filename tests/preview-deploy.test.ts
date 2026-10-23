// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// deploy/preview is Python standard library only. Its tests use fake gh, ssh,
// k3s, systemctl and check-target executables and never contact a cluster.
test('preview deploy command verifies, switches, smokes and rolls back over fakes', () => {
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./test_preview_deploy.py', import.meta.url))],
    { encoding: 'utf8', timeout: 900_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || 'Child process failed');
});
