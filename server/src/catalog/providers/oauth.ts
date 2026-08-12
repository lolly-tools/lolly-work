/**
 * Shared OAuth plumbing for refresh-token providers (plans/17 §11 phase 4:
 * Dropbox, Google Drive, O365/Graph).
 *
 * The sealed credential for an OAuth kind is one JSON blob:
 *   {"clientId": "…", "clientSecret": "…", "refreshToken": "…"}
 * — the operator's OWN registered app (BYOT, §13: no shared client ids ship in
 * this repo), captured once via `lw providers auth <id>` and stored through
 * the same write-only credential endpoint as any API key.
 *
 * Access tokens never touch the store: they live in a process-level cache
 * keyed by provider id + a hash of the refresh token, because provider
 * instances are created per request — without this cache every blob fetch
 * would burn a refresh-token exchange.
 */
import { sha256Hex } from '../../lib/crypto.ts';

export interface OAuthCredential {
  clientId: string;
  /** Absent for public (PKCE) clients — Dropbox and Microsoft allow them. */
  clientSecret?: string;
  refreshToken: string;
}

export function parseOAuthCredential(secret: string | undefined): OAuthCredential {
  if (!secret) throw new Error('oauth provider has no credential');
  let parsed: unknown;
  try { parsed = JSON.parse(secret); } catch {
    throw new Error('oauth credential must be JSON: {"clientId","clientSecret?","refreshToken"} — use `lw providers auth`');
  }
  const c = parsed as Partial<OAuthCredential>;
  if (typeof c.clientId !== 'string' || !c.clientId || typeof c.refreshToken !== 'string' || !c.refreshToken) {
    throw new Error('oauth credential needs clientId and refreshToken');
  }
  return { clientId: c.clientId, refreshToken: c.refreshToken, ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}) };
}

interface CachedToken { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>();
const EXPIRY_SLACK_MS = 60_000; // refresh a minute early, never serve a dying token

/** Exchange the refresh token at `tokenUrl` (standard RFC 6749 form POST),
 *  caching the access token until shortly before expiry. `extraParams` carries
 *  provider quirks (Graph wants a scope on refresh). */
export async function getAccessToken(opts: {
  providerId: string;
  cred: OAuthCredential;
  tokenUrl: string;
  extraParams?: Record<string, string>;
  fetchImpl: typeof fetch;
  now?: () => number;
}): Promise<string> {
  const now = opts.now ?? Date.now;
  const cacheKey = `${opts.providerId}:${sha256Hex(opts.cred.refreshToken).slice(0, 16)}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt - EXPIRY_SLACK_MS > now()) return hit.token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: opts.cred.refreshToken,
    client_id: opts.cred.clientId,
    ...(opts.cred.clientSecret ? { client_secret: opts.cred.clientSecret } : {}),
    ...opts.extraParams,
  });
  const res = await opts.fetchImpl(opts.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`oauth token refresh failed (${res.status}) — re-run \`lw providers auth\` if the grant was revoked`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('oauth token response carried no access_token');
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: now() + (typeof data.expires_in === 'number' ? data.expires_in * 1000 : 3600_000),
  });
  return data.access_token;
}

/** Drop cached tokens for a provider (credential rotation/clear). */
export function invalidateAccessTokens(providerId: string): void {
  for (const key of tokenCache.keys()) {
    if (key.startsWith(`${providerId}:`)) tokenCache.delete(key);
  }
}
