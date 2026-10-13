// SPDX-License-Identifier: MPL-2.0
/** Exact configured origins for cookie-authenticated mutations. */
import type { IncomingHttpHeaders } from 'node:http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfVerdict(
  method: string | undefined, headers: IncomingHttpHeaders, allowedUrls: readonly (string | undefined)[] = [],
): string | null {
  if (SAFE_METHODS.has((method ?? 'GET').toUpperCase())) return null;
  if (headers.authorization || !headers.cookie) return null;
  const site = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : undefined;
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  if (!origin) return site === 'cross-site' || site === 'same-site'
    ? 'cross-site request refused: this action needs a configured first-party origin' : null;
  if (origin === 'null') return 'request from an opaque origin refused';
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return 'request with a malformed Origin refused'; }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin) return 'request with a malformed Origin refused';
  const allowed = allowedUrls.flatMap(url => {
    try { return url ? [new URL(url).origin] : []; } catch { return []; }
  });
  return allowed.includes(origin) ? null : 'cross-site request refused: Origin is not this deployment';
}
