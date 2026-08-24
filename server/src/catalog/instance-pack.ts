/**
 * Instance-pack hosting (plans/34 wave 2, amended) - the control plane SERVES
 * the signed `.lolly` pack, it never builds one. The pack format belongs to
 * the OSS repo's `scripts/build-instance-pack.ts` (formatVersion, integrity
 * manifest, ECDSA signature, budget and audio guards, the include-list
 * recipe): a second builder here would be a third implementation of a signed
 * format with no shared library to keep them honest, which is exactly the
 * drift this repo's contract tests exist to prevent. So the operator cuts the
 * pack with the tool that owns the format, and this instance becomes what OSS
 * plans/131 left open - the internal store the signed pack publishes to.
 *
 * What IS ours is refusing a wrong pack at the door. `inspectInstancePack`
 * reads just enough zip to hold two lines: the file is a `.lolly` pack
 * (manifest.json + instance.json present), and its instance.json points at
 * THIS deployment - hosting a pack that enrolls devices somewhere else is the
 * one mistake an operator must not be able to make silently. The read is a
 * plain central-directory walk, no dependency, same posture as links/zip.ts
 * on the write side; zip64 is refused (a pack is budgeted far below it).
 */
import { inflateRawSync } from 'node:zlib';

export const PACK_BLOB_ID = 'instance-pack.lolly';
export const PACK_META_BLOB_ID = 'instance-pack.meta';
/** The OSS builder's own PACK_BUDGET - a pack past this failed ITS build too. */
export const PACK_MAX_BYTES = 64 * 1024 * 1024;

export interface InstancePackMeta {
  name?: string;
  publisher?: string;
  version?: string;
  /** The instance base the pack's instance.json carries - verified against
   *  this deployment's baseUrl before anything is stored. */
  packInstance: string;
  /** Whether pack.sig is present. Unsigned is dev-only and said out loud. */
  signed: boolean;
  entryCount: number;
  size: number;
  checksum: string;
  uploadedAt: string;
  uploadedBy: string;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface Entry { name: string; method: number; compressedSize: number; localOffset: number }

function centralEntries(bytes: Buffer): Entry[] {
  // EOCD sits in the last 22..(22+65535) bytes; scan backward for its signature.
  const from = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= from; i--) {
    if (bytes.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = bytes.readUInt16LE(eocd + 10);
  let at = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error('zip64 archive - not an instance pack');
  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIG) throw new Error('malformed zip central directory');
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const nameLen = bytes.readUInt16LE(at + 28);
    const extraLen = bytes.readUInt16LE(at + 30);
    const commentLen = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    out.push({ name, method, compressedSize, localOffset });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function entryBytes(bytes: Buffer, e: Entry): Buffer {
  if (bytes.readUInt32LE(e.localOffset) !== LOCAL_SIG) throw new Error(`malformed zip local header for ${e.name}`);
  const nameLen = bytes.readUInt16LE(e.localOffset + 26);
  const extraLen = bytes.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${e.method} for ${e.name}`);
}

export interface PackInspection {
  name?: string;
  publisher?: string;
  version?: string;
  packInstance: string;
  signed: boolean;
  entryCount: number;
}

/**
 * Refuses (throws, message operator-facing) unless the bytes are a `.lolly`
 * instance pack whose instance.json points at `expectedBase`.
 */
export function inspectInstancePack(bytes: Buffer, expectedBase: string): PackInspection {
  if (bytes.length > PACK_MAX_BYTES) throw new Error(`pack is ${bytes.length} bytes - over the ${PACK_MAX_BYTES} budget the OSS builder enforces too`);
  const entries = centralEntries(bytes);
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('manifest.json')) throw new Error('no manifest.json - not a .lolly pack');
  const instanceEntry = entries.find((e) => e.name === 'instance.json');
  if (!instanceEntry) throw new Error('no instance.json - a brand bundle, not an INSTANCE pack (rebuild with scripts/build-instance-pack.ts)');
  let parsed: { name?: unknown; publisher?: unknown; version?: unknown; instance?: unknown };
  try {
    parsed = JSON.parse(entryBytes(bytes, instanceEntry).toString('utf8')) as typeof parsed;
  } catch {
    throw new Error('instance.json is not valid JSON');
  }
  const packInstance = typeof parsed.instance === 'string' ? parsed.instance.replace(/\/+$/, '') : '';
  const want = expectedBase.replace(/\/+$/, '');
  if (!packInstance) throw new Error('instance.json carries no instance base');
  if (packInstance !== want) {
    throw new Error(`the pack's instance base is ${packInstance}, but this deployment is ${want} - hosting it here would enroll devices somewhere else. Rebuild the pack for this instance.`);
  }
  return {
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    ...(typeof parsed.publisher === 'string' ? { publisher: parsed.publisher } : {}),
    ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
    packInstance,
    signed: names.has('pack.sig'),
    entryCount: entries.length,
  };
}
