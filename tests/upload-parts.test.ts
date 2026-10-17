// SPDX-License-Identifier: MPL-2.0
/**
 * The shared transfer primitive (server/src/uploads/parts.ts) on its own:
 * manifests, verified part storage, the resume report, finalize checks and
 * verified reads, against the memory BlobStore and a store that reports an
 * ETag-style checksum the way an older S3 object does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import type { BlobStore } from '../server/src/blobs/types.ts';
import {
  parsePartIndex, parseTransferManifest, readTransfer, removeTransferParts, RunningDigests, sha256, storeTransferPart, transferChunks, transferProgress,
  verifyTransfer, TRANSFER_MAX_BYTES, TRANSFER_PART_BYTES, type TransferManifest, type TransferParts,
} from '../server/src/uploads/parts.ts';

const P = TRANSFER_PART_BYTES;

function manifestOf(bytes: Uint8Array): TransferManifest {
  const parts = [];
  for (let n = 0; n < bytes.length; n += P) parts.push({ size: Math.min(P, bytes.length - n), checksum: sha256(bytes.subarray(n, n + P)) });
  return { size: bytes.length, checksum: sha256(bytes), parts };
}
const transfer = (blobs: BlobStore, manifest: TransferManifest, id = 't1'): TransferParts => ({ blobs, partId: (n) => `test/${id}/${n}`, manifest });
const part = (bytes: Uint8Array, n: number): Uint8Array => bytes.subarray(n * P, (n + 1) * P);
async function drain(t: TransferParts): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of transferChunks(t)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('a manifest declares the size, the whole digest and one digest per full part', () => {
  const bytes = new Uint8Array(2 * P + 7).map((_, i) => i % 253);
  const good = manifestOf(bytes);
  assert.deepEqual(parseTransferManifest({ ...good, extra: 'ignored' }), good);
  assert.ok(parseTransferManifest({ size: TRANSFER_MAX_BYTES, checksum: 'a'.repeat(64), parts: Array.from({ length: TRANSFER_MAX_BYTES / P }, () => ({ size: P, checksum: 'b'.repeat(64) })) }), 'the ceiling itself');
  for (const bad of [
    null, [], 'x', { ...good, size: 0 }, { ...good, size: 1.5 }, { ...good, size: TRANSFER_MAX_BYTES + 1 }, { ...good, checksum: 'A'.repeat(64) },
    { ...good, parts: good.parts.slice(1) }, { ...good, parts: [...good.parts, good.parts[0]] },
    { ...good, parts: [{ ...good.parts[0], size: P - 1 }, ...good.parts.slice(1)] }, { ...good, parts: [null, ...good.parts.slice(1)] },
    { ...good, parts: [...good.parts.slice(0, 2), { size: 7, checksum: 'nope' }] },
  ]) assert.equal(parseTransferManifest(bad), null, JSON.stringify(bad)?.slice(0, 80));
  assert.equal(parseTransferManifest(good, 2 * P), null, 'a scope cap below the size');
  // One part is the whole file, so its two digests must agree.
  const small = manifestOf(new Uint8Array([1, 2, 3]));
  assert.ok(parseTransferManifest(small));
  assert.equal(parseTransferManifest({ ...small, checksum: 'd'.repeat(64) }), null);
});

test('part numbers are plain whole numbers', () => {
  assert.deepEqual(['0', '12', '007'].map(parsePartIndex), [0, 12, 7]);
  for (const bad of [undefined, '', '-1', '1.5', '1e3', ' 1', '0x1', '99999999999999999999']) assert.equal(parsePartIndex(bad), -1, String(bad));
});

test('only the declared bytes of a declared part are stored, and the report says what is missing', async () => {
  const blobs = createMemoryBlobStore();
  const bytes = new Uint8Array(3 * P + 9).map((_, i) => (i * 7) % 251);
  const t = transfer(blobs, manifestOf(bytes));
  assert.equal(await storeTransferPart(t, 4, new Uint8Array(1)), 'no-part');
  assert.equal(await storeTransferPart(t, -1, part(bytes, 0)), 'no-part');
  assert.equal(await storeTransferPart(t, 0, part(bytes, 1)), 'mismatch');
  assert.equal(await storeTransferPart(t, 0, part(bytes, 0).subarray(1)), 'mismatch');
  assert.equal(await blobs.head(t.partId(0)), null, 'a refused part stores nothing');
  assert.deepEqual(await transferProgress(t), { partBytes: P, parts: 4, missing: [0, 1, 2, 3], receivedParts: 0, receivedBytes: 0, offset: 0 });
  for (const n of [0, 2]) assert.equal(await storeTransferPart(t, n, part(bytes, n)), 'stored');
  assert.equal(await storeTransferPart(t, 2, part(bytes, 2)), 'stored', 'sending a part again is harmless');
  assert.deepEqual(await transferProgress(t), { partBytes: P, parts: 4, missing: [1, 3], receivedParts: 2, receivedBytes: 2 * P, offset: P });
  // A stored part whose bytes changed counts as missing, so sending it again replaces it.
  await blobs.put(t.partId(0), part(bytes, 1), 'application/octet-stream');
  assert.deepEqual((await transferProgress(t)).missing, [0, 1, 3]);
  for (const n of [0, 1, 3]) await storeTransferPart(t, n, part(bytes, n));
  assert.deepEqual(await transferProgress(t), { partBytes: P, parts: 4, missing: [], receivedParts: 4, receivedBytes: bytes.length, offset: bytes.length });
});

test('finalize checks every part from its stat, then the whole file from a running digest or the parts read back', async () => {
  const blobs = createMemoryBlobStore();
  const bytes = new Uint8Array(2 * P + 3).map((_, i) => i % 249);
  const t = transfer(blobs, manifestOf(bytes));
  await storeTransferPart(t, 0, part(bytes, 0));
  assert.deepEqual(await verifyTransfer(t), { ok: false, code: 'UPLOAD_INCOMPLETE', message: 'upload every part first' });
  for (const n of [1, 2]) await storeTransferPart(t, n, part(bytes, n));
  assert.deepEqual(await verifyTransfer(t), { ok: true }, 'read back');
  const running = new RunningDigests();
  for (const n of [0, 1, 2]) running.track('t1', n, part(bytes, n), Date.now() + 60_000);
  assert.equal(running.digest('t1', 3), sha256(bytes));
  assert.deepEqual(await verifyTransfer(t, running.digest('t1', 3)), { ok: true }, 'running digest');
  // Valid parts under a whole digest they do not make: refused either way.
  const liar = transfer(blobs, { ...manifestOf(bytes), checksum: 'e'.repeat(64) });
  assert.deepEqual(await verifyTransfer(liar), { ok: false, code: 'CHECKSUM_MISMATCH', message: 'file failed verification' });
  assert.deepEqual(await verifyTransfer(liar, sha256(bytes)), { ok: false, code: 'CHECKSUM_MISMATCH', message: 'file failed verification' });
  // A part that changed after it was stored fails on its stat alone.
  await blobs.put(t.partId(1), part(bytes, 0), 'application/octet-stream');
  assert.deepEqual(await verifyTransfer(t, sha256(bytes)), { ok: false, code: 'CHECKSUM_MISMATCH', message: 'stored part failed verification' });
});

test('a running digest follows parts in order only, and forgets', () => {
  const a = new Uint8Array([1]), b = new Uint8Array([2]), c = new Uint8Array([3]);
  const running = new RunningDigests(2);
  running.track('x', 1, b, Date.now() + 60_000);
  assert.equal(running.digest('x', 1), null, 'a chain starts at part 0');
  running.track('x', 0, a, Date.now() + 60_000);
  running.track('x', 0, a, Date.now() + 60_000);
  running.track('x', 2, c, Date.now() + 60_000);
  assert.equal(running.digest('x', 2), null, 'a skipped part breaks the chain');
  running.track('x', 1, b, Date.now() + 60_000);
  assert.equal(running.digest('x', 2), sha256(new Uint8Array([1, 2])), 'a retried part is counted once');
  running.track('y', 0, a, Date.now() + 60_000);
  running.track('z', 0, a, Date.now() + 60_000);
  assert.equal(running.digest('z', 1), null, 'bounded: a third transfer is not tracked');
  running.forget('x');
  assert.equal(running.digest('x', 2), null);
  running.track('old', 0, a, Date.now() - 1);
  running.track('y', 1, b, Date.now() + 60_000);
  assert.equal(running.digest('old', 1), null, 'an expired digest is dropped');
});

test('an older S3 object reports an ETag: it counts as stored, and finalize reads it back', async () => {
  const inner = createMemoryBlobStore();
  const etags: BlobStore = { ...inner, async head(id) { const stat = await inner.head(id); return stat && { ...stat, checksum: `"etag-${stat.size}"` }; } };
  const bytes = new Uint8Array(P + 5).map((_, i) => i % 13);
  const t = transfer(etags, manifestOf(bytes));
  for (const n of [0, 1]) await storeTransferPart(t, n, part(bytes, n));
  assert.deepEqual((await transferProgress(t)).missing, []);
  assert.deepEqual(await verifyTransfer(t, 'f'.repeat(64)), { ok: true }, 'a running digest cannot vouch for unchecked parts');
  await inner.put(t.partId(1), new Uint8Array(5), 'application/octet-stream');
  assert.deepEqual(await verifyTransfer(t), { ok: false, code: 'CHECKSUM_MISMATCH', message: 'stored part failed verification' });
});

test('verified reads stop at the first byte the manifest does not declare, and removal is idempotent', async () => {
  const blobs = createMemoryBlobStore();
  const bytes = new Uint8Array(2 * P + 1).map((_, i) => i % 241);
  const t = transfer(blobs, manifestOf(bytes));
  for (const n of [0, 1, 2]) await storeTransferPart(t, n, part(bytes, n));
  assert.deepEqual(await drain(t), Buffer.from(bytes));
  assert.deepEqual(await readTransfer(t, bytes.length), Buffer.from(bytes));
  await assert.rejects(readTransfer(t, bytes.length - 1), /read limit/);
  await assert.rejects(drain(transfer(blobs, { ...manifestOf(bytes), checksum: 'e'.repeat(64) })), /transfer failed verification/);
  await blobs.put(t.partId(1), part(bytes, 0), 'application/octet-stream');
  await assert.rejects(drain(t), /part failed verification/);
  await removeTransferParts(t, 3);
  await removeTransferParts(t, 3);
  for (const n of [0, 1, 2]) assert.equal(await blobs.head(t.partId(n)), null);
  await assert.rejects(drain(t), /part unavailable/);
});
