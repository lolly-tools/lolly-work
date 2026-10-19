// SPDX-License-Identifier: MPL-2.0
/** Copy the identity content of a reviewed signed release without rebuilding it. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

// A complete shell release (application plus catalog) holds more files than the
// catalog delivery inventory. The release bound matches server/src/lib/shell-release.ts
// and MAX_SHELL_FILES in scripts/prepare-private-cohort.py.
export const RELEASE_MAX_FILES = 120_000, INVENTORY_MAX_FILES = 100_000;
const MAX_BYTES = 8 * 1024 ** 3, JSON_LIMIT = 32 * 1024 ** 2;
const SHA = /^[0-9a-f]{64}$/;
const VERIFIER = 'scripts/verify-release-catalog.ts';
const SIGNATURE = 'catalog/tools/index.sig.json';
const INVENTORY = 'catalog/delivery-manifest.json';
const HASH_TOOL = /^tools\/([a-z0-9][a-z0-9-]*)@([0-9a-f]{16})\/(.+)$/i;
const TOOL = /^[a-z0-9][a-z0-9-]*$/i;

export interface FileRow { path: string; size: number; sha256: string }
interface FileRef { path: string; sha256: string }
interface ReleaseEnvelope {
  seq?: unknown;
  toolDirs?: Record<string, string>;
  files?: Record<string, string>;
  indexHash?: string;
  assetIndexHash?: string;
  slimHash?: string;
}
interface Custody {
  version: 1;
  status: 'SIGNED_LOLLY_RELEASE_REVIEWED';
  lollySource: string;
  profile: string;
  manifest: FileRef;
  publicPin: FileRef;
  verifier: FileRef;
}
export interface ReleaseDerivation {
  kind: 'verified-signed-release';
  custodySha256: string;
  manifestSha256: string;
  publicPinSha256: string;
  verifierSha256: string;
  indexSha256: string;
  envelopeSha256: string;
  omittedCodingSidecars: number;
}
export interface ReleasePackOptions {
  root: string;
  custody: string;
  custodySha256: string;
  lolly: string;
  commit: string;
  profile: string;
  node: string;
}
export interface VerifiedReleasePack {
  paths: string[];
  derivation: ReleaseDerivation;
  copyTo(out: string): void;
}

function requireValue(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`release pack: ${reason}`);
}
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'), 'unexpected record fields');
}
function safePath(path: unknown): asserts path is string {
  requireValue(typeof path === 'string' && Buffer.byteLength(path) <= 1024 && path.length > 0
    && path.split('/').length <= 64 && !isAbsolute(path) && !/[\\\p{Cc}]/u.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe release path');
}
function safeRoot(path: string): string {
  const root = resolve(path);
  requireValue(realpathSync(root) === root && lstatSync(root).isDirectory(), 'root must be a real directory without symlinks');
  return root;
}
function identity(st: Stats): string {
  return [st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs].join(':');
}
function regular(path: string, limit = MAX_BYTES): Stats {
  const st = lstatSync(path);
  requireValue(st.isFile() && st.size <= limit && !(st.mode & 0o022), 'input must be a bounded regular file not writable by others');
  return st;
}
function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Stream and recheck the opened identity; whole model or asset files never buffer. */
function streamFile(path: string, expected: FileRow | null, destination?: string): { sha256: string; size: number; stamp: string } {
  const before = regular(path), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: number | undefined;
  try {
    requireValue(identity(fstatSync(input)) === identity(before), 'file changed before reading');
    if (destination) output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, before.mode & 0o777);
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let size = 0, length: number;
    while ((length = readSync(input, buffer, 0, buffer.length, null)) > 0) {
      size += length;
      requireValue(size <= before.size && size <= MAX_BYTES, 'file grew while reading');
      const bytes = buffer.subarray(0, length);
      hash.update(bytes);
      if (output !== undefined) for (let offset = 0; offset < length;) offset += writeSync(output, bytes, offset, length - offset);
    }
    const sha256 = hash.digest('hex');
    requireValue(size === before.size && identity(fstatSync(input)) === identity(before)
      && identity(lstatSync(path)) === identity(before), 'file changed while reading');
    requireValue(!expected || (expected.sha256 === sha256 && expected.size === size), 'physical bytes differ from reviewed manifest');
    return { sha256, size, stamp: identity(before) };
  } finally {
    closeSync(input);
    if (output !== undefined) closeSync(output);
  }
}

