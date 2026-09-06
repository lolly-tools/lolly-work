/**
 * Cross-site request forgery guard for cookie-authenticated mutations.
 *
 * Sessions ride a SameSite=Lax cookie, which already stops a cross-site form
 * POST in every current browser. This adds the belt to that brace: a request
 * that changes state, carries a cookie and no bearer credential, and whose
 * browser says it came from another site (`Sec-Fetch-Site: cross-site`) or
 * whose `Origin` names a different site from the `Host` it reached, is refused
 * before any route runs. Non-browser callers (the `lw` CLI, service tokens,
 * curl) send an `Authorization` header or no cookie at all and are untouched.
 *
 * Site, not origin: the shell and the control plane may live on sibling
 * hostnames of one deployment (app.example.org and work.example.org), so a
 * matching registrable domain is enough. A different port on the same host is
 * the same site too, which keeps split development (Vite on :5173, the API on
 * :8787) working.
 */
import type { IncomingHttpHeaders } from 'node:http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function siteOf(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /^[\d.]+$/.test(h) || h.includes(':')) return h;
  const labels = h.split('.');
  return labels.length <= 2 ? h : labels.slice(-2).join('.');
}

function hostnameOf(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return hostHeader.split(':')[0] ?? hostHeader;
  }
}

/** A reason to refuse, or null when the request may proceed. */
export function csrfVerdict(method: string | undefined, headers: IncomingHttpHeaders): string | null {
  if (SAFE_METHODS.has((method ?? 'GET').toUpperCase())) return null;
  if (headers.authorization) return null;
  if (!headers.cookie) return null;
  const site = typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : undefined;
  if (site === 'cross-site') return 'cross-site request refused: this action needs a first-party page';
  const origin = typeof headers.origin === 'string' ? headers.origin : undefined;
  if (!origin) return null;
  if (origin === 'null') return 'request from an opaque origin refused';
  const host = typeof headers.host === 'string' ? headers.host : '';
  if (!host) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).hostname;
  } catch {
    return 'request with a malformed Origin refused';
  }
  if (siteOf(originHost) !== siteOf(hostnameOf(host))) {
    return `cross-site request refused: Origin ${origin} is not this deployment`;
  }
  return null;
}
