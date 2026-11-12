// SPDX-License-Identifier: MPL-2.0
/**
 * The shared sniff table (catalog/sniff.ts): each container is named by its own
 * bytes, from fixtures a few bytes long built here, never by the filename. The
 * images, PDF and SVG are named exactly as before; export review classifies its
 * formats exactly as before; every schema word is one the open asset schema has;
 * and the words Work wrote before the table read as the schema word the table
 * now writes for the same file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  LEGACY_TYPE_WORDS, MEDIA_FORMATS, previewKindOf, schemaTypeForFormat, schemaTypeOf, sniffBytes, typeWordsOf,
} from '../server/src/catalog/sniff.ts';
import { artifactMedia } from '../server/src/approvals/export-review.ts';

// ── fixture builders ────────────────────────────────────────────────────────

const bytes = (...parts: Array<string | number[] | Buffer>): Buffer =>
  Buffer.concat(parts.map((p) => typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)));
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

/** An ISO media box: size, type, payload. */
const box = (type: string, ...payload: Array<string | number[] | Buffer>): Buffer => {
  const body = bytes(...payload);
  return bytes(u32(8 + body.length), type, body);
};
const ftyp = (major: string, ...compat: string[]): Buffer => box('ftyp', major, u32(0), ...compat);
/** A movie box holding one track per handler (`vide`, `soun`). */
const moov = (...handlers: string[]): Buffer => box('moov', ...handlers.map((h) =>
  box('trak', box('mdia', box('hdlr', u32(0), u32(0), h, Buffer.alloc(12), [0])))));
const mdat = box('mdat', Buffer.alloc(16));

