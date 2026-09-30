// SPDX-License-Identifier: MPL-2.0
/** Bounded settled results for synchronous clipboard events. Pending work is never a receipt. */
import type { TextLayoutRequestV1, TextLayoutV1 } from '@lolly-tools/core';
import { textFrameKey } from './text-frame.ts';
export interface TextLayoutReceipt { key: string; layout: TextLayoutV1 }
export function textLayoutKey(request: TextLayoutRequestV1): string {
  return JSON.stringify([request.document,request.storyId,(request.document.stories.find(story=>story.id===request.storyId)?.frameIds ?? []).map(id=>request.frames.find(frame=>frame.id===id)).map(frame=>frame ? textFrameKey(frame) : null),request.artwork ?? [],request.wrap??null]);
}
export function createTextLayoutCache() {
  const entries = new Map<string,{receipt:string;bytes:number}>(); let bytes = 0;
  const limit = 32*1024*1024;
  return {
    remember(key: string, dependency: string, layout: TextLayoutV1): void {
      const id = JSON.stringify([key,dependency]), receipt = JSON.stringify({key,layout});
      const size = 2*(id.length+receipt.length);
      const old = entries.get(id); if (old) {bytes-=old.bytes;entries.delete(id);}
      if (size>limit) return;
      while (entries.size && (entries.size>=8 || bytes+size>limit)) {const first=entries.keys().next().value!;bytes-=entries.get(first)!.bytes;entries.delete(first);}
      entries.set(id,{receipt,bytes:size});bytes+=size;
    },
    peek(request: TextLayoutRequestV1, dependency: string): TextLayoutReceipt | null {
      const entry = entries.get(JSON.stringify([textLayoutKey(request),dependency]));
      return entry ? JSON.parse(entry.receipt) as TextLayoutReceipt : null;
    },
  };
}
