#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/** Compare manifest lookup costs without reading assets or preparing a release. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { changedAllowed, shellUpdateDelta } from './prepare-shell-update.ts';
import { readShellJson, requireShell, sha256 } from './shell-update-files.ts';
import type { ShellManifest } from './shell-update-files.ts';

// Preserve the former comparison for repeatable output and timing checks.
function repeatedScanDelta(candidate: ShellManifest, previous: ShellManifest) {
  const old = new Map(previous.files.map(file => [file.path, file]));
  const files = candidate.files.filter(file => { const prior = old.get(file.path); return prior?.size !== file.size || prior.sha256 !== file.sha256; });
  requireShell(files.every(file => changedAllowed(file.path)), 'A non-shell generated resource changed; use a broader release.');
  for (const file of previous.files) if (!changedAllowed(file.path)) {
    requireShell(candidate.files.some(row => row.path === file.path && row.sha256 === file.sha256 && row.size === file.size), 'A protected static resource was removed.');
  }
  return { version: 1 as const, files, totalBytes: files.reduce((n, file) => n + file.size, 0) };
}
function input(path: string) {
  const absolute = resolve(path), bytesSha256 = sha256(readFileSync(absolute));
  const manifest = readShellJson(absolute, bytesSha256) as ShellManifest;
  requireShell(manifest?.version === 1 && Array.isArray(manifest.files) && Number.isSafeInteger(manifest.totalBytes), 'Complete manifest required.');
  requireShell(manifest.files.every(file => typeof file.path === 'string' && Number.isSafeInteger(file.size) && file.size >= 0
    && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)), 'Exact manifest entries required.');
  return { path: absolute, bytesSha256, manifest };
}
function measure(operation: () => ShellManifest) {
  const started = performance.now(), result = operation();
  return { milliseconds: performance.now() - started, result };
}
function summary(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return { samplesMs: samples, medianMs: sorted[Math.floor(sorted.length / 2)]! };
}

const [previousPath, ...candidatePaths] = process.argv.slice(2);
if (!previousPath || candidatePaths.length === 0 || previousPath === '--help') {
  console.log('Usage: node scripts/benchmark-shell-update-delta.ts PREVIOUS_MANIFEST CANDIDATE_MANIFEST [CANDIDATE_MANIFEST ...]');
  process.exit(previousPath === '--help' ? 0 : 1);
}
const previous = input(previousPath), results = [];
for (const path of candidatePaths) {
  const candidate = input(path), repeatedScan: number[] = [], indexed: number[] = [];
  let delta: ShellManifest | undefined;
  for (let round = 0; round < 3; round++) {
    const operations = [() => measure(() => repeatedScanDelta(candidate.manifest, previous.manifest)), () => measure(() => shellUpdateDelta(candidate.manifest, previous.manifest))];
    const samples = round % 2 ? [operations[1]!(), operations[0]!()].toReversed() : operations.map(operation => operation());
    assert.deepEqual(samples[0]!.result, samples[1]!.result);
    repeatedScan.push(samples[0]!.milliseconds); indexed.push(samples[1]!.milliseconds); delta = samples[1]!.result;
  }
  assert.equal(sha256(readFileSync(candidate.path)), candidate.bytesSha256);
  results.push({ candidate: { path: candidate.path, sha256: candidate.bytesSha256, files: candidate.manifest.files.length },
    repeatedScan: summary(repeatedScan), indexed: summary(indexed), exactOutputMatch: true,
    delta: { files: delta!.files.length, totalBytes: delta!.totalBytes, sha256: sha256(JSON.stringify(delta)) } });
}
assert.equal(sha256(readFileSync(previous.path)), previous.bytesSha256);
console.log(JSON.stringify({ version: 1, scope: 'In-memory manifest delta only; excludes parsing, asset hashing, build, retention and deployment.',
  node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model,
  previous: { path: previous.path, sha256: previous.bytesSha256, files: previous.manifest.files.length }, results }, null, 2));
