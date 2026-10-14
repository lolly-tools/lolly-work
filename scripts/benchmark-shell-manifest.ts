#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/** Measure a fresh, read-only shell inventory against its saved manifest. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readShellJson, sha256, shellFileHash } from './shell-update-files.ts';
import type { ShellManifest } from './shell-update-files.ts';

const [tree, manifest, module] = process.argv.slice(2);
if (!tree || !manifest || process.argv.length > 5 || tree === '--help') {
  console.log('Usage: node scripts/benchmark-shell-manifest.ts TREE SAVED_MANIFEST [HELPER_MODULE]');
  process.exit(tree === '--help' ? 0 : 1);
}
const helperPath = resolve(module ?? fileURLToPath(new URL('./shell-update-files.ts', import.meta.url)));
const helperSha256 = sha256(readFileSync(helperPath));
const helper = await import(pathToFileURL(helperPath).href) as typeof import('./shell-update-files.ts');
const root = resolve(tree), manifestPath = resolve(manifest), reference = shellFileHash(manifestPath);
const expected = readShellJson(manifestPath, reference.sha256) as ShellManifest;
const before = process.resourceUsage(), started = performance.now();
const actual = helper.shellManifest(root);
const milliseconds = performance.now() - started, after = process.resourceUsage();
assert.deepEqual(actual, expected);
const manifestSha256 = sha256(`${JSON.stringify(actual, null, 2)}\n`);
assert.equal(manifestSha256, reference.sha256, 'Generated manifest bytes must match the saved receipt.');
assert.equal(shellFileHash(manifestPath).sha256, reference.sha256);
assert.equal(sha256(readFileSync(helperPath)), helperSha256);
console.log(JSON.stringify({ version: 1, scope: 'Fresh manifest traversal and byte hashing; excludes build, cloning, retention and deployment.',
  node: process.version, platform: process.platform, architecture: process.arch, cpu: cpus()[0]?.model,
  helper: { path: helperPath, sha256: helperSha256 }, root, expectedManifest: { path: manifestPath, sha256: reference.sha256 },
  files: actual.files.length, totalBytes: actual.totalBytes, milliseconds,
  cpuMicroseconds: { user: after.userCPUTime - before.userCPUTime, system: after.systemCPUTime - before.systemCPUTime },
  maxRssKiB: after.maxRSS, exactManifestBytesMatch: true, manifestSha256, shellId: helper.shellId(actual) }, null, 2));
