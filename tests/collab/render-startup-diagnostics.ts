// SPDX-License-Identifier: MPL-2.0
/** Failure-only metadata for the owned loopback fixture; never retains catalog bytes. */
export async function catalogStartupDiagnostic(base: string, cookie: string, fetchImpl: typeof fetch = fetch) {
  let status = 0;
  const signal = AbortSignal.timeout(1000);
  try {
    const origin = new URL(base);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password
      || origin.pathname !== '/' || origin.search || origin.hash) return { status, result: 'invalid-fixture-origin' };
    const response = await fetchImpl(`${origin.origin}/catalog/tools/index.sig.json`, {
      headers: { cookie }, redirect: 'error', signal,
    });
    status = response.status;
    if (response.ok) {
      void response.body?.cancel().catch(() => {});
      return { status, result: 'available-after-deadline', body: 'not-read' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { status, result: 'response', body: 'unavailable' };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 1024) return { status, result: 'response', body: 'oversized' };
        chunks.push(part.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let value: { error?: { code?: unknown; message?: unknown } };
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof value; }
    catch { return { status, result: 'response', body: 'invalid-json' }; }
    const codes = ['BAD_REQUEST', 'INTERNAL', 'CATALOG_SIGNING_UNAVAILABLE', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'];
    const code = typeof value?.error?.code === 'string' && codes.includes(value.error.code) ? value.error.code : 'other';
    const message = value?.error?.message;
    const category = message === 'Mounted catalog publication could not be verified' ? 'publication-refused'
      : typeof message === 'string' && message.startsWith('Tool transport sibling') ? 'tool-coding-refused'
      : typeof message === 'string' && message.startsWith('tool directory') ? 'tool-tree-refused' : 'other';
    return { status, result: 'response', body: 'bounded-error', code, category };
  } catch {
    return { status, result: signal.aborted ? 'timed-out' : 'unavailable' };
  }
}
