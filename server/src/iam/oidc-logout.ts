// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import type { OidcPolicy } from './oidc.ts';

export interface OidcSession {
  idp: string;
  issuer: string;
  clientId: string;
  subject: string;
  sid?: string;
  /** ID token issue time, preserved by local renewal and device approval. */
  iat: number;
}
export interface LogoutEvent {
  replayKey: string;
  targetKey: string;
  iat: number;
}
export interface OidcLogoutStore {
  recordOidcLogout(event: LogoutEvent): Promise<boolean>;
  oidcSessionRevoked(session: OidcSession): Promise<boolean>;
}
export const logoutKey = (issuer: string, clientId: string, kind: string, value: string): string =>
  createHash('sha256').update(JSON.stringify([issuer, clientId, kind, value])).digest('hex');
export const sessionLogoutKeys = (s: OidcSession): string[] => [
  ...(s.sid ? [logoutKey(s.issuer, s.clientId, 'sid', s.sid)] : []),
];

/** A signed logout token has its own required claims and cannot be an ID token. */
export async function verifyLogoutToken(token: string, jwks: JSONWebKeySet,
  expect: { issuer: string; clientId: string } & OidcPolicy, now = Date.now()): Promise<LogoutEvent> {
  const { payload: p } = await jwtVerify(token, createLocalJWKSet(jwks), {
    issuer: expect.issuer, audience: expect.clientId, algorithms: [expect.signingAlgorithm ?? 'RS256'],
    requiredClaims: ['iss', 'aud', 'iat', 'jti', 'events'], currentDate: new Date(now),
  });
  if (!Number.isFinite(p.iat) || p.iat! * 1000 > now + 60_000 || now - p.iat! * 1000 > 300_000) throw new Error('logout token is not fresh');
  if (typeof p.jti !== 'string' || !p.jti || p.jti.length > 256 || p.nonce !== undefined) throw new Error('invalid logout token');
  const audiences = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (audiences.some(a => a !== expect.clientId && !expect.trustedAudiences?.includes(a!))) throw new Error('untrusted logout audience');
  const events = p.events as Record<string, unknown> | undefined;
  const event = events?.['http://schemas.openid.net/event/backchannel-logout'];
  if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).length) throw new Error('invalid logout event');
  const valid = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024;
  if ((p.sid !== undefined && !valid(p.sid)) || (p.sub !== undefined && !valid(p.sub)) || (!valid(p.sid) && !valid(p.sub))) throw new Error('logout token has no session or subject');
  // Governance requires session-specific logout, so providers must include sid.
  if (!valid(p.sid)) throw new Error('session-specific logout requires sid');
  return { replayKey: logoutKey(expect.issuer, expect.clientId, 'jti', p.jti),
    targetKey: logoutKey(expect.issuer, expect.clientId, 'sid', p.sid), iat: p.iat! };
}
