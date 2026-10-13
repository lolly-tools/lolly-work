// SPDX-License-Identifier: MPL-2.0
/** Recode only changed frontend identities; old immutable wire bytes stay exact. */
import { copyFileSync, constants, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cloneShellFiles, readShellJson, requireShell, shellFileHash, shellManifest, writeShellJson } from './shell-update-files.ts';
import { verifyCodings } from './public-delivery-map.mjs';

const FIXED = ['index.html', 'precache.json', 'sw.js', 'portable/player.js'];
const coding = path => /\.(gz|br)$/.test(path);
const equal = (left, right) => left?.sha256 === right?.sha256 && left?.size === right?.size;

export async function prepareCodings(value) {
  requireShell(value.version === 1 && Object.keys(value).sort().join() === ['version', 'source', 'candidate', 'previous', 'scratch', 'receipt'].sort().join(), 'Closed coding request required.');
  const previous = readShellJson(value.previous.path, value.previous.sha256);
  const initial = shellManifest(value.candidate), old = new Map(previous.files.map(row => [row.path, row]));
  const changed = initial.files.filter(row => !coding(row.path) && (FIXED.includes(row.path) || row.path.startsWith('_app/')) && !equal(row, old.get(row.path)));
  requireShell(changed.length > 0 && !existsSync(value.scratch), 'Exclusive changed-frontend scratch required.');
  for (const row of initial.files) {
    if (row.path.startsWith('_app/') && old.has(row.path)) requireShell(equal(row, old.get(row.path)), 'Retained immutable wire bytes changed before compression.');
  }
  mkdirSync(value.scratch, { mode: 0o700 });
  cloneShellFiles(value.candidate, value.scratch, changed, value.scratch + '.clone.json');
  const compressionSource = join(value.source, 'scripts/build-delivery.ts');
  const before = shellFileHash(compressionSource).sha256;
  const { prepareStaticDelivery } = await import(pathToFileURL(compressionSource).href);
  prepareStaticDelivery(value.scratch);
  requireShell(shellFileHash(compressionSource).sha256 === before, 'Maintained compressor changed.');
  const compressed = new Map(shellManifest(value.scratch).files.map(row => [row.path, row]));
  const removed = [], written = [];
  for (const row of changed) {
    requireShell(equal(compressed.get(row.path), row), 'Compression changed an identity.');
    for (const suffix of ['.gz', '.br']) {
      const path = row.path + suffix, target = join(value.candidate, path);
      if (existsSync(target)) { unlinkSync(target); removed.push(path); }
      if (compressed.has(path)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(value.scratch, path), target, constants.COPYFILE_EXCL); written.push(path);
      }
    }
  }
  const physical = shellManifest(value.candidate), physicalRows = new Map(physical.files.map(row => [row.path, row]));
  for (const [path, row] of old) {
    if (!path.startsWith('_app/') && !FIXED.includes(path.replace(/\.(gz|br)$/, ''))) requireShell(equal(physicalRows.get(path), row), 'Every protected identity and immutable wire file must precede map generation.');
  }
  await verifyCodings(value.candidate, physical.files);
  const result = { version: 1, status: 'PRIVATE_FRONTEND_CODINGS_PREPARED_NOT_QUALIFIED',
    candidate: value.candidate, previous: value.previous,
    compressor: { path: compressionSource, sha256: before }, changed: changed.map(row => row.path),
    written: written.sort(), removed: removed.sort(),
    retainedImmutableWireVerified: true, allCodingsDecoded: true, runtimeQualified: false, productionMutation: false };
  writeShellJson(value.receipt, result); return result;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [input, sha] = process.argv.slice(2);
  await prepareCodings(readShellJson(input, sha));
}
