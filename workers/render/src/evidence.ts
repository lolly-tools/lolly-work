import { createHash } from 'node:crypto';
import type { Page, Response } from 'playwright-core';
const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Network observations are partial: they do not prove shaping or resource use. */
export function observeWorkerResources(page: Page) {
  const resources: { url: string; sha256: string; size: number }[] = [], limitations = new Set<string>(['font-shaping-and-resource-use-unattested']);
  const pending = new Set<Promise<void>>(); let retained = 0, count = 0, sealed = false;
  const observe = (response: Response): void => {
    if (sealed) return;
    const work = (async () => {
      if (++count > 256) { limitations.add('worker-resource-count-budget'); return; }
      const length = Number(response.headers()['content-length']);
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024 || retained + length > 32 * 1024 * 1024) { limitations.add('worker-resource-size-unavailable-or-budget'); return; }
      retained += length;
      const body = await response.body();
      if (body.length > 8 * 1024 * 1024) { limitations.add('worker-resource-decoded-byte-budget'); return; }
      if (!sealed) resources.push({ url: response.url(), sha256: digest(body), size: body.length });
    })().catch(() => { limitations.add('worker-resource-read-failed'); });
    pending.add(work); void work.finally(() => pending.delete(work));
  };
  page.on('response', observe);
  return async (svg: string, requestSha256: string) => {
    page.off('response', observe);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...pending]), new Promise<void>(resolve => { timer = setTimeout(() => { limitations.add('worker-resource-read-timeout'); resolve(); }, 5000); })]);
    if (timer) clearTimeout(timer); sealed = true;
    return { version: 1 as const, requestSha256, outputSha256: digest(svg), resources: resources.sort((a, b) => a.url.localeCompare(b.url) || a.sha256.localeCompare(b.sha256)), limitations: [...limitations].sort() };
  };
}
