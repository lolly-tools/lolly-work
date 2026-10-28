#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * Which Lolly commit Work should pin, and whether a re-pin is due.
 *
 * Work builds from its own main plus one Lolly commit, recorded four times: the
 * vendor/lolly gitlink, engine-pin.json (generatedFrom), docs-pin.json (commit)
 * and content-resolver-pin.json (commit). The scheduled re-pin
 * (.github/workflows/lolly-repin.yml) moves all four to the newest Lolly main
 * commit that qualified: its CI push run on main concluded success AND the run's
 * `qualification` job (the aggregate that refuses any failed, cancelled or
 * unreviewed skipped job) succeeded in the latest attempt.
 *
 *   node scripts/lolly-repin-target.ts                 # print target=, current=, due=, ... for $GITHUB_OUTPUT
 *   node scripts/lolly-repin-target.ts --expect=<sha>  # exit 1 unless all four pins name <sha>
 *
 * A re-pin is due when the target is ahead of the gitlink, or when the gitlink
 * already names the target but one of the JSON pins does not. A target that is
 * behind or beside the gitlink (someone pinned a newer commit by hand) is never
 * proposed: the schedule moves the pin forward only.
 *
 * Reads the public Lolly repository through the GitHub REST API, with GH_TOKEN
 * when set and anonymously otherwise.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LOLLY_REPOSITORY = 'lolly-tools/lolly';
/** How many recent successful main push runs to inspect before giving up. */
export const RUN_WINDOW = 30;
const SHA = /^[a-f0-9]{40}$/;

export interface Pins {
  gitlink: string;
  engine: string;
  docs: string;
  resolver: string;
}

export interface Run {
  id: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  path: string;
  html_url: string;
}

export interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}

export type Comparison = 'ahead' | 'identical' | 'behind' | 'diverged';

export interface Decision {
  due: boolean;
  reason: string;
}

/** The four places Work records its Lolly commit. */
export function readPins(root = ROOT): Pins {
  const json = (file: string) => JSON.parse(readFileSync(join(root, file), 'utf8')) as Record<string, unknown>;
  // The index, not HEAD: the workflow checks a staged pointer before it commits.
  const entry = execFileSync('git', ['-C', root, 'ls-files', '--stage', '--', 'vendor/lolly'], { encoding: 'utf8' }).trim();
  const gitlink = /^160000 ([a-f0-9]{40}) 0\tvendor\/lolly$/.exec(entry)?.[1];
  if (!gitlink) throw new Error(`vendor/lolly is not a submodule gitlink in the index: ${entry || '(missing)'}`);
  const pins = {
    gitlink,
    engine: String(json('engine-pin.json').generatedFrom),
    docs: String(json('docs-pin.json').commit),
    resolver: String(json('content-resolver-pin.json').commit),
  };
  for (const [name, sha] of Object.entries(pins)) if (!SHA.test(sha)) throw new Error(`${name} pin is not a full commit SHA: ${sha}`);
  return pins;
}

/** True only for a run this workflow may trust: a completed, successful push run of ci.yml on main. */
export function isQualifyingRun(run: Run): boolean {
  return run.event === 'push' && run.head_branch === 'main' && run.path === '.github/workflows/ci.yml'
    && run.status === 'completed' && run.conclusion === 'success' && SHA.test(run.head_sha);
}

/** The latest attempt's `qualification` job must exist and have succeeded. */
export function qualificationPassed(jobs: Job[]): boolean {
  const matches = jobs.filter(job => job.name === 'qualification');
  return matches.length === 1 && matches[0]!.status === 'completed' && matches[0]!.conclusion === 'success';
}

/** Walk runs newest first and return the first that qualifies, or null. */
export async function selectQualifiedRun(runs: Run[], jobsOf: (run: Run) => Promise<Job[]>): Promise<Run | null> {
  for (const run of runs) {
    if (!isQualifyingRun(run)) continue;
    if (qualificationPassed(await jobsOf(run))) return run;
  }
  return null;
}

/** Whether to re-pin from `pins` to `target`, given how the target compares with the gitlink. */
export function decide(pins: Pins, target: string, comparison: Comparison): Decision {
  const stale = (['engine', 'docs', 'resolver'] as const).filter(name => pins[name] !== target);
  if (comparison === 'identical') {
    return stale.length
      ? { due: true, reason: `vendor/lolly already names ${target}, but ${stale.join(', ')} pin(s) do not` }
      : { due: false, reason: `Work already pins ${target}, the newest qualified Lolly main commit` };
  }
  if (comparison === 'ahead') return { due: true, reason: `${target} is ahead of the pinned ${pins.gitlink}` };
  return { due: false, reason: `${target} is ${comparison} the pinned ${pins.gitlink}; the schedule only moves the pin forward` };
}

async function api<T>(path: string): Promise<T> {
  const token = process.env.GH_TOKEN;
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  let res = await fetch(`${base}${path}`, { headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers });
  // Every read here is public. A token scoped to Work alone may be refused for
  // another repository, so ask again without it (the few calls fit the anonymous limit).
  if (token && (res.status === 401 || res.status === 403)) res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${path}: ${res.status} ${res.statusText}`);
  return await res.json() as T;
}

async function main(): Promise<void> {
  const expect = process.argv.slice(2).find(arg => arg.startsWith('--expect='))?.slice('--expect='.length);
  const pins = readPins();
  if (expect !== undefined) {
    const wrong = Object.entries(pins).filter(([, sha]) => sha !== expect);
    if (!SHA.test(expect) || wrong.length) {
      throw new Error(`Pins disagree with ${expect}: ${wrong.map(([name, sha]) => `${name}=${sha}`).join(', ') || 'invalid SHA'}`);
    }
    console.error(`All four pins name ${expect}.`);
    return;
  }
  const { workflow_runs: runs } = await api<{ workflow_runs: Run[] }>(
    `/repos/${LOLLY_REPOSITORY}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=${RUN_WINDOW}`);
  const run = await selectQualifiedRun(runs, async candidate =>
    (await api<{ jobs: Job[] }>(`/repos/${LOLLY_REPOSITORY}/actions/runs/${candidate.id}/jobs?filter=latest&per_page=100`)).jobs);
  if (!run) throw new Error(`None of the last ${runs.length} successful Lolly main push runs has a green qualification job.`);
  const target = run.head_sha;
  const { status } = await api<{ status: Comparison }>(`/repos/${LOLLY_REPOSITORY}/compare/${pins.gitlink}...${target}`);
  const decision = decide(pins, target, status);
  console.error(decision.reason);
  console.log([
    `target=${target}`,
    `run_url=${run.html_url}`,
    `current=${pins.gitlink}`,
    `engine_pin=${pins.engine}`,
    `due=${decision.due}`,
    `reason=${decision.reason}`,
  ].join('\n'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`::error title=Lolly re-pin target::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
