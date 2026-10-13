/**
 * Generic OIDC - discovery, Auth Code + PKCE (S256), id_token verified
 * against the provider JWKS using jose. Provider-agnostic by
 * design: SUSE ID (id.suse.com, Keycloak) is the primary target but nothing
 * here knows that - instance config supplies issuer/clientId/claim map.
 *
 * The id_token signature is verified BEFORE any claim is believed; claims
 * feed the org user record (plans/02 §3), so an unverified decode is never
 * acceptable.
 */
import { createHash, randomBytes } from 'node:crypto';
import { b64u } from '../lib/crypto.ts';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from 'jose';

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

export interface ClaimMap {
  firstname?: string;
  lastname?: string;
  email?: string;
  title?: string;
}

export interface MappedIdentity {
  oidc?: import('./oidc-logout.ts').OidcSession;
  sub: string;
  email: string;
  firstname?: string;
  lastname?: string;
  title?: string;
  groups: string[];
  /** The raw `email_verified` claim (admission counts only boolean true). */
  emailVerified?: unknown;
  /** Google Workspace hosted domain. */
  hd?: string;
  /** Microsoft Entra tenant id. */
  tid?: string;
  /** Other verified addresses of this sign-in (GitHub only, iam/github.ts),
   *  lowercased. They match an invitation and nothing else: never the
   *  admission lists, linking by email, or the stored email (plans/75 4.8
   *  rule 7). */
  invitationEmails?: string[];
}

/** Authorization request parameters an operator may add per IdP. Anything
 *  else (redirect_uri, response_type, state, PKCE) is ours and never set
 *  from configuration. */
export const AUTH_PARAM_ALLOWLIST = ['prompt', 'hd', 'domain_hint', 'login_hint', 'acr_values'] as const;
export type AuthParam = typeof AUTH_PARAM_ALLOWLIST[number];

export type TokenAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';
export interface OidcPolicy {
  tokenEndpointAuthMethod?: TokenAuthMethod;
  signingAlgorithm?: 'RS256' | 'ES256' | 'PS256';
  trustedAudiences?: string[];
  assurance?: { acrValues?: string[]; amrValues?: string[]; maxAgeSeconds?: number };
}

/** HTTPS is mandatory except for a loopback development IdP. */
export function oidcUrl(value: string, issuer = false): URL {
  const u = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) || u.username || u.password || u.hash || (issuer && u.search)) {
    throw new Error('invalid OIDC endpoint URL');
  }
  return u;
}

/** Bound the entire response, including its body, and never follow redirects with credentials. */
export async function oidcJson(url: string, fetchImpl: typeof fetch, init: RequestInit = {}): Promise<unknown> {
  oidcUrl(url);
  const res = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OIDC request failed: ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('empty OIDC response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error('OIDC response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

const discoveryCaches = new WeakMap<typeof fetch, Map<string, { at: number; doc: OidcDiscovery }>>();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OidcDiscovery> {
  oidcUrl(issuer, true);
  let cache = discoveryCaches.get(fetchImpl);
  if (!cache) { cache = new Map(); discoveryCaches.set(fetchImpl, cache); }
  const cached = cache.get(issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  const doc = await oidcJson(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, fetchImpl) as OidcDiscovery;
  if (!doc || doc.issuer !== issuer) throw new Error('OIDC discovery issuer mismatch');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[k] !== 'string') throw new Error(`OIDC discovery missing ${k}`);
    const endpoint = oidcUrl(doc[k]);
    if (issuer.startsWith('https:') && endpoint.protocol !== 'https:') throw new Error('OIDC endpoint must use HTTPS');
  }
  if (doc.end_session_endpoint !== undefined) {
    const endpoint = oidcUrl(doc.end_session_endpoint);
    if (issuer.startsWith('https:') && endpoint.protocol !== 'https:') throw new Error('OIDC endpoint must use HTTPS');
  }
  if (doc.token_endpoint_auth_methods_supported !== undefined && (!Array.isArray(doc.token_endpoint_auth_methods_supported)
    || doc.token_endpoint_auth_methods_supported.some(v => typeof v !== 'string'))) throw new Error('invalid token endpoint authentication metadata');
  cache.set(issuer, { at: Date.now(), doc });
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
  assurance?: OidcPolicy['assurance'];
  /** Extra allowlisted parameters (`AUTH_PARAM_ALLOWLIST`); others are dropped. */
  params?: Partial<Record<string, string>>;
}): string {
  const u = new URL(opts.authorizationEndpoint);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v && (AUTH_PARAM_ALLOWLIST as readonly string[]).includes(k)) u.searchParams.set(k, v);
  }
  if (opts.assurance?.acrValues?.length) u.searchParams.set('acr_values', opts.assurance.acrValues.join(' '));
  if (opts.assurance?.maxAgeSeconds !== undefined) u.searchParams.set('max_age', String(opts.assurance.maxAgeSeconds));
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
  authMethod?: TokenAuthMethod;
  supportedAuthMethods?: string[];
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
  const method = opts.authMethod ?? (opts.clientSecret ? 'client_secret_post' : 'none');
  if (opts.supportedAuthMethods && !opts.supportedAuthMethods.includes(method)) throw new Error('IdP does not support configured client authentication');
  if (method !== 'none' && !opts.clientSecret) throw new Error('client authentication needs a secret');
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (method === 'client_secret_post') body.set('client_secret', opts.clientSecret!);
  if (method === 'client_secret_basic') {
    const form = (v: string): string => new URLSearchParams({ v }).toString().slice(2);
    headers.authorization = `Basic ${Buffer.from(`${form(opts.clientId)}:${form(opts.clientSecret!)}`).toString('base64')}`;
    body.delete('client_id');
  }
  return await oidcJson(opts.tokenEndpoint, opts.fetchImpl ?? fetch, { method: 'POST', headers, body: body.toString() }) as { id_token?: string; access_token?: string };
}

