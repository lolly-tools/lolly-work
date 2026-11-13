// SPDX-License-Identifier: MPL-2.0
/**
 * scripts/chart-release-annotations.ts, which writes the chart's release facts each
 * release: the lines it writes, that it rewrites Chart.yaml in place, and that the
 * migration facts Chart.yaml carries fit the migrations this source ships. Kept out of
 * tests/helm-chart.test.ts so a migration change does not start Helm qualification
 * (scripts/ci-change-scope.ts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { CHART_FILE, RELEASE_NOTES, releaseAnnotations, writeAnnotations } from '../scripts/chart-release-annotations.ts';
import { classifyMigrations } from '../server/src/store/migration-classifier.ts';

const text = readFileSync(CHART_FILE, 'utf8');
const chart = parse(text);
const a = chart.annotations as Record<string, string>;
const classes = /^additive=(\d+),maintenance=(\d+)$/.exec(a['lolly.tools/migration-classes'] ?? '');

test('the script writes the four release facts in Chart.yaml\'s form', () => {
  assert.deepEqual(releaseAnnotations({ version: '1.3.0', security: true, additive: 2, maintenance: 1 }), [
    ['artifacthub.io/containsSecurityUpdates', '"true"'],
    ['lolly.tools/migrations', '"3"'],
    ['lolly.tools/migration-classes', 'additive=2,maintenance=1'],
    ['lolly.tools/release-notes', 'https://github.com/lolly-tools/lolly-work/releases/tag/v1.3.0'],
  ]);
  assert.equal(RELEASE_NOTES('1.4.0-rc.1'), 'https://github.com/lolly-tools/lolly-work/releases/tag/v1.4.0-rc.1');
  assert.throws(() => releaseAnnotations({ version: '1.3', security: false, additive: 0, maintenance: 0 }), /Not a release version/);
});

test('writing Chart.yaml\'s current facts changes nothing, and missing ones go back beside the changes', () => {
  assert.ok(classes);
  const same = releaseAnnotations({ version: chart.version, security: a['artifacthub.io/containsSecurityUpdates'] === 'true',
    additive: Number(classes[1]), maintenance: Number(classes[2]) });
  assert.equal(writeAnnotations(text, same), text);
  const bare = text.split('\n').filter(line => !/^ {2}(lolly\.tools\/|artifacthub\.io\/containsSecurityUpdates)/.test(line)).join('\n');
  assert.notEqual(bare, text);
  assert.equal(writeAnnotations(bare, same), text);
  const next = parse(writeAnnotations(text, releaseAnnotations({ version: '9.9.9', security: true, additive: 1, maintenance: 0 })));
  assert.equal(next.annotations['lolly.tools/migrations'], '1');
  assert.equal(next.annotations['artifacthub.io/containsSecurityUpdates'], 'true');
  assert.equal(next.annotations['artifacthub.io/license'], 'MPL-2.0', 'other annotations stay');
  assert.equal(next.description, chart.description, 'the rest of Chart.yaml stays');
});

test('the migration facts fit the migrations this source ships', async () => {
  assert.ok(classes);
  const verdicts = await classifyMigrations(fileURLToPath(new URL('../migrations', import.meta.url)));
  assert.ok(Number(a['lolly.tools/migrations']) <= verdicts.length, 'no more migrations than the source ships');
  assert.ok(Number(classes[2]) <= verdicts.filter(v => v.class === 'maintenance').length, 'no more maintenance migrations than the classifier finds');
});