function readBounded(path: string): Buffer {
  const before = regular(path, JSON_LIMIT), input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireValue(identity(fstatSync(input)) === identity(before), 'JSON changed before reading');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(input, bytes, offset, bytes.length - offset, null);
      requireValue(read > 0, 'JSON ended before its declared size');
      offset += read;
    }
    requireValue(identity(fstatSync(input)) === identity(before) && identity(lstatSync(path)) === identity(before), 'JSON changed while reading');
    return bytes;
  } finally { closeSync(input); }
}
function reviewedFile(ref: unknown, base: string): { bytes: Buffer; path: string; sha256: string } {
  exact(ref, ['path', 'sha256']);
  requireValue(typeof ref.path === 'string' && ref.path.length > 0 && !ref.path.includes('\0')
    && typeof ref.sha256 === 'string' && SHA.test(ref.sha256), 'invalid reviewed file reference');
  const path = resolve(base, ref.path);
  requireValue(realpathSync(path) === path, 'reviewed inputs must not use symlink paths');
  const bytes = readBounded(path);
  requireValue(digest(bytes) === ref.sha256, 'reviewed input digest differs');
  return { bytes, path, sha256: ref.sha256 };
}
export function manifestRows(bytes: Buffer): Map<string, FileRow> {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  exact(value, ['version', 'files', 'totalBytes']);
  requireValue(value.version === 1 && Array.isArray(value.files) && value.files.length > 0
    && value.files.length <= RELEASE_MAX_FILES && Number.isSafeInteger(value.totalBytes)
    && Number(value.totalBytes) >= 0 && Number(value.totalBytes) <= MAX_BYTES, 'invalid complete tree manifest');
  const rows = new Map<string, FileRow>();
  let total = 0;
  for (const row of value.files) {
    exact(row, ['path', 'size', 'sha256']); safePath(row.path);
    requireValue(Number.isSafeInteger(row.size) && Number(row.size) >= 0 && Number(row.size) <= MAX_BYTES
      && typeof row.sha256 === 'string' && SHA.test(row.sha256) && !rows.has(row.path), 'invalid or duplicate manifest row');
    total += Number(row.size);
    requireValue(total <= MAX_BYTES, 'tree exceeds byte bound');
    rows.set(row.path, { path: row.path, size: Number(row.size), sha256: row.sha256 });
  }
  requireValue(total === value.totalBytes && [...rows.keys()].join('\0') === [...rows.keys()].sort().join('\0'), 'manifest ordering or total differs');
  return rows;
}

function treeFiles(root: string): { paths: string[]; directories: Map<string, string> } {
  const paths: string[] = [], directories = new Map<string, string>();
  let count = 0;
  function walk(path: string, depth: number): void {
    requireValue(depth <= 64 && ++count <= RELEASE_MAX_FILES * 2, 'tree exceeds its depth or entry bound');
    const directory = join(root, path), st = lstatSync(directory);
    requireValue(st.isDirectory() && !(st.mode & 0o022), 'tree directory must not be a symlink or writable by others');
    const names = readdirSync(directory).sort();
    directories.set(path, identity(st) + '\0' + names.join('\0'));
    for (const name of names) {
      const leaf = path ? `${path}/${name}` : name; safePath(leaf);
      const st = lstatSync(join(root, leaf));
      if (st.isDirectory()) walk(leaf, depth + 1);
      else { requireValue(st.isFile() && ++count <= RELEASE_MAX_FILES * 2, 'tree contains a link or special file'); paths.push(leaf); }
    }
  }
  walk('', 0);
  return { paths: paths.sort(), directories };
}

