// SPDX-License-Identifier: MPL-2.0
// scripts/ci-provider-mirror.sh: the lock file's zh: hashes decide which provider
// packages enter the mirror. A fake curl stands in for the registry and GitHub.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'ci-provider-mirror.sh');
const PACKAGE = 'synthetic provider package bytes';
const DIGEST = createHash('sha256').update(PACKAGE).digest('hex');
const OTHER = 'f'.repeat(64);
const tools = ['jq', 'awk', 'sha256sum'].every(name => spawnSync('sh', ['-c', `command -v ${name}`]).status === 0);
const skip = tools ? false : 'needs jq, awk and sha256sum';

function run(options: { lockHash: string; downloadUrl?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'lw-provider-mirror-'));
  try {
    const bin = join(dir, 'bin'), mirror = join(dir, 'mirror');
    mkdirSync(bin);
    const os = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const asset = `terraform-provider-upcloud_5.45.0_${os}_${arch}.zip`;
    const url = options.downloadUrl ?? `https://github.com/UpCloudLtd/terraform-provider-upcloud/releases/download/v5.45.0/${asset}`;
    writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ download_url: url, filename: asset }));
    writeFileSync(join(dir, 'package.zip'), PACKAGE);
    writeFileSync(join(bin, 'curl'), `#!/bin/bash
out=; target=
while (($#)); do case "$1" in --output) out=$2; shift ;; https://*) target=$1 ;; esac; shift; done
case "$target" in
  https://registry.terraform.io/v1/providers/upcloudltd/upcloud/5.45.0/download/*) cat "${join(dir, 'metadata.json')}" ;;
  https://github.com/*) cp "${join(dir, 'package.zip')}" "$out" ;;
  *) exit 22 ;;
esac
`);
    chmodSync(join(bin, 'curl'), 0o755);
    const lock = join(dir, '.terraform.lock.hcl');
    writeFileSync(lock, `provider "registry.terraform.io/upcloudltd/upcloud" {
  version     = "5.45.0"
  constraints = "5.45.0"
  hashes = [
    "h1:PHR8qKN+7oxfcn7pwif2quVZJWs2+7389O1str8o49M=",
    "zh:${'0'.repeat(64)}",
    "zh:${options.lockHash}",
  ]
}
`);
    const result = spawnSync('bash', [SCRIPT, lock, mirror], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: '' }, encoding: 'utf8' });
    const packed = join(mirror, 'registry.terraform.io', 'upcloudltd', 'upcloud');
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, files: existsSync(packed) ? readdirSync(packed) : [], asset };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a package whose SHA-256 the lock records goes into the packed mirror layout', { skip }, () => {
  const result = run({ lockHash: DIGEST });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.files, [result.asset]);
  assert.match(result.stdout, /matches the lock file/);
});

test('a package the lock does not record is refused and removed', { skip }, () => {
  const result = run({ lockHash: OTHER });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`SHA-256 ${DIGEST}, which the lock file does not record`));
  assert.deepEqual(result.files, []);
});

test('a registry download that is not a GitHub release asset is refused', { skip }, () => {
  const result = run({ lockHash: DIGEST, downloadUrl: 'https://example.com/terraform-provider-upcloud.zip' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a GitHub release asset/);
  assert.deepEqual(result.files, []);
});
