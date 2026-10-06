// SPDX-License-Identifier: MPL-2.0
/** Check the opt-in SUSE image's release contract without pulling or building it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const baseline = read('deploy/compose/Dockerfile');
const candidate = read('deploy/compose/Dockerfile.suse');
const workflow = read('.github/workflows/suse-container.yml');
const pkg = JSON.parse(read('package.json')) as { packageManager: string };

/** Logical Dockerfile instructions, excluding comments and joined continuations. */
function instructions(source: string, kind: string): string[] {
  return source.replace(/\\\r?\n\s*/g, ' ').split(/\r?\n/)
    .filter(line => line.startsWith(`${kind} `));
}

test('SUSE candidate uses one immutable BCI base and installs native dependencies there', () => {
  assert.deepEqual(instructions(candidate, 'FROM'), [
    'FROM registry.suse.com/bci/nodejs:24-base@sha256:719aa24270f9d490ac9e78973a2ef8f6328b23eddbfe09613859e07c356d9f65',
  ]);
  assert.doesNotMatch(candidate, /^COPY .*--from|^COPY .*node_modules|^RUN apk /m);
  const install = candidate.indexOf('RUN pnpm install --frozen-lockfile --prod');
  assert.ok(install > candidate.indexOf('COPY vendor/@lolly ./vendor/@lolly'));
  assert.ok(install > candidate.indexOf('COPY vendor/@lolly-tools ./vendor/@lolly-tools'));
  assert.ok(install > 0);
  assert.ok(candidate.includes(`RUN npm install --global --prefix /usr/local ${pkg.packageManager}`));
});

test('SUSE image preserves every default release input and both built-in gates', () => {
  assert.deepEqual(instructions(candidate, 'COPY'), instructions(baseline, 'COPY'));
  const gates = 'RUN node scripts/verify-engine-pin.ts && node scripts/check-release-capabilities.ts';
  assert.ok(candidate.includes(gates));
  assert.ok(candidate.indexOf(gates) > candidate.indexOf('COPY scripts ./scripts'));
  const pins = candidate.indexOf('COPY tsconfig.json engine-pin.json content-resolver-pin.json');
  assert.ok(pins >= 0 && candidate.indexOf(gates) > pins);
});

test('SUSE runtime keeps the default non-root identity, command, port and health probe', () => {
  for (const kind of ['ENV', 'USER', 'EXPOSE', 'HEALTHCHECK', 'CMD']) {
    assert.deepEqual(instructions(candidate, kind), instructions(baseline, kind), kind);
  }
  assert.match(candidate, /groupadd --gid 1000 node/);
  assert.match(candidate, /useradd --uid 1000 --gid node --create-home --shell \/usr\/sbin\/nologin node/);
  assert.match(candidate, /rpm -e npm24/);
  assert.doesNotMatch(candidate, /rpm -e --nodeps|\/usr\/local\/lib\/node_modules\/npm/);
});

test('qualification builds and boots amd64 without publishing or using instance secrets', () => {
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /docker build --platform linux\/amd64 -f deploy\/compose\/Dockerfile\.suse/);
  assert.match(workflow, /glibcVersionRuntime/);
  assert.match(workflow, /import \{ Resvg \} from ["']@resvg\/resvg-js["']/);
  assert.match(workflow, /import sharp from ["']sharp["']/);
  assert.match(workflow, /process\.getuid\(\), 1000/);
  assert.match(workflow, /docker run --detach --name suse-work-smoke --network none/);
  assert.match(workflow, /deployment: \{ mode: 'evaluation'/);
  assert.match(workflow, /\.State\.Health\.Status/);
  assert.match(workflow, /\/api\/v1\/agents\/activity/);
  assert.doesNotMatch(workflow, /secrets\.|packages: write|id-token: write|docker login|--push|docker push/);
  assert.doesNotMatch(read('.github/workflows/release.yml'), /Dockerfile\.suse/);
});
