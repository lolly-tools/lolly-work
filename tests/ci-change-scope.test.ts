// SPDX-License-Identifier: MPL-2.0
/** Check the pull request scope policy, its coverage and the one aggregate check. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { classify, EVERYTHING, INPUTS, matches, outputLines, parsePaths, SUITES, type Suite } from '../scripts/ci-change-scope.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPT = join(ROOT, 'scripts/ci-change-scope.ts');
const text = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

interface Step { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown>; 'working-directory'?: string }
interface Job { name?: string; needs?: string | string[]; if?: string; uses?: string; with?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[]; strategy?: { matrix: Record<string, unknown> } }
interface Workflow { on: Record<string, unknown>; concurrency?: { group: string }; jobs: Record<string, Job> }
const workflow = (name: string): Workflow => parse(text(`.github/workflows/${name}`)) as Workflow;
const runs = (job: Job): string => (job.steps ?? []).map(step => step.run ?? '').join('\n');
const selected = (paths: string[]): Suite[] => SUITES.filter(suite => classify(paths).scope[suite]);

test('documentation, console and unrelated source changes select no scoped suite', () => {
  assert.deepEqual(selected([]), []);
  assert.deepEqual(selected(['docs/deployment.md', 'docs-pin.json', 'console/index.html', 'migrations/0042_x.sql',
    'cli/src/main.ts', 'README.md', 'tests/scim.test.ts', 'scripts/scan-code.ts', 'deploy/vercel/README.md']), []);
});

test('each suite is selected by its own inputs', () => {
  assert.deepEqual(selected(['workers/render/src/server.ts']), ['render_worker']);
  assert.deepEqual(selected(['engine-pin.json']), ['render_worker']);
  assert.deepEqual(selected(['deploy/seccomp/chromium.json']), ['render_worker']);
  assert.deepEqual(selected(['tests/render-worker-image.test.ts']), ['render_worker']);
  assert.deepEqual(selected(['deploy/upcloud/main.tf']), ['deployment']);
  assert.deepEqual(selected(['deploy/yunohost/manifest.toml']), ['deployment']);
  assert.deepEqual(selected(['deploy/vm/postgres-backup.sh']), ['deployment']);
  assert.deepEqual(selected(['deploy/helm/values.yaml']), ['helm']);
  assert.deepEqual(selected(['deploy/marketplaces/release.json']), ['helm']);
  assert.deepEqual(selected(['tests/marketplace-packages.test.ts']), ['helm']);
  assert.deepEqual(selected(['server/src/config/instance.ts']), ['render_worker', 'helm']);
  assert.deepEqual(selected(['vendor/@lolly/engine/src/index.ts']), ['render_worker', 'helm']);
});

test('workflows, root dependency manifests and the policy itself select every suite', () => {
  for (const path of ['.github/workflows/ci.yml', '.github/dependabot.yml', 'package.json', 'pnpm-lock.yaml',
    'pnpm-workspace.yaml', 'scripts/ci-change-scope.ts', 'tests/ci-change-scope.test.ts']) {
    assert.deepEqual(selected([path]), [...SUITES], path);
  }
  assert.equal(selected(['workers/render/package.json']).join(), 'render_worker');
});

test('a deletion or a rename on either side counts like any other change', () => {
  // The workflow lists paths with --no-renames, so a move shows both paths.
  assert.deepEqual(selected(['deploy/helm/old.yaml', 'docs/new.md']), ['helm']);
  assert.deepEqual(selected(['docs/old.md', 'deploy/evroc/new.tf']), ['deployment']);
});

test('entries match exact files or whole directories, never a prefix of a name', () => {
  assert.equal(matches('workers/render/x.ts', ['workers/']), true);
  assert.equal(matches('workersx/a.ts', ['workers/']), false);
  assert.equal(matches('engine-pin.json.bak', ['engine-pin.json']), false);
  assert.equal(matches('server', ['server/']), false);
});

test('only plain repository-relative paths are accepted', () => {
  for (const path of ['/etc/passwd', '../outside', 'a/../b', 'a//b', './a', 'a\\b', 'a\nb']) {
    assert.throws(() => classify([path]), /Unexpected changed path/, JSON.stringify(path));
  }
});

test('the command reads NUL-separated paths and prints one output line per suite', () => {
  assert.deepEqual(parsePaths('a\0b c\0\0'), ['a', 'b c']);
  assert.equal(outputLines({ render_worker: true, deployment: false, helm: true }), 'render_worker=true\ndeployment=false\nhelm=true\n');
  // The workflow runs a copy outside the repository, so the script must stand alone.
  const directory = mkdtempSync(join(tmpdir(), 'ci-change-scope-'));
  try {
    const copy = join(directory, 'ci-change-scope.mts');
    copyFileSync(SCRIPT, copy);
    const run = (input: string) => spawnSync(process.execPath, [copy], { input, encoding: 'utf8' });
    const docs = run('docs/a.md\0console/b.js\0');
    assert.equal(docs.status, 0, docs.stderr);
    assert.equal(docs.stdout, 'render_worker=false\ndeployment=false\nhelm=false\n');
    const helm = run('deploy/helm/Chart.yaml\0');
    assert.equal(helm.stdout, 'render_worker=false\ndeployment=false\nhelm=true\n');
    assert.match(helm.stderr, /deploy\/helm\/Chart\.yaml: helm/);
    const bad = run('../escape\0');
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, '');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  assert.doesNotMatch(text('scripts/ci-change-scope.ts'), /from '\.|import\('\./);
});

test('every policy entry names a path that exists', () => {
  for (const entry of [...EVERYTHING, ...SUITES.flatMap(suite => INPUTS[suite])]) {
    const path = join(ROOT, entry);
    assert.ok(existsSync(path), `${entry} does not exist`);
    assert.equal(statSync(path).isDirectory(), entry.endsWith('/'), `${entry} must end in / exactly when it is a directory`);
  }
});

/** Files reached from `seeds` through relative imports and `new URL('./x', import.meta.url)`. */
function closure(seeds: string[]): string[] {
  const reference = /(?:import|export)[^'"`;]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url/g;
  const seen = new Set<string>();
  const pending = seeds.map(seed => join(ROOT, seed));
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    if (statSync(file).isDirectory() || !/\.(?:ts|mts|mjs|js)$/.test(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(reference)) pending.push(resolve(dirname(file), match[1] ?? match[2] ?? match[3]!));
  }
  // `new URL('..', import.meta.url)` names the repository root, which is not an input.
  return [...seen].filter(file => file !== ROOT).map(file => relative(ROOT, file) + (statSync(file).isDirectory() ? '/' : ''));
}

/** Existing scripts/, tests/ and deploy/ paths that `source` names; a directory ends in `/`. */
function named(source: string): string[] {
  const paths = [...source.matchAll(/(?<![\w.-])((?:scripts|tests|deploy)\/[\w./-]*[\w-])/g)].map(match => match[1]!);
  return [...new Set(paths)].filter(path => existsSync(join(ROOT, path)))
    .map(path => statSync(join(ROOT, path)).isDirectory() ? `${path}/` : path);
}

function covers(suite: Suite, path: string): boolean {
  const entries = [...INPUTS[suite], ...EVERYTHING];
  return path.endsWith('/') ? entries.some(entry => entry.endsWith('/') && path.startsWith(entry)) : matches(path, entries);
}

/** deploy/ paths a script names without reading them from this checkout. */
const NOT_READ: Record<string, string[]> = {
  // Repository layout markers it looks up with `git ls-tree` in the candidate it classifies.
  'scripts/classify-application-release.ts': ['deploy/helm/Chart.yaml'],
};

function assertCovered(suite: Suite, seeds: string[]): void {
  assert.ok(seeds.length > 1, suite);
  const files = closure(seeds);
  // The qualification scripts read deploy/ files by path, not by import.
  for (const file of files.filter(file => file.startsWith('scripts/') && /\.(?:ts|mjs)$/.test(file))) {
    for (const path of named(readFileSync(join(ROOT, file), 'utf8'))) {
      if (path.startsWith('deploy/') && !NOT_READ[file]?.includes(path)) files.push(path);
    }
  }
  const missing = [...new Set(files)].filter(path => !covers(suite, path));
  assert.deepEqual(missing, [], `${suite} scope misses inputs its jobs use`);
}

test('the render-worker scope covers everything its CI leg builds, imports and runs', () => {
  const job = workflow('ci.yml').jobs.package!;
  const build = job.steps?.find(step => step.name === 'Build the image (no push)')?.run ?? '';
  const image = /render-worker\) dockerfile=(\S+); context=(\S+) ;;/.exec(build);
  assert.deepEqual(image?.slice(1), ['workers/render/Dockerfile', 'workers/render']);
  const leg = (job.steps ?? []).filter(step => step.if !== "matrix.image == 'server'" && step.run !== build).map(step => step.run ?? '').join('\n');
  const qualifier = text('scripts/qualify-render-worker-image.ts');
  const inImage = [...qualifier.matchAll(/\/qualification\/work\/(tests\/[\w./-]+\.ts)/g)].map(match => match[1]!);
  assert.deepEqual(inImage, ['tests/render-worker-image.test.ts', 'tests/render-worker-tls.image.test.ts']);
  assertCovered('render_worker', [...named(leg), ...inImage, `${image![2]}/`, 'engine-pin.json']);
});

