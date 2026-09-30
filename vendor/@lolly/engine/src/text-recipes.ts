// SPDX-License-Identifier: MPL-2.0
/** Recipes apply only to new work or an explicit paragraph command. */
import type { TextParagraphStyleV1 } from '@lolly-tools/core';
export type TextRecipe = 'heading'|'body'|'label';
export function textRecipe(recipe: TextRecipe): TextParagraphStyleV1 {
  return {composition:recipe==='heading'?'balanced':recipe==='body'?'best':'standard',
    shortLastLine:{enabled:recipe==='body',words:2,fraction:.2},
    keep:{startLines:recipe==='body'?2:1,endLines:recipe==='body'?2:1,together:false,nextLines:0},
    hyphenation:{mode:recipe==='heading'?'off':'manual',minWord:6,minBefore:2,minAfter:3,consecutive:2}};
}