/** An EBML element with a one-byte size, or the eight-byte form when `wide`. */
const ebml = (id: number[], payload: Buffer | string, wide = false): Buffer => {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload;
  const size = wide ? bytes([0x01, 0, 0, 0, 0, 0, 0, body.length]) : bytes([0x80 | body.length]);
  return bytes(id, size, body);
};
/** A WebM or Matroska file whose Segment has an unknown size, as a browser recorder writes one. */
const matroska = (docType: string, ...trackTypes: number[]): Buffer => bytes(
  ebml([0x1a, 0x45, 0xdf, 0xa3], bytes(ebml([0x42, 0x86], bytes([1])), ebml([0x42, 0x82], docType))),
  [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  ebml([0x15, 0x49, 0xa9, 0x66], Buffer.alloc(4)),
  ebml([0x16, 0x54, 0xae, 0x6b], bytes(...trackTypes.map((t) => ebml([0xae], bytes(ebml([0xd7], bytes([1])), ebml([0x83], bytes([t]))))) ), true),
  ebml([0x1f, 0x43, 0xb6, 0x75], Buffer.alloc(8)),
);

/** One Ogg page that begins a stream, holding one packet. */
const oggPage = (packet: string): Buffer => {
  const body = Buffer.from(packet.padEnd(30, '\0'), 'latin1');
  return bytes('OggS', [0, 0x02], Buffer.alloc(8), Buffer.alloc(4), Buffer.alloc(4), Buffer.alloc(4), [1, body.length], body);
};

/** Two MPEG-1 Layer III frames at 32 kbps and 48 kHz: 96 bytes each. */
const mp3Frame = bytes([0xff, 0xfb, 0x14, 0x00], Buffer.alloc(92));
/** One ADTS frame of `length` bytes (AAC-LC, 44.1 kHz, stereo). */
const adtsFrame = (length: number): Buffer => bytes(
  [0xff, 0xf1, 0x50, 0x80 | ((length >> 11) & 0x03), (length >> 3) & 0xff, ((length & 0x07) << 5) | 0x1f, 0xfc], Buffer.alloc(length - 7));

/** A ZIP of empty stored entries, with a central directory unless `cut`. */
function zip(names: string[], cut = false): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const n = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(n.length, 26);
    local.push(head, n);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += 30 + n.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return cut ? Buffer.concat(local) : Buffer.concat([...local, cd, end]);
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000000200010005fe02fea7c1cd0e0000000049454e44ae426082', 'hex');

/** The facts a sniff names, without the dimensions. */
const named = (buf: Buffer, filename?: string) => {
  const { contentType, format, preview, schemaType } = sniffBytes(buf, filename === undefined ? undefined : { filename });
  return { contentType, format, preview, schemaType };
};

// ── each container ──────────────────────────────────────────────────────────

test('the images, PDF and SVG are named exactly as before, with their dimensions', () => {
  assert.deepEqual(sniffBytes(PNG), { contentType: 'image/png', format: 'png', preview: 'image', schemaType: 'raster', width: 1, height: 1 });
  assert.deepEqual(named(bytes([0xff, 0xd8, 0xff, 0xe0]), 'x.jpeg'), { contentType: 'image/jpeg', format: 'jpg', preview: 'image', schemaType: 'raster' });
  assert.deepEqual(sniffBytes(bytes('GIF89a', [3, 0, 2, 0])), { contentType: 'image/gif', format: 'gif', preview: 'image', schemaType: 'raster', width: 3, height: 2 });
  assert.deepEqual(named(bytes('RIFF', u32(0), 'WEBPVP8 ', Buffer.alloc(14))), { contentType: 'image/webp', format: 'webp', preview: 'image', schemaType: 'raster' });
  assert.deepEqual(named(bytes('%PDF-1.7\n')), { contentType: 'application/pdf', format: 'pdf', preview: 'document', schemaType: 'data' });
  assert.deepEqual(sniffBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"/>')),
    { contentType: 'image/svg+xml', format: 'svg', preview: 'image', schemaType: 'vector', width: 200, height: 100 });
  // Submit's SVG test is the narrower one it always was: only an SVG doctype may
  // come first. Export review's own test still allows any doctype.
  const htmlFirst = Buffer.from('<!DOCTYPE html><svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(sniffBytes(htmlFirst).contentType, 'application/octet-stream');
  assert.equal(artifactMedia('svg', htmlFirst)?.mediaType, 'image/svg+xml');
});

test('ISO media files are named by their brands, and by their tracks when the brands are generic', () => {
  const video = { contentType: 'video/mp4', format: 'mp4', preview: 'video', schemaType: 'video' };
  assert.deepEqual(named(bytes(ftyp('isom', 'isom', 'iso2', 'avc1', 'mp41'), moov('vide', 'soun'), mdat)), video);
  // The movie box after the media data, with a 64-bit size on the media box:
  // only a walk that steps over that box finds the sound-only track.
  const large = bytes(u32(1), 'mdat', [0, 0, 0, 0, 0, 0, 0, 24], Buffer.alloc(8));
  assert.equal(named(bytes(ftyp('mp42', 'isom'), large, moov('soun'))).format, 'm4a');
  assert.equal(named(bytes(ftyp('mp42', 'isom'), large, moov('vide'))).format, 'mp4');
  assert.deepEqual(named(bytes(ftyp('M4V ', 'M4V ', 'mp42'), moov('vide'))), { ...video, format: 'm4v' });
  assert.deepEqual(named(bytes(ftyp('qt  ', 'qt  '), moov('vide'))), { contentType: 'video/quicktime', format: 'mov', preview: 'video', schemaType: 'video' });
  const audio = { contentType: 'audio/mp4', format: 'm4a', preview: 'audio', schemaType: 'audio' };
  assert.deepEqual(named(bytes(ftyp('M4A ', 'M4A ', 'mp42', 'isom'))), audio);
  assert.deepEqual(named(bytes(ftyp('isom', 'iso2'), moov('soun'))), audio, 'a generic MP4 with sound and no picture');
  assert.deepEqual(named(bytes(ftyp('avif', 'mif1', 'miaf'))), { contentType: 'image/avif', format: 'avif', preview: 'image', schemaType: 'raster' });
  assert.deepEqual(named(bytes(ftyp('mif1', 'mif1', 'avif'))), { contentType: 'image/avif', format: 'avif', preview: 'image', schemaType: 'raster' });
  assert.deepEqual(named(bytes(ftyp('heic', 'mif1', 'heic'))), { contentType: 'image/heic', format: 'heic', preview: 'none', schemaType: 'raster' });
  // A brand the table does not know is not guessed at.
  assert.equal(named(bytes(ftyp('crx ', 'crx ')), 'photo.cr3').contentType, 'application/octet-stream');
});

test('WebM and Matroska are named by the DocType, and as sound when no track is a picture', () => {
  assert.deepEqual(named(matroska('webm', 1, 2)), { contentType: 'video/webm', format: 'webm', preview: 'video', schemaType: 'video' });
  assert.deepEqual(named(matroska('webm', 2)), { contentType: 'audio/webm', format: 'webm', preview: 'audio', schemaType: 'audio' });
  assert.deepEqual(named(matroska('matroska', 1)), { contentType: 'video/x-matroska', format: 'mkv', preview: 'none', schemaType: 'video' });
  assert.deepEqual(named(matroska('matroska', 2)), { contentType: 'audio/x-matroska', format: 'mka', preview: 'none', schemaType: 'audio' });
  assert.equal(named(matroska('other', 1)).contentType, 'application/octet-stream');
});

test('Ogg is named by the codec its streams open with', () => {
  const sound = { contentType: 'audio/ogg', format: 'ogg', preview: 'audio', schemaType: 'audio' };
  assert.deepEqual(named(oggPage('\x01vorbis')), sound);
  assert.deepEqual(named(oggPage('OpusHead')), sound);
  assert.deepEqual(named(bytes(oggPage('\x80theora'), oggPage('\x01vorbis'))), { contentType: 'video/ogg', format: 'ogv', preview: 'video', schemaType: 'video' });
  assert.equal(named(oggPage('unknown!')).contentType, 'application/octet-stream');
});

test('MP3, AAC, WAV and FLAC are named by their frames and headers', () => {
  const mp3 = { contentType: 'audio/mpeg', format: 'mp3', preview: 'audio', schemaType: 'audio' };
  assert.deepEqual(named(bytes('ID3', [3, 0, 0, 0, 0, 0, 0], mp3Frame)), mp3);
  assert.deepEqual(named(bytes(mp3Frame, mp3Frame)), mp3);
  // One frame header alone is not enough: plenty of files open with 0xFF.
  assert.equal(named(bytes(mp3Frame, Buffer.alloc(8)), 'song.mp3').contentType, 'application/octet-stream');
  assert.equal(named(bytes([0xff, 0x00, 0x00, 0x00]), 'x.mp3').contentType, 'application/octet-stream');
  const aac = { contentType: 'audio/aac', format: 'aac', preview: 'audio', schemaType: 'audio' };
  assert.deepEqual(named(bytes(adtsFrame(16), adtsFrame(16))), aac);
  assert.deepEqual(named(bytes('ID3', [4, 0, 0, 0, 0, 0, 0], adtsFrame(16))), aac);
  assert.deepEqual(named(bytes('RIFF', u32(0), 'WAVEfmt ', Buffer.alloc(20))), { contentType: 'audio/wav', format: 'wav', preview: 'audio', schemaType: 'audio' });
  assert.deepEqual(named(bytes('fLaC', Buffer.alloc(38))), { contentType: 'audio/flac', format: 'flac', preview: 'audio', schemaType: 'audio' });
});

test('a ZIP is named by what it holds, and keeps an extension the table does not claim', () => {
  const archive = { contentType: 'application/zip', format: 'zip', preview: 'archive', schemaType: 'data' };
  assert.deepEqual(named(zip(['notes.txt'])), archive);
  assert.deepEqual(named(zip([])), archive, 'an empty archive');
  assert.deepEqual(named(zip(['manifest.json', 'lolly.txt']), 'My design.lolly'), { ...archive, format: 'lolly' });
  assert.deepEqual(named(zip(['designmap.xml']), 'brochure.idml'), { ...archive, format: 'idml' });
  assert.deepEqual(named(zip(['notes.txt']), 'photo.png'), archive, 'a name cannot claim a format the bytes are not');
  const office = ['[Content_Types].xml', '_rels/.rels'];
  assert.deepEqual(named(zip([...office, 'word/document.xml'])),
    { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', format: 'docx', preview: 'document', schemaType: 'data' });
  assert.equal(named(zip([...office, 'ppt/presentation.xml']), 'deck.zip').format, 'pptx');
  assert.equal(named(zip([...office, 'ppt/presentation.xml']), 'deck.docx').format, 'pptx', 'the bytes say which Office file');
  assert.equal(named(zip([...office, 'xl/workbook.xml'])).format, 'xlsx');
  // A template keeps its name: Office refuses one renamed to .pptx.
  assert.deepEqual(named(zip([...office, 'ppt/presentation.xml']), 'brand.potx'), { ...archive, format: 'potx' });
  // Without a readable directory the local headers name the entries.
  assert.equal(named(zip([...office, 'word/document.xml'], true)).format, 'docx');
  assert.deepEqual(named(zip(['manifest.json', 'a/sequence.json'])), { contentType: 'application/zip+dotlottie', format: 'lottie', preview: 'none', schemaType: 'lottie' });
  assert.equal(named(zip(['manifest.json', 'animations/intro.json'])).format, 'lottie');
});

test('the filename never decides a known container, and an unknown one keeps its extension as before', () => {
  const mp4 = bytes(ftyp('isom', 'isom'), moov('vide'));
  assert.equal(sniffBytes(mp4, { contentType: 'audio/mpeg', filename: 'song.mp3' }).contentType, 'video/mp4');
  assert.deepEqual(sniffBytes(Buffer.from('not a video at all'), { contentType: 'video/mp4', filename: 'clip.mp4' }),
    { contentType: 'application/octet-stream', format: 'mp4', preview: 'none', schemaType: 'data' });
  assert.equal(sniffBytes(Buffer.from('plain'), { filename: 'Campaign Hero' }).format, 'bin');
  assert.equal(sniffBytes(Buffer.from('plain')).format, 'bin');
  // Fonts are left to the fallback on purpose (see catalog/sniff.ts).
  assert.equal(sniffBytes(bytes([0, 1, 0, 0], Buffer.alloc(8)), { filename: 'Brand.ttf' }).contentType, 'application/octet-stream');
  assert.equal(sniffBytes(bytes('wOF2', Buffer.alloc(8)), { filename: 'Brand.woff2' }).schemaType, 'data');
});

test('every row names a schema word the open asset schema has, and a preview the panels know', () => {
  const schema = JSON.parse(readFileSync(new URL('../vendor/@lolly/schemas/asset.schema.json', import.meta.url), 'utf8')) as {
    properties: { type: { enum: string[] } };
  };
  const words = new Set(schema.properties.type.enum);
  for (const [key, row] of Object.entries(MEDIA_FORMATS)) {
    assert.ok(words.has(row.schemaType), `${key}: ${row.schemaType} is in the schema`);
    assert.ok(['image', 'video', 'audio', 'document', 'archive', 'none'].includes(row.preview), `${key}: ${row.preview}`);
    assert.match(row.format, /^[a-z0-9]{1,12}$/, `${key}: the format is a URL segment`);
    assert.match(row.mediaType, /^[a-z]+\/[a-z0-9.+-]+$/, `${key}: a bare media type`);
  }
  assert.ok(words.has(sniffBytes(Buffer.from('?')).schemaType), 'the fallback word too');
});

test('a stored media type reads back as its preview, and octet-stream as none', () => {
  assert.equal(previewKindOf('video/mp4'), 'video');
  assert.equal(previewKindOf('audio/mpeg'), 'audio');
  assert.equal(previewKindOf('audio/webm'), 'audio');
  assert.equal(previewKindOf('image/svg+xml'), 'image');
  assert.equal(previewKindOf('Image/PNG; charset=binary'), 'image');
  assert.equal(previewKindOf('application/pdf'), 'document');
  assert.equal(previewKindOf('application/zip'), 'archive');
  assert.equal(previewKindOf('application/octet-stream'), 'none');
  assert.equal(previewKindOf('application/json'), 'none');
});

test('the older type words and the schema words agree in both directions', () => {
  // Before the table, submit wrote `icon` for an SVG and `image` for everything
  // else. Read through the record's format, that word is the schema word the
  // table now writes for the same bytes, so an older record and a newer one of
  // the same file answer the same question the same way.
  const oldDefault = (format: string): string => format === 'svg' ? 'icon' : 'image';
  for (const row of Object.values(MEDIA_FORMATS)) {
    if (MEDIA_FORMATS[row.format as keyof typeof MEDIA_FORMATS] !== row) continue;
    assert.equal(schemaTypeOf(oldDefault(row.format), row.format), row.schemaType, row.format);
    assert.equal(schemaTypeForFormat(row.format), row.schemaType, row.format);
  }
  assert.equal(schemaTypeOf('image', 'psd'), 'data');
  assert.equal(schemaTypeOf('image', 'psd'), sniffBytes(Buffer.from('8BPS'), { filename: 'art.psd' }).schemaType);
  assert.equal(schemaTypeOf('icon', 'svg'), 'vector');
  assert.equal(schemaTypeOf('image', 'MP4'), 'video');
  // Any other word is already the record's own and passes through.
  for (const word of ['raster', 'vector', 'video', 'template', 'user-tool', 'partner-kit', 'logo']) assert.equal(schemaTypeOf(word, 'png'), word);
  assert.deepEqual([...LEGACY_TYPE_WORDS].sort(), ['icon', 'image']);
});

test('a submitted asset answers to the older and the newer name for its type; other entries to their own', () => {
  const inst = (type: string, format: string) => ({ id: 'inst/x', type, formats: [{ format, url: `/catalog/inst/x/${format}` }] });
  const words = (e: Parameters<typeof typeWordsOf>[0]) => typeWordsOf(e).sort();
  // Older records answer to the schema word as well.
  assert.deepEqual(words(inst('icon', 'svg')), ['icon', 'vector']);
  assert.deepEqual(words(inst('image', 'png')), ['image', 'raster']);
  assert.deepEqual(words(inst('image', 'mp4')), ['image', 'video']);
  assert.deepEqual(words(inst('image', 'psd')), ['data', 'image']);
  // Newer records answer to the word the older submit would have written.
  assert.deepEqual(words(inst('vector', 'svg')), ['icon', 'vector']);
  assert.deepEqual(words(inst('raster', 'png')), ['image', 'raster']);
  assert.deepEqual(words(inst('video', 'mp4')), ['image', 'video']);
  assert.deepEqual(words(inst('data', 'psd')), ['data', 'image']);
  // A word someone chose keeps its own meaning.
  assert.deepEqual(words(inst('template', 'json')), ['template']);
  assert.deepEqual(words(inst('icon', 'png')), ['icon', 'raster'], 'a declared icon PNG is not an image');
  assert.deepEqual(words(inst('raster', 'svg')), ['raster']);
  // Pack and provider entries never had the older defaults.
  assert.deepEqual(words({ id: 'acme/logo', type: 'vector', formats: [{ format: 'svg' }] }), ['vector']);
  assert.deepEqual(words({ id: 'ext/dam/1', type: 'image', formats: [{ format: 'png' }] }), ['image']);
  assert.deepEqual(words({ id: 'inst/x', type: 'image' }), ['image'], 'no format, no second name');
  assert.deepEqual(words({ id: 'inst/x' }), []);
});

// ── export review keeps its classification ──────────────────────────────────

test('export review classifies every format it knew exactly as before, and no other', () => {
  const iso = bytes(ftyp('isom', 'isom'));
  const before: Array<[string, Buffer, { mediaType: string; preview: string }]> = [
    ['png', PNG, { mediaType: 'image/png', preview: 'image' }],
    ['jpg', bytes([0xff, 0xd8, 0xff, 0xdb]), { mediaType: 'image/jpeg', preview: 'image' }],
    ['gif', bytes('GIF87a'), { mediaType: 'image/gif', preview: 'image' }],
    ['webp', bytes('RIFF', u32(0), 'WEBP'), { mediaType: 'image/webp', preview: 'image' }],
    ['avif', iso, { mediaType: 'image/avif', preview: 'image' }],
    ['svg', Buffer.from('﻿<?xml version="1.0"?><svg/>'), { mediaType: 'image/svg+xml', preview: 'image' }],
    ['pdf', bytes('%PDF-1.4'), { mediaType: 'application/pdf', preview: 'pdf' }],
    ['mp4', iso, { mediaType: 'video/mp4', preview: 'video' }],
    ['mov', iso, { mediaType: 'video/quicktime', preview: 'video' }],
    ['webm', bytes([0x1a, 0x45, 0xdf, 0xa3]), { mediaType: 'video/webm', preview: 'video' }],
    ['mp3', bytes('ID3'), { mediaType: 'audio/mpeg', preview: 'audio' }],
    ['mp3', bytes([0xff, 0x00]), { mediaType: 'audio/mpeg', preview: 'audio' }],
    ['wav', bytes('RIFF', u32(0), 'WAVE'), { mediaType: 'audio/wav', preview: 'audio' }],
    ['zip', bytes([0x50, 0x4b, 0x03, 0x04]), { mediaType: 'application/zip', preview: 'none' }],
    ['zip', bytes([0x50, 0x4b, 0x05, 0x06]), { mediaType: 'application/zip', preview: 'none' }],
  ];
  for (const [format, head, media] of before) {
    assert.deepEqual(artifactMedia(format, head), media, format);
    assert.equal(artifactMedia(format, Buffer.from('<html>nope</html>')), null, `${format} refuses bytes that contradict it`);
  }
  // A format export review did not know stays opaque, whatever its bytes, so no
  // Lolly export is refused for a format it was accepted in before.
  for (const format of ['m4a', 'ogg', 'flac', 'aac', 'docx', 'lottie', 'eps']) {
    assert.deepEqual(artifactMedia(format, Buffer.from('anything')), { mediaType: 'application/octet-stream', preview: 'none' }, format);
  }
});

test('a file cut short anywhere, or random bytes, never makes the sniffer throw', () => {
  const office = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
  const fixtures = [
    bytes(ftyp('isom', 'iso2'), bytes(u32(1), 'mdat', [0, 0, 0, 0, 0, 0, 0, 24], Buffer.alloc(8)), moov('soun')),
    matroska('webm', 2), bytes(oggPage('\x80theora'), oggPage('OpusHead')), bytes('ID3', [4, 0x10, 0, 0, 0, 0x7f], adtsFrame(16)),
    bytes(mp3Frame, mp3Frame), bytes(adtsFrame(16), adtsFrame(16)), zip(office), zip(office, true), zip(['manifest.json', 'a/x.json']),
  ];
  for (const whole of fixtures) {
    for (let n = 0; n <= whole.length; n++) assert.doesNotThrow(() => sniffBytes(whole.subarray(0, n), { filename: 'cut.bin' }));
  }
  // A seeded generator, so a failure names the same bytes on every run.
  let seed = 357;
  const next = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; };
  const leads = [[0x1a, 0x45, 0xdf, 0xa3], [0x4f, 0x67, 0x67, 0x53], [0x50, 0x4b, 0x03, 0x04], [0xff, 0xfb], [0xff, 0xf1], [0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], [0x49, 0x44, 0x33]];
  for (let i = 0; i < 2000; i++) {
    const lead = leads[i % leads.length]!;
    const tail = Buffer.from(Array.from({ length: next() + 1 }, next));
    assert.doesNotThrow(() => sniffBytes(bytes(lead, tail)));
  }
});
