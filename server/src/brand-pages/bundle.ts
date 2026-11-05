// SPDX-License-Identifier: MPL-2.0
/**
 * Reading a brand page bundle: one ZIP, sent through the parts upload, with
 * `brand.json` at its root. The reader takes only what the writer needs. It looks at
 * the central directory first and refuses anything it cannot bound before it inflates
 * a byte: ZIP64, encryption, other compression methods, links, unsafe names,
 * overlapping entries, and sizes over the limits.
 *
 * Then every file is checked against the manifest: the manifest's own digest, each
 * file's size and SHA-256, and nothing present that the manifest does not list.
 */
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';
import { brandPageDigest, BrandPageRefusal, parseBrandPageManifest, type BrandPageManifest } from './manifest.ts';

const inflate = promisify(inflateRaw) as (buffer: Buffer, options: { maxOutputLength: number }) => Promise<Buffer>;

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff, EOCD_BYTES = 22, CENTRAL_BYTES = 46, LOCAL_BYTES = 30;
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
/** The manifest's 4096 files, the manifest itself and folder entries a zip tool may add. */
const MAX_ENTRIES = 8192;

export interface BundleLimits { maxBundleBytes: number; maxFileBytes: number }
export interface CheckedBundle { manifest: BrandPageManifest; files: Map<string, Buffer>; size: number }

interface Entry { name: string; method: number; crc: number; compressed: number; size: number; offset: number }

const fail = (code: string, message: string, status = 422): never => { throw new BrandPageRefusal(code, message, status); };

function eocdOffset(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - EOCD_BYTES - MAX_COMMENT);
  for (let at = zip.length - EOCD_BYTES; at >= lowest; at--) {
    if (zip.readUInt32LE(at) === EOCD && at + EOCD_BYTES + zip.readUInt16LE(at + 20) === zip.length) return at;
  }
  return fail('BUNDLE_NOT_A_ZIP', 'the bundle is not a ZIP file');
}

function safeName(name: string): void {
  const parts = name.split('/');
  if (name.startsWith('/') || name.includes('\\') || name.includes('\0') || /[\u0000-\u001f\u007f]/.test(name) || parts.some(part => part === '..' || part === '.')) {
    fail('BUNDLE_PATH_REFUSED', `a path leaves the folder: ${JSON.stringify(name).slice(0, 120)}`);
  }
}

function directory(zip: Buffer, limits: BundleLimits): Entry[] {
  if (zip.length < EOCD_BYTES) fail('BUNDLE_NOT_A_ZIP', 'the bundle is not a ZIP file');
  const end = eocdOffset(zip);
  const total = zip.readUInt16LE(end + 10), size = zip.readUInt32LE(end + 12), start = zip.readUInt32LE(end + 16);
  if (zip.readUInt16LE(end + 4) !== 0 || zip.readUInt16LE(end + 6) !== 0 || zip.readUInt16LE(end + 8) !== total) fail('BUNDLE_NOT_SUPPORTED', 'a bundle in several parts is not supported');
  if (total === 0xffff || size === 0xffffffff || start === 0xffffffff) fail('BUNDLE_NOT_SUPPORTED', 'ZIP64 bundles are not supported');
  if (total > MAX_ENTRIES) fail('BUNDLE_TOO_MANY_FILES', `a bundle can hold at most ${MAX_ENTRIES} entries`, 413);
  if (start + size > end) fail('BUNDLE_NOT_A_ZIP', 'the ZIP directory is out of bounds');
  const entries: Entry[] = [];
  const names = new Set<string>();
  let at = start, declared = 0;
  for (let i = 0; i < total; i++) {
    if (at + CENTRAL_BYTES > end || zip.readUInt32LE(at) !== CENTRAL) fail('BUNDLE_NOT_A_ZIP', 'the ZIP directory is damaged');
    const madeBy = zip.readUInt16LE(at + 4) >> 8, flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16), compressed = zip.readUInt32LE(at + 20), uncompressed = zip.readUInt32LE(at + 24);
    const nameBytes = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const attributes = zip.readUInt32LE(at + 38), offset = zip.readUInt32LE(at + 42);
    if (at + CENTRAL_BYTES + nameBytes + extra + comment > end) fail('BUNDLE_NOT_A_ZIP', 'the ZIP directory is damaged');
    const name = zip.subarray(at + CENTRAL_BYTES, at + CENTRAL_BYTES + nameBytes).toString('utf8');
    at += CENTRAL_BYTES + nameBytes + extra + comment;
    safeName(name);
    if (flags & 0x1) fail('BUNDLE_NOT_SUPPORTED', 'encrypted bundles are not supported');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) fail('BUNDLE_NOT_SUPPORTED', 'ZIP64 bundles are not supported');
    // On Unix the top 16 bits of the attributes hold the file mode, which marks a link.
    if (madeBy === 3 && ((attributes >>> 16) & 0o170000) === 0o120000) fail('BUNDLE_PATH_REFUSED', `${name.slice(0, 120)} is a link`);
    if (names.has(name)) fail('BUNDLE_PATH_REFUSED', `${name.slice(0, 120)} appears twice`);
    names.add(name);
    if (name.endsWith('/')) {
      if (uncompressed !== 0) fail('BUNDLE_PATH_REFUSED', `${name.slice(0, 120)} is a folder with content`);
      continue;
    }
    if (method !== 0 && method !== 8) fail('BUNDLE_NOT_SUPPORTED', `${name.slice(0, 120)} uses a compression method this server does not read`);
    if (method === 0 && compressed !== uncompressed) fail('BUNDLE_NOT_A_ZIP', `${name.slice(0, 120)} has inconsistent sizes`);
    if (uncompressed > limits.maxFileBytes && name !== 'brand.json') fail('BUNDLE_FILE_TOO_LARGE', `${name.slice(0, 120)} is larger than the ${limits.maxFileBytes} bytes one file may be`, 413);
    declared += uncompressed;
    if (declared > limits.maxBundleBytes) fail('BUNDLE_TOO_LARGE', `the files come to more than the ${limits.maxBundleBytes} bytes a bundle may hold`, 413);
    entries.push({ name, method, crc, compressed, size: uncompressed, offset });
  }
  // Entries that share bytes are how a small ZIP expands to a great deal.
  let next = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset < next) fail('BUNDLE_NOT_A_ZIP', 'entries in the ZIP overlap');
    next = dataOffset(zip, entry, start) + entry.compressed;
  }
  return entries;
}

