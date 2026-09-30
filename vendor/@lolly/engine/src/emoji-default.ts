// SPDX-License-Identifier: MPL-2.0
/** Shared emoji defaults beneath explicit document, brand and personal choices. */
import type { HostV1 } from '@lolly-tools/core/host-v1';
import type { EmojiPackPinV1, EmojiStyleV1 } from '@lolly-tools/core/emoji-v1';

export const DEFAULT_EMOJI_PIN: EmojiPackPinV1 = Object.freeze({
  id: 'community/emoji/fluent/high-contrast',
  pin: Object.freeze({ version: '2026.8.24' }),
  checksum: 'sha256:0428cfd8a440aef92a1ea1d227c1b601c79d747144d26159336ed0c3230dbd7e',
});

/** Choose only the shipped default's exact pin, without fetching its artwork. */
export function defaultEmojiStyle(sets: readonly { pin: EmojiPackPinV1 }[]): EmojiStyleV1 | null {
  const pin = DEFAULT_EMOJI_PIN;
  if (!sets.some(set => set.pin.id === pin.id && set.pin.pin.version === pin.pin.version && set.pin.checksum === pin.checksum)) return null;
  return {
    schemaVersion: 1, primary: structuredClone(pin), fallbacks: [],
    metricsPolicy: 'inline-em-v1', treatment: { mode: 'original', strengthBps: 0 },
  };
}

/** An unused implicit default does not need a permanent section on every tool. */
export function isDefaultEmojiStyle(style: EmojiStyleV1 | null): boolean {
  return !!style && style.primary.id === DEFAULT_EMOJI_PIN.id
    && style.primary.pin.version === DEFAULT_EMOJI_PIN.pin.version && style.primary.checksum === DEFAULT_EMOJI_PIN.checksum
    && style.fallbacks.length === 0 && style.treatment.mode === 'original';
}

/** The same brand seed for interactive, embedded and headless rendering. */
export async function brandEmojiStyle(host:Pick<HostV1,'tokens'>):Promise<EmojiStyleV1|null> {
  if(!host.tokens?.snapshot)return null;
  const { readEmojiStyle } = await import('./emoji-style.ts');
  const snapshot=await host.tokens.snapshot();
  const result=readEmojiStyle(snapshot.document);
  return result.status==='selected'?result.style:null;
}