export function inventoryPaths(root: string, rows: Map<string, FileRow>): Set<string> {
  requireValue(rows.has(INVENTORY), 'modern release needs its catalog delivery inventory');
  const inventory: unknown = JSON.parse(readBounded(join(root, INVENTORY)).toString('utf8'));
  exact(inventory, ['version', 'files']);
  requireValue(inventory.version === 1 && Array.isArray(inventory.files) && inventory.files.length <= INVENTORY_MAX_FILES, 'invalid catalog delivery inventory');
  const paths = new Set<string>();
  for (const row of inventory.files) {
    exact(row, ['path', 'size', 'sha256']); safePath(row.path);
    const actual = rows.get(row.path);
    requireValue(!paths.has(row.path) && actual && row.size === actual.size && row.sha256 === actual.sha256
      && (HASH_TOOL.test(row.path) || /^(?:catalog|info\/shots)\/.+\.[0-9a-f]{16}\.[a-z0-9]{1,12}$/.test(row.path))
      && !/[\s%?#]/u.test(row.path), 'delivery inventory differs from content-addressed physical bytes');
    const address = /\.([0-9a-f]{16})\.[a-z0-9]{1,12}$/.exec(row.path);
    requireValue(HASH_TOOL.test(row.path) || !!address && actual.sha256.startsWith(address[1]!), 'delivery path differs from its digest');
    paths.add(row.path);
  }
  return paths;
}

function canonicalFiles(files: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(files).sort().map(path => [path, files[path]])));
}
function checkIdentityClosure(rows: Map<string, FileRow>, envelope: ReleaseEnvelope, inventory: Set<string>): void {
  const logical: Record<string, string> = {}, aliases = new Map<string, Record<string, string>>();
  for (const row of rows.values()) {
    if (/\.(?:gz|br)$/.test(row.path)) continue;
    const hashed = HASH_TOOL.exec(row.path);
    if (hashed) {
      requireValue(inventory.has(row.path), 'immutable tool byte is outside delivery inventory');
      const key = `${hashed[1]}@${hashed[2]}`, files = aliases.get(key) ?? {};
      files[hashed[3]!] = row.sha256; aliases.set(key, files); continue;
    }
    const parts = row.path.split('/'), toolId = parts[1] ?? '', rel = parts.slice(2).join('/');
    if (row.path.startsWith('tools/') && row.path.endsWith('/tool.json')) requireValue(!!envelope.files?.[row.path.slice(6)], 'tool manifest is outside signed logical closure');
    if (parts[0] !== 'tools' || parts.length < 3 || !TOOL.test(toolId)) continue;
    if (rel.startsWith('i18n/') && !/^i18n\/[a-z0-9-]+\.json$/.test(rel)) continue;
    if (rel.startsWith('templates/') && !/^templates\/[A-Za-z0-9._-]+\.json$/.test(rel)) continue;
    logical[`${toolId}/${rel}`] = row.sha256;
  }
  requireValue(envelope.files && canonicalFiles(logical) === canonicalFiles(envelope.files), 'logical tool bytes exceed signed closure');
  for (const [key, files] of aliases) requireValue(files['tool.json'] && digest(Buffer.from(canonicalFiles(files))).startsWith(key.slice(key.indexOf('@') + 1)), 'immutable tool directory differs from content address');
  for (const [toolId, expected] of Object.entries(envelope.toolDirs ?? {})) {
    requireValue(SHA.test(expected) && aliases.has(`${toolId}@${expected.slice(0, 16)}`), 'current immutable tool tree is missing');
  }
  for (const [field, path] of [['assetIndexHash', 'catalog/assets/index.json'], ['slimHash', 'catalog/tools/index.slim.json']] as const) {
    requireValue(!!envelope[field] === rows.has(path) && (!envelope[field] || rows.get(path)?.sha256 === envelope[field]), 'catalog sibling is outside signed index closure');
  }
  for (const [digestValue, prefix] of [[envelope.indexHash, 'catalog/tools/index'], [envelope.assetIndexHash, 'catalog/assets/index'], [envelope.slimHash, 'catalog/tools/index.slim']] as const) {
    if (digestValue) requireValue(inventory.has(`${prefix}.${digestValue.slice(0, 16)}.json`), 'current immutable index is missing');
  }
}

