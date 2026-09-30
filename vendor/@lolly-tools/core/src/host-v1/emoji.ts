// SPDX-License-Identifier: MPL-2.0

import type { AssetRef } from './asset-ref.ts';
import type { EmojiGlyphV1, EmojiPackPinV1, EmojiSetInfoV1 } from '../emoji-v1.ts';

// ─── Emoji packs (optional, v1.196) ─────────────────────────────────────────

/**
 * Pinned vector emoji packs the host can supply, so no owned surface ever
 * draws an operating-system emoji glyph. The host owns storage and transport
 * only: which packs its catalog mounts, the exact bytes of a manifest and of
 * each glyph's source SVG, and a non-networked XML parser. Everything that
 * decides what to draw (sequence lookup, admission, resolution through the
 * saved pins, the static SVG subset, brand treatment, sizing) is the engine's
 * and is identical on every host, which is what makes the artwork uniform.
 *
 * A pin names an exact pack: id, version and the manifest's sha256. A host
 * that has a newer or older release of the same set answers `null`, never a
 * substitute; the engine then reports `pack-unavailable` and the surface
 * shows its neutral placeholder rather than a different picture.
 */
export interface EmojiTextRenderOpts {
  text: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  letterSpacing?: number;
  fill?: string;
}

export interface EmojiAPI {
  /** Resolve text in a tool-generated SVG before it is baked into a bitmap. */
  renderSvg?(source:string): Promise<string>;
  /** Runtime-scoped vector text using the document's selected pack and treatment. */
  renderText?(opts: EmojiTextRenderOpts): Promise<{svg:string;width:number;height:number;baseline:number;advanceWidth:number}>;
  /** Every set this host can load, from the catalog it mounts. Never lists a system font. */
  sets(): Promise<EmojiSetInfoV1[]>;
  /** Admit and install a complete pack. Every glyph is verified before storage. */
  install?(bytes: Uint8Array): Promise<EmojiSetInfoV1>;
  /** Pin exact pack assets for document history and portable files. */
  dependencies?(pins: readonly EmojiPackPinV1[]): Promise<AssetRef[]>;
  /** The exact manifest bytes for the pin, or null when this exact pack is absent. */
  manifest(pin: EmojiPackPinV1): Promise<Uint8Array | null>;
  /** The exact source SVG bytes of one glyph of an exact pack, or null. */
  artwork(pin: EmojiPackPinV1, asset: EmojiGlyphV1['asset']): Promise<Uint8Array | null>;
  /**
   * Parse SVG text into a DOM Document with a parser that performs no network
   * access (DOMParser in a browser, jsdom on Node). Typed as unknown so the
   * SDK stays free of DOM types; the engine narrows it.
   */
  parseXml(source: string): unknown;
}
