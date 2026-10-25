// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

test('public lolly.ing approvals bind private requests and require human reviews', () => {
  const suite = fileURLToPath(new URL('../deploy/preview/approval/approval.test.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', suite], { encoding: 'utf8', timeout: 120_000, env });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /tests 14/);
});
