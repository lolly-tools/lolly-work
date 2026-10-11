// SPDX-License-Identifier: MPL-2.0
/** Generated transport siblings are excluded only after proving their identity bytes. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip } from 'node:zlib';
import { regularSourceFile } from '../api/file-delivery.ts';

export interface ToolIdentity { sha256: string; size: number }

export async function verifyToolCoding(root: string, rel: string, expected: ToolIdentity): Promise<void> {
  const identityRel = rel.slice(0, -3);
  if (!/\.(gz|br)$/.test(rel) || /\.(gz|br)$/.test(identityRel) || !identityRel ||
    /[\\%?#\p{White_Space}\p{Cc}]/u.test(rel) || rel.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid tool transport sibling path');
  }
  const [coding, identity] = await Promise.all([regularSourceFile(root, rel), regularSourceFile(root, identityRel)]);
  if (!coding || !identity || identity.size !== expected.size || !Number.isSafeInteger(expected.size) || expected.size < 0 ||
    !/^[0-9a-f]{64}$/.test(expected.sha256)) throw new Error('Tool transport sibling has no matching identity');
  const decoder = rel.endsWith('.gz') ? createGunzip() : createBrotliDecompress();
  const hash = createHash('sha256'); let size = 0;
  const sink = new Writable({ write(bytes: Buffer, _encoding, done) {
    size += bytes.length;
    if (size > expected.size) { done(new Error('Tool transport sibling expands beyond its identity')); return; }
    hash.update(bytes); done();
  } });
  // pipeline destroys every stream on malformed input, cancellation or expansion.
  await pipeline(createReadStream(coding.path), decoder, sink);
  if (size !== expected.size || hash.digest('hex') !== expected.sha256 || decoder.bytesWritten !== coding.size) {
    throw new Error('Tool transport sibling differs from its complete identity');
  }
}
