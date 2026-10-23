// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// deploy/preview is Python standard library only. Its tests use fake gh, ssh,
// k3s, systemctl and check-target executables and never contact a cluster.
// The end-to-end groups each start many fake processes, so they run in parallel.
const GROUPS = [
  ['Verifier', 'Expectations', 'Layout', 'Binding', 'Smoke', 'Shipped'],
  ['Deploys'],
  ['Refusals'],
  ['Operations'],
];

function run(classes: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn('python3', ['-B', '-m', 'unittest', ...classes.map(name => `test_preview_deploy.${name}`)],
      { cwd: fileURLToPath(new URL('.', import.meta.url)) });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', status => resolve({ status, output }));
    child.on('error', error => resolve({ status: null, output: String(error) }));
  });
}

test('preview deploy command verifies, switches, smokes and rolls back over fakes', { timeout: 900_000 }, async () => {
  const results = await Promise.all(GROUPS.map(run));
  const failed = results.flatMap((result, index) => result.status === 0 ? [] : [`${(GROUPS[index] ?? []).join(', ')}:\n${result.output.slice(-6000)}`]);
  assert.deepEqual(failed, []);
});
