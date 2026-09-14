// SPDX-License-Identifier: MPL-2.0
/** Validate pinned emoji manifests and artwork bytes without performing IO or rendering SVG. */
import Ajv from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import type {
  EmojiGlyphV1, EmojiIssueV1, EmojiMeaningV1, EmojiPackManifestV1, EmojiPackPinV1, EmojiStyleV1,
} from '@lolly-tools/core';
import packSchema from '../../schemas/emoji-pack-v1.schema.json' with { type: 'json' };
import styleSchema from '../../schemas/emoji-style-v1.schema.json' with { type: 'json' };
import { sha256Hex } from './bytes.ts';
import { isCanonicalEmojiKey } from './emoji-sequence.ts';

export const EMOJI_PACK_MAX_BYTES = 32 * 1024 * 1024;
export const EMOJI_ARTWORK_MAX_BYTES = 2 * 1024 * 1024;

/** Opaque handle. Only readEmojiPack can admit a manifest to resolution. */
export interface VerifiedEmojiPack {
  readonly id: string;
  readonly version: string;
  readonly checksum: string;
}

interface PackRecord {
  manifest: EmojiPackManifestV1;
  pin: EmojiPackPinV1;
  glyphs: Map<string, EmojiGlyphV1>;
}
const admitted = new WeakMap<VerifiedEmojiPack, PackRecord>();
let validators: { pack: ValidateFunction; style: ValidateFunction; pin: ValidateFunction } | undefined;
function schemas(): NonNullable<typeof validators> {
  if (!validators) {
    const ajv = new Ajv({ strict: true, allErrors: false, ownProperties: true });
    validators = { pack: ajv.compile(packSchema), style: ajv.compile(styleSchema), pin: ajv.compile(styleSchema.$defs.pin) };
  }
  return validators;
}

const clone = <T>(value: T): T => structuredClone(value);
const immutableVersion = (version: string): boolean => !/^(latest|head|main|master|default)$/i.test(version);
const failure = (code: EmojiIssueV1['code'], message: string): { ok: false; issue: EmojiIssueV1 } => ({ ok: false, issue: { code, message } });
const meaningKey = (meaning: EmojiMeaningV1): string => meaning.kind === 'unicode' ? `unicode:${meaning.key}` : `custom:${meaning.id}`;

export function emojiPackPinKey(pin: EmojiPackPinV1): string {
  return JSON.stringify([pin.id, pin.pin.version, pin.checksum]);
}

export function validateEmojiStyle(value: unknown): EmojiIssueV1 | null {
  if (!schemas().style(value)) return { code: 'invalid-style', message: 'Unsupported or malformed emoji style.' };
  const style = value as EmojiStyleV1;
  const pins = [style.primary, ...style.fallbacks];
  if (pins.some(pin => !immutableVersion(pin.pin.version)) || new Set(pins.map(emojiPackPinKey)).size !== pins.length) {
    return { code: 'invalid-style', message: 'Emoji sets require distinct immutable pins.' };
  }
  return null;
}

function sourceUrlsValid(source: EmojiPackManifestV1['source']): boolean {
  return [source.sourceUrl, source.licenseUrl].every(value => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
    } catch { return false; }
  });
}

/** Shape validation does not prove rights, coverage, vector safety or source authenticity. */
export async function readEmojiPack(bytes: Uint8Array, expected: EmojiPackPinV1): Promise<
  { ok: true; pack: VerifiedEmojiPack } | { ok: false; issue: EmojiIssueV1 }
