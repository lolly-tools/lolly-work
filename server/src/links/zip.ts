/**
 * A minimal ZIP writer (plans/31 section 5) - the "download everything in this
 * collection" archive, built from what Node already ships.
 *
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY. The whole archive format we need is
 * three fixed-layout records: a local header per file, a central-directory
 * header per file, and one end-of-central-directory record. Node's zlib gives
 * us both halves that are genuinely hard - `crc32` (added in Node 20, and this
 * deployment's floor is 24) and raw DEFLATE - so a zip library would be a
 * supply-chain dependency bought for about 120 lines of byte layout. Nothing
 * here is novel; it is the PKWARE APPNOTE 4.3 record layout, written out.
 *
 * HOW THE ARCHIVE IS BUILT, and the trade it makes. Entries are written one at a
 * time and the response is flushed after each, so the archive STREAMS: the
 * server never holds more than a single member's bytes plus the (tiny) central
 * directory. It does not stream WITHIN a member - each one is buffered whole to
 * compute its CRC and its size before its header goes out. The alternative
 * (data descriptors, general-purpose bit 3) would let a member stream too, at
 * the cost of an archive whose sizes are only discoverable from the central
 * directory - which every streaming extractor reads worst. Buffering one member
 * is the honest trade: catalog assets are bounded (the submit cap is 64 MiB)
 * and the resulting archive is the maximally compatible kind.
 *
 * No ZIP64: `MAX_ENTRIES` and the caller's own byte budget keep an archive
 * inside the 4 GiB / 65535-entry classic limits, which is ample for a curated
 * set and far too small to be a bulk-export channel.
 */
import { crc32, deflateRawSync } from 'node:zlib';

/** Classic-ZIP entry ceiling. A collection caps well below this anyway. */
export const MAX_ENTRIES = 0xffff;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Bit 11: the filename is UTF-8, so a non-ASCII asset name survives. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

interface CentralEntry {
  name: Buffer;
  crc: number;
  compressed: number;
  uncompressed: number;
  method: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

/** MS-DOS date/time, the only timestamp the classic record has room for.
 *  Anything before 1980 clamps, because the format cannot express it. */
function dosStamp(at: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    dosTime: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * Make one entry name safe and unique inside the archive.
 *
 * A member's name comes from a catalog record, which on a submitted asset came
 * from a member of the org - so it is untrusted for this purpose. Path
 * separators, traversal and control characters are stripped rather than escaped
 * (a zip whose entries write outside the extraction directory is the classic
 * archive vulnerability), and a repeat gets a numbered suffix so two assets
 * called "logo.svg" both survive instead of one silently replacing the other.
 */
export function safeEntryName(raw: string, used: Set<string>): string {
  const cleaned = raw
    .replace(/[\\/]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/^[.\-\s]+/, '')
    .trim()
    .slice(0, 150) || 'asset';
  if (!used.has(cleaned)) {
    used.add(cleaned);
    return cleaned;
  }
  const dot = cleaned.lastIndexOf('.');
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
  const ext = dot > 0 ? cleaned.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/**
 * Builds a ZIP archive incrementally. `add` returns the bytes for one entry and
 * `end` returns the trailer; the caller writes each to wherever the archive is
 * going, so this module knows nothing about HTTP.
 */
export class ZipBuilder {
  private readonly entries: CentralEntry[] = [];
  private offset = 0;
  private readonly at: Date;

  constructor(at: Date = new Date()) {
    this.at = at;
  }

  get count(): number {
    return this.entries.length;
  }

  /**
   * One stored file: its local header followed by its (possibly deflated)
   * bytes. DEFLATE is attempted and kept only when it actually wins - most
   * catalog assets are already-compressed rasters, where deflating costs CPU to
   * make the file marginally bigger.
   */
  add(name: string, bytes: Buffer): Buffer {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(bytes) >>> 0;
    let method = METHOD_STORE;
    let payload = bytes;
    if (bytes.length > 0) {
      const deflated = deflateRawSync(bytes);
      if (deflated.length < bytes.length) {
        method = METHOD_DEFLATE;
        payload = deflated;
      }
    }
    const { dosTime, dosDate } = dosStamp(this.at);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(20, 4); // version needed to extract
    header.writeUInt16LE(FLAG_UTF8, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(dosTime, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // no extra field
    this.entries.push({
      name: nameBuf, crc, compressed: payload.length, uncompressed: bytes.length,
      method, offset: this.offset, dosTime, dosDate,
    });
    this.offset += header.length + nameBuf.length + payload.length;
    return Buffer.concat([header, nameBuf, payload]);
  }

  /** The central directory plus the end-of-central-directory record. */
  end(): Buffer {
    const parts: Buffer[] = [];
    let size = 0;
    for (const e of this.entries) {
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(CENTRAL_SIG, 0);
      rec.writeUInt16LE(20, 4); // version made by
      rec.writeUInt16LE(20, 6); // version needed
      rec.writeUInt16LE(FLAG_UTF8, 8);
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(e.dosTime, 12);
      rec.writeUInt16LE(e.dosDate, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.compressed, 20);
      rec.writeUInt32LE(e.uncompressed, 24);
      rec.writeUInt16LE(e.name.length, 28);
      rec.writeUInt16LE(0, 30); // extra
      rec.writeUInt16LE(0, 32); // comment
      rec.writeUInt16LE(0, 34); // disk number start
      rec.writeUInt16LE(0, 36); // internal attributes
      rec.writeUInt32LE(0, 38); // external attributes
      rec.writeUInt32LE(e.offset, 42);
      parts.push(rec, e.name);
      size += rec.length + e.name.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // this disk
    eocd.writeUInt16LE(0, 6); // disk with central directory
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(size, 12);
    eocd.writeUInt32LE(this.offset, 16);
    eocd.writeUInt16LE(0, 20); // no archive comment
    parts.push(eocd);
    return Buffer.concat(parts);
  }
}