// Decode sequentially with exact identity limits; a compressed bomb cannot expand unboundedly.
const CODING_CHECK = `
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip, createBrotliDecompress } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { join } from 'node:path';
let input = ''; for await (const part of process.stdin) input += part;
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error();
  const { root, pairs } = JSON.parse(input);
  for (const { coded, identity } of pairs) {
    const encodedHash = createHash('sha256'), decodedHash = createHash('sha256');
    let encodedSize = 0, decodedSize = 0;
    const decoder = coded.path.endsWith('.gz') ? createGunzip() : createBrotliDecompress();
    await pipeline(createReadStream(join(root, coded.path)), new Transform({ transform(bytes, _, next) {
      encodedSize += bytes.length; encodedHash.update(bytes);
      if (encodedSize > coded.size) next(new Error()); else next(null, bytes);
    } }), decoder, new Writable({ write(bytes, _, next) {
      decodedSize += bytes.length; decodedHash.update(bytes);
      next(decodedSize > identity.size ? new Error() : undefined);
    } }));
    if (encodedSize !== coded.size || decoder.bytesWritten !== encodedSize || decodedSize !== identity.size || encodedHash.digest('hex') !== coded.sha256 || decodedHash.digest('hex') !== identity.sha256) throw new Error();
  }
} catch { process.exitCode = 1; }
`;
function validateCoding(root: string, rows: Map<string, FileRow>, node: string): number {
  const pairs = [...rows.values()].filter(row => /\.(?:gz|br)$/.test(row.path)).map(coded => {
    const identity = rows.get(coded.path.replace(/\.(?:gz|br)$/, ''));
    requireValue(identity && !/\.(?:gz|br)$/.test(identity.path), 'coding sidecar is orphaned or nested');
    return { coded, identity };
  });
  if (pairs.length) {
    const checked = spawnSync(node, ['--input-type=module', '-e', CODING_CHECK], {
      input: JSON.stringify({ root, pairs }), encoding: 'utf8', maxBuffer: 1024 * 1024,
      timeout: 120_000, env: { PATH: process.env.PATH },
    });
    requireValue(checked.status === 0 && !checked.error, 'coding sidecar differs from exact identity bytes');
  }
  return pairs.length;
}

