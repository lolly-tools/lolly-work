// SPDX-License-Identifier: MPL-2.0
/** Store explicit emoji typography in the existing DTCG vendor extension without changing other tokens. */
import type { EmojiIssueV1, EmojiPackPinV1, EmojiStyleV1 } from '@lolly-tools/core';
import { TOKEN_EXT } from './token-ext.ts';
import { validateEmojiStyle } from './emoji-pack.ts';
import { emojiOklab } from './emoji-treatment.ts';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === 'object' && !Array.isArray(value);

export function readEmojiStyle(doc: unknown):
  | { status: 'unselected' }
  | { status: 'invalid'; issue: EmojiIssueV1 }
  | { status: 'selected'; style: EmojiStyleV1 } {
  if (!record(doc)) return { status: 'invalid', issue: { code: 'invalid-style', message: 'A design token document must be an object.' } };
  if (!Object.hasOwn(doc, '$extensions')) return { status: 'unselected' };
  if (!record(doc.$extensions)) return { status: 'invalid', issue: { code: 'invalid-style', message: 'Invalid design token extensions.' } };
  if (!Object.hasOwn(doc.$extensions, TOKEN_EXT)) return { status: 'unselected' };
  if (!record(doc.$extensions[TOKEN_EXT])) return { status: 'invalid', issue: { code: 'invalid-style', message: 'Invalid design token vendor extension.' } };
  const vendor = doc.$extensions[TOKEN_EXT];
  if (!Object.hasOwn(vendor, 'emoji')) return { status: 'unselected' };
  const issue = validateEmojiStyle(vendor.emoji);
  return issue ? { status: 'invalid', issue } : { status: 'selected', style: structuredClone(vendor.emoji as EmojiStyleV1) };
}

/** Passing null deliberately clears the saved selection. It does not select a replacement. */
export function withEmojiStyle(doc: RecordValue, style: EmojiStyleV1 | null): RecordValue {
  if (!record(doc)) throw new Error('A design token document must be an object.');
  if (style !== null) {
    const issue = validateEmojiStyle(style);
    if (issue) throw new Error(issue.message);
  }
  const next = structuredClone(doc);
  if (next.$extensions !== undefined && !record(next.$extensions)) throw new Error('Invalid design token extensions.');
  const extensions = (next.$extensions ?? {}) as RecordValue;
  if (extensions[TOKEN_EXT] !== undefined && !record(extensions[TOKEN_EXT])) throw new Error('Invalid design token vendor extension.');
  const vendor = (extensions[TOKEN_EXT] ?? {}) as RecordValue;
  if (style === null) delete vendor.emoji;
  else vendor.emoji = structuredClone(style);
  if (Object.keys(vendor).length) extensions[TOKEN_EXT] = vendor;
  else delete extensions[TOKEN_EXT];
  if (Object.keys(extensions).length) next.$extensions = extensions;
  else delete next.$extensions;
  return next;
}

/** The treatment union, read off the contract so the engine keeps no second copy. */
export type EmojiTreatment = EmojiStyleV1['treatment'];
/** One approved brand colour, as the treatment pins it. */
export type EmojiPaletteEntry = Extract<EmojiTreatment, { mode: 'snap' }>['palette'][number];
/** The slice of a host's `EmojiSetInfoV1` listing this parser reads. */
export interface EmojiSetPin { pin: EmojiPackPinV1 }

/** The two reserved URL params, as a link or an argv pair delivers them. */
export interface EmojiParamValues {
  emoji?: string | null;
  emojifx?: string | null;
  emojistyle?: string | null;
}

