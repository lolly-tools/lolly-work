// SPDX-License-Identifier: MPL-2.0
/**
 * Pull request scope for the path-scoped qualification suites.
 *
 *   git diff --name-only --no-renames -z BASE HEAD | node scripts/ci-change-scope.ts
 *
 * Reads the changed paths, NUL-separated, on stdin and prints one
 * `<suite>=true|false` line per suite for $GITHUB_OUTPUT. The reasons go to
 * stderr for the job log.
 *
 * pr-qualification.yml runs the copy of this file committed on the pull
 * request's base, so a pull request cannot narrow its own scope by editing it.
 * The file is therefore self-contained: it imports only Node built-ins.
 *
 * Only pull requests are scoped. Pushes to main, v* tags, the nightly schedule
 * and manual runs start each workflow directly and run every job.
 *
 * Each suite lists the paths that can change its result: the files its jobs
 * build, lint or execute, and their import closures
 * (tests/ci-change-scope.test.ts recomputes those closures). An entry ending in
 * `/` matches everything below it; any other entry matches one exact path. A
 * change to a workflow, the root dependency manifests or this policy selects
 * every suite.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SUITES = ['render_worker', 'deployment', 'helm'] as const;
export type Suite = typeof SUITES[number];
export type Scope = Record<Suite, boolean>;

/** Paths that select every suite. */
export const EVERYTHING: readonly string[] = [
  '.github/',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'scripts/ci-change-scope.ts',
  'tests/ci-change-scope.test.ts',
];

export const INPUTS: Readonly<Record<Suite, readonly string[]>> = {
  // CI's render-worker image leg. The image builds from workers/render alone.
  // Its qualification checks out the Lolly source named by engine-pin.json,
  // loads the vendored engine, applies the Chromium seccomp profile (the
  // qualification can add its opt-in AppArmor companion), runs the
  // shell update tools with genuine Vite, and runs the in-image acceptance
  // tests, which import the server's render and API code.
  render_worker: [
    'deploy/apparmor/',
    'deploy/seccomp/',
    'engine-pin.json',
    'scripts/ci-buildkit.sh',
    'scripts/classify-application-release.ts',
    'scripts/prepare-public-shell-update.ts',
    'scripts/prepare-shell-update.ts',
    'scripts/private-shell-codings.mjs',
    'scripts/public-delivery-map.mjs',
    'scripts/public-shell-codings.mjs',
    'scripts/qualify-render-worker-image.ts',
    'scripts/retain-shell-assets.ts',
    'scripts/shell-release-id.ts',
    'scripts/shell-update-clone.py',
    'scripts/shell-update-files.ts',
    'scripts/shell-update-vite.mjs',
    'scripts/verify-public-baseline.py',
    'server/',
    'tests/collab/',
    'tests/prepare-public-shell-update.test.ts',
    'tests/prepare-shell-update.test.ts',
    'tests/render-worker-image.test.ts',
    'tests/render-worker-tls.image.test.ts',
    'tests/retain-shell-assets.test.ts',
    'vendor/',
    'workers/',
  ],
  // Deployment qualification: the OpenTofu and Terraform modules, the YunoHost
  // package lint and the PostgreSQL backup and restore drill.
  deployment: [
    'deploy/evroc/',
    'deploy/upcloud/',
    'deploy/vm/',
    'deploy/yunohost/',
    'scripts/check-yunohost-lint.ts',
    'tests/postgres-backup.test.ts',
  ],
  // Helm qualification: chart schemas and profiles, the generated marketplace
  // packages and the neutral Compose installation. Its tests import the server's
  // configuration and setup checks. The Kubewarden requirements are derived from
  // the chart, the worker's egress rule and the release workflow's signing identity.
  helm: [
    '.github/workflows/release.yml',
    'deploy/compose/',
    'deploy/dokploy/',
    'deploy/helm/',
    'deploy/kubewarden/',
    'deploy/marketplaces/',
    'scripts/capture-marketplace-screenshots.ts',
    'scripts/kubewarden-preflight.ts',
    'scripts/kubewarden-requirements.ts',
    'scripts/marketplace-channels.ts',
    'scripts/marketplace-packages.ts',
    'scripts/package-helm-chart.ts',
    'scripts/prepare-marketplace-instance.ts',
    'scripts/publish-helm-chart.ts',
    'scripts/qualify-marketplace-compose.ts',
    'server/',
    'tests/helm-chart.test.ts',
    'tests/helm-profile-schema.test.ts',
    'tests/kubewarden-policies.test.ts',
    'tests/marketplace-channels.test.ts',
    'tests/marketplace-packages.test.ts',
    'vendor/',
    'workers/render/src/egress.ts',
  ],
};

/** True when `path` is one of `entries`, or below an entry that ends in `/`. */
export function matches(path: string, entries: readonly string[]): boolean {
  return entries.some(entry => entry.endsWith('/') ? path.startsWith(entry) : path === entry);
}

/** Refuse anything that is not a plain repository-relative path. */
function checkPath(path: string): void {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')
      || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error(`Unexpected changed path: ${JSON.stringify(path)}`);
  }
}

/** Select the suites a set of changed paths needs, with one reason per selection. */
export function classify(paths: readonly string[]): { scope: Scope; reasons: string[] } {
  const scope = Object.fromEntries(SUITES.map(suite => [suite, false])) as Scope;
  const reasons: string[] = [];
  for (const path of paths) {
    checkPath(path);
    if (matches(path, EVERYTHING)) {
      for (const suite of SUITES) scope[suite] = true;
      reasons.push(`${path}: selects every suite`);
      continue;
    }
    for (const suite of SUITES) {
      if (matches(path, INPUTS[suite])) {
        scope[suite] = true;
        reasons.push(`${path}: ${suite}`);
      }
    }
  }
  return { scope, reasons };
}

/** Split `git diff --name-only -z` output. */
export function parsePaths(raw: string): string[] {
  return raw.split('\0').filter(path => path !== '');
}

export function outputLines(scope: Scope): string {
  return SUITES.map(suite => `${suite}=${scope[suite]}\n`).join('');
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const paths = parsePaths(Buffer.concat(chunks).toString('utf8'));
  const { scope, reasons } = classify(paths);
  process.stderr.write(`${paths.length} changed paths\n`);
  for (const reason of reasons) process.stderr.write(`${reason}\n`);
  process.stdout.write(outputLines(scope));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
