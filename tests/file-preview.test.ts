// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewInputFormat } from '../workers/render/src/file-preview.ts';
import { createFilePreview, readPreviewInput } from '../server/src/catalog/file-preview.ts';
import { verifyBody } from '../server/src/render/worker-client.ts';
test('native preview inputs are recognised by bytes and bounded', () => {
  assert.equal(previewInputFormat(Buffer.from('%!PS-Adobe-3.0 EPSF-3.0')), 'eps');
  const emf = Buffer.alloc(88); emf.writeUInt32LE(1); emf.writeUInt32LE(0x464d4520, 40); assert.equal(previewInputFormat(emf), 'emf');
  const wmf = Buffer.alloc(22); wmf.writeUInt32LE(0x9ac6cdd7); assert.equal(previewInputFormat(wmf), 'wmf');
  assert.throws(() => previewInputFormat(Buffer.from('arbitrary SVG')), /not a supported/);
  assert.throws(() => previewInputFormat(Buffer.alloc(17 * 1024 * 1024)), /too large/);
});
test('preview jobs are signed and return a bounded PDF rather than arbitrary output', async () => {
  const config = { url: 'http://worker', secret: 'test-only-secret', timeoutMs: 5000 }, signal = new AbortController().signal;
  const fake = (async (_url, init) => { assert.equal(verifyBody(String(init?.body), config.secret, (init?.headers as Record<string, string>)['x-lw-render-sig']!), true); return new Response('%PDF-1.7\nfixture', { headers: { 'content-type': 'application/pdf' } }); }) as typeof fetch;
  assert.match((await createFilePreview(config, Buffer.from('%!PS fixture'), signal, fake)).toString(), /^%PDF/);
  const bad = (async () => new Response('not a PDF', { headers: { 'content-type': 'application/pdf' } })) as typeof fetch;
  await assert.rejects(createFilePreview(config, Buffer.from('%!PS fixture'), signal, bad), /invalid PDF/);
});

test('cancellation stops an upstream preview stream that never finishes', async () => {
  let cancelled = false; const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }); const controller = new AbortController();
  const read = readPreviewInput(stream, controller.signal); controller.abort(new Error('cancelled')); await assert.rejects(read, /cancelled/); assert.equal(cancelled, true);
});
