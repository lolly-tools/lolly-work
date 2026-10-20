// SPDX-License-Identifier: MPL-2.0
/** Immutable shell releases selected by an operator-owned atomic pointer. */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { checkShellDist } from './shell-dist.ts';

export interface ReleaseFile { path: string; size: number; sha256: string }
export interface ReleaseManifest { version: 1; files: ReleaseFile[]; totalBytes: number }
export interface ShellPointer { version: 1; revision: number; current: string; previous: string | null; retained: Array<{ id: string; expiresAt: number }> }
export interface ShellRelease { id: string; directory: string; manifest: ReleaseManifest }
export const releaseHash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
export const releaseJson = (value: unknown): string => JSON.stringify(value) + '\n';
export function releaseNeed(ok: unknown, message: string): asserts ok {
  if (!ok) throw Object.assign(new Error(message), { status: 503 });
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function keys(value: unknown, names: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === names.sort().join(',');
}
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  releaseNeed(keys(value, ['version', 'files', 'totalBytes']) && value.version === 1 && Array.isArray(value.files)
    && value.files.length > 0 && value.files.length <= 130_000, 'Invalid shell release manifest');
  let total = 0, previous = '';
  for (const row of value.files) {
    releaseNeed(keys(row, ['path', 'size', 'sha256']) && typeof row.path === 'string' && row.path > previous
      && Buffer.byteLength(row.path) <= 1024 && !/[\\\u0000-\u001f\u007f]/.test(row.path)
      && row.path.split('/').length <= 64 && row.path.split('/').every(part => part && part !== '.' && part !== '..')
      && Number.isSafeInteger(row.size) && Number(row.size) >= 0 && hash(row.sha256), 'Invalid shell release file');
    total += Number(row.size); previous = row.path;
    releaseNeed(Number.isSafeInteger(total) && total <= 8 * 1024 ** 3, 'Shell release size exceeds bound');
  }
  releaseNeed(total === value.totalBytes && value.files.some(row => row.path === 'index.html'), 'Shell release totals or entry point differ');
  return { version: 1, files: value.files.map(row => ({ path: row.path, size: row.size, sha256: row.sha256 })), totalBytes: total };
}
export function releaseDirectory(path: string, immutable = false): string {
  releaseNeed(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path, 'Physical absolute shell directory required');
  const stat = lstatSync(path);
  releaseNeed(stat.isDirectory() && !stat.isSymbolicLink() && !(stat.mode & (immutable ? 0o222 : 0o022)), 'Unsafe shell release directory');
  return path;
}
/** Open the inspected inode without following a substituted leaf symlink. */
export function releaseBytes(path: string, maxBytes: number, immutable = false): Buffer {
  const before = lstatSync(path, { bigint: true });
  releaseNeed(before.isFile() && before.size <= BigInt(maxBytes) && !(before.mode & BigInt(immutable ? 0o222 : 0o022)), 'Unsafe shell release metadata');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(':');
  try {
    releaseNeed(stamp(fstatSync(fd, { bigint: true })) === stamp(before), 'Shell metadata changed before read');
    const bytes = readFileSync(fd);
    releaseNeed(bytes.length === Number(before.size) && stamp(fstatSync(fd, { bigint: true })) === stamp(before)
      && stamp(lstatSync(path, { bigint: true })) === stamp(before), 'Shell metadata changed during read');
    return bytes;
  } finally { closeSync(fd); }
}
export function readShellPointer(root: string): { pointer: ShellPointer; sha256: string } {
  releaseDirectory(root); const bytes = releaseBytes(join(root, 'current.json'), 1024), value: unknown = JSON.parse(bytes.toString());
  releaseNeed(keys(value, ['version', 'revision', 'current', 'previous', 'retained']) && value.version === 1
    && Number.isSafeInteger(value.revision) && Number(value.revision) > 0 && hash(value.current)
    && (value.previous === null || hash(value.previous)) && value.current !== value.previous && Array.isArray(value.retained) && value.retained.length <= 6
    && value.retained.every(row => keys(row, ['id', 'expiresAt']) && hash(row.id) && Number.isSafeInteger(row.expiresAt) && Number(row.expiresAt) > 0)
    && new Set([value.current, value.previous, ...value.retained.map(row => row.id)].filter(Boolean)).size === 1 + (value.previous ? 1 : 0) + value.retained.length
    && releaseJson(value) === bytes.toString(), 'Invalid canonical shell pointer');
  return { pointer: value as unknown as ShellPointer, sha256: releaseHash(bytes) };
}
const cache = new Map<string, { identity: string; release: ShellRelease }>();
export function readShellRelease(root: string, id: string): ShellRelease {
  releaseNeed(hash(id), 'Invalid shell release identity'); releaseDirectory(root);
  releaseDirectory(join(root, 'releases'));
  const directory = releaseDirectory(join(root, 'releases', id), true);
  const files = releaseDirectory(join(directory, 'files'), true), manifestPath = join(directory, 'manifest.json');
  const stat = lstatSync(manifestPath, { bigint: true }), dir = lstatSync(directory, { bigint: true }), tree = lstatSync(files, { bigint: true });
  releaseNeed(stat.isFile() && !(stat.mode & 0o222n), 'Shell release manifest must be immutable');
  const identity = [dir.dev, dir.ino, dir.ctimeNs, tree.dev, tree.ino, tree.ctimeNs, stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(':');
  const held = cache.get(directory); if (held?.identity === identity) return held.release;
  const bytes = releaseBytes(manifestPath, 64 * 1024 ** 2, true);
  releaseNeed(releaseHash(bytes) === id, 'Shell release manifest digest differs');
  const manifest = parseReleaseManifest(JSON.parse(bytes.toString()));
  const governance = checkShellDist(files);
  releaseNeed(governance.present && governance.hasOrgConfig, 'Shell release lacks governed boot');
  const release = { id, directory: files, manifest };
  if (cache.size >= 8) cache.delete(cache.keys().next().value!);
  cache.set(directory, { identity, release }); return release;
}
export function shellDirectories(instance: { shellDir?: string; shellReleasePointer?: boolean }): string[] {
  if (!instance.shellDir) return [];
  if (!instance.shellReleasePointer) return [instance.shellDir];
  const { pointer } = readShellPointer(instance.shellDir);
  return [pointer.current, ...(pointer.previous ? [pointer.previous] : []), ...pointer.retained.filter(row => row.expiresAt > Date.now()).map(row => row.id)]
    .map(id => readShellRelease(instance.shellDir!, id).directory);
}
export function shellDirectory(instance: { shellDir?: string; shellReleasePointer?: boolean }): string | undefined {
  return shellDirectories(instance)[0];
}
