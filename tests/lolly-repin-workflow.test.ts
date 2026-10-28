// SPDX-License-Identifier: MPL-2.0
/**
 * The scheduled Lolly re-pin (.github/workflows/lolly-repin.yml) and the target
 * choice behind it (scripts/lolly-repin-target.ts), without calling GitHub,
 * cloning Lolly or pushing anything.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { decide, isQualifyingRun, qualificationPassed, readPins, selectQualifiedRun, type Job, type Pins, type Run } from '../scripts/lolly-repin-target.ts';

interface Step { id?: string; name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> }
interface WorkflowJob { name: string; if?: string; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] }
interface Workflow { on: Record<string, unknown>; permissions: Record<string, string>; concurrency: { group: string; 'cancel-in-progress': boolean }; jobs: Record<string, WorkflowJob> }

const text = readFileSync(new URL('../.github/workflows/lolly-repin.yml', import.meta.url), 'utf8');
const workflow = parse(text) as Workflow;
const job = workflow.jobs.repin!;
const step = (name: string): Step => {
  const found = job.steps.find(candidate => candidate.name === name || candidate.id === name);
  assert.ok(found, `missing step ${name}`);
  return found;
};

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const run = (id: number, sha: string, extra: Partial<Run> = {}): Run => ({
  id, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success',
  path: '.github/workflows/ci.yml', html_url: `https://github.com/lolly-tools/lolly/actions/runs/${id}`, ...extra,
});
const ciJob = (name: string, conclusion: string | null, status = 'completed'): Job => ({ name, status, conclusion });

test('runs on a schedule and by hand, never on a pull request, one run at a time', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.ok(Array.isArray(workflow.on.schedule) && (workflow.on.schedule as Array<{ cron: string }>)[0]?.cron);
  assert.deepEqual(workflow.concurrency, { group: 'lolly-repin', 'cancel-in-progress': false });
  assert.equal(job.if, "github.repository == 'lolly-tools/lolly-work'");
  assert.equal(job.env?.BRANCH, 'chore/repin-lolly-auto');
});

test('GITHUB_TOKEN only reads; every write goes through the App token, scoped to Work', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read' });
  const app = step('app');
  assert.match(app.uses ?? '', /^actions\/create-github-app-token@[a-f0-9]{40}$/);
  assert.deepEqual(app.with, {
    'client-id': '${{ secrets.LOLLY_REPIN_APP_CLIENT_ID }}',
    'private-key': '${{ secrets.LOLLY_REPIN_APP_PRIVATE_KEY }}',
    repositories: 'lolly-work',
    'permission-contents': 'write',
    'permission-pull-requests': 'write',
  });
  const propose = step('Open, refresh or close the pull request');
  assert.equal(propose.env?.GH_TOKEN, '${{ steps.app.outputs.token }}');
  assert.match(propose.run ?? '', /gh pr create .*--head "\$BRANCH"/);
  assert.match(propose.run ?? '', /push --force "https:\/\/github\.com\/\$GITHUB_REPOSITORY\.git" "HEAD:refs\/heads\/\$BRANCH"/);
  assert.doesNotMatch(propose.run ?? '', /refs\/heads\/main/, 'never pushes main');
  assert.doesNotMatch(text, /gh pr merge|secrets\.GITHUB_TOKEN/);
  for (const candidate of job.steps.filter(s => s.uses?.startsWith('actions/checkout@'))) {
    assert.equal(candidate.with?.['persist-credentials'], false, 'the checkout keeps no token in .git/config');
  }
});

test('missing App secrets stop the run first, naming what to add', () => {
  assert.equal(job.steps[0]?.name, 'Require the re-pin App secrets');
  const check = step('Require the re-pin App secrets');
  const attempt = (env: Record<string, string>) => spawnSync('bash', ['-e', '-c', check.run ?? ''], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  const none = attempt({ CLIENT_ID: '', PRIVATE_KEY: '' });
  assert.equal(none.status, 1);
  assert.match(none.stdout, /::error title=Re-pin App secrets missing::Add the repository secret\(s\) LOLLY_REPIN_APP_CLIENT_ID LOLLY_REPIN_APP_PRIVATE_KEY\./);
  assert.match(none.stdout, /GITHUB_TOKEN does not start PR qualification/);
  const keyOnly = attempt({ CLIENT_ID: '', PRIVATE_KEY: 'pem' });
  assert.equal(keyOnly.status, 1);
  assert.match(keyOnly.stdout, /secret\(s\) LOLLY_REPIN_APP_CLIENT_ID\./);
  assert.equal(attempt({ CLIENT_ID: 'Iv1.x', PRIVATE_KEY: 'pem' }).status, 0);
});

test('re-pins with the existing scripts, then verifies every pin against the target', () => {
  const repin = step('Re-pin with the existing scripts').run ?? '';
  const order = ['sync-docs-bundle.ts --source=vendor/lolly --commit="$TARGET"', 'vendor-content-resolver.ts --write', 'repin-engine.ts --apply', 'git add vendor/lolly']
    .map(fragment => repin.indexOf(fragment));
  assert.ok(order.every(position => position >= 0), repin);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'docs first, while the Lolly checkout is still clean');
  // pack-engine.ts runs pnpm pack, which cannot resolve workspace: references in an uninstalled checkout.
  assert.match(step('Check out Lolly at the target in vendor/lolly').run ?? '',
    /pnpm -C vendor\/lolly install --frozen-lockfile --ignore-scripts --filter @lolly\/engine --filter @lolly-tools\/core/);
  const verify = step('Verify the pins').run ?? '';
  for (const check of ['verify-engine-pin.ts', 'verify-docs-pin.ts', 'node scripts/vendor-content-resolver.ts\n', '--check', 'lolly-repin-target.ts --expect="$TARGET"']) {
    assert.ok(verify.includes(check), `verification runs ${check.trim()}`);
  }
  for (const name of ['Install', 'Check out Lolly at the target in vendor/lolly', 'Re-pin with the existing scripts', 'Verify the pins']) {
    assert.equal(step(name).if, "steps.target.outputs.due == 'true' && steps.proposal.outputs.current != 'true'", name);
  }
});

test('the newest successful main push run with a green qualification job is the target', async () => {
  assert.equal(isQualifyingRun(run(1, A)), true);
  for (const extra of [{ event: 'pull_request' }, { head_branch: 'feature' }, { conclusion: 'failure' }, { status: 'in_progress' }, { path: '.github/workflows/other.yml' }]) {
    assert.equal(isQualifyingRun(run(1, A, extra)), false, JSON.stringify(extra));
  }
  assert.equal(qualificationPassed([ciJob('test', 'success'), ciJob('qualification', 'success')]), true);
  assert.equal(qualificationPassed([ciJob('qualification', 'failure')]), false);
  assert.equal(qualificationPassed([ciJob('qualification', 'skipped')]), false);
  assert.equal(qualificationPassed([ciJob('test', 'success')]), false, 'a run without the aggregate does not qualify');

  const jobs: Record<number, Job[]> = { 3: [ciJob('qualification', 'failure')], 2: [ciJob('qualification', 'success')], 1: [ciJob('qualification', 'success')] };
  const asked: number[] = [];
  const chosen = await selectQualifiedRun([run(4, C, { head_branch: 'release' }), run(3, C), run(2, B), run(1, A)], async candidate => { asked.push(candidate.id); return jobs[candidate.id] ?? []; });
  assert.equal(chosen?.head_sha, B);
  assert.deepEqual(asked, [3, 2], 'stops at the first qualified run and never asks about a run that cannot qualify');
  assert.equal(await selectQualifiedRun([run(3, C)], async () => jobs[3]!), null);
});

test('a re-pin is due only to move forward, or to bring a lagging JSON pin up to the gitlink', () => {
  const pins: Pins = { gitlink: A, engine: A, docs: A, resolver: A };
  assert.deepEqual(decide(pins, B, 'ahead'), { due: true, reason: `${B} is ahead of the pinned ${A}` });
  assert.equal(decide(pins, A, 'identical').due, false);
  assert.equal(decide({ ...pins, docs: C }, A, 'identical').due, true);
  assert.match(decide({ ...pins, docs: C }, A, 'identical').reason, /but docs pin\(s\) do not/);
  for (const comparison of ['behind', 'diverged'] as const) {
    const decision = decide(pins, B, comparison);
    assert.equal(decision.due, false, comparison);
    assert.match(decision.reason, /only moves the pin forward/);
  }
});

test('reads the four pins Work records', () => {
  const pins = readPins();
  for (const [name, sha] of Object.entries(pins)) assert.match(sha, /^[a-f0-9]{40}$/, name);
});
