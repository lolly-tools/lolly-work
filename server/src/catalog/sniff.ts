// SPDX-License-Identifier: MPL-2.0
/**
 * What a stored file is, read from its own bytes. One table names every format
 * this server recognises: the media type it is served with, the preview a
 * reviewer gets and the open asset schema's `type` word for it
 * (schemas/asset.schema.json). Catalog submit identifies a file with
 * `sniffBytes`. Export review confirms the format a Lolly app named with
 * `MEDIA_FORMATS` and `namedMediaFormat` (approvals/export-review.ts). Both read
 * the same rows, so a format cannot be served as one type in the catalog and
 * reviewed as another.
 *
 * Content decides. The submitter's declared content type and filename never
 * choose a type: a client that lies about a file must not decide what the
 * catalog serves it as, and `x-content-type-options: nosniff` on the blob routes
 * only helps if what was stored is honest. The filename is read in two places
 * only, both after the bytes have answered: an unknown file keeps its extension
 * as its format so the URL stays readable, and a ZIP keeps an extension the
 * table does not claim (`.lolly`, `.idml`) because the container is proven and
 * the download should keep its name.
 *
 * Fonts are not in the table on purpose. `font` is a design-system type that
 * every partner programme receives and the licence gate never holds
 * (programmes/types.ts), so typing a submitted font `font` by default would
 * widen its audience past the groups its submitter chose.
 */

/** What a reviewer can be shown for a file. */
export type PreviewKind = 'image' | 'video' | 'audio' | 'document' | 'archive' | 'none';

/** The open asset schema's `type` words this table can produce. */
export type SchemaType = 'raster' | 'vector' | 'video' | 'audio' | 'lottie' | 'data';

export interface MediaFormat {
  /** Lowercase extension: the blob key, the URL segment and the download's extension. */
  format: string;
  /** The media type the bytes are stored and served with. */
  mediaType: string;
  preview: PreviewKind;
  /** The open asset schema's `type` for a file of this format. */
  schemaType: SchemaType;
  /**
   * Whether a file's opening bytes are this format's container, for a caller that
   * was told the format (export review). A family check: every ISO media file
   * passes for `mp4`, `mov` and `avif` alike, because the named format is the
   * export's own word and only a contradiction is refused.
   */
  opens(head: Uint8Array): boolean;
}

const ascii = (b: Uint8Array, from: number, to: number): string => Buffer.from(b.subarray(from, to)).toString('latin1');
const opensWith = (b: Uint8Array, ...lead: number[]): boolean => lead.every((byte, i) => b[i] === byte);
const isIsoMedia = (b: Uint8Array): boolean => ascii(b, 4, 8) === 'ftyp';
const isEbml = (b: Uint8Array): boolean => opensWith(b, 0x1a, 0x45, 0xdf, 0xa3);
const isOgg = (b: Uint8Array): boolean => ascii(b, 0, 4) === 'OggS';
const isZip = (b: Uint8Array): boolean => opensWith(b, 0x50, 0x4b, 0x03, 0x04) || opensWith(b, 0x50, 0x4b, 0x05, 0x06);
const isRiff = (b: Uint8Array, form: string): boolean => (ascii(b, 0, 4) === 'RIFF' || ascii(b, 0, 4) === 'RF64') && ascii(b, 8, 12) === form;
/** Export review's SVG test: text, then an <svg root, allowing a BOM, an XML
 *  declaration, comments and a doctype first. Kept exactly as it was. */
const isSvgNamed = (b: Uint8Array): boolean => /^(?:\uFEFF)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s/>]/i.test(Buffer.from(b.subarray(0, 64 * 1024)).toString('utf8'));
const isAdtsSync = (b: Uint8Array, at = 0): boolean => b[at] === 0xff && ((b[at + 1] ?? 0) & 0xf6) === 0xf0;

const fmt = (format: string, mediaType: string, preview: PreviewKind, schemaType: SchemaType, opens: (b: Uint8Array) => boolean): MediaFormat =>
  ({ format, mediaType, preview, schemaType, opens });

/**
 * The table. A key equal to its `format` is that format's canonical row, the one
 * a caller that names the format reads (`namedMediaFormat`). The other keys are
 * the same extension holding a different medium, such as a WebM with sound and
 * no picture, which only the sniffer returns.
 */
