/**
 * Generic OIDC - discovery, Auth Code + PKCE (S256), id_token verified
 * against the provider JWKS (RS256 via WebCrypto). Provider-agnostic by
 * design: SUSE ID (id.suse.com, Keycloak) is the primary target but nothing
 * here knows that - instance config supplies issuer/clientId/claim map.
 *
 * The id_token signature is verified BEFORE any claim is believed; claims
 * feed the org user record (plans/02 §3), so an unverified decode is never
 * acceptable.
 */
import { createHash, randomBytes, type webcrypto } from 'node:crypto';
import { b64u, b64uDecode } from '../lib/crypto.ts';

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

export interface ClaimMap {
  firstname?: string;
  lastname?: string;
  email?: string;
  title?: string;
}

export interface MappedIdentity {
  sub: string;
  email: string;
  firstname?: string;
  lastname?: string;
  title?: string;
  groups: string[];
}

const discoveryCache = new Map<string, { at: number; doc: OidcDiscovery }>();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  const res = await fetchImpl(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  const doc = (await res.json()) as OidcDiscovery;
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(opts: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  nonce: string;
  scope?: string;
}): string {
  const u = new URL(opts.authorizationEndpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('scope', opts.scope ?? 'openid profile email');
  u.searchParams.set('state', opts.state);
  u.searchParams.set('nonce', opts.nonce);
  u.searchParams.set('code_challenge', opts.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function exchangeCode(opts: {
  tokenEndpoint: string;
  code: string;
  verifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<{ id_token?: string; access_token?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
  const res = await (opts.fetchImpl ?? fetch)(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return (await res.json()) as { id_token?: string; access_token?: string };
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

/** Verify an RS256 id_token against a JWKS and return its claims, or throw. */
export async function verifyIdToken(
  idToken: string,
  jwks: { keys: Jwk[] },
  expect: { issuer: string; clientId: string; nonce?: string },
  now = Date.now(),
): Promise<Record<string, unknown>> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  const [h, p, s] = parts as [string, string, string];
  const header = JSON.parse(b64uDecode(h).toString('utf8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error(`unsupported id_token alg: ${header.alg}`);
  const jwk = jwks.keys.find((k) => k.kty === 'RSA' && (!header.kid || k.kid === header.kid));
  if (!jwk) throw new Error('no matching JWKS key');
  const key = await crypto.subtle.importKey(
    'jwk',
    jwk as webcrypto.JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64uDecode(s),
    Buffer.from(`${h}.${p}`, 'utf8'),
  );
  if (!ok) throw new Error('id_token signature invalid');
  const claims = JSON.parse(b64uDecode(p).toString('utf8')) as Record<string, unknown>;
  if (claims.iss !== expect.issuer) throw new Error('id_token issuer mismatch');
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(expect.clientId) : aud === expect.clientId;
  if (!audOk) throw new Error('id_token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) throw new Error('id_token expired');
  if (expect.nonce && claims.nonce !== expect.nonce) throw new Error('id_token nonce mismatch');
  return claims;
}

/** Map verified claims onto the org identity via the instance's claim map. */
export function mapClaims(
  claims: Record<string, unknown>,
  claimMap: ClaimMap,
  groupsClaim: string,
): MappedIdentity {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  const sub = str(claims.sub);
  const email = str(claims[claimMap.email ?? 'email']);
  if (!sub) throw new Error('id_token carries no sub');
  if (!email) throw new Error('id_token carries no email claim');
  const rawGroups = claims[groupsClaim];
  const groups = Array.isArray(rawGroups) ? rawGroups.filter((g): g is string => typeof g === 'string') : [];
  const identity: MappedIdentity = { sub, email, groups };
  const firstname = str(claims[claimMap.firstname ?? 'given_name']);
  const lastname = str(claims[claimMap.lastname ?? 'family_name']);
  const title = str(claims[claimMap.title ?? 'title']);
  if (firstname) identity.firstname = firstname;
  if (lastname) identity.lastname = lastname;
  if (title) identity.title = title;
  return identity;
}

export function b64uJson(value: unknown): string {
  return b64u(JSON.stringify(value));
}