/** Where an entry's bytes begin. The local header must name the same file as the
 *  directory, so two readers cannot see two different bundles. */
function dataOffset(zip: Buffer, entry: Entry, directoryStart: number): number {
  if (entry.offset + LOCAL_BYTES > directoryStart || zip.readUInt32LE(entry.offset) !== LOCAL) fail('BUNDLE_NOT_A_ZIP', `the header for ${entry.name.slice(0, 120)} is damaged`);
  const nameBytes = zip.readUInt16LE(entry.offset + 26), extra = zip.readUInt16LE(entry.offset + 28);
  const data = entry.offset + LOCAL_BYTES + nameBytes + extra;
  if (data + entry.compressed > directoryStart) fail('BUNDLE_NOT_A_ZIP', `the bytes of ${entry.name.slice(0, 120)} are out of bounds`);
  if (zip.subarray(entry.offset + LOCAL_BYTES, entry.offset + LOCAL_BYTES + nameBytes).toString('utf8') !== entry.name) fail('BUNDLE_NOT_A_ZIP', `the headers for ${entry.name.slice(0, 120)} disagree`);
  return data;
}

async function contents(zip: Buffer, entry: Entry): Promise<Buffer> {
  const start = zip.readUInt32LE(eocdOffset(zip) + 16);
  const data = dataOffset(zip, entry, start);
  const raw = zip.subarray(data, data + entry.compressed);
  let bytes: Buffer;
  if (entry.method === 0) bytes = raw;
  else {
    try { bytes = entry.size === 0 ? Buffer.alloc(0) : await inflate(raw, { maxOutputLength: entry.size }); }
    catch { return fail('BUNDLE_NOT_A_ZIP', `${entry.name.slice(0, 120)} could not be read`); }
  }
  if (bytes.length !== entry.size || (crc32(bytes) >>> 0) !== entry.crc) fail('BUNDLE_NOT_A_ZIP', `${entry.name.slice(0, 120)} does not match its ZIP entry`);
  return bytes;
}

/** Reads and checks a whole bundle. Nothing here writes anything. */
export async function readBundle(zip: Buffer, limits: BundleLimits): Promise<CheckedBundle> {
  const entries = directory(zip, limits);
  const manifestEntry = entries.find(entry => entry.name === 'brand.json');
  if (!manifestEntry) return fail('BUNDLE_MANIFEST_MISSING', 'brand.json must be at the top of the bundle');
  if (manifestEntry.size > MAX_MANIFEST_BYTES) fail('BUNDLE_FILE_TOO_LARGE', 'brand.json is too large', 413);
  let parsed: unknown;
  try { parsed = JSON.parse((await contents(zip, manifestEntry)).toString('utf8')); }
  catch (error) {
    if (error instanceof BrandPageRefusal) throw error;
    return fail('MANIFEST_INVALID', 'brand.json is not JSON');
  }
  const manifest = parseBrandPageManifest(parsed);
  if (brandPageDigest(parsed as Record<string, unknown>) !== manifest.digest) fail('BUNDLE_MANIFEST_DIGEST', 'brand.json does not match its own digest');

  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const listed = new Set(manifest.files.map(file => file.path));
  for (const entry of entries) {
    if (entry.name !== 'brand.json' && !listed.has(entry.name)) fail('BUNDLE_UNLISTED_FILE', `${entry.name.slice(0, 120)} is in the bundle but not in brand.json`);
  }
  // Sizes first, so a wrong bundle is refused before any file is inflated.
  let size = 0;
  for (const file of manifest.files) {
    const entry = byName.get(file.path);
    if (!entry) return fail('BUNDLE_FILE_MISSING', `${file.path.slice(0, 120)} is listed in brand.json but not in the bundle`);
    if (entry.size !== file.size) fail('BUNDLE_DIGEST_MISMATCH', `${file.path.slice(0, 120)} is not the size brand.json lists`);
    size += file.size;
  }
  const files = new Map<string, Buffer>();
  for (const file of manifest.files) {
    const bytes = await contents(zip, byName.get(file.path)!);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) fail('BUNDLE_DIGEST_MISMATCH', `${file.path.slice(0, 120)} does not match the digest in brand.json`);
    files.set(file.path, Buffer.from(bytes));
  }
  return { manifest, files, size };
}
