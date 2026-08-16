/**
 * Session + guest cookies. Stateless (HMAC via tokens.ts), httpOnly,
 * SameSite=Lax; Secure whenever the instance base is https.
 *
 * Two principals, two cookies, two token domains:
 *   lw_session - a signed-in member (from OIDC or the dev provider)
 *   lw_guest - a guest admitted by a guest-edit link (plans/02 §8)
 */
import { mintToken, verifyToken } from './tokens.ts';

export const SESSION_COOKIE = 'lw_session';
export const GUEST_COOKIE = 'lw_guest';
// Fallback session lifetime when no instance policy is threaded through; the live
// value comes from policy.sessionTtlHours (see config/instance.ts). 12h ≈ a work
// shift: short enough that an uncaught revocation self-heals same-day, long enough
// to avoid re-auth churn. Both the signed-token exp and the cookie Max-Age derive
// from the same value so they never drift.
export const DEFAULT_SESSION_TTL_SEC = 12 * 60 * 60;

export interface SessionUser {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  role: string;
  /** The user's sessionEpoch at mint - checked against the stored epoch on
   *  every authenticated request (pre-expiry revocation). Optional for
   *  back-compat: tokens minted before this field existed carry no epoch and
   *  are read as 0, matching the column default, so pre-upgrade sessions stay
   *  valid until an actual bump. */
  epoch?: number;
}

export interface GuestSession {
  linkId: string;
  toolId: string;
  sessionRef?: string;
  inviter: string;
  /** Display name the guest chose - rendered as "<name> (guest of <inviter>)". */
  name: string;
}

export type Principal =
  | { kind: 'member'; user: SessionUser }
  | { kind: 'guest'; guest: GuestSession };

/**
 * A guest principal's canonical id string - the AUDIT actor for everything a
 * guest does (`GET /l/:id`'s `guest.admit`, the collab room's
 * `collab.join`/`collab.leave`, a room's quiesce revision), and the shape
 * `activity/feed.ts`'s `parseActor` already renders as "a guest".
 *
 * The LINK id, not the guest's chosen name: a guest is pseudonymous (plans/02
 * §8) and its display name is client-supplied, so the only accountable identity
 * it has is the link that admitted it - which is also the thing an operator
 * revokes. One function, so a guest's audit row, its room seat and its revision
 * cannot end up naming the same principal three ways.
 */
export function guestActor(linkId: string): string {
  return `guest:${linkId}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function cookieValue(name: string, value: string, opts: { secure: boolean; maxAgeSec: number }): string {
  const bits = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${opts.maxAgeSec}`];
  if (opts.secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearCookie(name: string, secure: boolean): string {
  return cookieValue(name, '', { secure, maxAgeSec: 0 });
}

export function mintSessionCookie(user: SessionUser, secret: string, secure: boolean, ttlSec: number = DEFAULT_SESSION_TTL_SEC): string {
  const token = mintToken('lw/session', user, secret, ttlSec);
  return cookieValue(SESSION_COOKIE, token, { secure, maxAgeSec: ttlSec });
}

export function mintGuestCookie(guest: GuestSession, secret: string, secure: boolean, ttlSec: number): string {
  const token = mintToken('lw/guest', guest, secret, ttlSec);
  return cookieValue(GUEST_COOKIE, token, { secure, maxAgeSec: ttlSec });
}

/** Member session wins when both cookies are present. Returns null when neither verifies. */
export function readPrincipal(cookieHeader: string | undefined, secret: string): Principal | null {
  const cookies = parseCookies(cookieHeader);
  const session = cookies[SESSION_COOKIE];
  if (session) {
    const user = verifyToken<SessionUser>('lw/session', session, secret);
    if (user) return { kind: 'member', user };
  }
  const guest = cookies[GUEST_COOKIE];
  if (guest) {
    const g = verifyToken<GuestSession>('lw/guest', guest, secret);
    if (g) return { kind: 'guest', guest: g };
  }
  return null;
}
