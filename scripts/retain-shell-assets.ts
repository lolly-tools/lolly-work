// SPDX-License-Identifier: MPL-2.0
/** Prepare local shell files; retain only the previous bundled _app tree. */
import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FILES = 100_000;
const MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
const CHUNK = 64 * 1024;
const ID = /^release-[0-9a-f]{16}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Identity = { dev: bigint; ino: bigint };
type File = { path: string; size: number; sha256: string; stamp: string };
type Snapshot = { root: string; files: File[]; directories: Map<string, Identity>; id: string; inventorySha256: string };
type Owned = { path: string; identity: Identity; directory: boolean };
export type RetainShellOptions = {
  candidate: string; expectedCandidateId: string;
  previous: string; expectedPreviousId: string;
  out: string; receiptOut: string;
};
export class RetentionRefusal extends Error {
  partialOutput = false;
}
function requireThat(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new RetentionRefusal(reason);
}
function identity(stat: BigIntStats): Identity { return { dev: stat.dev, ino: stat.ino }; }
function matches(stat: BigIntStats, value: Identity): boolean { return stat.dev === value.dev && stat.ino === value.ino; }
function stamp(stat: BigIntStats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
function within(a: string, b: string): boolean { return a === b || b.startsWith(`${a}${sep}`); }
function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}
function regularRoot(path: string): string {
  const root = resolve(path);
  requireThat(realpathSync(root) === root && lstatSync(root).isDirectory(), 'Inputs must be canonical directories without symbolic links.');
  return root;
}
function checkDirectory(snapshot: Snapshot, path: string): void {
  const expected = snapshot.directories.get(path);
  const stat = lstatSync(join(snapshot.root, path), { bigint: true });
  requireThat(expected && stat.isDirectory() && matches(stat, expected), 'An input directory changed during preparation.');
}
function checkParents(snapshot: Snapshot, path: string): void {
  checkDirectory(snapshot, '');
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) checkDirectory(snapshot, parts.slice(0, i).join('/'));
}
function readFile(snapshot: Snapshot, file: Pick<File, 'path'> & Partial<File>, consume?: (bytes: Buffer) => void): File {
  checkParents(snapshot, file.path);
  const path = join(snapshot.root, file.path);
  const before = lstatSync(path, { bigint: true });
  requireThat(before.isFile() && before.size <= BigInt(MAX_BYTES), 'Shell inputs must contain bounded regular files.');
  requireThat(file.stamp === undefined || file.stamp === stamp(before), 'An input file differs from the reviewed inventory.');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    requireThat(opened.isFile() && stamp(opened) === stamp(before), 'An input file changed before it was read.');
    const digest = createHash('sha256'), buffer = Buffer.alloc(CHUNK);
    let total = 0;
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      total += bytes;
      requireThat(total <= MAX_BYTES && total <= Number(before.size), 'An input file changed while it was read.');
      const part = buffer.subarray(0, bytes);
      digest.update(part); consume?.(part);
    }
    requireThat(total === Number(before.size) && stamp(fstatSync(fd, { bigint: true })) === stamp(before), 'An input file changed while it was read.');
    checkParents(snapshot, file.path);
    requireThat(stamp(lstatSync(path, { bigint: true })) === stamp(before), 'An input file was replaced while it was read.');
    return { path: file.path, size: total, sha256: digest.digest('hex'), stamp: stamp(before) };
  } finally { closeSync(fd); }
}
function publicFiles(snapshot: Snapshot): Array<{ path: string; size: number; sha256: string }> {
  return snapshot.files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
}
function snapshot(root: string): Snapshot {
  const result: Snapshot = { root, files: [], directories: new Map(), id: '', inventorySha256: '' };
  let total = 0, entries = 0, inventoryBytes = 0;
  function walk(path: string, depth: number): void {
    requireThat(depth <= MAX_DEPTH && ++entries <= MAX_FILES, 'Shell input inventory exceeds its bounds.');
    const full = join(root, path), stat = lstatSync(full, { bigint: true });
    requireThat(stat.isDirectory(), 'Shell inputs must not contain symbolic links or special files.');
    result.directories.set(path, identity(stat));
    const names = readdirSync(full).sort();
    for (const name of names) {
      requireThat([...name].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 && character !== '\\')
        && name !== '.' && name !== '..', 'Shell input contains an unsafe file name.');
      const child = path ? `${path}/${name}` : name;
      requireThat(Buffer.byteLength(child) <= 1024, 'Shell input paths exceed their bound.');
      const entry = lstatSync(join(root, child), { bigint: true });
      if (entry.isDirectory()) walk(child, depth + 1);
      else {
        requireThat(entry.isFile() && ++entries <= MAX_FILES, 'Shell inputs must contain bounded regular files.');
        const file = readFile(result, { path: child });
        inventoryBytes += Buffer.byteLength(child) + 160;
        requireThat(inventoryBytes <= MAX_INVENTORY_BYTES, 'Shell input inventory exceeds its byte bound.');
        total += file.size;
        requireThat(total <= MAX_BYTES, 'Shell input bytes exceed their bound.');
        result.files.push(file);
      }
    }
    checkDirectory(result, path);
    requireThat(JSON.stringify(readdirSync(full).sort()) === JSON.stringify(names), 'An input directory changed during inventory.');
  }
  walk('', 0);
  requireThat(result.files.some(file => file.path === 'index.html'), 'Each input shell needs a regular index.html.');
  result.id = `release-${hash(JSON.stringify(result.files.map(file => [file.path, file.sha256]))).slice(0, 16)}`;
  result.inventorySha256 = hash(JSON.stringify(publicFiles(result)));
  // Use the existing shell-release-id algorithm with guarded descriptor reads.
  return result;
}
function unchanged(before: Snapshot): void {
  const after = snapshot(before.root);
  requireThat(after.inventorySha256 === before.inventorySha256 && after.id === before.id
    && JSON.stringify(after.files) === JSON.stringify(before.files)
    && after.directories.size === before.directories.size, 'Shell input changed during preparation.');
  for (const [path, value] of before.directories) {
    const actual = after.directories.get(path);
    requireThat(actual?.dev === value.dev && actual.ino === value.ino, 'An input directory was replaced during preparation.');
  }
}
function writeAll(fd: number, bytes: Buffer): void {
  for (let offset = 0; offset < bytes.length;) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    requireThat(written > 0, 'Could not write complete preparation output.');
    offset += written;
  }
}
function ownedDirectory(path: string, owned: Owned[], mode = 0o755): void {
  mkdirSync(path, { mode });
  try { owned.push({ path, identity: identity(lstatSync(path, { bigint: true })), directory: true }); }
  catch {
    const refusal = new RetentionRefusal('Created output ownership could not be recorded.');
    refusal.partialOutput = true; throw refusal;
  }
}
function assertOwnedParents(path: string, out: string, owned: Owned[]): void {
  for (let parent = dirname(path); within(out, parent); parent = dirname(parent)) {
    const expected = owned.find(entry => entry.path === parent && entry.directory);
    const stat = lstatSync(parent, { bigint: true });
    requireThat(expected && stat.isDirectory() && matches(stat, expected.identity), 'Output ownership changed during preparation.');
    if (parent === out) break;
  }
}
function copyFile(source: Snapshot, file: File, out: string, owned: Owned[]): void {
  const destination = join(out, file.path), parts = file.path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const directory = join(out, ...parts.slice(0, i));
    if (!owned.some(entry => entry.path === directory)) {
      assertOwnedParents(directory, out, owned); ownedDirectory(directory, owned);
    }
  }
  assertOwnedParents(destination, out, owned);
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  let tracked = false;
  try {
    const created = identity(fstatSync(fd, { bigint: true }));
    owned.push({ path: destination, identity: created, directory: false }); tracked = true;
    const copied = readFile(source, file, bytes => writeAll(fd, bytes));
    requireThat(JSON.stringify(copied) === JSON.stringify(file), 'An input file differs from the reviewed inventory.');
    fsyncSync(fd);
    requireThat(matches(lstatSync(destination, { bigint: true }), created), 'An output file was replaced during preparation.');
    assertOwnedParents(destination, out, owned);
  } catch (error) {
    if (tracked) throw error;
    const refusal = new RetentionRefusal('Created output ownership could not be recorded.');
    refusal.partialOutput = true; throw refusal;
  } finally { closeSync(fd); }
}
function cleanup(owned: Owned[]): boolean {
  let clean = true;
  for (const entry of [...owned].reverse()) {
    try {
      const stat = lstatSync(entry.path, { bigint: true });
      if (!matches(stat, entry.identity) || (entry.directory ? !stat.isDirectory() : !stat.isFile())) { clean = false; continue; }
      const parents = owned.filter(parent => parent.directory && within(parent.path, entry.path) && parent.path !== entry.path);
      if (parents.some(parent => !matches(lstatSync(parent.path, { bigint: true }), parent.identity))) { clean = false; continue; }
      if (entry.directory) rmdirSync(entry.path); else unlinkSync(entry.path);
    } catch { clean = false; }
  }
  return clean;
}

