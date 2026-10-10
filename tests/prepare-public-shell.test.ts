// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
test('offline public planner independently binds source, catalog, original runtime and exact overlay changes', () => {
  const r=spawnSync('python3',['-B','tests/test_prepare_public_shell.py'],{cwd:import.meta.dirname+'/..',env:{...process.env,LOLLY_TEST_NODE:process.execPath},encoding:'utf8',timeout:120_000});
  assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`); assert.match(r.stderr,/Ran \d+ tests/); assert.match(r.stderr,/OK/);
});
