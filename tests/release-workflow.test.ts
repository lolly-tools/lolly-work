// SPDX-License-Identifier: MPL-2.0
/** Check the release workflow's image jobs without building, pushing or signing anything. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

interface Step { id?: string; name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface Job {
  name: string;
  needs?: string | string[];
  if?: string;
  'runs-on': string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; matrix: { include: Array<Record<string, string>> } };
  steps: Step[];
}
interface Input { required: boolean; type: string; default?: string; options?: string[] }
interface Workflow {
  on: { push: unknown; workflow_dispatch: { inputs: Record<string, Input> } };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')) as Workflow;
const { jobs } = workflow;

function job(id: string): Job {
  const found = jobs[id];
  assert.ok(found, `missing job ${id}`);
  return found;
}
function step(owner: Job, name: string): Step {
  const found = owner.steps.find(candidate => candidate.name === name || candidate.id === name);
  assert.ok(found?.run, `missing step ${name}`);
  return found;
}
const position = (owner: Job, match: (candidate: Step) => boolean): number => owner.steps.findIndex(match);
const usesAction = (action: string) => (candidate: Step): boolean => candidate.uses?.startsWith(`${action}@`) ?? false;
const script = (owner: Job): string => owner.steps.map(candidate => candidate.run ?? '').join('\n');

test('a dispatch chooses the images, defaulting to both, and a tag push builds both', () => {
  const { inputs } = workflow.on.workflow_dispatch;
  assert.deepEqual(workflow.on.push, { tags: ['v*'] });
  assert.equal(inputs.version_tag?.required, true);
  assert.equal(inputs.expected_source_sha?.required, true);
  assert.equal(inputs.images?.type, 'choice');
  assert.equal(inputs.images?.required, false);
  assert.equal(inputs.images?.default, 'both');
  assert.deepEqual(inputs.images?.options, ['both', 'server', 'worker']);

  const source = job('release-source');
  const select = step(source, 'images');
  assert.equal(select.env?.RELEASE_IMAGES, "${{ github.event_name == 'push' && 'both' || inputs.images }}");
  assert.equal(source.outputs?.server, '${{ steps.images.outputs.server }}');
  assert.equal(source.outputs?.worker, '${{ steps.images.outputs.worker }}');
  assert.ok(position(source, candidate => candidate.id === 'images') < position(source, usesAction('actions/checkout')));

  const directory = mkdtempSync(join(tmpdir(), 'release-images-'));
  try {
    const output = join(directory, 'output');
    const choose = (value: string) => {
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-c', select.run ?? ''], { env: { ...process.env, RELEASE_IMAGES: value, GITHUB_OUTPUT: output }, encoding: 'utf8' });
      return { status: result.status, output: readFileSync(output, 'utf8') };
    };
    assert.deepEqual(choose('both'), { status: 0, output: 'server=true\nworker=true\n' });
    assert.deepEqual(choose('server'), { status: 0, output: 'server=true\nworker=false\n' });
    assert.deepEqual(choose('worker'), { status: 0, output: 'server=false\nworker=true\n' });
    for (const rejected of ['', 'all', 'server,worker']) assert.deepEqual(choose(rejected), { status: 1, output: '' }, rejected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  assert.equal(job('server-image').if, "needs.release-source.outputs.server == 'true'");
  assert.equal(job('server-manifest').if, "needs.release-source.outputs.server == 'true'");
  assert.equal(job('render-worker-image').if, "needs.release-source.outputs.worker == 'true'");
});

test('the server image builds natively on amd64 and arm64 runners and pushes by digest only', () => {
  const build = job('server-image');
  assert.equal(build['runs-on'], '${{ matrix.runner }}');
  assert.deepEqual(build.strategy?.matrix.include, [
    { platform: 'linux/amd64', arch: 'amd64', runner: 'ubuntu-latest' },
    { platform: 'linux/arm64', arch: 'arm64', runner: 'ubuntu-24.04-arm' },
  ]);
  for (const id of ['server-image', 'server-manifest']) {
    assert.equal(position(job(id), usesAction('docker/setup-qemu-action')), -1, id);
  }
  assert.ok(position(build, usesAction('docker/setup-buildx-action')) >= 0);

  const commands = script(build);
  assert.match(commands, /docker buildx build --platform "\$PLATFORM" \\\n\s+--provenance=mode=max --sbom=true \\/);
  assert.match(commands, /--label "org\.opencontainers\.image\.source=https:\/\/github\.com\/\$GITHUB_REPOSITORY"/);
  assert.match(commands, /--label "org\.opencontainers\.image\.revision=\$RELEASE_SOURCE"/);
  assert.match(commands, /--output "type=image,name=\$IMAGE,push-by-digest=true,name-canonical=true,push=true"/);
  assert.match(commands, /-f deploy\/compose\/Dockerfile \.\n/);
  assert.match(commands, /IMAGE="ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER\}\/lolly-work-server"/);
  assert.doesNotMatch(commands, /--push\b|\s-t\s|--tag\b|linux\/amd64,linux\/arm64/);
  assert.match(commands, /\."containerimage\.digest"/);
  assert.match(commands, /> "\$RUNNER_TEMP\/digests\/\$ARCH"/);

  const upload = build.steps[position(build, usesAction('actions/upload-artifact'))];
  assert.deepEqual(upload?.with, {
    name: 'server-digest-${{ matrix.arch }}',
    path: '${{ runner.temp }}/digests/${{ matrix.arch }}',
    'if-no-files-found': 'error',
    overwrite: true,
  });
  assert.equal(position(build, usesAction('sigstore/cosign-installer')), -1);
});

test('the merge job joins both digests under the version tags, checks the index, then signs it', () => {
  const merge = job('server-manifest');
  const worker = job('render-worker-image');
  assert.deepEqual(merge.needs, ['release-source', 'server-image']);
  assert.equal(merge['runs-on'], 'ubuntu-latest');

  const download = position(merge, usesAction('actions/download-artifact'));
  assert.deepEqual(merge.steps[download]?.with, {
    pattern: 'server-digest-*',
    path: '${{ runner.temp }}/digests',
    'merge-multiple': true,
  });

  const create = step(merge, 'Create the multi-platform index (amd64 + arm64)');
  const commands = create.run ?? '';
  const dryRun = commands.indexOf('docker buildx imagetools create --dry-run -t "$IMAGE:$VERSION" -t "$IMAGE:latest" \\\n  "$IMAGE@$AMD64_DIGEST" "$IMAGE@$ARM64_DIGEST" > "$RUNNER_TEMP/index.dry-run.json"');
  const dryRunCheck = commands.indexOf('python3 "$RUNNER_TEMP/check-index.py" "$IMAGE" < "$RUNNER_TEMP/index.dry-run.json"');
  const publish = commands.indexOf('docker buildx imagetools create -t "$IMAGE:$VERSION" -t "$IMAGE:latest" \\\n  "$IMAGE@$AMD64_DIGEST" "$IMAGE@$ARM64_DIGEST"\n');
  const pushedCheck = commands.indexOf('python3 "$RUNNER_TEMP/check-index.py" "$IMAGE" < "$RUNNER_TEMP/index.pushed.json"');
  assert.ok(dryRun >= 0 && dryRun < dryRunCheck && dryRunCheck < publish && publish < pushedCheck, 'dry run, check, publish, check');
  assert.ok(position(merge, usesAction('actions/download-artifact')) < position(merge, candidate => candidate === create));

  const sign = step(merge, 'Sign the image (keyless)');
  assert.ok(position(merge, candidate => candidate === create) < position(merge, usesAction('sigstore/cosign-installer')));
  assert.ok(position(merge, usesAction('sigstore/cosign-installer')) < position(merge, candidate => candidate === sign));
  assert.equal(sign.run, step(worker, 'Sign the image (keyless)').run);
  assert.match(sign.run ?? '', /cosign sign "\$IMAGE@\$DIGEST"/);
  assert.equal(sign.env?.COSIGN_YES, 'true');
});

test('only signing jobs get an OIDC token and every image job checks out the exact source', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(job('release-source').permissions, { contents: 'read' });
  assert.deepEqual(job('server-image').permissions, { contents: 'read', packages: 'write' });
  assert.deepEqual(job('server-manifest').permissions, { contents: 'read', packages: 'write', 'id-token': 'write' });
  assert.deepEqual(job('render-worker-image').permissions, { contents: 'read', packages: 'write', 'id-token': 'write' });
  for (const [id, owner] of Object.entries(jobs)) {
    assert.equal(owner.permissions?.['id-token'] === 'write', /cosign sign/.test(script(owner)), id);
    if (id === 'release-source') continue;
    assert.ok([owner.needs ?? []].flat().includes('release-source'), id);
    const checkout = owner.steps[position(owner, usesAction('actions/checkout'))];
    assert.deepEqual(checkout?.with, { ref: '${{ needs.release-source.outputs.source }}', 'persist-credentials': false }, id);
    const verify = step(owner, 'Verify exact build source').run ?? '';
    assert.match(verify, /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_SOURCE"/, id);
    assert.match(verify, /process\.env\.RELEASE_VERSION/, id);
    assert.match(step(owner, 'Log in to GHCR').run ?? '', /docker login ghcr\.io -u "\$GITHUB_ACTOR" --password-stdin/, id);
  }
});

test('the render-worker image still builds both platforms in one QEMU job', () => {
  const worker = job('render-worker-image');
  assert.equal(worker['runs-on'], 'ubuntu-latest');
  assert.ok(position(worker, usesAction('docker/setup-qemu-action')) >= 0);
  assert.match(script(worker), /docker buildx build --platform linux\/amd64,linux\/arm64 \\\n\s+--provenance=mode=max --sbom=true/);
  assert.match(script(worker), /-t "\$IMAGE:\$VERSION" -t "\$IMAGE:latest" --push workers\/render/);
});

/** The index check script, as the merge step writes it. */
function indexCheck(): string {
  const commands = step(job('server-manifest'), 'Create the multi-platform index (amd64 + arm64)').run ?? '';
  const match = /cat > "\$RUNNER_TEMP\/check-index\.py" <<'PY'\n([\s\S]*?)\nPY\n/.exec(commands);
  assert.ok(match?.[1], 'check-index.py heredoc');
  return match[1];
}