> {
  if (!schemas().pin(expected) || !immutableVersion(expected.pin.version)) return failure('invalid-pack', 'An exact emoji pack pin is required.');
  if (!bytes.length || bytes.byteLength > EMOJI_PACK_MAX_BYTES) return failure('invalid-pack', 'Emoji manifest exceeds the supported byte limit.');
  const pin = clone(expected);
  // Own the snapshot before the digest awaits; a caller may reuse its transfer buffer.
  const snapshot = new Uint8Array(bytes);
  if (`sha256:${await sha256Hex(snapshot)}` !== pin.checksum) return failure('integrity-mismatch', 'Emoji manifest does not match its saved checksum.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(snapshot)); }
  catch { return failure('invalid-pack', 'Emoji manifest is not valid UTF-8 JSON.'); }
  if (value && typeof value === 'object' && ('schemaVersion' in value || 'minimumReader' in value || 'unicodeVersion' in value)) {
    const header = value as Record<string, unknown>;
    if (header.schemaVersion !== 1 || header.minimumReader !== 1 || header.unicodeVersion !== '17.0') return failure('unsupported-pack', 'This emoji manifest requires an unsupported reader or Unicode version.');
  }
  if (!schemas().pack(value)) return failure('invalid-pack', 'Emoji manifest does not satisfy its schema.');
  const manifest = value as EmojiPackManifestV1;
  if (manifest.id !== pin.id || manifest.version !== pin.pin.version) return failure('integrity-mismatch', 'Emoji manifest identity differs from its saved pin.');
  if (!sourceUrlsValid(manifest.source)) return failure('invalid-pack', 'Emoji source URLs are invalid or contain private credentials.');
  const glyphs = new Map<string, EmojiGlyphV1>();
  const assets = new Map<string, string>();
  for (const glyph of manifest.glyphs) {
    if (glyph.meaning.kind === 'unicode' && !isCanonicalEmojiKey(glyph.meaning.key)) return failure('invalid-pack', 'Emoji glyph key is not a canonical sequence in the pinned Unicode data.');
    const key = meaningKey(glyph.meaning);
    if (glyphs.has(key)) return failure('invalid-pack', 'Emoji manifest repeats a semantic identity.');
    if (!immutableVersion(glyph.asset.pin.version) || !sourceUrlsValid(glyph.source)) return failure('invalid-pack', 'Emoji glyph has a mutable pin or invalid source URL.');
    const assetKey = JSON.stringify([glyph.asset.id, glyph.asset.pin.version, glyph.asset.format]);
    const prior = assets.get(assetKey);
    if (prior && prior !== glyph.asset.checksum) return failure('invalid-pack', 'An emoji asset pin names conflicting bytes.');
    assets.set(assetKey, glyph.asset.checksum);
    glyphs.set(key, glyph);
  }
  const pack = Object.freeze({ id: manifest.id, version: manifest.version, checksum: pin.checksum });
  admitted.set(pack, { manifest, pin, glyphs });
  return { ok: true, pack };
}

/** A detached inspection snapshot; edits cannot mutate the admitted dependency. */
export function inspectEmojiPack(pack: VerifiedEmojiPack): EmojiPackManifestV1 | null {
  const record = admitted.get(pack);
  return record ? clone(record.manifest) : null;
}

/** Family and style names for records and display; identity fields repeat the admitted manifest. */
export function describeEmojiPack(pack: VerifiedEmojiPack): { id: string; version: string; family: string; style: string } | null {
  const record = admitted.get(pack);
  return record ? { id: record.manifest.id, version: record.manifest.version, family: record.manifest.family, style: record.manifest.style } : null;
}

/** Exact pin matching checks admission, not just a caller-provided object shape. */
export function matchesEmojiPack(pack: VerifiedEmojiPack, pin: EmojiPackPinV1): boolean {
  const record = admitted.get(pack);
  return !!record && emojiPackPinKey(record.pin) === emojiPackPinKey(pin);
}

export function findEmojiGlyph(pack: VerifiedEmojiPack, meaning: EmojiMeaningV1): { glyph: EmojiGlyphV1; metrics: EmojiPackManifestV1['metrics'] } | null {
  const record = admitted.get(pack);
  const glyph = record?.glyphs.get(meaningKey(meaning));
  return record && glyph ? clone({ glyph, metrics: glyph.metrics ?? record.manifest.metrics }) : null;
}

/** Verify exact SVG bytes before a later sanitizer/compiler sees them. Does not admit SVG for DOM use. */
export async function verifyEmojiArtwork(pack: VerifiedEmojiPack, meaning: EmojiMeaningV1, bytes: Uint8Array): Promise<
  { ok: true; bytes: Uint8Array } | { ok: false; issue: EmojiIssueV1 }
> {
  if (!admitted.has(pack)) return failure('invalid-pack', 'Emoji pack has not been validated.');
  const entry = findEmojiGlyph(pack, meaning);
  if (!entry) return failure('glyph-unavailable', 'This emoji is not in the pinned set.');
  if (!bytes.length) return failure('artwork-unavailable', 'The pinned emoji artwork has not been loaded.');
  if (bytes.byteLength > EMOJI_ARTWORK_MAX_BYTES) return failure('invalid-pack', 'Emoji artwork exceeds the supported byte limit.');
  const snapshot = new Uint8Array(bytes);
  if (`sha256:${await sha256Hex(snapshot)}` !== entry.glyph.asset.checksum) return failure('integrity-mismatch', 'Emoji artwork does not match its saved checksum.');
  return { ok: true, bytes: snapshot };
}