export const MEDIA_FORMATS = {
  png: fmt('png', 'image/png', 'image', 'raster', b => opensWith(b, 0x89, 0x50, 0x4e, 0x47)),
  jpg: fmt('jpg', 'image/jpeg', 'image', 'raster', b => opensWith(b, 0xff, 0xd8, 0xff)),
  gif: fmt('gif', 'image/gif', 'image', 'raster', b => ascii(b, 0, 4) === 'GIF8'),
  webp: fmt('webp', 'image/webp', 'image', 'raster', b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP'),
  avif: fmt('avif', 'image/avif', 'image', 'raster', isIsoMedia),
  // Browsers other than Safari draw neither, so a reviewer downloads them.
  heic: fmt('heic', 'image/heic', 'none', 'raster', isIsoMedia),
  heif: fmt('heif', 'image/heif', 'none', 'raster', isIsoMedia),
  svg: fmt('svg', 'image/svg+xml', 'image', 'vector', isSvgNamed),
  pdf: fmt('pdf', 'application/pdf', 'document', 'data', b => ascii(b, 0, 5) === '%PDF-'),
  mp4: fmt('mp4', 'video/mp4', 'video', 'video', isIsoMedia),
  // An M4V is an MP4 by another name, and every browser that plays one plays the other.
  m4v: fmt('m4v', 'video/mp4', 'video', 'video', isIsoMedia),
  mov: fmt('mov', 'video/quicktime', 'video', 'video', isIsoMedia),
  webm: fmt('webm', 'video/webm', 'video', 'video', isEbml),
  'webm-audio': fmt('webm', 'audio/webm', 'audio', 'audio', isEbml),
  // Matroska plays in some browsers and not others, so a reviewer downloads the file.
  mkv: fmt('mkv', 'video/x-matroska', 'none', 'video', isEbml),
  mka: fmt('mka', 'audio/x-matroska', 'none', 'audio', isEbml),
  ogv: fmt('ogv', 'video/ogg', 'video', 'video', isOgg),
  ogg: fmt('ogg', 'audio/ogg', 'audio', 'audio', isOgg),
  mp3: fmt('mp3', 'audio/mpeg', 'audio', 'audio', b => ascii(b, 0, 3) === 'ID3' || opensWith(b, 0xff)),
  m4a: fmt('m4a', 'audio/mp4', 'audio', 'audio', isIsoMedia),
  aac: fmt('aac', 'audio/aac', 'audio', 'audio', b => isAdtsSync(b)),
  wav: fmt('wav', 'audio/wav', 'audio', 'audio', b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE'),
  flac: fmt('flac', 'audio/flac', 'audio', 'audio', b => ascii(b, 0, 4) === 'fLaC'),
  lottie: fmt('lottie', 'application/zip+dotlottie', 'none', 'lottie', isZip),
  docx: fmt('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document', 'data', isZip),
  pptx: fmt('pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document', 'data', isZip),
  xlsx: fmt('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'document', 'data', isZip),
  zip: fmt('zip', 'application/zip', 'archive', 'data', isZip),
} as const satisfies Record<string, MediaFormat>;

type FormatKey = keyof typeof MEDIA_FORMATS;

/** Every extension the table names. A ZIP cannot borrow one of these from its filename. */
const CLAIMED_EXTENSIONS: ReadonlySet<string> = new Set([...Object.values(MEDIA_FORMATS).map((m) => m.format), 'jpeg']);

/** The canonical row for a format a caller named, or undefined when the table has none. */
export function namedMediaFormat(format: string): MediaFormat | undefined {
  return Object.hasOwn(MEDIA_FORMATS, format) ? MEDIA_FORMATS[format as FormatKey] : undefined;
}

/**
 * The preview for bytes stored under `mediaType`, read from the table. A stored
 * `application/octet-stream`, which is what every file this table did not know
 * was kept as, has none.
 */
export function previewKindOf(mediaType: string): PreviewKind {
  const bare = mediaType.split(';')[0]!.trim().toLowerCase();
  return Object.values(MEDIA_FORMATS).find((m) => m.mediaType === bare)?.preview ?? 'none';
}

// ── the schema type, and the words Work wrote before this table ─────────────

/**
 * Work's default `type` before this table was `icon` for an SVG and `image` for
 * everything else. Records keep the word they were written with and are served
 * with it, so nothing a client already holds changes. Each word stands for the
 * schema word the table gives the record's format, which is how a reader that
 * filters on the schema's vocabulary reads an older record.
 */
export const LEGACY_TYPE_WORDS: ReadonlySet<string> = new Set(['image', 'icon']);

/** The schema word for a stored format: the table's, or `data` for a format it does not know. */
export function schemaTypeForFormat(format: string): SchemaType {
  return namedMediaFormat(format.toLowerCase())?.schemaType ?? 'data';
}

/** An entry's `type` in the schema's vocabulary: an older default word read
 *  through its format, any other word unchanged. */
export function schemaTypeOf(type: string, format: string): string {
  return LEGACY_TYPE_WORDS.has(type) ? schemaTypeForFormat(format) : type;
}

/** The schema words the table can give a file of this format: one for most, two
 *  for WebM and Matroska (a picture track, or sound only), `data` for an unknown one. */
function schemaTypesForFormat(format: string): SchemaType[] {
  const words = new Set(Object.values(MEDIA_FORMATS).filter((m) => m.format === format).map((m) => m.schemaType));
  return words.size ? [...words] : ['data'];
}

/** Every word this table writes for a new submission without a declared type. */
const SCHEMA_DEFAULT_WORDS: ReadonlySet<string> = new Set<SchemaType>(['raster', 'vector', 'video', 'audio', 'lottie', 'data']);

/**
 * Every `type` word a served entry answers to when a reader filters or counts
 * by type. Only instance assets (`inst/`) have two names for one meaning, since
 * only catalog submit ever wrote the older defaults, so every other entry
 * answers to its own word alone.
 *
 * The pairing follows the record's stored word, so it survives a new version in
 * another format, and a record written before the table answers to the same
 * words as one written after. `icon` and `vector` always answer to each other,
 * since `icon` was only ever the older word for what is now `vector`. Every
 * other schema word answers to `image`, and an older `image` answers to what its
 * current bytes are, read from the format the record now serves: an `image` PNG
 * to `raster`, and an `image` WebM to both `video` and `audio`, because the
 * older record does not say which. A word someone chose, such as `template` or
 * `logo`, answers to itself alone.
 */
export function typeWordsOf(entry: { id?: unknown; type?: unknown; formats?: unknown }): string[] {
  if (typeof entry.type !== 'string' || !entry.type) return [];
  if (typeof entry.id !== 'string' || !entry.id.startsWith('inst/')) return [entry.type];
  const first: unknown = Array.isArray(entry.formats) ? entry.formats[0] : undefined;
  const format = first && typeof first === 'object' && typeof (first as { format?: unknown }).format === 'string'
    ? ((first as { format: string }).format).toLowerCase() : '';
  const words = new Set([entry.type]);
  if (SCHEMA_DEFAULT_WORDS.has(entry.type)) words.add(entry.type === 'vector' ? 'icon' : 'image');
  if (entry.type === 'icon') words.add('vector');
  else if (entry.type === 'image' && format) for (const word of schemaTypesForFormat(format)) words.add(word);
  return [...words];
}

// ── dimensions ───────────────────────────────────────────────────────────────

const SVG_DIM = (svg: string, attr: 'width' | 'height'): number | undefined => {
  const m = new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([0-9.]+)`, 'i').exec(svg);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
};

/** JPEG carries its dimensions in a start-of-frame segment, which follows a
 *  variable number of metadata segments, so the segments have to be walked. */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1] as number;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return undefined;
    i += 2 + len;
  }
  return undefined;
}

function webpSize(buf: Buffer): { width: number; height: number } | undefined {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  return undefined;
}

// ── containers that need more than their first bytes ────────────────────────

/** Most boxes, elements or pages one walk reads, so a hostile file cannot keep a walk going. */
const WALK_LIMIT = 10_000;

/**
 * An ISO media file (MP4, MOV, M4A, AVIF, HEIC) by its brands, and by its tracks
 * when the brands are the generic ones: a generic MP4 with sound and no picture
 * is an M4A. Null when the brands name nothing in the table.
 */
function isoMedia(buf: Buffer): MediaFormat | null {
  const ftypSize = buf.readUInt32BE(0);
  const end = Math.min(buf.length, ftypSize >= 16 ? ftypSize : 16, 16 + 4 * 64);
  const major = buf.toString('latin1', 8, 12);
  const brands = new Set([major]);
  for (let at = 16; at + 4 <= end; at += 4) brands.add(buf.toString('latin1', at, at + 4));
  const has = (...names: string[]): boolean => names.some((n) => brands.has(n));
  if (has('avif', 'avis')) return MEDIA_FORMATS.avif;
  if (has('heic', 'heix', 'heim', 'heis', 'hevc', 'hevx')) return MEDIA_FORMATS.heic;
  if (has('mif1', 'msf1')) return MEDIA_FORMATS.heif;
  if (major === 'qt  ') return MEDIA_FORMATS.mov;
  if (major.startsWith('M4V')) return MEDIA_FORMATS.m4v;
  const handlers = isoTrackHandlers(buf);
  const video = handlers.has('vide'), audio = handlers.has('soun');
  if (!video && (audio || has('M4A ', 'M4B ', 'M4P ', 'F4A '))) return MEDIA_FORMATS.m4a;
  const generic = [...brands].some((b) => /^(?:iso[2-9m]|isom|mp4[12]|mp71|avc1|dash|msdh|msix|mmp4|3gp\d|3g2\w|MSNV|f4v |XAVC|M4A )$/.test(b));
  return video || generic ? MEDIA_FORMATS.mp4 : null;
}

/** The handler of every track in the movie box: `vide` for a picture, `soun` for sound. */
function isoTrackHandlers(buf: Buffer): Set<string> {
  const found = new Set<string>();
  let steps = 0;
  const walk = (from: number, to: number, path: string): void => {
    let at = from;
    while (at + 8 <= to && steps++ < WALK_LIMIT) {
      let size = buf.readUInt32BE(at);
      const type = buf.toString('latin1', at + 4, at + 8);
      let header = 8;
      if (size === 1) {
        if (at + 16 > to) return;
        size = Number(buf.readBigUInt64BE(at + 8));
        header = 16;
      } else if (size === 0) size = to - at;
      if (size < header || at + size > to) return;
      const next = `${path}/${type}`;
      if (next === '/moov' || next === '/moov/trak' || next === '/moov/trak/mdia') walk(at + header, at + size, next);
      else if (next === '/moov/trak/mdia/hdlr' && size >= header + 12) found.add(buf.toString('latin1', at + header + 8, at + header + 12));
      at += size;
    }
  };
  walk(0, buf.length, '');
  return found;
}

/** An EBML variable-length number at `at`: its byte length and value. `keepMarker`
 *  reads an element id, whose length marker is part of the id. */
function ebmlVint(buf: Buffer, at: number, keepMarker: boolean): { len: number; value: number; unknown: boolean } | null {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > (keepMarker ? 4 : 8) || at + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let ones = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    const byte = buf[at + i] as number;
    value = value * 256 + byte;
    if (byte !== 0xff) ones = false;
  }
  return { len, value, unknown: !keepMarker && ones };
}

const EBML_DOCTYPE = 0x4282, EBML_SEGMENT = 0x18538067, EBML_TRACKS = 0x1654ae6b, EBML_TRACK = 0xae, EBML_TRACK_TYPE = 0x83, EBML_CLUSTER = 0x1f43b675;

/**
 * WebM or Matroska by the header's DocType, then audio-only or not by the
 * TrackType of each track: a voice recording from a browser is a WebM with
 * sound and no picture. Tracks come before the first Cluster in every muxer this
 * reads, so the walk stops there.
 */
function ebmlMedia(buf: Buffer): MediaFormat | null {
  const headerSize = ebmlVint(buf, 4, false);
  if (!headerSize || headerSize.unknown) return null;
  const headerEnd = Math.min(buf.length, 4 + headerSize.len + headerSize.value);
  let docType = '';
  let steps = 0;
  const children = (from: number, to: number, visit: (id: number, start: number, end: number, unknown: boolean) => boolean | void): void => {
    let at = from;
    while (at < to && steps++ < WALK_LIMIT) {
      const id = ebmlVint(buf, at, true);
      if (!id) return;
      const size = ebmlVint(buf, at + id.len, false);
      if (!size) return;
      const start = at + id.len + size.len;
      const end = size.unknown ? to : Math.min(to, start + size.value);
      if (visit(id.value, start, end, size.unknown) === false) return;
      if (size.unknown) return;
      at = end;
    }
  };
  children(4 + headerSize.len, headerEnd, (id, start, end) => {
    if (id === EBML_DOCTYPE) docType = buf.toString('latin1', start, end);
  });
  if (docType !== 'webm' && docType !== 'matroska') return null;
  const kinds = new Set<number>();
  children(headerEnd, buf.length, (id, start, end) => {
    if (id !== EBML_SEGMENT) return;
    children(start, end, (child, cStart, cEnd) => {
      if (child === EBML_CLUSTER) return false;
      if (child === EBML_TRACKS) {
        children(cStart, cEnd, (entry, eStart, eEnd) => {
          if (entry !== EBML_TRACK) return;
          children(eStart, eEnd, (field, fStart, fEnd) => {
            if (field === EBML_TRACK_TYPE && fEnd > fStart && fEnd - fStart <= 6) kinds.add(buf.readUIntBE(fStart, fEnd - fStart));
          });
        });
        return false;
      }
    });
    return false;
  });
  const audioOnly = !kinds.has(1) && kinds.has(2);
  if (docType === 'webm') return audioOnly ? MEDIA_FORMATS['webm-audio'] : MEDIA_FORMATS.webm;
  return audioOnly ? MEDIA_FORMATS.mka : MEDIA_FORMATS.mkv;
}

/**
 * An Ogg file by the codec each stream's first page opens with. All of a
 * file's first pages come before any other page, so the walk stops at the first
 * page that does not begin a stream. Null when no stream is one this table knows.
 */
function oggMedia(buf: Buffer): MediaFormat | null {
  let at = 0, video = false, audio = false;
  for (let page = 0; page < 64 && at + 27 <= buf.length && buf.toString('latin1', at, at + 4) === 'OggS'; page++) {
    if (!((buf[at + 5] as number) & 0x02)) break;
    const segments = buf[at + 26] as number;
    const body = at + 27 + segments;
    let length = 0;
    for (let i = 0; i < segments; i++) length += buf[at + 27 + i] as number;
    const packet = buf.subarray(body, Math.min(buf.length, body + 8)).toString('latin1');
    if (packet.startsWith('\x80theora') || packet.startsWith('\x80daala') || packet.startsWith('OVP80')) video = true;
    else if (packet.startsWith('\x01vorbis') || packet.startsWith('OpusHead') || packet.startsWith('\x7fFLAC') || packet.startsWith('Speex   ')) audio = true;
    at = body + length;
  }
  return video ? MEDIA_FORMATS.ogv : audio ? MEDIA_FORMATS.ogg : null;
}

const MPEG_BITRATES: Record<string, readonly number[]> = {
  '3-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MPEG_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** The length of the MPEG audio frame whose header starts at `at`, or 0 when the
 *  four bytes there are not a valid header. Version 1 is `3`, 2 is `2`, 2.5 is `0`. */
function mpegFrameLength(buf: Buffer, at: number): number {
  if (at + 4 > buf.length || buf[at] !== 0xff || ((buf[at + 1] as number) & 0xe0) !== 0xe0) return 0;
  const version = ((buf[at + 1] as number) >> 3) & 3, layer = ((buf[at + 1] as number) >> 1) & 3;
  const bitrateIndex = (buf[at + 2] as number) >> 4, rateIndex = ((buf[at + 2] as number) >> 2) & 3, padding = ((buf[at + 2] as number) >> 1) & 1;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return 0;
  const table = MPEG_BITRATES[`${version === 3 ? 3 : 2}-${version === 3 ? layer : layer === 3 ? 3 : 2}`]!;
  const bitrate = table[bitrateIndex]! * 1000, rate = MPEG_RATES[version]![rateIndex]!;
  if (layer === 3) return (Math.floor((12 * bitrate) / rate) + padding) * 4;
  return Math.floor(((layer === 1 && version !== 3 ? 72 : 144) * bitrate) / rate) + padding;
}

/** The length of the ADTS (raw AAC) frame whose header starts at `at`, or 0. */
function adtsFrameLength(buf: Buffer, at: number): number {
  if (at + 7 > buf.length || !isAdtsSync(buf, at)) return 0;
  const length = (((buf[at + 3] as number) & 0x03) << 11) | ((buf[at + 4] as number) << 3) | ((buf[at + 5] as number) >> 5);
  return length >= 7 ? length : 0;
}

/**
 * MP3 or raw AAC. After an ID3 tag one frame header is enough, because the tag
 * already says the file is audio. Without one, a frame header has to be followed
 * by a second, since one 0xFF byte opens plenty of files that are not sound.
 */
function mpegAudio(buf: Buffer): MediaFormat | null {
  let at = 0;
  const tagged = buf.toString('latin1', 0, 3) === 'ID3' && buf.length >= 10;
  if (tagged) {
    const size = (((buf[6] as number) & 0x7f) << 21) | (((buf[7] as number) & 0x7f) << 14) | (((buf[8] as number) & 0x7f) << 7) | ((buf[9] as number) & 0x7f);
    at = 10 + size + (((buf[5] as number) & 0x10) ? 10 : 0);
    if (buf.toString('latin1', at, at + 4) === 'fLaC') return MEDIA_FORMATS.flac;
    if (adtsFrameLength(buf, at)) return MEDIA_FORMATS.aac;
    return MEDIA_FORMATS.mp3;
  }
  const adts = adtsFrameLength(buf, 0);
  if (adts && adtsFrameLength(buf, adts)) return MEDIA_FORMATS.aac;
  const frame = mpegFrameLength(buf, 0);
  if (frame && mpegFrameLength(buf, frame)) return MEDIA_FORMATS.mp3;
  return null;
}

/**
 * The names of a ZIP's entries, from its central directory, or from the local
 * headers in order when the directory cannot be read (a ZIP64 file, or one cut
 * short). Bounded by WALK_LIMIT either way.
 */
function zipEntryNames(buf: Buffer): string[] {
  const names: string[] = [];
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let at = buf.length - 22; at >= floor; at--) {
    if (buf.readUInt32LE(at) === 0x06054b50) { eocd = at; break; }
  }
  const count = eocd >= 0 ? buf.readUInt16LE(eocd + 10) : 0xffff;
  const dirAt = eocd >= 0 ? buf.readUInt32LE(eocd + 16) : 0xffffffff;
  if (count !== 0xffff && dirAt !== 0xffffffff && dirAt < buf.length) {
    let at = dirAt;
    for (let i = 0; i < count && i < WALK_LIMIT && at + 46 <= buf.length && buf.readUInt32LE(at) === 0x02014b50; i++) {
      const nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
      names.push(buf.toString('utf8', at + 46, Math.min(buf.length, at + 46 + nameLen)));
      at += 46 + nameLen + extra + comment;
    }
    return names;
  }
  let at = 0;
  for (let i = 0; i < WALK_LIMIT && at + 30 <= buf.length && buf.readUInt32LE(at) === 0x04034b50; i++) {
    const flags = buf.readUInt16LE(at + 6), packed = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26), extra = buf.readUInt16LE(at + 28);
    names.push(buf.toString('utf8', at + 30, Math.min(buf.length, at + 30 + nameLen)));
    // Sizes written after the data cannot be skipped without reading the data.
    if (flags & 0x08) break;
    at += 30 + nameLen + extra + packed;
  }
  return names;
}

/** A ZIP by what it holds: a dotLottie, an Office document, or an archive. */
function zipMedia(buf: Buffer, filename: string): MediaFormat {
  const names = zipEntryNames(buf);
  const has = (test: (name: string) => boolean): boolean => names.some(test);
  if (has((n) => n === 'manifest.json') && has((n) => /^(?:a|animations)\/[^/]+\.json$/.test(n))) return MEDIA_FORMATS.lottie;
  if (has((n) => n === '[Content_Types].xml')) {
    const office = has((n) => n.startsWith('word/')) ? MEDIA_FORMATS.docx
      : has((n) => n.startsWith('ppt/')) ? MEDIA_FORMATS.pptx
        : has((n) => n.startsWith('xl/')) ? MEDIA_FORMATS.xlsx : null;
    const ext = extensionOf(filename);
    // A template or macro file (.potx, .docm) is the same container under its own
    // name, and Office refuses one renamed to .pptx or .docx, so it keeps its name.
    if (office && (!ext || ext === office.format || CLAIMED_EXTENSIONS.has(ext))) return office;
  }
  const ext = extensionOf(filename);
  return ext && !CLAIMED_EXTENSIONS.has(ext) ? { ...MEDIA_FORMATS.zip, format: ext } : MEDIA_FORMATS.zip;
}

/** The filename's extension when it is a short lowercase slug, else ''. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot > 0 ? filename.slice(dot + 1) : '';
  return /^[a-z0-9]{1,12}$/i.test(ext) ? ext.toLowerCase() : '';
}

// ── the sniffer ──────────────────────────────────────────────────────────────

export interface SniffResult {
  contentType: string;
  /** Lowercase format name; doubles as the blob key and the URL segment. */
  format: string;
  preview: PreviewKind;
  schemaType: SchemaType;
  width?: number;
  height?: number;
}

const result = (m: MediaFormat, size?: { width?: number; height?: number }): SniffResult => ({
  contentType: m.mediaType, format: m.format, preview: m.preview, schemaType: m.schemaType,
  ...(size?.width ? { width: size.width } : {}), ...(size?.height ? { height: size.height } : {}),
});

/**
 * Identify submitted bytes from the bytes themselves. The images, PDF and SVG
 * are tested first and exactly as they were before the table grew, so no file
 * this sniffer named before is named differently now. The SVG test is the one
 * catalog submit always used, narrower than export review's: it reads the first
 * 1 KiB and allows only an SVG doctype.
 */
export function sniffBytes(buf: Buffer, declared?: { contentType?: string; filename?: string }): SniffResult {
  const magic = (hex: string, at = 0): boolean => buf.length >= at + hex.length / 2 && buf.toString('hex', at, at + hex.length / 2) === hex;
  if (magic('89504e470d0a1a0a')) {
    return result(MEDIA_FORMATS.png, buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : undefined);
  }
  if (magic('ffd8ff')) return result(MEDIA_FORMATS.jpg, jpegSize(buf));
  if (buf.toString('ascii', 0, 4) === 'GIF8' && buf.length >= 10) {
    return result(MEDIA_FORMATS.gif, { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) });
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return result(MEDIA_FORMATS.webp, webpSize(buf));
  if (magic('25504446')) return result(MEDIA_FORMATS.pdf);
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024));
  if (/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    const svg = buf.toString('utf8', 0, Math.min(buf.length, 4096));
    const open = svg.slice(svg.search(/<svg[\s>]/i));
    const tag = open.slice(0, open.indexOf('>') + 1 || open.length);
    const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
    const width = SVG_DIM(tag, 'width') ?? (box ? Math.round(Number(box[1])) : undefined);
    const height = SVG_DIM(tag, 'height') ?? (box ? Math.round(Number(box[2])) : undefined);
    return result(MEDIA_FORMATS.svg, { width, height });
  }
  const filename = declared?.filename ?? '';
  const media = buf.length >= 12 && isIsoMedia(buf) ? isoMedia(buf)
    : buf.length >= 8 && isEbml(buf) ? ebmlMedia(buf)
      : buf.length >= 27 && isOgg(buf) ? oggMedia(buf)
        : buf.toString('latin1', 0, 4) === 'fLaC' ? MEDIA_FORMATS.flac
          : buf.length >= 12 && isRiff(buf, 'WAVE') ? MEDIA_FORMATS.wav
            : buf.length >= 22 && isZip(buf) ? zipMedia(buf, filename)
              : mpegAudio(buf);
  if (media) return result(media);
  // Unrecognized container: keep the bytes, stay honest about not knowing what
  // they are. The extension names the format so the URL is readable; the served
  // content-type falls back to the generic one rather than to the client's word.
  const ext = filename.split('.').pop() ?? '';
  const format = /^[a-z0-9]{1,12}$/i.test(ext) ? ext.toLowerCase() : 'bin';
  return { contentType: 'application/octet-stream', format, preview: 'none', schemaType: 'data' };
}
