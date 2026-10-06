// SPDX-License-Identifier: MPL-2.0
import { canonicalJson } from '../lib/crypto.ts';
import { signBody, WorkerError, type WorkerConfig } from '../render/worker-client.ts';
import { readBlobBody } from '../blobs/types.ts';
export const PREVIEW_INPUT_LIMIT = 16 * 1024 * 1024;
export async function createFilePreview(worker: WorkerConfig, bytes: Uint8Array, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (!bytes.length || bytes.length > PREVIEW_INPUT_LIMIT) throw new WorkerError('The preview input is empty or too large.', 413);
  const payload = canonicalJson({ bytesB64: Buffer.from(bytes).toString('base64'), ts: Date.now() });
  const response = await fetchImpl(`${worker.url.replace(/\/$/, '')}/file-preview`, { method: 'POST', body: payload,
    headers: { 'content-type': 'application/json', 'x-lw-render-sig': signBody(payload, worker.secret) }, signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(worker.timeoutMs, 35_000))]) });
  if (!response.ok) throw new WorkerError(response.status === 503 ? 'The preview service is busy. Try again.' : 'This file could not be converted within the preview limits.', response.status === 422 ? 422 : response.status === 503 ? 503 : 502);
  if (!response.body || response.headers.get('content-type') !== 'application/pdf') throw new WorkerError('The preview service returned an invalid document.');
  const output = await readBlobBody(response.body, 32 * 1024 * 1024); signal.throwIfAborted();
  if (output.subarray(0, 5).toString() !== '%PDF-') throw new WorkerError('The preview service returned an invalid PDF.'); return output;
}
export async function readPreviewInput(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Buffer> {
  const reader = body.getReader(); const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); }; signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks = (async function* () { for (;;) { signal.throwIfAborted(); const next = await reader.read(); signal.throwIfAborted(); if (next.done) return; yield next.value; } })();
    return await readBlobBody(chunks, PREVIEW_INPUT_LIMIT);
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}