const digest = (fill: string): string => `sha256:${fill.repeat(64)}`;
const amd64 = digest('a'), arm64 = digest('b'), amd64Attestation = digest('c'), arm64Attestation = digest('d');
const imageEntry = (value: string, architecture: string) => ({
  mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: value, size: 2198, platform: { architecture, os: 'linux' },
});
const attestationEntry = (value: string, subject: string) => ({
  mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: value, size: 1113,
  annotations: { 'vnd.docker.reference.digest': subject, 'vnd.docker.reference.type': 'attestation-manifest' },
  platform: { architecture: 'unknown', os: 'unknown' },
});
const attestation = (...predicates: string[]) => JSON.stringify({
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  artifactType: 'application/vnd.docker.attestation.manifest.v1+json',
  layers: predicates.map(kind => ({ mediaType: 'application/vnd.in-toto+json', annotations: { 'in-toto.io/predicate-type': kind } })),
});
const attested = attestation('https://spdx.dev/Document', 'https://slsa.dev/provenance/v1');

/** Run the check with a docker stand-in that serves `attestationJson` for every inspect. */
function checkIndex(manifests: unknown[], attestationJson = attested): { status: number | null; stdout: string; calls: string[] } {
  const directory = mkdtempSync(join(tmpdir(), 'release-index-'));
  try {
    const log = join(directory, 'docker.log');
    writeFileSync(log, '');
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_DOCKER_LOG"\nprintf \'%s\' "$FAKE_ATTESTATION"\n');
    chmodSync(join(directory, 'docker'), 0o755);
    writeFileSync(join(directory, 'check-index.py'), indexCheck());
    const index = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests });
    const result = spawnSync('python3', [join(directory, 'check-index.py'), 'ghcr.io/example/lolly-work-server'], {
      input: index, encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ''}`, FAKE_DOCKER_LOG: log, FAKE_ATTESTATION: attestationJson },
    });
    return { status: result.status, stdout: result.stdout, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('the index check passes both attested platforms in the merged order', () => {
  const result = checkIndex([
    imageEntry(amd64, 'amd64'), attestationEntry(amd64Attestation, amd64),
    imageEntry(arm64, 'arm64'), attestationEntry(arm64Attestation, arm64),
  ]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [
    `buildx imagetools inspect --raw ghcr.io/example/lolly-work-server@${amd64Attestation}`,
    `buildx imagetools inspect --raw ghcr.io/example/lolly-work-server@${arm64Attestation}`,
  ]);
  assert.equal(result.stdout, `linux/amd64 ${amd64} attested by ${amd64Attestation}\nlinux/arm64 ${arm64} attested by ${arm64Attestation}\n`);
});

test('the index check stops on a missing platform, attestation or predicate', () => {
  const complete = [
    imageEntry(amd64, 'amd64'), imageEntry(arm64, 'arm64'),
    attestationEntry(amd64Attestation, amd64), attestationEntry(arm64Attestation, arm64),
  ];
  assert.equal(checkIndex(complete).status, 0);
  assert.notEqual(checkIndex(complete.filter(entry => entry.digest !== arm64)).status, 0);
  assert.notEqual(checkIndex(complete.filter(entry => entry.digest !== arm64Attestation)).status, 0);
  assert.notEqual(checkIndex([...complete, imageEntry(digest('e'), 'arm64')]).status, 0);
  assert.notEqual(checkIndex([...complete, imageEntry(digest('e'), 's390x')]).status, 0);
  assert.notEqual(checkIndex([...complete, attestationEntry(digest('f'), amd64)]).status, 0);
  assert.notEqual(checkIndex(complete, attestation('https://spdx.dev/Document')).status, 0);
  assert.notEqual(checkIndex(complete, attestation('https://slsa.dev/provenance/v1')).status, 0);
});
