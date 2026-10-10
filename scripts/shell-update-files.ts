// SPDX-License-Identifier: MPL-2.0
/** Bounded local file custody shared by shell preparation and clone retention. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statfsSync, writeFileSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export type ShellFile = { path: string; size: number; sha256: string };
export type ShellManifest = { version: 1; files: ShellFile[]; totalBytes: number };
export type ClonedShellFile = ShellFile & { dev: string; ino: string; mode: string; mtimeNs: string; ctimeNs: string };
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export function requireShell(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
export function safeShellPath(path: string): void {
  requireShell(typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 1024 && !path.startsWith('/') && !path.includes('\\')
    && !/[\u0000-\u001f\u007f\u2028-\u202e\u2066-\u2069]/.test(path) && path.split('/').length <= 64
    && path.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'Unsafe shell path.');
}
export function canonicalDirectory(path: string): string {
  requireShell(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path && lstatSync(path).isDirectory(), 'Canonical absolute directory required.'); return path;
}
export function shellFileStamp(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
export function shellFileCustody(path: string): { size: number; sha256: string; stamp: string } {
  const stat = lstatSync(path, { bigint: true });
  requireShell(stat.isFile() && stat.size <= 8n * 1024n ** 3n && !(stat.mode & 0o022n), 'Bounded regular non-writable file required.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stamp = shellFileStamp;
  try {
    requireShell(stamp(fstatSync(fd, { bigint: true })) === stamp(stat), 'File changed before reading.');
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let size = 0;
    for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) > 0;) { size += count; requireShell(size <= Number(stat.size), 'File grew during reading.'); digest.update(buffer.subarray(0, count)); }
    requireShell(size === Number(stat.size) && stamp(fstatSync(fd, { bigint: true })) === stamp(stat) && stamp(lstatSync(path, { bigint: true })) === stamp(stat), 'File changed while reading.');
    return { size, sha256: digest.digest('hex'), stamp: stamp(stat) };
  } finally { closeSync(fd); }
}
export function shellFileHash(path: string): { size: number; sha256: string } {
  const { size, sha256 } = shellFileCustody(path); return { size, sha256 };
}
export function shellManifest(root: string): ShellManifest {
  canonicalDirectory(root); const files: ShellFile[] = []; let entries = 0, totalBytes = 0;
  function walk(relative: string, depth: number): void {
    const full = join(root, relative), stat = lstatSync(full, { bigint: true });
    requireShell(depth <= 64 && stat.isDirectory() && !(stat.mode & 0o022n), 'Tree needs bounded non-writable directories.');
    const names = readdirSync(full).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name; safeShellPath(path);
      requireShell(++entries <= 200_000, 'Tree entry bound exceeded.');
      const child = join(root, path), info = lstatSync(child);
      if (info.isDirectory()) walk(path, depth + 1);
      else { const hash = shellFileHash(child); files.push({ path, ...hash }); totalBytes += hash.size; requireShell(files.length <= 100_000 && totalBytes <= 8 * 1024 ** 3, 'Tree size bound exceeded.'); }
    }
    const after = lstatSync(full, { bigint: true });
    requireShell(stat.dev === after.dev && stat.ino === after.ino && stat.mtimeNs === after.mtimeNs && stat.ctimeNs === after.ctimeNs
      && JSON.stringify(names) === JSON.stringify(readdirSync(full).sort()), 'Tree directory changed during inventory.');
  }
  walk('', 0); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { version: 1, files, totalBytes };
}
export function shellId(manifest: ShellManifest): string {
  // Established shell-release-id order is the depth-first directory walk, not a flat path sort.
  const entries = new Map(manifest.files.map(file => [file.path, file.sha256]));
  const children = new Map<string, Set<string>>();
  for (const file of manifest.files) {
    const parts = file.path.split('/');
    for (let depth = 0; depth < parts.length; depth++) {
      const parent = parts.slice(0, depth).join('/'), names = children.get(parent) ?? new Set<string>();
      names.add(parts[depth]!); children.set(parent, names);
    }
  }
  const ordered: [string, string][] = [];
  function walk(parent: string): void {
    const prefix = parent ? `${parent}/` : '';
    for (const name of [...(children.get(parent) ?? [])].sort()) { const path = prefix + name, hash = entries.get(path); if (hash) ordered.push([path, hash]); else walk(path); }
  }
  walk(''); return `release-${sha256(JSON.stringify(ordered)).slice(0, 16)}`;
}
export function writeShellJson(path: string, value: unknown): { path: string; sha256: string } {
  const bytes = `${JSON.stringify(value, null, 2)}\n`; requireShell(Buffer.byteLength(bytes) <= 64 * 1024 ** 2, 'Receipt exceeds byte bound.');
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); return { path, sha256: sha256(bytes) };
}
export function readShellJson(path: string, expected?: string): unknown {
  requireShell(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path, 'Canonical input file required.');
  const hash = shellFileHash(path); requireShell(hash.size <= 64 * 1024 ** 2 && (!expected || hash.sha256 === expected), 'Input custody differs.');
  const bytes = readFileSync(path); requireShell(sha256(bytes) === hash.sha256, 'Input changed after custody inspection.'); return JSON.parse(bytes.toString('utf8'));
}
export function requireDisk(path: string, projected = 0): void {
  const stat = statfsSync(path, { bigint: true }); requireShell(stat.bavail * stat.bsize >= BigInt(2 * 1024 ** 3 + projected), 'Keep at least 2 GiB free after preparation.');
}
export function cloneShellFiles(root: string, destination: string, files: ShellFile[], inputPath: string): ClonedShellFile[] {
  canonicalDirectory(root); canonicalDirectory(destination); requireDisk(dirname(destination));
  const input = writeShellJson(inputPath, { version: 1, destination, files: files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256, source: join(root, file.path) })) });
  const result = spawnSync('python3', ['-B', fileURLToPath(new URL('./shell-update-clone.py', import.meta.url)), input.path, input.sha256],
    { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8' }, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  requireShell(!result.error && result.status === 0 && result.signal === null, 'Exclusive local clone failed; preserve incomplete artifact.');
  const receipt = JSON.parse(result.stdout.toString('utf8'));
  requireShell(receipt && typeof receipt === 'object' && JSON.stringify(Object.keys(receipt).sort()) === JSON.stringify(['clonedFiles', 'copiedFiles', 'files', 'hardlinks', 'identities', 'status', 'version'])
    && receipt.version === 1 && receipt.status === 'EXCLUSIVE_FILES_PREPARED' && receipt.hardlinks === false && receipt.files === files.length
    && Number.isSafeInteger(receipt.clonedFiles) && receipt.clonedFiles >= 0 && Number.isSafeInteger(receipt.copiedFiles) && receipt.copiedFiles >= 0
    && receipt.clonedFiles + receipt.copiedFiles === files.length && Array.isArray(receipt.identities) && receipt.identities.length === files.length, 'Clone identity receipt differs.');
  const seen = new Set<string>();
  for (const [index, row] of receipt.identities.entries()) {
    const expected = files[index];
    requireShell(row && typeof row === 'object' && JSON.stringify(Object.keys(row).sort()) === JSON.stringify(['ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'path', 'sha256', 'size'])
      && expected && row.path === expected.path && !seen.has(row.path) && row.size === expected.size && row.sha256 === expected.sha256
      && ['dev', 'ino', 'mode'].every(key => typeof row[key] === 'string' && /^(0|[1-9][0-9]{0,30})$/.test(row[key]))
      && ['mtimeNs', 'ctimeNs'].every(key => typeof row[key] === 'string' && /^(0|-?[1-9][0-9]{0,30})$/.test(row[key])), 'Clone file custody receipt differs.');
    safeShellPath(row.path); seen.add(row.path);
  }
  return receipt.identities;
}