export function retainShellAssets(options: RetainShellOptions) {
  const owned: Owned[] = [];
  let uncertainReceipt = false;
  try {
    requireThat(ID.test(options.expectedCandidateId) && ID.test(options.expectedPreviousId), 'Expected shell release IDs are required.');
    const candidateRoot = regularRoot(options.candidate), previousRoot = regularRoot(options.previous);
    const out = resolve(options.out), receiptOut = resolve(options.receiptOut);
    const roots = [candidateRoot, previousRoot, out];
    for (const [index, root] of roots.entries()) for (const other of roots.slice(index + 1)) {
      requireThat(!within(root, other) && !within(other, root), 'Input and output directories must not overlap.');
    }
    requireThat(roots.every(root => !within(root, receiptOut) && !within(receiptOut, root)), 'Receipt must be separate from all shell trees.');
    const outParent = regularRoot(dirname(out)), receiptParent = regularRoot(dirname(receiptOut));
    const outParentIdentity = identity(lstatSync(outParent, { bigint: true }));
    const receiptParentIdentity = identity(lstatSync(receiptParent, { bigint: true }));
    requireThat(absent(out) && absent(receiptOut), 'Output directory and receipt must be new exclusive paths.');
    const candidate = snapshot(candidateRoot), previous = snapshot(previousRoot);
    requireThat(candidate.id === options.expectedCandidateId && previous.id === options.expectedPreviousId, 'Input shell release IDs differ from the reviewed IDs.');
    const active = new Map(candidate.files.map(file => [file.path, file]));
    const retained = previous.files.filter(file => file.path.startsWith('_app/'));
    requireThat(retained.length > 0, 'Previous shell has no bundled _app files to retain.');
    for (const file of retained) {
      const present = active.get(file.path);
      requireThat(!present || (present.sha256 === file.sha256 && present.size === file.size), 'Same-path shell assets contain different bytes.');
      const ancestors = file.path.split('/');
      for (let i = 1; i < ancestors.length; i++) requireThat(!active.has(ancestors.slice(0, i).join('/')), 'Retained shell path conflicts with a candidate file.');
      requireThat(!candidate.directories.has(file.path), 'Retained shell file conflicts with a candidate directory.');
    }
    requireThat(candidate.files.length + retained.filter(file => !active.has(file.path)).length <= MAX_FILES
      && candidate.files.reduce((n, file) => n + file.size, 0) + retained.filter(file => !active.has(file.path)).reduce((n, file) => n + file.size, 0) <= MAX_BYTES,
    'Prepared shell exceeds its inventory bounds.');
    unchanged(candidate); unchanged(previous);
    requireThat(matches(lstatSync(outParent, { bigint: true }), outParentIdentity) && regularRoot(outParent) === outParent, 'Output parent ownership changed during preparation.');
    ownedDirectory(out, owned, 0o700);
    for (const file of candidate.files) copyFile(candidate, file, out, owned);
    for (const file of retained) if (!active.has(file.path)) copyFile(previous, file, out, owned);
    unchanged(candidate); unchanged(previous);
    const prepared = snapshot(out), expected = new Map(active);
    for (const file of retained) expected.set(file.path, file);
    requireThat(prepared.files.length === expected.size && prepared.files.every(file => {
      const want = expected.get(file.path); return want && want.size === file.size && want.sha256 === file.sha256;
    }), 'Prepared shell differs from its reviewed input files.');
    requireThat(matches(lstatSync(outParent, { bigint: true }), outParentIdentity) && regularRoot(outParent) === outParent, 'Output parent ownership changed during preparation.');
    const receipt = {
      version: 1, result: 'PREPARED', scope: 'previous bundled _app files only', runtimeQualified: false, promotionAttempted: false,
      candidate: { shellId: candidate.id, inventorySha256: candidate.inventorySha256, files: publicFiles(candidate) },
      previous: { shellId: previous.id, inventorySha256: previous.inventorySha256, files: publicFiles(previous) },
      output: { shellId: prepared.id, inventorySha256: prepared.inventorySha256, files: publicFiles(prepared) },
      retained: retained.map(file => ({ path: file.path, size: file.size, sha256: file.sha256, action: active.has(file.path) ? 'unchanged' : 'copied' })),
      unchangedCandidateFiles: candidate.files.length,
      outstanding: ['Signed release and engine/pack cohort qualification', 'Resources outside _app, including ORT, models, fonts and catalog', 'Prior-tab lazy imports and collaboration reconnect'],
    };
    requireThat(matches(lstatSync(receiptParent, { bigint: true }), receiptParentIdentity) && regularRoot(receiptParent) === receiptParent, 'Receipt parent ownership changed during preparation.');
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    requireThat(receiptBytes.length <= MAX_RECEIPT_BYTES, 'Preparation receipt exceeds its byte bound.');
    const fd = openSync(receiptOut, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    uncertainReceipt = true;
    let receiptIdentity: Identity, receiptStamp: string;
    try {
      receiptIdentity = identity(fstatSync(fd, { bigint: true }));
      owned.push({ path: receiptOut, identity: receiptIdentity, directory: false }); uncertainReceipt = false;
      writeAll(fd, receiptBytes); fsyncSync(fd);
      const actual = createHash('sha256'), buffer = Buffer.alloc(CHUNK);
      for (let offset = 0; offset < receiptBytes.length;) {
        const bytes = readSync(fd, buffer, 0, Math.min(CHUNK, receiptBytes.length - offset), offset);
        requireThat(bytes > 0, 'Preparation receipt was not written completely.');
        actual.update(buffer.subarray(0, bytes)); offset += bytes;
      }
      requireThat(actual.digest('hex') === createHash('sha256').update(receiptBytes).digest('hex')
        && fstatSync(fd, { bigint: true }).size === BigInt(receiptBytes.length)
        && matches(lstatSync(receiptOut, { bigint: true }), receiptIdentity), 'Receipt ownership or bytes changed during preparation.');
      receiptStamp = stamp(fstatSync(fd, { bigint: true }));
    } finally { closeSync(fd); }
    unchanged(candidate); unchanged(previous); unchanged(prepared);
    requireThat(matches(lstatSync(outParent, { bigint: true }), outParentIdentity) && regularRoot(outParent) === outParent, 'Output parent ownership changed during preparation.');
    requireThat(matches(lstatSync(receiptParent, { bigint: true }), receiptParentIdentity)
      && regularRoot(receiptParent) === receiptParent && stamp(lstatSync(receiptOut, { bigint: true })) === receiptStamp, 'Receipt ownership changed during preparation.');
    return receipt;
  } catch (error) {
    const refusal = error instanceof RetentionRefusal ? error : new RetentionRefusal('Local preparation failed; review the inputs and output ownership.');
    const clean = cleanup(owned);
    refusal.partialOutput ||= uncertainReceipt || !clean;
    throw refusal;
  }
}
export function main(argv = process.argv.slice(2)): number {
  try {
    const names = new Map([
      ['--candidate', 'candidate'], ['--expected-candidate-id', 'expectedCandidateId'],
      ['--previous', 'previous'], ['--expected-previous-id', 'expectedPreviousId'],
      ['--out', 'out'], ['--receipt-out', 'receiptOut'],
    ] as const);
    const options: Partial<RetainShellOptions> = {};
    for (let i = 0; i < argv.length; i += 2) {
      const name = names.get(argv[i] as Parameters<typeof names.get>[0]), value = argv[i + 1];
      requireThat(name && value && !value.startsWith('--') && !options[name], 'Provide each documented input option exactly once.');
      options[name] = value;
    }
    requireThat(Object.keys(options).length === names.size, 'All six documented input options are required.');
    const receipt = retainShellAssets(options as RetainShellOptions);
    console.log(JSON.stringify({ result: receipt.result, shellId: receipt.output.shellId, runtimeQualified: false, promotionAttempted: false }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ result: 'REFUSED', reason: error instanceof RetentionRefusal ? error.message : 'Local preparation failed.', partialOutput: error instanceof RetentionRefusal && error.partialOutput, promotionAttempted: false }));
    return 1;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
