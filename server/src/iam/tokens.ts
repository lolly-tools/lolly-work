/**
 * HMAC-signed, domain-separated tokens.
 *
 * Every token carries a `typ` domain baked into the signed payload, so a
 * session token can never be replayed as a guest token, a link signature, or
 * an OAuth state - the same domain-separation rule services/ca established
 * and plans/02-identity-sso.md carries forward.
 */
import { b64u, b64uDecode, hmac, macEquals } from '../lib/crypto.ts';

export type TokenDomain = 'lw/session' | 'lw/guest' | 'lw/state' | 'lw/link' | 'lw/job' | 'lw/api-key';

export interface TokenBox<T> {
  typ: TokenDomain;
  exp: number; // unix seconds
  p: T;
}

export function mintToken<T>(typ: TokenDomain, payload: T, secret: string, ttlSec: number, now = Date.now()): string {
  const box: TokenBox<T> = { typ, exp: Math.floor(now / 1000) + ttlSec, p: payload };
  const body = b64u(JSON.stringify(box));
  return `${body}.${hmac(`${typ}.${body}`, secret)}`;
}

/** Verify signature + domain + expiry. Returns the payload or null - never throws on bad input. */
export function verifyToken<T>(typ: TokenDomain, token: string, secret: string | readonly string[], now = Date.now()): T | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Dual-key rotation (plans/35 wave 4): verification accepts current-then-
  // previous; minting always uses current. A list of one is the ordinary case.
  const keys = typeof secret === 'string' ? [secret] : secret;
  if (!keys.some((k) => macEquals(sig, hmac(`${typ}.${body}`, k)))) return null;
  let box: TokenBox<T>;
  try {
    box = JSON.parse(b64uDecode(body).toString('utf8')) as TokenBox<T>;
  } catch {
    return null;
  }
  if (box.typ !== typ) return null;
  if (typeof box.exp !== 'number' || box.exp * 1000 <= now) return null;
  return box.p;
}
