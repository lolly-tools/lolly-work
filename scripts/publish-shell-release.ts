// SPDX-License-Identifier: MPL-2.0
/** Local filesystem publication only; target and release qualification stay external. */
import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { publicStaticDeliveryClass } from '@lolly-tools/core/delivery-v1';
import { canonicalDirectory, readShellJson, requireDisk, shellFileCustody, shellManifest } from './shell-update-files.ts';
import { parseReleaseManifest, readShellPointer, readShellRelease, releaseDirectory, releaseHash, releaseJson, releaseNeed, type ShellPointer } from '../server/src/lib/shell-release.ts';
import { checkShellDist } from '../server/src/lib/shell-dist.ts';

function locked<T>(root: string, action: () => T): T {
  releaseDirectory(root); const lock = join(root, '.publication-lock'); mkdirSync(lock, { mode: 0o700 });
  try { return action(); } finally { rmdirSync(lock); }
}
function current(root: string, expected: string): ReturnType<typeof readShellPointer> | null {
  releaseNeed(expected === 'absent' || /^[a-f0-9]{64}$/.test(expected), 'Expected pointer digest required');
  let present = true;
  try { lstatSync(join(root, 'current.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; present = false; }
  if (!present) { releaseNeed(expected === 'absent', 'Current pointer disappeared'); return null; }
  const held = readShellPointer(root); releaseNeed(held.sha256 === expected, 'Current pointer changed'); return held;
}
function syncDirectory(path: string): void { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function seal(path: string): void {
  for (const name of readdirSync(path)) { const full = join(path, name), stat = lstatSync(full); releaseNeed(!stat.isSymbolicLink(), 'Release symlink refused');
    if (stat.isDirectory()) seal(full); else { releaseNeed(stat.isFile(), 'Release special file refused'); chmodSync(full, 0o444); } }
  chmodSync(path, 0o555);
}
function copyHeld(source: string, destination: string, expected: { size: number; sha256: string }): void {
  const before = shellFileCustody(source); releaseNeed(before.size === expected.size && before.sha256 === expected.sha256, 'Source file changed');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const bytes = Buffer.alloc(1024 * 1024); let total = 0;
    for (let count; (count = readSync(input, bytes, 0, bytes.length, null)) > 0;) {
      total += count; releaseNeed(total <= expected.size, 'Source file grew');
      for (let offset = 0; offset < count;) offset += writeSync(output, bytes, offset, count - offset);
    }
    releaseNeed(total === expected.size, 'Source file shrank'); fsyncSync(output);
  } finally { closeSync(input); closeSync(output); }
  releaseNeed(shellFileCustody(source).stamp === before.stamp, 'Source file identity changed');
}
export function stageRelease(root: string, source: string, manifestPath: string, manifestSha256: string): { release: string; files: number; bytes: number } {
  return locked(root, () => {
    canonicalDirectory(source); releaseNeed(/^[a-f0-9]{64}$/.test(manifestSha256), 'Manifest digest required');
    releaseNeed(source !== root && !source.startsWith(root + '/') && !root.startsWith(source + '/'), 'Candidate and release store must be separate trees');
    const manifest = parseReleaseManifest(readShellJson(manifestPath, manifestSha256));
    releaseNeed(releaseJson(shellManifest(source)) === releaseJson(manifest), 'Complete candidate inventory differs');
    const governance = checkShellDist(source); releaseNeed(governance.present && governance.hasOrgConfig, 'Candidate lacks governed shell boot');
    const bytes = releaseJson(manifest), id = releaseHash(bytes), releases = join(root, 'releases');
    if (!existsSync(releases)) mkdirSync(releases, { mode: 0o755 }); releaseDirectory(releases);
    releaseNeed(readdirSync(releases).length < 10, 'Release storage bound reached; explicitly retire unused releases first');
    releaseNeed(!existsSync(join(releases, id)), 'Release already exists; immutable releases are never overwritten');
    requireDisk(root, manifest.totalBytes);
    const pending = join(root, '.staging-' + randomUUID()); mkdirSync(pending, { mode: 0o700 });
    const files = join(pending, 'files'); mkdirSync(files, { mode: 0o755 });
    for (const file of manifest.files) copyHeld(join(source, file.path), join(files, file.path), file);
    releaseNeed(releaseJson(shellManifest(files)) === bytes && releaseJson(shellManifest(source)) === bytes, 'Copied release or held source changed');
    const manifestFd = openSync(join(pending, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o444);
    try { writeFileSync(manifestFd, bytes); fsyncSync(manifestFd); } finally { closeSync(manifestFd); }
    const published = join(releases, id); renameSync(pending, published); seal(published); syncDirectory(published); syncDirectory(releases);
    return { release: id, files: manifest.files.length, bytes: manifest.totalBytes };
  });
}
/** Overlapping immutable URLs must retain their bytes, including after rollback. */
function compatible(root: string, ids: string[]): void {
  const hashes = new Map<string, string>();
  for (const id of ids) for (const file of readShellRelease(root, id).manifest.files) {
    if (publicStaticDeliveryClass('/' + file.path) !== 'public-immutable') continue;
    const prior = hashes.get(file.path), content = `${file.size}:${file.sha256}`;
    releaseNeed(!prior || prior === content, 'Immutable URL was reused with different bytes'); hashes.set(file.path, content);
  }
}
function verifyRelease(root: string, id: string): void {
  const release = readShellRelease(root, id);
  releaseNeed(releaseJson(shellManifest(release.directory)) === releaseJson(release.manifest), 'Complete staged release inventory differs');
  const directories = new Set<string>();
  for (const file of release.manifest.files) {
    const full = join(release.directory, file.path); releaseNeed(!(lstatSync(full).mode & 0o222), 'Staged file is writable');
    let parent = dirname(full);
    while (!directories.has(parent)) { releaseDirectory(parent, true); directories.add(parent); if (parent === release.directory) break; parent = dirname(parent); }
  }
}
function publishPointer(root: string, expected: string, next: ShellPointer): { pointer: ShellPointer; sha256: string } {
  const bytes = releaseJson(next), temporary = join(root, '.pointer-' + randomUUID());
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  current(root, expected); renameSync(temporary, join(root, 'current.json')); syncDirectory(root);
  return readShellPointer(root);
}
export function activateRelease(root: string, id: string, expected: string, graceSeconds = 0, now = Date.now()): ReturnType<typeof readShellPointer> {
  return locked(root, () => {
    releaseNeed(Number.isSafeInteger(graceSeconds) && graceSeconds >= 0 && graceSeconds <= 86400, 'Grace must be 0..86400 seconds');
    const held = current(root, expected), previous = held?.pointer.current ?? null;
    releaseNeed(id !== previous, 'Release is already current'); verifyRelease(root, id);
    const retained = (held?.pointer.retained ?? []).filter(row => row.expiresAt > now && row.id !== id && row.id !== previous);
    if (graceSeconds && held?.pointer.previous && held.pointer.previous !== id) retained.push({ id: held.pointer.previous, expiresAt: now + graceSeconds * 1000 });
    releaseNeed(retained.length <= 6, 'Lazy asset grace retention is full; wait for expiry or reduce future grace');
    const pointer: ShellPointer = { version: 1, revision: (held?.pointer.revision ?? 0) + 1, current: id, previous, retained };
    compatible(root, [id, ...(previous ? [previous] : []), ...retained.map(row => row.id)]);
    return publishPointer(root, expected, pointer);
  });
}
export function rollbackRelease(root: string, expected: string): ReturnType<typeof readShellPointer> {
  return locked(root, () => {
    const held = current(root, expected); releaseNeed(held?.pointer.previous, 'No previous release to restore');
    verifyRelease(root, held.pointer.previous);
    const pointer = { ...held.pointer, revision: held.pointer.revision + 1, current: held.pointer.previous, previous: held.pointer.current };
    compatible(root, [pointer.current, pointer.previous]); return publishPointer(root, expected, pointer);
  });
}
export function retireRelease(root: string, id: string, expected: string, now = Date.now()): void {
  locked(root, () => {
    const held = current(root, expected); releaseNeed(held, 'An accepted current release is required before retirement');
    releaseNeed(id !== held.pointer.current && id !== held.pointer.previous && !held.pointer.retained.some(row => row.id === id && row.expiresAt > now), 'Current, rollback or grace release cannot be retired');
    const release = readShellRelease(root, id), directory = dirname(release.directory);
    releaseNeed(releaseJson(shellManifest(release.directory)) === releaseJson(release.manifest), 'Retirement inventory changed');
    current(root, expected);
    const unseal = (path: string): void => { chmodSync(path, 0o755); for (const name of readdirSync(path)) { const full = join(path, name); if (lstatSync(full).isDirectory()) unseal(full); } };
    unseal(directory); rmSync(directory, { recursive: true }); syncDirectory(join(root, 'releases'));
  });
}
export function main(argv = process.argv.slice(2)): void {
  const { values } = parseArgs({ args: argv, options: { action: { type: 'string' }, root: { type: 'string' }, source: { type: 'string' }, manifest: { type: 'string' }, 'manifest-sha256': { type: 'string' }, release: { type: 'string' }, 'expected-pointer': { type: 'string' }, 'grace-seconds': { type: 'string' } }, strict: true, allowPositionals: false });
  releaseNeed(values.root && values.action, '--root and --action are required'); let result: unknown;
  if (values.action === 'stage') { releaseNeed(values.source && values.manifest && values['manifest-sha256'], 'Stage requires source and original manifest digest'); result = stageRelease(resolve(values.root), resolve(values.source), resolve(values.manifest), values['manifest-sha256']); }
  else { releaseNeed(values['expected-pointer'], 'Publication requires the reviewed expected pointer digest');
    if (values.action === 'rollback') result = rollbackRelease(resolve(values.root), values['expected-pointer']);
    else { releaseNeed(values.release, '--release is required');
      if (values.action === 'activate') result = activateRelease(resolve(values.root), values.release, values['expected-pointer'], Number(values['grace-seconds'] ?? 0));
      else { releaseNeed(values.action === 'retire', 'Unknown publication action'); retireRelease(resolve(values.root), values.release, values['expected-pointer']); result = { retired: values.release }; } }
  }
  console.log(JSON.stringify({ version: 1, status: 'LOCAL_SHELL_RELEASE_OPERATION_COMPLETED', action: values.action, result, liveTargetQualificationClaimed: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error('Shell release refused: ' + (error as Error).message); process.exitCode = 1; }
}
