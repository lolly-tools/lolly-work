// SPDX-License-Identifier: MPL-2.0
/** Rendered schema checks only; no cluster, cloud credentials or runtime changes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const chart = fileURLToPath(new URL('../deploy/helm', import.meta.url));
const tools = ['helm', 'kubeconform'].every(binary => {
  const result = spawnSync(binary, [binary === 'helm' ? 'version' : '-v'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
});
if (process.env.LW_REQUIRE_HELM_TESTS === '1' && !tools) throw new Error('Helm qualification requires Helm and kubeconform');
const skip = tools ? false : 'install helm and kubeconform for offline schema qualification';
const secret = ['--set', 'existingSecret=qualification-secrets'];
const worker = ['--set', 'renderWorker.enabled=true', '--set', 'renderWorker.webBase=https://shell.example.test'];
const small = ['-f', `${chart}/values-small-suse.yaml`];
const copies = [
  '--set-json', 'imagePullSecrets=[{"name":"qualification-registry"}]',
  '--set', 'pack.type=emptyDir', '--set', 'pack.image=registry.example.test/pack:release',
  '--set', 'shell.enabled=true', '--set', 'shell.type=emptyDir', '--set', 'shell.image=registry.example.test/shell:release',
];

const profiles: [string, string[]][] = [
  ['default', secret],
  ['evaluation', ['-f', `${chart}/values-eval.yaml`]],
  ['worker', [...secret, ...worker]],
  ['small SUSE', [...secret, ...small]],
  ['small SUSE with authenticated OCI copies and worker', [...secret, ...small, ...worker, ...copies]],
  ['small SUSE with worker HPA', [...secret, ...small, ...worker, '--set', 'renderWorker.autoscaling.enabled=true']],
  ['immutable digests', [...secret, ...worker, '--set', `image.digest=sha256:${'a'.repeat(64)}`, '--set', `renderWorker.image.digest=sha256:${'b'.repeat(64)}`]],
  ['worker placement and network policy', [...secret, ...worker,
    '--set', 'renderWorker.nodeSelector.workload=render',
    '--set-json', 'renderWorker.tolerations=[{"key":"render","operator":"Exists","effect":"NoSchedule"}]',
    '--set', 'networkPolicy.enabled=true', '--set', 'renderWorker.networkPolicy.enabled=true',
  ]],
];

for (const [name, args] of profiles) {
  test(`Helm ${name} manifests satisfy strict Kubernetes schemas`, { skip }, () => {
    const rendered = spawnSync('helm', ['template', 'lolly', chart, ...args], { encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
    const schema = spawnSync('kubeconform', ['-strict', '-summary', '-kubernetes-version', '1.34.0'], { input: rendered.stdout, encoding: 'utf8' });
    assert.equal(schema.status, 0, schema.stdout + schema.stderr);
    assert.match(schema.stdout, /Invalid: 0, Errors: 0, Skipped: 0/, 'every rendered built-in resource must be checked');
  });
}
