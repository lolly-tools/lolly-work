import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const renderer = fileURLToPath(new URL('../deploy/suse/postgres-backup-cronjob.py', import.meta.url));
const nodeImage = `registry.example.test/private-node@sha256:${'a'.repeat(64)}`;
function render(extra: string[] = []) {
  return spawnSync('python3', [renderer, '--node-image', nodeImage, ...extra], { encoding: 'utf8' });
}

test('backup pod isolates database credentials and CA from the encrypted object uploader', () => {
  const r = render(); assert.equal(r.status, 0, r.stderr);
  const job = JSON.parse(r.stdout), pod = job.spec.jobTemplate.spec.template.spec;
  const dump = pod.initContainers[0], upload = pod.containers[0];
  assert.match(dump.image, /^dp\.apps\.rancher\.io\/containers\/postgresql@sha256:[a-f0-9]{64}$/);
  assert.equal(upload.image, nodeImage);
  const dumpMounts = dump.volumeMounts.map((m: { name: string }) => m.name);
  const uploadMounts = upload.volumeMounts.map((m: { name: string }) => m.name);
  assert.ok(dumpMounts.includes('database-connection') && dumpMounts.includes('database-ca'));
  assert.ok(!dumpMounts.includes('upload-credentials'));
  assert.ok(uploadMounts.includes('upload-credentials'));
  assert.ok(!uploadMounts.includes('database-connection') && !uploadMounts.includes('database-ca'));
  assert.deepEqual(dumpMounts.filter((name: string) => uploadMounts.includes(name)), ['archive']);
  assert.equal(upload.volumeMounts.find((m: { name: string }) => m.name === 'archive').readOnly, true);
  assert.deepEqual(upload.command, ['node', '--max-old-space-size=128', '/operator/backup-object.mjs', 'upload',
    '--credentials', '/run/backup/storage.json', '--key', '/run/backup/encryption-key.txt', '--input', '/archive/database.dump']);
  for (const c of [dump, upload]) assert.equal(c.env, undefined, 'no inline credentials or URL');
});

test('backup scheduling remains suspended and runtime budgets and TLS/read-only checks are bounded', () => {
  const r = render(); assert.equal(r.status, 0, r.stderr);
  const job = JSON.parse(r.stdout), spec = job.spec, pod = spec.jobTemplate.spec.template.spec;
  assert.equal(spec.suspend, true); assert.equal(spec.concurrencyPolicy, 'Forbid');
  assert.equal(spec.timeZone, 'Etc/UTC'); assert.equal(spec.startingDeadlineSeconds, 300);
  assert.equal(spec.jobTemplate.spec.activeDeadlineSeconds, 600);
  assert.equal(spec.jobTemplate.spec.backoffLimit, 0);
  assert.equal(spec.jobTemplate.spec.ttlSecondsAfterFinished, 86400);
  assert.equal(pod.automountServiceAccountToken, false); assert.equal(pod.restartPolicy, 'Never');
  assert.equal(pod.securityContext.runAsUser, 1000);
  assert.deepEqual(pod.securityContext.seccompProfile, { type: 'RuntimeDefault' });
  for (const c of [...pod.initContainers, ...pod.containers]) {
    assert.equal(c.securityContext.allowPrivilegeEscalation, false);
    assert.equal(c.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(c.securityContext.capabilities.drop, ['ALL']);
    assert.ok(c.resources.limits.memory && c.resources.limits['ephemeral-storage']);
  }
  assert.equal(pod.containers[0].resources.limits.memory, '768Mi');
  assert.deepEqual(pod.volumes.find((v: { name: string }) => v.name === 'archive').emptyDir, { sizeLimit: '256Mi' });
  const command = pod.initContainers[0].command[2];
  assert.match(command, /default_transaction_read_only=on/);
  assert.match(command, /SELECT ssl FROM pg_stat_ssl/);
  assert.match(command, /chmod 600/);
  assert.match(command, /postgres-backup\.sh backup \/archive\/database\.dump/);
});

test('backup rendering refuses mutable images and invalid resource names before producing manifests', () => {
  for (const image of ['registry.example.test/node:latest', 'node@sha256:abc', `node@sha256:${'A'.repeat(64)}`, 'node@sha256:x;touch /tmp/no']) {
    const r = render(['--node-image', image]); assert.notEqual(r.status, 0); assert.equal(r.stdout, '');
  }
  for (const option of ['--namespace', '--connection-secret', '--upload-secret']) {
    const r = render([option, '../escape']); assert.notEqual(r.status, 0); assert.equal(r.stdout, '');
  }
});
