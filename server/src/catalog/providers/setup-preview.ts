// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { mapProviderAsset, passesExposure } from '../federation.ts';
import { combinedState, entryWindow } from '../lifecycle.ts';
import { createProvider } from './registry.ts';
import type { ProviderAssetRef, ProviderRecord } from './types.ts';

export const SETUP_PREVIEW_LIMITS = { pages: 5, assets: 1000, listingBytes: 2 * 1024 * 1024, originalBytes: 32 * 1024 * 1024, timeoutMs: 30000 };

/** Read one stream with an aggregate deadline and byte cap; return no content. */
async function readChecked(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal) {
  const reader = body.getReader(), hash = createHash('sha256');
  let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error('Original exceeds the 32 MiB preview limit. Choose a smaller representative file.');
      hash.update(next.value);
    }
    if (!bytes) throw new Error('Original file is empty.');
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Opt-in evidence; no persisted fragment or file, and no returned secret. */
export async function previewGuidedProvider(rec: ProviderRecord, secret: string | undefined, fetchImpl: typeof fetch = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Preview timed out after 30 seconds. Narrow the folder or retry.')), SETUP_PREVIEW_LIMITS.timeoutMs);
  const { signal } = controller;
  // Driver rate-limit waits precede fetch. Bound those waits too, and fence any
  // late continuation with boundedFetch's abort check before it touches a URL.
  const deadline = <T>(operation: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(operation).then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
  const boundedFetch: typeof fetch = async (input, init) => {
    signal.throwIfAborted();
    const response = await fetchImpl(input, { ...init, signal });
    if (response.status === 206) {
      await response.body?.cancel();
      throw new Error('Server returned a partial original without a range request. Check the source.');
    }
    const googleJson = rec.kind === 'gdrive' && new URL(typeof input === 'object' && 'url' in input ? input.url : String(input)).searchParams.get('alt') !== 'media';
    if ((response.status !== 207 && !googleJson) || !response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    // Bound both DAV XML and OAuth/Drive JSON consumed by existing drivers.
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          signal.throwIfAborted();
          const next = await reader.read();
          signal.throwIfAborted();
          if (next.done) { signal.removeEventListener('abort', abort); stream.close(); reader.releaseLock(); return; }
          bytes += next.value.byteLength;
          if (bytes > SETUP_PREVIEW_LIMITS.listingBytes) throw new Error('Directory listing exceeds the 2 MiB preview limit. Narrow the folder.');
          stream.enqueue(next.value);
        } catch (error) { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); stream.error(error); }
      },
      cancel() { signal.removeEventListener('abort', abort); return reader.cancel(); },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  try {
    const provider = createProvider(rec, secret, { fetchImpl: boundedFetch });
    const health = await deadline(() => provider.healthCheck());
    if (!health.ok) return { health, sample: [], original: { ok: false, detail: 'Connection check failed.' } };
    const assets: ProviderAssetRef[] = [], seen = new Set<string>(), cursors = new Set<string>();
    let pages = 0, excludedByExposure = 0, unavailable = 0, skipped = 0, scanned = 0, truncated = false;
    let cursor: string | undefined;
    const notes = new Set<string>();
    try {
      do {
        signal.throwIfAborted();
        const page = await deadline(() => provider.listAssets(cursor));
        pages++; skipped += page.skipped ?? 0;
        for (const note of page.notes ?? []) notes.add(note);
        for (const asset of page.assets) {
          if (seen.has(asset.remoteId)) continue;
          if (scanned >= SETUP_PREVIEW_LIMITS.assets) { truncated = true; break; }
          seen.add(asset.remoteId); scanned++;
          if (!passesExposure(rec, asset)) { excludedByExposure++; continue; }
          const window = entryWindow(mapProviderAsset(rec, asset));
          if (combinedState(undefined, window, Date.now()).state !== 'live') { unavailable++; continue; }
          assets.push(asset);
        }
        cursor = page.next;
        if (cursor && cursors.has(cursor)) throw new Error('Listing repeated a pagination cursor. Check the server response.');
        if (cursor) cursors.add(cursor);
      } while (cursor && pages < SETUP_PREVIEW_LIMITS.pages && !truncated);
      truncated ||= Boolean(cursor);
    } catch (error) {
      return { health, sample: [], sampleError: (error as Error).message, original: { ok: false, detail: 'Listing failed.' } };
    }
    let original: { ok: boolean; detail?: string; assetId?: string; format?: string; contentType?: string; bytes?: number; sha256?: string };
    const representative = assets.find(asset => asset.formats.some(format => format.size === undefined || format.size <= SETUP_PREVIEW_LIMITS.originalBytes));
    const format = representative?.formats.find(format => format.size === undefined || format.size <= SETUP_PREVIEW_LIMITS.originalBytes);
    if (!representative || !format) original = { ok: false, detail: assets.length ? 'No original fits the 32 MiB preview limit. Choose a smaller representative file.' : 'No currently available files survive the folder and exposure rules.' };
    else {
      try {
        const blob = await deadline(() => provider.resolveBlob(representative.remoteId, format.remoteRef));
        if (blob.kind !== 'stream') throw new Error('This preview requires a streamed original.');
        const checked = await readChecked(blob.body, SETUP_PREVIEW_LIMITS.originalBytes, signal);
        if ((format.size !== undefined && format.size !== checked.bytes) || (blob.size !== undefined && blob.size !== checked.bytes)) throw new Error('Original byte count differs from its declared size. The file may have changed; retry.');
        original = { ok: true, assetId: mapProviderAsset(rec, representative).id, format: format.format, contentType: blob.contentType, ...checked };
      } catch (error) { original = { ok: false, detail: (error as Error).message }; }
    }
    return { health, sample: assets.slice(0, 10).map(asset => mapProviderAsset(rec, asset)), sampleTotal: assets.length,
      scanned, pages, truncated, excludedByExposure, unavailable, skipped, notes: [...notes], original };
  } catch (error) {
    return { health: { ok: false, detail: (error as Error).message }, sample: [], original: { ok: false, detail: 'Connection check failed.' } };
  } finally { clearTimeout(timeout); controller.abort(); }
}
