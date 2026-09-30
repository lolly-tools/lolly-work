// SPDX-License-Identifier: MPL-2.0
/** Portable source declarations retain their original attribution after vector conversion. */
import { Ajv } from 'ajv';
import type { EmojiSourceRecordV1 } from '@lolly-tools/core';
import schema from '../../schemas/emoji-source-records-v1.schema.json' with {type:'json'};
const validate=new Ajv({strict:true,ownProperties:true}).compile<EmojiSourceRecordV1[]>(schema);
export function readEmojiSourceRecords(value:unknown):EmojiSourceRecordV1[]{
  if(typeof value==='string'){if(value.length>2*1024*1024)throw new Error('The recorded emoji sources exceed the supported size.');value=JSON.parse(value);}
  if(!validate(value))throw new Error('The recorded emoji sources are invalid.');return structuredClone(value);
}
export function mergeEmojiSourceRecords(sources:readonly EmojiSourceRecordV1[]):EmojiSourceRecordV1[]{
  const result=new Map<string,EmojiSourceRecordV1>();
  for(const source of sources){const key=`${source.pack.checksum}:${source.assetId}:${source.canonicalChecksum}`,existing=result.get(key);if(existing)existing.occurrences.push(...source.occurrences);else result.set(key,structuredClone(source));}
  return [...result.values()];
}
