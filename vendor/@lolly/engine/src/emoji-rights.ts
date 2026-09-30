// SPDX-License-Identifier: MPL-2.0
/** Turn a compiled line's emoji source census into Content Credentials source ingredients and readable credits. */
import type { CreativeOperationV1, CreativeUseV1, CreativeWorkRecordV1 } from '@lolly-tools/core/rights-v1';
import type { C2paSourceIngredient, C2paRightsRecord } from './c2pa.ts';
import type { EmojiLineSource } from './emoji-line.ts';
import { EMOJI_RECOLOUR_PREFIX } from './emoji-treatment.ts';
import type { SourceDetailV1 } from './rights-attribution.ts';

const CHECKSUM = /^sha256:([0-9a-f]{64})$/;

function checksumBytes(checksum: string, what: string): Uint8Array {
  const hex = CHECKSUM.exec(checksum)?.[1];
  if (!hex) throw new Error(`Emoji ${what} is not a sha256 checksum.`);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

const setName = (source: EmojiLineSource): string => `${source.family} ${source.style} ${source.pack.pin.version}`;

/** Every change the used artwork carries: the source's own recorded changes, then Lolly's normalization. */
export function emojiSourceModifications(source: EmojiLineSource): string[] {
  return [...source.source.modifications, ...source.changes];
}

/** The rights Lolly read for one incorporated emoji source, bound to the exact source and used bytes. */
export function emojiRightsRecord(source: EmojiLineSource): C2paRightsRecord {
  return {
    creator: source.source.creator,
    license: source.source.license,
    licenseUrl: source.source.licenseUrl,
    attribution: source.source.attribution,
    sourceUrl: source.source.sourceUrl,
    revision: source.source.revision,
    modifications: emojiSourceModifications(source),
    sourceHash: source.sourceChecksum,
    usedHash: source.canonicalChecksum,
  };
}

/**
 * One componentOf source ingredient per distinct incorporated artwork. The
 * ingredient binds the ORIGINAL source bytes (the work as obtained, at its
 * public locator) and its rights record carries what Lolly changed and the
 * hash of the canonical form actually placed. Nothing here signs on the
 * upstream artist's behalf; the licence recorded is the source's, not the
 * composition's. A CC BY-SA source stays CC BY-SA in the record.
 */
export function emojiSourceIngredients(sources: readonly EmojiLineSource[]): C2paSourceIngredient[] {
  return sources.map((source) => {
    const modifications = emojiSourceModifications(source);
    const changed = modifications.length ? ` Changes: ${modifications.join(' ')}` : '';
    return {
      credential: 'none',
      title: `${source.label} (${setName(source)})`,
      format: 'image/svg+xml',
      relationship: 'componentOf',
      url: source.source.sourceUrl,
      hash: checksumBytes(source.sourceChecksum, 'source checksum'),
      instanceId: `${source.assetId}@${source.pack.pin.version}`,
      description: `${source.source.attribution} Licence: ${source.source.license} <${source.source.licenseUrl}>.${changed}`,
      informationalUri: source.source.licenseUrl,
      rights: emojiRightsRecord(source),
    };
  });
}

/** The emoji census as the rights evaluator reads it: works, their uses, and the
 *  per-work details a portable work record has no field for. */
export interface EmojiRightsCensusV1 {
  works: CreativeWorkRecordV1[];
  uses: CreativeUseV1[];
  details: Record<string, SourceDetailV1>;
}

/**
 * The same census, said in the shared rights vocabulary (plan 253): one work per
 * distinct artwork, carrying the pack's own declaration as evidence the CATALOG
 * asserted, and one incorporated use per work pinned to the exact asset and
 * version drawn. The operations are the facts the pass performed: every glyph is
 * placed, and a glyph whose paints the treatment actually rewrote is recoloured.
 * Whether that amounts to an adaptation is the evaluator's answer, not this
 * function's.
 *
 * Recolouring is read PER GLYPH, off the changes the renderer recorded, not off
 * the style that was asked for. `applyEmojiTreatment` hands the artwork back
 * untouched and records no change for a protected meaning (every flag, every
 * skin-toned sequence) and for a palette too small for the mode, so a census
 * keyed on the style alone would tell the evaluator a byte-identical flag was
 * recoloured, and the evaluator would ask for an adaptation licence for a use
 * that needs no decision.
 *
 * `sourceIngredientsFor(works, uses, details)` over this census produces exactly
 * what {@link emojiSourceIngredients} produces for the same sources, which is
 * what lets the export path go through the shared route with no change to the
 * bytes a credential records (tests/rights-runtime.test.ts pins it).
 */
export function emojiWorksAndUses(sources: readonly EmojiLineSource[]): EmojiRightsCensusV1 {
  const works: CreativeWorkRecordV1[] = [];
  const uses: CreativeUseV1[] = [];
  // A null prototype and a Set, because the keys are asset ids read out of a
  // pack manifest: an id spelled `constructor` must be one more entry, not a
  // hit on Object.prototype.
  const details: Record<string, SourceDetailV1> = Object.create(null) as Record<string, SourceDetailV1>;
  const seen = new Set<string>();
  for (const source of sources) {
    const id = source.assetId;
    if (seen.has(id)) continue;
    seen.add(id);
    // Single-ink artwork is the deliberate exception, and it must stay one. A
    // monochrome set's black paints are bound to `currentColor` so the glyph
    // takes the surrounding text colour, exactly as the same artwork does when
    // the set ships as a font, and `EMOJI_SINGLE_INK_CHANGE` records that. That
    // sentence does not start with EMOJI_RECOLOUR_PREFIX on purpose, so it is
    // not read as a recolour here: no palette was applied and no colour was
    // chosen, the document's own text colour is what draws. Do not widen this
    // test to catch it. Reporting it as recoloured would ask a person for an
    // adaptation licence for a use that needs no decision.
    const recoloured = emojiSourceModifications(source).some((change) => change.startsWith(EMOJI_RECOLOUR_PREFIX));
    const operations: CreativeOperationV1[] = recoloured ? ['placed', 'recoloured'] : ['placed'];
    works.push({
      id,
      title: `${source.label} (${setName(source)})`,
      creators: [{ name: source.source.creator, role: 'creator' }],
      sourceUrl: source.source.sourceUrl,
      revision: source.source.revision,
      sourceHash: source.sourceChecksum,
      rights: [{
        declaration: source.source.license,
        ...(source.notices?.length ? { notices: source.notices.map(notice => notice.text) } : {}),
        url: source.source.licenseUrl,
        // The pack publisher recorded this, and the artwork carries no
        // credential of its own. Saying which is the whole point of the field.
        assertedBy: 'catalog',
        evidence: 'catalog-entry',
        status: 'parsed',
      }],
    });
    uses.push({
      work: id,
      pin: { id, version: source.pack.pin.version, checksum: source.canonicalChecksum },
      role: 'incorporated',
      operations,
      scope: { count: source.occurrences.length },
    });
    details[id] = {
      format: 'image/svg+xml',
      attribution: source.source.attribution,
      modifications: emojiSourceModifications(source),
    };
  }
  return { works, uses, details };
}

/**
 * Readable credits for recipients who do not inspect credentials, one line per
 * incorporated source: the work, its creator and set, licence and link, the
 * source location and the recorded changes. This accompanies the credential;
 * it is not itself a Content Credential.
 */
export function emojiCreditsText(sources: readonly EmojiLineSource[]): string {
  return sources.map((source) => {
    const modifications = emojiSourceModifications(source);
    const uses = source.occurrences.length;
    return `"${source.label}" by ${source.source.creator} (${setName(source)}), used ${uses} time${uses === 1 ? '' : 's'}. `
      + `${source.source.license}: ${source.source.licenseUrl}. Source: ${source.source.sourceUrl}. `
      + (modifications.length ? `Changes: ${modifications.join(' ')}` : 'Unchanged.');
  }).join('\n');
}
