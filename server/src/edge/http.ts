// SPDX-License-Identifier: MPL-2.0
/**
 * One provider API request. The base URL is a constant in each adapter, never
 * configuration, so a credential can only reach its own provider. Redirects are
 * refused (a redirect would carry the credential somewhere else), the request
 * has a deadline, and every error message is scrubbed of the credential before
 * it is thrown, logged or stored.
 */
import { EdgeApiError } from './types.ts';

export interface ApiAnswer {
  status: number;
  headers: Headers;
  json: unknown;
}

export interface ApiRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Remove every occurrence of the credential from text that may be stored. */
export function scrub(text: string, secret: string): string {
  let out = text;
  if (secret.length >= 4) out = out.split(secret).join('[redacted]');
  return out.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300);
}

/** Retry-After as milliseconds: delta seconds or an HTTP date, capped at an hour. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const ms = /^\d+$/.test(trimmed) ? Number(trimmed) * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 3_600_000) : undefined;
}

export async function apiRequest(fetchImpl: typeof fetch, req: ApiRequest, secret: string, timeoutMs: number): Promise<ApiAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(req.url, {
      method: req.method,
      headers: { accept: 'application/json', ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}), ...req.headers },
      ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EdgeApiError(`The provider API did not answer (${scrub(reason, secret)}).`);
  }
  const text = await response.text().catch(() => '');
  let json: unknown = null;
  if (text) { try { json = JSON.parse(text); } catch { json = null; } }
  return { status: response.status, headers: response.headers, json };
}

/** An error for a non-success answer, with the provider's own short explanation when it gave one. */
export function answerError(answer: ApiAnswer, what: string, secret: string, explanation?: string): EdgeApiError {
  const status = answer.status;
  // A malformed request fails the same way every time; authorization and
  // availability can recover once an operator fixes the credential or the zone.
  const permanent = status === 400 || status === 422;
  const detail = explanation ? `: ${scrub(explanation, secret)}` : '';
  return new EdgeApiError(`${what} answered ${status}${detail}`, {
    status,
    permanent,
    ...(retryAfterMs(answer.headers.get('retry-after')) !== undefined ? { retryAfterMs: retryAfterMs(answer.headers.get('retry-after'))! } : {}),
  });
}

/** Split items into requests of at most `size` items. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/** The hostname of an absolute HTTPS URL with no credentials, or null. */
export function httpsHost(value: string): string | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  return url.hostname.toLowerCase();
}