test('the deployment scope covers everything Deployment qualification lints, plans and runs', () => {
  const job = workflow('deployment-qualification.yml');
  const source = Object.values(job.jobs).map(runs).join('\n');
  const drill = text('tests/postgres-backup.test.ts');
  assert.match(drill, /join\(dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', 'deploy', 'vm', 'postgres-backup\.sh'\)/);
  const modules = (job.jobs.infrastructure?.strategy?.matrix.cloud as string[]).map(cloud => `deploy/${cloud}/`);
  assert.deepEqual(modules, ['deploy/upcloud/', 'deploy/evroc/']);
  assertCovered('deployment', [...named(source), ...modules, 'deploy/yunohost/', 'deploy/vm/postgres-backup.sh']);
});

test('the Helm scope covers everything Helm qualification renders, generates and runs', () => {
  const source = Object.values(workflow('helm-qualification.yml').jobs).map(runs).join('\n');
  assertCovered('helm', named(source));
});

test('pull requests start the full-scope workflows only through PR qualification', () => {
  const withPullRequests = readdirSync(join(ROOT, '.github/workflows')).filter(name => 'pull_request' in workflow(name).on).sort();
  assert.deepEqual(withPullRequests, ['admission-qualification.yml', 'pr-qualification.yml', 'suse-container.yml']);
  for (const name of ['ci.yml', 'deployment-qualification.yml', 'helm-qualification.yml']) {
    const { on, concurrency } = workflow(name);
    assert.deepEqual(on.push, { branches: ['main'], tags: ['v*'] }, name);
    assert.equal((on.schedule as { cron: string }[]).length, 1, name);
    assert.ok('workflow_dispatch' in on && 'workflow_call' in on, name);
    assert.match(concurrency?.group ?? '', /\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}$/, name);
  }
  assert.deepEqual(workflow('source-checks.yml').on, { push: { branches: ['main'] }, workflow_call: null });
});

test('CI leaves out only the render-worker leg, and only when the caller says so', () => {
  const ci = workflow('ci.yml');
  assert.deepEqual(ci.on.workflow_call, { inputs: { render_worker: {
    description: "'false' leaves out the render-worker image leg (pull requests only)", type: 'string', default: 'true' } } });
  assert.deepEqual(ci.jobs.package?.strategy?.matrix, {
    image: `\${{ fromJSON(inputs.render_worker == 'false' && '["server"]' || '["server", "render-worker"]') }}` });
  assert.equal(ci.jobs.package?.name, 'container image builds (${{ matrix.image }})');
  for (const [id, job] of Object.entries(ci.jobs)) if (id !== 'package') assert.equal(job.if, undefined, id);
});

test('SUSE container qualification no longer starts for documentation changes', () => {
  const { on } = workflow('suse-container.yml');
  for (const event of ['pull_request', 'push']) {
    const paths = (on[event] as { paths: string[] }).paths;
    assert.ok(paths.includes('engine-pin.json') && paths.includes('content-resolver-pin.json'), event);
    assert.ok(!paths.some(path => path.startsWith('docs') || path.includes('*-pin')), event);
  }
});

const pr = workflow('pr-qualification.yml');

test('PR qualification calls each suite and requires all of them', () => {
  assert.deepEqual(Object.keys(pr.on), ['pull_request']);
  assert.deepEqual(Object.keys(pr.jobs), ['scope', 'ci', 'source-checks', 'deployment', 'helm', 'required']);
  assert.deepEqual(Object.keys(pr.jobs.scope?.outputs ?? {}), [...SUITES]);
  assert.equal(pr.jobs.ci?.uses, './.github/workflows/ci.yml');
  assert.deepEqual(pr.jobs.ci?.with, { render_worker: '${{ needs.scope.outputs.render_worker }}' });
  assert.equal(pr.jobs['source-checks']?.uses, './.github/workflows/source-checks.yml');
  assert.equal(pr.jobs['source-checks']?.if, undefined);
  for (const suite of ['deployment', 'helm']) {
    assert.equal(pr.jobs[suite]?.uses, `./.github/workflows/${suite}-qualification.yml`);
    assert.equal(pr.jobs[suite]?.if, `needs.scope.outputs.${suite} == 'true'`);
  }
  const required = pr.jobs.required!;
  assert.equal(required.name, 'required');
  assert.equal(required.if, 'always()');
  assert.deepEqual([required.needs].flat().sort(), Object.keys(pr.jobs).filter(id => id !== 'required').sort());
});

test('the scope job runs the base commit copy of the policy and runs everything without one', () => {
  const script = runs(pr.jobs.scope!);
  assert.match(script, /base=\$\(git rev-parse HEAD\^1\)/);
  assert.match(script, /git show "\$base:scripts\/ci-change-scope\.ts" > "\$RUNNER_TEMP\/ci-change-scope\.mts"/);
  assert.match(script, /git diff --name-only --no-renames -z "\$base" HEAD \| node "\$RUNNER_TEMP\/ci-change-scope\.mts"/);
  const fallback = /printf '([^']+)'/.exec(script)?.[1]?.replaceAll('\\n', '\n');
  assert.equal(fallback, outputLines({ render_worker: true, deployment: true, helm: true }));
  assert.equal(pr.jobs.scope?.steps?.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth'], 2);
});

