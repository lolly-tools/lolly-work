// SPDX-License-Identifier: MPL-2.0
import { setTimeout as delay } from 'node:timers/promises';
import { readBlobBody } from '../../blobs/types.ts';
import type { ProviderAssetRef, ProviderExposure, ResolvedBlob } from './types.ts';

export class DamHttpError extends Error {
  readonly status: number;
  constructor(kind: string, status: number) {
    super(`${kind} request failed (${status})${status === 429 ? '; rate limited, retry later' : ''}`);
    this.status = status;
  }
}

/** Exact HTTPS origins only. Credentials never follow an upstream redirect. */
export function damOrigin(value: string, kind: string): string {
  try {
    const url = new URL(value);
    if (/[\s\\]/.test(value) || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || /[*%]/.test(url.hostname) || url.port === '0' || (value !== url.origin && value !== `${url.origin}/`)) throw new Error();
    return url.origin;
  } catch { throw new Error(`${kind} needs an exact HTTPS origin without credentials or a path`); }
}

/** Bound JSON and redact network errors that may contain a signed URL or secret. */
export function createDamHttp(kind: string, fetchImpl: typeof fetch, minGapMs: number) {
  if (!Number.isInteger(minGapMs) || minGapMs < 0 || minGapMs > 60_000) throw new Error(`${kind} minGapMs must be between 0 and 60000`);
  let tail: Promise<void> = Promise.resolve(), lastStart = 0;
  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const slot = tail.then(async () => {
      const wait = minGapMs - (Date.now() - lastStart);
      if (wait > 0) await delay(wait);
      lastStart = Date.now();
    });
    tail = slot.catch(() => {});
    await slot;
    let res: Response;
    try { res = await fetchImpl(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(30_000) }); }
    catch { throw new Error(`${kind} transport failed; check connectivity and redirect policy`); }
    if (!res.ok || res.status === 206) {
      await res.body?.cancel().catch(() => {});
      throw new DamHttpError(kind, res.status);
    }
    return res;
  };
  return {
    request,
    async json(url: string, init?: RequestInit): Promise<unknown> {
      const res = await request(url, init);
      try {
        if (!res.body) throw new Error();
        return JSON.parse((await readBlobBody(res.body, 4 * 1024 * 1024)).toString('utf8'));
      } catch { throw new Error(`${kind} returned invalid or oversized JSON`); }
    },
    async stream(url: string, init?: RequestInit): Promise<ResolvedBlob> {
      const res = await request(url, init);
      if (!res.body) throw new Error(`${kind} returned no file body`);
      const size = Number(res.headers.get('content-length'));
      return { kind: 'stream', body: res.body, contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        ...(res.headers.has('content-length') && Number.isSafeInteger(size) && size >= 0 ? { size } : {}) };
    },
  };
}

export const damRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DAM response must be an object');
  return value as Record<string, unknown>;
};
export const damString = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;
export const damNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function damDate(value: unknown, kind: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`${kind} availability field is not a valid ISO date`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month! - 1 || calendar.getUTCDate() !== day) throw new Error(`${kind} availability field is not a valid calendar date`);
  return new Date(value).toISOString();
}
export function damLimit(value: number, max = 500): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`DAM result limit must be between 1 and ${max}`);
  return value;
}

/** Recheck the fresh source projection before requesting bytes. Groups stay at the API gate. */
export function assertDamExposure(asset: ProviderAssetRef, exposure: ProviderExposure = {}): void {
  if ((exposure.requireApproved && asset.approved !== true)
    || (exposure.includeSections?.length && !asset.sections.some(section => exposure.includeSections!.includes(section)))
    || (exposure.excludeTags?.length && asset.tags.some(tag => exposure.excludeTags!.includes(tag)))
    || (asset.availableFrom && Date.parse(asset.availableFrom) > Date.now())
    || (asset.availableUntil && Date.parse(asset.availableUntil) <= Date.now())) throw new Error('DAM asset is no longer available under this source policy');
}
