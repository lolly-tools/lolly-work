// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// deploy/preview is Python standard library only. Its tests use fake gh, ssh,
// k3s, systemctl and check-target executables and never contact a cluster.
// The end-to-end groups each start many fake processes, so they run in parallel.
// lolly.tools lives in test_preview_deploy.py, lolly.ing in test_preview_deploy_ing.py, and the
// fast deploy lanes' rules in test_preview_lane.py.
const GROUPS = [
  ['Verifier', 'Expectations', 'Layout', 'Binding', 'Smoke', 'Shipped'].map(name => `test_preview_deploy.${name}`)
    .concat(['test_preview_deploy_ing.IngRules', 'test_preview_lane.LaneRules', 'test_preview_lane.LaneGitHub']),
  ['test_preview_deploy.Deploys'],
  ['test_preview_deploy.BuildAtMerge'],
  ['test_preview_deploy.LaneShips'],
  ['test_preview_deploy.Refusals'],
  ['test_preview_deploy.Operations'],
  ['test_preview_deploy.Endurance'],
  ['test_preview_deploy_ing.IngDeploys'],
  ['test_preview_deploy_ing.IngRefusals'],
  ['test_preview_deploy_ing.IngCutover', 'test_preview_deploy_ing.IngRetention'],
  ['test_preview_deploy_ing.IngFetch'],
];

function run(classes: string[]): Promise<{ status: number | null; output: string }> {
  return new Promise(resolve => {
    const child = spawn('python3', ['-B', '-m', 'unittest', ...classes],
      { cwd: fileURLToPath(new URL('.', import.meta.url)) });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', status => resolve({ status, output }));
    child.on('error', error => resolve({ status: null, output: String(error) }));
  });
}

test('preview deploy command verifies, switches, smokes and rolls back over fakes', { timeout: 1_500_000 }, async () => {
  const results = await Promise.all(GROUPS.map(run));
  const failed = results.flatMap((result, index) => result.status === 0 ? [] : [`${(GROUPS[index] ?? []).join(', ')}:\n${result.output.slice(-6000)}`]);
  assert.deepEqual(failed, []);
});