/** Run the `required` gate with a stand-in `needs` context. */
function gate(needs: Record<string, unknown>): { status: number | null; output: string } {
  const run = pr.jobs.required?.steps?.[0]?.run ?? '';
  const program = /python3 - <<'PY'\n([\s\S]*?)\nPY\n?$/.exec(run)?.[1];
  assert.ok(program, 'gate heredoc');
  const result = spawnSync('python3', ['-c', program], { env: { ...process.env, NEEDS: JSON.stringify(needs) }, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}
const needs = (scope: Record<string, string>, results: Record<string, string> = {}, scopeResult = 'success') => ({
  scope: { result: scopeResult, outputs: scope },
  ci: { result: results.ci ?? 'success', outputs: {} },
  'source-checks': { result: results['source-checks'] ?? 'success', outputs: {} },
  deployment: { result: results.deployment ?? (scope.deployment === 'true' ? 'success' : 'skipped'), outputs: {} },
  helm: { result: results.helm ?? (scope.helm === 'true' ? 'success' : 'skipped'), outputs: {} },
});
const all = { render_worker: 'true', deployment: 'true', helm: 'true' };
const none = { render_worker: 'false', deployment: 'false', helm: 'false' };

test('the gate passes selected suites that succeed and unselected suites that are skipped', () => {
  assert.equal(gate(needs(all)).status, 0);
  assert.equal(gate(needs(none)).status, 0);
  assert.equal(gate(needs({ ...none, helm: 'true' })).status, 0);
});

test('the gate fails on any failure, cancellation, unexpected skip or missing decision', () => {
  for (const [label, value] of Object.entries({
    'ci failed': needs(none, { ci: 'failure' }),
    'ci cancelled': needs(none, { ci: 'cancelled' }),
    'ci skipped': needs(none, { ci: 'skipped' }),
    'source checks failed': needs(none, { 'source-checks': 'failure' }),
    'selected suite skipped': needs(all, { deployment: 'skipped' }),
    'selected suite failed': needs(all, { helm: 'failure' }),
    'unselected suite ran': needs(none, { helm: 'success' }),
    'scope failed': needs({}, { deployment: 'skipped', helm: 'skipped' }, 'failure'),
    'scope gave no decision': needs({ render_worker: 'true' }, { deployment: 'skipped', helm: 'skipped' }),
    'unknown decision': needs({ ...none, deployment: 'yes' }, { deployment: 'skipped' }),
    'missing job': (({ helm: _, ...rest }) => rest)(needs(none)),
    'extra job': { ...needs(none), other: { result: 'success', outputs: {} } },
  })) {
    const result = gate(value);
    assert.notEqual(result.status, 0, label);
    assert.match(result.output, /Pull request qualification failed/, label);
  }
});
