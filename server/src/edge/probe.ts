// SPDX-License-Identifier: MPL-2.0
/**
 * `lw edge probe <hostname>`: read-only HTTP checks of a hostname through its
 * edge (plan 80 section 8.3, the public-class subset). Every request is a GET
 * with no credential of any kind; the cookies it sends are made-up probe values
 * that sign nobody in. It checks that:
 *
 *   - private answers and errors are not served from a shared cache, even when
 *     two requests carry different cookies;
 *   - the security headers arrive unchanged (compared with `--origin` when given);
 *   - purge-tag headers do not reach the client;
 *   - a provider image-transform path (`/cdn-cgi/image/`) is refused;
 *   - on a public-only hostname, private routes are refused.
 *
 * Zone settings are checked separately, by the server, through verifyZone.
 */
import { randomBytes } from 'node:crypto';
import type { ZoneFinding } from './types.ts';

export interface ProbeOptions {
  /** `https://<hostname>`, the address visitors use. */
  base: string;
  /** The origin behind the edge, to compare security headers byte for byte. */
  origin?: string;
  /** The hostname is configured publicOnly. */
  publicOnly?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface Seen { status: number; headers: Headers; body: string }

/** Headers a shared cache adds when it served a stored copy. */
export function servedFromCache(headers: Headers): string | null {
  const age = Number(headers.get('age') ?? '0');
  if (Number.isFinite(age) && age > 0) return `Age: ${headers.get('age')}`;
  const cf = headers.get('cf-cache-status');
  if (cf && /^(hit|stale|updating|revalidated)$/i.test(cf.trim())) return `CF-Cache-Status: ${cf}`;
  const bunny = headers.get('cdn-cache');
  if (bunny && /hit/i.test(bunny)) return `CDN-Cache: ${bunny}`;
  const xcache = headers.get('x-cache');
  if (xcache && /\bhit\b/i.test(xcache)) return `X-Cache: ${xcache}`;
  const status = headers.get('cache-status');
  if (status && /;\s*hit\b/i.test(status)) return `Cache-Status: ${status}`;
  return null;
}

const SECURITY_HEADERS = ['content-security-policy', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'referrer-policy', 'x-content-type-options', 'strict-transport-security'];
const TAG_HEADERS = ['cache-tag', 'cdn-tag', 'surrogate-key', 'edge-cache-tag'];

export async function runEdgeProbe(options: ProbeOptions): Promise<ZoneFinding[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = options.base.replace(/\/+$/, '');
  const out: ZoneFinding[] = [];
  const get = async (root: string, path: string, headers: Record<string, string> = {}): Promise<Seen | null> => {
    try {
      const res = await fetchImpl(`${root}${path}`, { method: 'GET', headers: { 'cache-control': 'no-cache', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      return { status: res.status, headers: res.headers, body: (await res.text().catch(() => '')).slice(0, 4096) };
    } catch { return null; }
  };
  const unreachable = (id: string, path: string): ZoneFinding => ({ id, status: 'fail', message: `${base}${path} did not answer.` });

  // 1. A private answer, asked twice with different made-up cookies.
  const nonce = randomBytes(6).toString('hex');
  const first = await get(base, '/api/auth/session', { cookie: `lw_edge_probe=${nonce}a` });
  const second = await get(base, '/api/auth/session', { cookie: `lw_edge_probe=${nonce}b` });
  if (!first || !second) out.push(unreachable('probe.private', '/api/auth/session'));
  else {
    const hit = servedFromCache(second.headers);
    const control = second.headers.get('cache-control') ?? '';
    const cdn = second.headers.get('cdn-cache-control');
    const privateHeaders = /\b(private|no-store)\b/.test(control) && (cdn === null || /\bno-store\b/.test(cdn));
    out.push(hit
      ? { id: 'probe.private', status: 'fail', message: `A private answer came from a shared cache (${hit}). A rule on the edge caches what the origin marks private; remove it.`, observed: hit }
      : privateHeaders
        ? { id: 'probe.private', status: 'pass', message: 'Private answers are not cached and keep private, no-store.', observed: control }
        : { id: 'probe.private', status: 'fail', message: `The private answer arrived with Cache-Control "${control}" and CDN-Cache-Control "${cdn ?? ''}". The edge changed the origin's headers.`, observed: control });
    if (options.publicOnly) {
      const refused = second.status === 404 && /PUBLIC_HOST_ONLY/.test(second.body);
      out.push(refused
        ? { id: 'probe.public-only', status: 'pass', message: 'Private routes are refused on this public-only hostname.', observed: second.status }
        : { id: 'probe.public-only', status: 'fail', message: `A private route answered ${second.status} on a public-only hostname. Check that the edge forwards the Host header unchanged, so the origin can tell this hostname apart.`, observed: second.status });
    }
  }

  // 2. An error, asked twice: errors are never stored.
  const missing = `/api/v1/edge-probe-missing-${nonce}`;
  const e1 = await get(base, missing), e2 = await get(base, missing);
  if (!e1 || !e2) out.push(unreachable('probe.errors', missing));
  else {
    const hit = servedFromCache(e2.headers);
    out.push(hit || e2.status < 400
      ? { id: 'probe.errors', status: 'fail', message: `A missing path answered ${e2.status}${hit ? ` from a shared cache (${hit})` : ''}. Errors must reach the origin every time.`, observed: hit ?? e2.status }
      : { id: 'probe.errors', status: 'pass', message: 'Errors are not cached.', observed: e2.status });
  }

  // 3. Security headers on the application page, compared with the origin when given.
  const page = await get(base, '/');
  if (!page) out.push(unreachable('probe.security-headers', '/'));
  else if (options.origin) {
    const direct = await get(options.origin.replace(/\/+$/, ''), '/');
    if (!direct) out.push({ id: 'probe.security-headers', status: 'warn', message: `The origin ${options.origin} did not answer, so the headers were not compared.` });
    else {
      const changed = SECURITY_HEADERS.filter(name => (page.headers.get(name) ?? '') !== (direct.headers.get(name) ?? ''));
      out.push(changed.length
        ? { id: 'probe.security-headers', status: 'fail', message: `The edge changed ${changed.join(', ')}. Security headers must pass through exactly as the origin sends them.`, observed: changed.join(',') }
        : { id: 'probe.security-headers', status: 'pass', message: 'Security headers match the origin.' });
    }
  } else {
    const absent = ['referrer-policy', 'x-content-type-options'].filter(name => !page.headers.get(name));
    out.push(absent.length
      ? { id: 'probe.security-headers', status: 'fail', message: `The page arrived without ${absent.join(', ')}.`, observed: absent.join(',') }
      : { id: 'probe.security-headers', status: 'info', message: 'Referrer-Policy and X-Content-Type-Options are present. Pass --origin to compare every security header with the origin.' });
  }

  // 4. A public, tagged answer: the tag header must not reach the client.
  const brand = await get(base, '/api/brand');
  if (brand) {
    const leaked = TAG_HEADERS.filter(name => brand.headers.get(name));
    out.push(leaked.length
      ? { id: 'probe.tag-header', status: 'warn', message: `${leaked.join(', ')} reached the client. Tags are opaque digests, but the edge should strip them.`, observed: leaked.join(',') }
      : { id: 'probe.tag-header', status: 'pass', message: 'No purge-tag header reached the client.' });
  }

  // 5. A provider transform of an origin path, with no token: must be refused.
  const transform = await get(base, '/cdn-cgi/image/width=64/api/brand/logo/light');
  if (!transform) out.push(unreachable('probe.transform', '/cdn-cgi/image/'));
  else out.push(transform.status >= 200 && transform.status < 300
    ? { id: 'probe.transform', status: 'fail', message: '/cdn-cgi/image/ answered 200. Image transformations are on for this zone; turn them off, because they serve a transformed copy of any path without the origin\'s checks.', observed: transform.status }
    : { id: 'probe.transform', status: 'pass', message: `/cdn-cgi/image/ is refused (${transform.status}).`, observed: transform.status });
  return out;
}