/** Clock skew tolerated on `iat` - an id_token minted further in the future than this is refused. */
const IAT_SKEW_MS = 5 * 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCaches = new WeakMap<typeof fetch, Map<string, { keys: JSONWebKeySet['keys']; at: number }>>();

/** The `kid` an id_token's header names, so the JWKS cache knows when a rotation forces a refetch. */
export function kidOf(idToken: string): string | undefined {
  try {
    const header = decodeProtectedHeader(idToken);
    return typeof header.kid === 'string' ? header.kid : undefined;
  } catch {
    return undefined;
  }
}

/** JWKS by URI, cached for JWKS_TTL_MS and refetched early when the token's
 *  `kid` is not in the cached set (a key rotation), so a callback neither hits
 *  the IdP on every sign-in nor fails for the TTL after a rotation. */
export async function fetchJwks(
  uri: string,
  fetchImpl: typeof fetch,
  kid?: string,
  now = Date.now(),
): Promise<JSONWebKeySet> {
  let jwksCache = jwksCaches.get(fetchImpl);
  if (!jwksCache) { jwksCache = new Map(); jwksCaches.set(fetchImpl, jwksCache); }
  const cached = jwksCache.get(uri);
  if (cached && now - cached.at < JWKS_TTL_MS && (!kid || cached.keys.some((k) => k.kid === kid))) {
    return { keys: cached.keys };
  }
  const body = await oidcJson(uri, fetchImpl) as JSONWebKeySet;
  if (!body || !Array.isArray(body.keys) || !body.keys.length) throw new Error('invalid JWKS');
  const keys = body.keys;
  jwksCache.set(uri, { keys, at: now });
  return { keys };
}

/** Test seam: forget every cached JWKS. */
export function resetJwksCache(): void {
  jwksCaches = new WeakMap();
}

/** Verify signature and required claims before applying this provider's OIDC policy. */
export async function verifyIdToken(
  idToken: string,
  jwks: JSONWebKeySet,
  expect: { issuer: string; clientId: string; nonce?: string } & OidcPolicy,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  const { payload: claims } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: expect.issuer, audience: expect.clientId,
    algorithms: [expect.signingAlgorithm ?? 'RS256'],
    requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat'], currentDate: new Date(now),
  });
  if (typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp)) throw new Error('invalid required id_token claims');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audiences.some(a => a !== expect.clientId && !expect.trustedAudiences?.includes(a!))) throw new Error('untrusted id_token audience');
  // This supported provider profile binds azp to this client when supplied.
  if (claims.azp !== undefined && claims.azp !== expect.clientId) throw new Error('id_token authorized party mismatch');
  if (claims.iat! * 1000 > now + IAT_SKEW_MS) throw new Error('id_token issued in the future');
  if (expect.nonce !== undefined && claims.nonce !== expect.nonce) throw new Error('id_token nonce mismatch');
  const policy = expect.assurance;
  if (policy?.acrValues?.length && (typeof claims.acr !== 'string' || !policy.acrValues.includes(claims.acr))) throw new Error('id_token assurance level insufficient');
  const methods = claims.amr;
  if (policy?.amrValues?.length && (!Array.isArray(methods) || !policy.amrValues.every(v => methods.includes(v)))) throw new Error('id_token authentication methods insufficient');
  if (policy?.maxAgeSeconds !== undefined && (typeof claims.auth_time !== 'number' || !Number.isFinite(claims.auth_time)
    || claims.auth_time * 1000 > now + IAT_SKEW_MS || now - claims.auth_time * 1000 > policy.maxAgeSeconds * 1000 + 60_000)) throw new Error('id_token authentication too old');
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
  // `email_verified` vouches for the `email` claim and nothing else. When
  // claimMap.email names another claim (preferred_username, upn), the flag
  // carries over only if that value IS the verified email; otherwise the
  // address counts as verified only under emailVerification 'trusted'.
  const vouched = typeof claims.email === 'string' && claims.email.trim().toLowerCase() === email.trim().toLowerCase();
  if (claims.email_verified !== undefined && vouched) identity.emailVerified = claims.email_verified;
  const hd = str(claims.hd);
  const tid = str(claims.tid);
  if (hd) identity.hd = hd;
  if (tid) identity.tid = tid;
  return identity;
}

export function b64uJson(value: unknown): string {
  return b64u(JSON.stringify(value));
}