export interface ParsedEmojiParams {
  /** Exact document style, including checksums, ordered fallbacks and palette. */
  style?: EmojiStyleV1;
  /** The named set, pinned from the host's listing. Absent when the param named nothing. */
  pin?: EmojiPackPinV1;
  /** The treatment, with the caller's palette already pinned into it. */
  treatment?: EmojiTreatment;
  /** Everything the parser could not honour. A total function: junk reads as an
   *  issue, never a throw, so a link always draws something. */
  issues: EmojiIssueV1[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** OKLCH chroma below this reads as a neutral, the same line brand-map draws. */
const NEUTRAL_CHROMA = 0.03;
const PALETTE_MAX = 64;
const issue = (message: string, code: EmojiIssueV1['code'] = 'invalid-style'): EmojiIssueV1 => ({ code, message });
const lastTwo = (id: string): string => id.split('/').slice(-2).join('/');

/** `#rgb`, `#rrggbb` or `#rrggbbaa` to the lowercase `#rrggbb` the style pins. */
function normalizeHex(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(hex)) return `#${hex[1]!}${hex[1]!}${hex[2]!}${hex[2]!}${hex[3]!}${hex[3]!}`;
  if (/^#[0-9a-f]{6}$/.test(hex)) return hex;
  if (/^#[0-9a-f]{8}$/.test(hex)) return hex.slice(0, 7);
  return null;
}

function normalizePalette(palette: readonly EmojiPaletteEntry[]): EmojiPaletteEntry[] {
  const out: EmojiPaletteEntry[] = [];
  for (const entry of palette) {
    const hex = normalizeHex(entry?.hex);
    const id = typeof entry?.id === 'string' ? entry.id.slice(0, 256) : '';
    if (hex && id) out.push({ id, hex });
    if (out.length === PALETTE_MAX) break;
  }
  return out;
}

/**
 * Both colour decisions below go through the treatment's own pinned core, not the
 * engine's ordinary float path. The URL carries only the word `mono` or `duotone`,
 * so WHICH brand colours a link resolves to is decided again on every host that
 * opens it; deciding that with Math.cbrt would put a per-host answer in front of
 * an arithmetic the whole core exists to make identical.
 */
const chromaOf = (hex: string): number => {
  const lab = emojiOklab(hex);
  return lab ? Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]) : 0;
};
const lightnessOf = (hex: string): number => emojiOklab(hex)?.[0] ?? 0;

/** The one colour a mono treatment takes: the brand's own accent where the token
 *  names one, else the first colour with real chroma in it. */
function monoEntry(palette: readonly EmojiPaletteEntry[]): EmojiPaletteEntry {
  const named = palette.find(entry => /primary|accent|brand/i.test(entry.id));
  if (named) return named;
  return palette.find(entry => chromaOf(entry.hex) >= NEUTRAL_CHROMA) ?? palette[0]!;
}

/** The darkest and lightest colours, in that order, by OKLab lightness. */
function duotoneEntries(palette: readonly EmojiPaletteEntry[]): [EmojiPaletteEntry, EmojiPaletteEntry] {
  const ranked = [...palette].sort((a, b) => lightnessOf(a.hex) - lightnessOf(b.hex));
  return [ranked[0]!, ranked.at(-1)!];
}

function parseSet(raw: string, sets: readonly EmojiSetPin[], issues: EmojiIssueV1[]): EmojiPackPinV1 | undefined {
  const at = raw.lastIndexOf('@');
  const id = at > 0 ? raw.slice(0, at) : '';
  const version = at > 0 ? raw.slice(at + 1) : '';
  if (!ID_PATTERN.test(id) || !VERSION_PATTERN.test(version)) {
    issues.push(issue('An emoji set is named as id@version, for example twemoji/color-starter@17.0.3.'));
    return undefined;
  }
  const exact = sets.find(set => set.pin.id === id && set.pin.pin.version === version);
  if (exact) return structuredClone(exact.pin);
  // The short form names a set by its last two id segments, which is what a person
  // reads and types. It only resolves while exactly one set answers to it.
  const short = sets.filter(set => lastTwo(set.pin.id) === id && set.pin.pin.version === version);
  if (short.length === 1) return structuredClone(short[0]!.pin);
  if (short.length > 1) {
    issues.push(issue('More than one emoji set answers to that short name. Use the full set id.'));
    return undefined;
  }
  issues.push(issue('That emoji set is not on this device.', 'pack-unavailable'));
  return undefined;
}

function parseTreatment(raw: string, palette: readonly EmojiPaletteEntry[], issues: EmojiIssueV1[]): EmojiTreatment | undefined {
  const parts = raw.split(',').map(part => part.trim()).filter(part => part !== '');
  const mode = parts.shift() ?? '';
  let protect: { skinTones: boolean; flags: boolean; custom: boolean } | undefined;
  for (const flag of parts) {
    if (flag === 'unprotected') protect = { skinTones: false, flags: false, custom: false };
    else {
      issues.push(issue(`This emoji treatment option is not supported: ${flag}.`));
      return undefined;
    }
  }
  if (mode === 'original') return { mode: 'original', strengthBps: 0 };
  const colours = normalizePalette(palette);
  const recipe = 'emoji-treatment-v1' as const;
  const guard = (need: number): boolean => {
    if (colours.length >= need) return true;
    issues.push(issue('This emoji treatment needs brand colours, and the brand in force supplies none.'));
    return false;
  };
  if (mode === 'snap') return guard(1) ? { mode: 'snap', strengthBps: 10000, palette: colours, ...(protect ? { protect } : {}), recipe } : undefined;
  if (mode === 'mono') return guard(1) ? { mode: 'mono', strengthBps: 10000, palette: [monoEntry(colours)], ...(protect ? { protect } : {}), recipe } : undefined;
  if (mode === 'duotone') return guard(2) ? { mode: 'duotone', strengthBps: 10000, palette: duotoneEntries(colours), ...(protect ? { protect } : {}), recipe } : undefined;
  if (mode.startsWith('influence')) {
    const strength = Number(mode.slice('influence'.length).replace(/^:/, ''));
    if (!Number.isInteger(strength) || strength < 1 || strength > 9999) {
      issues.push(issue('Palette influence is a whole number of basis points from 1 to 9999, as influence:2500.'));
      return undefined;
    }
    return guard(1) ? { mode: 'influence', strengthBps: strength, palette: colours, ...(protect ? { protect } : {}), recipe } : undefined;
  }
  issues.push(issue(`This emoji treatment is not supported: ${mode || 'blank'}.`));
  return undefined;
}

/** Read an exact document style, or resolve the short params for newly authored work. */
export function parseEmojiParams(
  params: EmojiParamValues,
  sets: readonly EmojiSetPin[] = [],
  palette: readonly EmojiPaletteEntry[] = [],
): ParsedEmojiParams {
  const issues: EmojiIssueV1[] = [];
  if (params?.emojistyle) {
    try {
      if (params.emojistyle.length > 32768) throw new Error('Emoji style exceeds 32 KiB.');
      const style: unknown = JSON.parse(params.emojistyle);
      const invalid = validateEmojiStyle(style);
      if (invalid) return { issues: [invalid] };
      const saved = structuredClone(style as EmojiStyleV1);
      return { style: saved, pin: saved.primary, treatment: saved.treatment, issues };
    } catch {
      return { issues: [issue('The saved emoji style is invalid.')] };
    }
  }
  const setRaw = typeof params?.emoji === 'string' ? params.emoji.trim() : '';
  if (setRaw === 'none') return { issues };
  const fxRaw = typeof params?.emojifx === 'string' ? params.emojifx.trim() : '';
  const pin = setRaw ? parseSet(setRaw, sets, issues) : undefined;
  const treatment = fxRaw ? parseTreatment(fxRaw.toLowerCase(), palette, issues) : undefined;
  return { ...(pin ? { pin } : {}), ...(treatment ? { treatment } : {}), issues };
}

/** Write a saved style back as the two params. The full set id is always written:
 *  the short form is a convenience for a person typing one, not a wire format. */
export function emojiParams(style: EmojiStyleV1): { emoji: string; emojifx: string; emojistyle: string } {
  const treatment = style.treatment;
  const base = treatment.mode === 'influence' ? `influence:${treatment.strengthBps}` : treatment.mode;
  const protect = 'protect' in treatment ? treatment.protect : undefined;
  // The URL form is all or nothing. A part-protected treatment keeps its
  // protection rather than losing the flags it cannot spell.
  const unprotected = protect && !protect.skinTones && !protect.flags && !protect.custom;
  return { emoji: `${style.primary.id}@${style.primary.pin.version}`, emojifx: unprotected ? `${base},unprotected` : base, emojistyle: JSON.stringify(style) };
}
