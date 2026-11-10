// SPDX-License-Identifier: MPL-2.0
/**
 * The release facts the chart carries in its annotations, for Artifact Hub, Rancher and
 * Lolly Work's own release notice (server/src/updates/feed.ts):
 *
 *   artifacthub.io/containsSecurityUpdates  "true" with --security, otherwise "false"
 *   lolly.tools/migrations                  migration files added since the previous release
 *   lolly.tools/migration-classes           additive=<n>,maintenance=<n>, the classifier's verdicts
 *   lolly.tools/release-notes               https://github.com/lolly-tools/lolly-work/releases/tag/v<version>
 *
 *   node scripts/chart-release-annotations.ts --since v1.2.0              print them for the chart's version
 *   node scripts/chart-release-annotations.ts --since v1.2.0 --write      write them into deploy/helm/Chart.yaml
 *   node scripts/chart-release-annotations.ts --since v1.2.0 --security   the release fixes a vulnerability
 *
 * --since names the previous release's tag. Migration files are counted from git (files
 * added under migrations/ between that tag and HEAD) and classified with the same
 * allowlist as `pnpm run migrate:classify`. artifacthub.io/changes stays hand-written.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { classifyMigrations } from '../server/src/store/migration-classifier.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CHART_FILE = join(ROOT, 'deploy/helm/Chart.yaml');
export const RELEASE_NOTES = (version: string) => `https://github.com/lolly-tools/lolly-work/releases/tag/v${version}`;

export interface ReleaseFacts { version: string; security: boolean; additive: number; maintenance: number }

/** The annotation lines, in the order Chart.yaml keeps them. */
export function releaseAnnotations(facts: ReleaseFacts): Array<[string, string]> {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(facts.version)) throw new Error(`Not a release version: ${facts.version}`);
  return [
    ['artifacthub.io/containsSecurityUpdates', `"${facts.security}"`],
    ['lolly.tools/migrations', `"${facts.additive + facts.maintenance}"`],
    ['lolly.tools/migration-classes', `additive=${facts.additive},maintenance=${facts.maintenance}`],
    ['lolly.tools/release-notes', RELEASE_NOTES(facts.version)],
  ];
}

/** Chart.yaml with these annotations set: each existing line replaced in place, a
 *  missing one added before artifacthub.io/changes. Everything else is kept as written. */
export function writeAnnotations(text: string, annotations: Array<[string, string]>): string {
  let out = text;
  for (const [key, value] of annotations) {
    const line = `  ${key}: ${value}`;
    const existing = new RegExp(`^  ${key.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:.*$`, 'm');
    if (existing.test(out)) out = out.replace(existing, line);
    else if (/^ {2}artifacthub\.io\/changes:/m.test(out)) out = out.replace(/^ {2}artifacthub\.io\/changes:/m, `${line}\n  artifacthub.io/changes:`);
    else throw new Error('Chart.yaml has no artifacthub.io/changes annotation to place the release facts beside');
  }
  return out;
}

/** Migration files added between the previous release's tag and HEAD. */
export function addedMigrations(since: string, cwd = ROOT): string[] {
  if (!/^[A-Za-z0-9._/-]+$/.test(since)) throw new Error('--since must be a tag such as v1.2.0');
  execFileSync('git', ['rev-parse', '--verify', `${since}^{commit}`], { cwd, stdio: 'pipe' });
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=A', since, 'HEAD', '--', 'migrations/'], { cwd, encoding: 'utf8' })
    .split('\n').filter(path => path.endsWith('.sql')).map(path => basename(path)).sort();
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { since: { type: 'string' }, write: { type: 'boolean', default: false }, security: { type: 'boolean', default: false } }, strict: true });
  if (!values.since) throw new Error('Usage: node scripts/chart-release-annotations.ts --since <previous release tag> [--security] [--write]');
  const chart = readFileSync(CHART_FILE, 'utf8');
  const version = String(parse(chart).version);
  const added = addedMigrations(values.since);
  const verdicts = added.length ? await classifyMigrations(join(ROOT, 'migrations'), added) : [];
  const maintenance = verdicts.filter(v => v.class === 'maintenance').length;
  const annotations = releaseAnnotations({ version, security: values.security, additive: verdicts.length - maintenance, maintenance });
  if (values.write) {
    writeFileSync(CHART_FILE, writeAnnotations(chart, annotations));
    console.log(`Chart.yaml ${version}: ${added.length} migrations since ${values.since} (${verdicts.length - maintenance} additive, ${maintenance} maintenance).`);
  } else {
    for (const [key, value] of annotations) console.log(`  ${key}: ${value}`);
  }
}