/** Inspect all reviewed bytes and the public signature before writing the raw projection. */
export function verifyReleasePack(options: ReleasePackOptions): VerifiedReleasePack {
  const root = safeRoot(options.root), lolly = safeRoot(options.lolly);
  const runtime = spawnSync(options.node, ['-p', 'Number(process.versions.node.split(".")[0])'], {
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000,
  });
  requireValue(runtime.status === 0 && Number(runtime.stdout.trim()) >= 24, 'release mode needs Node 24 or newer');
  requireValue(SHA.test(options.custodySha256), 'custody needs a reviewed SHA-256');
  const custodyFile = reviewedFile({ path: options.custody, sha256: options.custodySha256 }, process.cwd());
  const custodyValue: unknown = JSON.parse(custodyFile.bytes.toString('utf8'));
  exact(custodyValue, ['version', 'status', 'lollySource', 'profile', 'manifest', 'publicPin', 'verifier']);
  requireValue(custodyValue.version === 1 && custodyValue.status === 'SIGNED_LOLLY_RELEASE_REVIEWED'
    && custodyValue.lollySource === options.commit && custodyValue.profile === options.profile, 'release custody differs from source or profile');
  const custody = custodyValue as unknown as Custody, base = dirname(custodyFile.path);
  const manifest = reviewedFile(custody.manifest, base), pin = reviewedFile(custody.publicPin, base);
  requireValue(custody.verifier.path === VERIFIER, 'verifier must be the maintained Lolly release verifier');
  const verifier = reviewedFile(custody.verifier, lolly);
  const publicKey: unknown = JSON.parse(pin.bytes.toString('utf8'));
  exact(publicKey, ['kty', 'crv', 'x', 'y']);
  requireValue(publicKey.kty === 'EC' && publicKey.crv === 'P-256'
    && typeof publicKey.x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(publicKey.x)
    && typeof publicKey.y === 'string' && /^[A-Za-z0-9_-]{43}$/.test(publicKey.y), 'pin must be public-only P-256 JWK');
  const rows = manifestRows(manifest.bytes), tree = treeFiles(root), stamps = new Map<string, string>();
  requireValue(tree.paths.join('\0') === [...rows.keys()].join('\0'), 'release tree differs from complete reviewed inventory');
  for (const row of rows.values()) stamps.set(row.path, streamFile(join(root, row.path), row).stamp);
  const envelope = JSON.parse(readBounded(join(root, SIGNATURE)).toString('utf8')) as ReleaseEnvelope;
  requireValue(Number.isSafeInteger(envelope.seq) && Number(envelope.seq) >= 0 && envelope.toolDirs
    && typeof envelope.toolDirs === 'object' && !Array.isArray(envelope.toolDirs), 'release mode requires a modern signed catalog');
  const verified = spawnSync(options.node, [verifier.path, '--root', root, '--public-key', pin.path], {
    cwd: lolly, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 120_000,
    env: { PATH: process.env.PATH, VITE_CATALOG_PUBLIC_KEY_JWK: pin.bytes.toString('utf8') },
  });
  requireValue(verified.status === 0 && !verified.error, 'pinned release catalog verification failed');
  const result = JSON.parse(verified.stdout.trim()) as { verified?: unknown; indexSha256?: unknown; files?: unknown };
  requireValue(result.verified === true && result.indexSha256 === rows.get('catalog/tools/index.json')?.sha256
    && Number.isSafeInteger(result.files) && Number(result.files) === Object.keys(envelope.files ?? {}).length
    && Number(result.files) > 0, 'release verifier report differs from reviewed bytes');
  const inventory = inventoryPaths(root, rows), paths: string[] = [];
  checkIdentityClosure(rows, envelope, inventory);
  const omittedCodingSidecars = validateCoding(root, rows, options.node);
  for (const row of rows.values()) {
    if (row.path === SIGNATURE) continue;
    if (/\.(?:gz|br)$/.test(row.path)) {
      requireValue(!inventory.has(row.path) && !envelope.files?.[row.path.slice(6)] && rows.has(row.path.replace(/\.(?:gz|br)$/, '')), 'coding sidecar is orphaned or signed as identity content');
      continue;
    }
    if (row.path.startsWith('tools/') || row.path.startsWith('catalog/') || inventory.has(row.path)) paths.push(row.path);
  }
  requireValue(paths.includes(INVENTORY) && [...inventory].every(path => paths.includes(path)), 'raw projection omits delivery inventory bytes');
  const derivation: ReleaseDerivation = {
    kind: 'verified-signed-release', custodySha256: custodyFile.sha256, manifestSha256: manifest.sha256,
    publicPinSha256: pin.sha256, verifierSha256: verifier.sha256,
    indexSha256: rows.get('catalog/tools/index.json')!.sha256,
    envelopeSha256: rows.get(SIGNATURE)!.sha256, omittedCodingSidecars,
  };
  function unchanged(): void {
    const now = treeFiles(root);
    requireValue(now.paths.join('\0') === tree.paths.join('\0') && [...tree.directories].every(([path, stamp]) => now.directories.get(path) === stamp)
      && [...stamps].every(([path, stamp]) => identity(lstatSync(join(root, path))) === stamp), 'release changed during verification or copying');
    for (const ref of [custodyFile, manifest, pin, verifier]) requireValue(digest(readBounded(ref.path)) === ref.sha256, 'reviewed input changed during verification');
  }
  unchanged();
  return { paths, derivation, copyTo(out) {
    const destination = safeRoot(out), outside = (path: string): boolean => path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
    requireValue(outside(relative(root, destination)) && outside(relative(destination, root)), 'output must not overlap the release');
    requireValue(treeFiles(destination).paths.every(path => path === '.lolly-pack-source.json'), 'raw output must be empty apart from its build marker');
    unchanged();
    for (const path of paths) {
      mkdirSync(dirname(join(destination, path)), { recursive: true, mode: 0o755 });
      streamFile(join(root, path), rows.get(path)!, join(destination, path));
    }
    unchanged();
  } };
}
