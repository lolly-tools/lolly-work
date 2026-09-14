// SPDX-License-Identifier: MPL-2.0
/** Resolve one complete emoji meaning through an explicit, ordered chain of verified pack pins. */
import type { EmojiMeaningV1, EmojiRequestV1, EmojiResolutionV1, EmojiStyleV1 } from '@lolly-tools/core';
import { emojiSequenceKey, lookupEmojiSequence, usesTextPresentation } from './emoji-sequence.ts';
import { findEmojiGlyph, matchesEmojiPack, validateEmojiStyle } from './emoji-pack.ts';
import type { VerifiedEmojiPack } from './emoji-pack.ts';

/** This prepares a glyph dependency, not a rendered or credited export. No ambient fallback. */
export function resolveEmoji(
  request: EmojiRequestV1,
  style: EmojiStyleV1 | null | undefined,
  packs: readonly VerifiedEmojiPack[],
): EmojiResolutionV1 {
  let meaning: EmojiMeaningV1;
  if (request?.kind === 'unicode' && typeof request.text === 'string') {
    if (!emojiSequenceKey(request.text) || ![undefined, 'auto', 'emoji'].includes(request.presentation)) return { status: 'unresolved', issue: { code: 'invalid-request', message: 'Emoji input must be one bounded Unicode sequence.' } };
    if (usesTextPresentation(request.text, request.presentation)) return { status: 'text', text: request.text };
    const sequence = lookupEmojiSequence(request.text);
    if (!sequence) return { status: 'unresolved', issue: { code: 'unsupported-sequence', message: 'This complete sequence is not in the pinned emoji data.' } };
    meaning = { kind: 'unicode', key: sequence.key };
  } else if (request?.kind === 'custom' && typeof request.id === 'string' && request.id.length <= 512
    && /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+$/.test(request.id)
    && typeof request.label === 'string' && request.label.trim().length > 0 && request.label.length <= 4096) {
    meaning = { kind: 'custom', id: request.id };
  } else return { status: 'unresolved', issue: { code: 'invalid-request', message: 'Emoji input requires a Unicode sequence or a labelled custom symbol.' } };

  if (style == null) return { status: 'unresolved', issue: { code: 'selection-required', message: 'Choose an emoji set for this content.' } };
  const invalid = validateEmojiStyle(style);
  if (invalid) return { status: 'unresolved', issue: invalid };
  const pins = [style.primary, ...style.fallbacks];
  for (const [position, pin] of pins.entries()) {
    const pack = packs.find(candidate => matchesEmojiPack(candidate, pin));
    // A missing primary is not evidence of a coverage gap. The same saved selection
    // must produce the same dependency even when a device has more installed packs.
    if (!pack) return { status: 'unresolved', issue: { code: 'pack-unavailable', message: 'Restore the exact saved emoji set before resolving this content.', packId: pin.id } };
    const entry = findEmojiGlyph(pack, meaning);
    if (entry) return { status: 'resolved', value: {
      request: structuredClone(request), meaning, pack: structuredClone(pin), ...entry, usedFallback: position !== 0,
    } };
  }
  return { status: 'unresolved', issue: { code: 'glyph-unavailable', message: 'This complete emoji is absent from the selected sets.' } };
}
