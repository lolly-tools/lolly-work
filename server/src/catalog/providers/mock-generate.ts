/**
 * Synthetic assets for the mock driver - tests and the demo only. A large
 * DAM is the case the shell and the feed have to survive, and nobody wants a
 * 20000-entry options blob in a test or in the demo store, so the mock can
 * describe its assets as a count instead and build each one on demand.
 *
 * Everything here is deterministic: asset `i` always has the same name, tags,
 * sections and bytes, so a sync, a page walk and a blob fetch agree without
 * any shared state between driver instances.
 */
import { crc32, deflateSync } from 'node:zlib';
import type { ProviderAssetRef } from './types.ts';

export interface MockGenerateOptions {
  /** How many synthetic assets the provider holds. */
  count: number;
  /** Shifts every name and colour, so two generated providers look different. */
  seed?: number;
  /** Every Nth asset is an SVG; the rest are PNGs. Default 2 (half and half). */
  svgEvery?: number;
}

const SECTIONS = ['Logos', 'Icons', 'Photography', 'Illustrations', 'Backgrounds', 'Events', 'Partners', 'Social'];
const COLLECTIONS = ['Launch Kit', 'Summit 2026', 'Evergreen', 'Campaign Spring', 'Retired'];
const TAGS = [
  'blue', 'green', 'warm', 'cool', 'dark', 'light', 'square', 'wide', 'tall', 'outline',
  'filled', 'flat', 'gradient', 'photo', 'people', 'product', 'office', 'outdoor', 'night', 'day',
  'print', 'web', 'social', 'event', 'partner', 'team', 'hero', 'banner', 'badge', 'pattern',
];
const ADJECTIVES = ['Amber', 'Bold', 'Calm', 'Deep', 'Early', 'Fresh', 'Grand', 'Hidden', 'Ivory', 'Jade', 'Keen', 'Lunar'];
const NOUNS = ['Harbour', 'Summit', 'Meadow', 'Signal', 'Canyon', 'Orbit', 'Garden', 'Bridge', 'Comet', 'Valley', 'Forest', 'Atlas'];

/** Generated remote ids are `g` plus a zero-padded index, so they sort the way they were made. */
export function generatedRemoteId(i: number): string {
  return `g${String(i).padStart(6, '0')}`;
}

/** The index behind a generated remote id, or -1 when the id is not one. */
export function generatedIndex(remoteId: string, gen: MockGenerateOptions): number {
  const m = /^g(\d{6,})$/.exec(remoteId);
  if (!m) return -1;
  const i = Number(m[1]);
  return Number.isInteger(i) && i >= 0 && i < gen.count ? i : -1;
}

function isSvg(i: number, gen: MockGenerateOptions): boolean {
  const every = gen.svgEvery && gen.svgEvery > 0 ? Math.floor(gen.svgEvery) : 2;
  return i % every === 0;
}

function hue(i: number, gen: MockGenerateOptions): number {
  return ((i * 47) + (gen.seed ?? 0) * 13) % 360;
}

export function generatedAsset(i: number, gen: MockGenerateOptions): ProviderAssetRef {
  const s = gen.seed ?? 0;
  const svg = isSvg(i, gen);
  const format = svg ? 'svg' : 'png';
  const name = `${ADJECTIVES[(i + s) % ADJECTIVES.length]} ${NOUNS[Math.floor(i / ADJECTIVES.length + s) % NOUNS.length]} ${i + 1}`;
  const section = SECTIONS[(i * 7 + s) % SECTIONS.length] as string;
  const tags = [TAGS[i % TAGS.length] as string, TAGS[(i * 3 + 11) % TAGS.length] as string];
  return {
    remoteId: generatedRemoteId(i),
    name,
    nativeType: 'file',
    sections: [section],
    collections: [COLLECTIONS[(i + s) % COLLECTIONS.length] as string],
    tags: [...new Set(tags)],
    approved: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    formats: [{
      format, remoteRef: 'f1', width: 256, height: 256, filename: `${name.toLowerCase().replaceAll(' ', '-')}.${format}`,
      size: svg ? generatedSvg(i, gen).length : generatedPng(i, gen, 64).length,
    }],
    hasThumbnail: true,
  };
}

/** A small, valid SVG naming its own index, so a tile that draws the SVG is easy to tell from one that draws the thumbnail. */
export function generatedSvg(i: number, gen: MockGenerateOptions): Uint8Array {
  const h = hue(i, gen);
  const label = `SVG ${i + 1}`;
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">`
    + `<rect width="256" height="256" rx="24" fill="hsl(${h} 70% 45%)"/>`
    + `<circle cx="128" cy="104" r="56" fill="hsl(${(h + 180) % 360} 80% 80%)"/>`
    + `<text x="128" y="214" font-family="sans-serif" font-size="34" font-weight="700" text-anchor="middle" fill="#fff">${label}</text>`
    + `</svg>`,
  );
}

const pngCache = new Map<string, Uint8Array>();

/** A solid-colour PNG of `size` pixels square, built by hand (no image library). */
export function generatedPng(i: number, gen: MockGenerateOptions, size: number): Uint8Array {
  const h = hue(i, gen);
  const key = `${h}:${size}`;
  const hit = pngCache.get(key);
  if (hit) return hit;
  const [r, g, b] = hslToRgb(h, 0.6, 0.5);
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const png = new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
  if (pngCache.size > 512) pngCache.clear();
  pngCache.set(key, png);
  return png;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return [f(0), f(8), f(4)];
}

/** Bytes and type for one generated blob. Thumbnails are small PNGs on purpose. */
export function generatedBlob(i: number, gen: MockGenerateOptions, formatRef: string): { bytes: Uint8Array; contentType: string } {
  if (formatRef === 'thumb') return { bytes: generatedPng(i, gen, 24), contentType: 'image/png' };
  return isSvg(i, gen)
    ? { bytes: generatedSvg(i, gen), contentType: 'image/svg+xml' }
    : { bytes: generatedPng(i, gen, 64), contentType: 'image/png' };
}
