/**
 * Session + guest cookies. Stateless (HMAC via tokens.ts), httpOnly,
 * SameSite=Lax; Secure whenever the instance base is https.
 *
 * Two principals, two cookies, two token domains:
 *   lw_session - a signed-in member (from OIDC or the dev provider)
 *   lw_guest - a guest admitted by a guest-edit link (plans/02 §8)
 */
import { b64uDecode } from '../lib/crypto.ts';
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
  /** Time of the last completed sign-in; session refreshes cannot advance it. */
  authenticatedAt?: number;
  /** When this chain of sessions began (ms): the sign-in, or the device
   *  approval, that the session and every renewal of it descend from. Sliding
   *  renewal (`sessionRenewal`) carries it unchanged, so a renewed session never
   *  outlives `authAt + policy.sessionMaxHours`. `mintSessionCookie` stamps it
   *  when the caller does not; a cookie minted before it existed has none and
   *  is read as starting at its sign-in, or else when it was issued. */
  authAt?: number;
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

/** A new session starts its renewal chain now, unless the caller carries one
 *  over (a renewal passes the `authAt` it read). */
export function mintSessionCookie(
  user: SessionUser, secret: string, secure: boolean, ttlSec: number = DEFAULT_SESSION_TTL_SEC, now: number = Date.now(),
): string {
  const payload: SessionUser = typeof user.authAt === 'number' ? user : { ...user, authAt: user.authenticatedAt ?? now };
  const token = mintToken('lw/session', payload, secret, ttlSec, now);
  return cookieValue(SESSION_COOKIE, token, { secure, maxAgeSec: ttlSec });
}

/** A verified member session token with its expiry (unix seconds). */
export interface MemberSession {
  user: SessionUser;
  exp: number;
}

/**
 * The member session cookie, verified, with the expiry the token was signed
 * with. Null for no cookie, a bad signature, a wrong domain or an expired
 * token, exactly as `readPrincipal` refuses them. The expiry is read from the
 * token itself only after `verifyToken` accepted it, so it is the signed value.
 */
export function readMemberSession(cookieHeader: string | undefined, secret: string | readonly string[], now: number = Date.now()): MemberSession | null {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const user = verifyToken<SessionUser>('lw/session', token, secret, now);
  if (!user) return null;
  try {
    const box = JSON.parse(b64uDecode(token.slice(0, token.lastIndexOf('.'))).toString('utf8')) as { exp?: unknown };
    return typeof box.exp === 'number' && Number.isFinite(box.exp) ? { user, exp: box.exp } : null;
  } catch {
    return null;
  }
}

/** A renewal must lengthen the session by at least this much to be minted. */
const RENEWAL_MIN_GAIN_MS = 60_000;

/** What a renewal mints: the chain's start, carried over, and the new lifetime. */
export interface SessionRenewal {
  authAt: number;
  ttlSec: number;
}

/**
 * Sliding renewal (plans/75 RENEW): whether a member session should be
 * re-minted now, and for how long. Pure; the caller asks the store whether the
 * person is still a live, admitted member before minting anything.
 *
 * - Nothing happens in the first half of a session's lifetime, so an active
 *   person gets at most one new cookie per half TTL.
 * - The chain's start is the token's `authAt`. A cookie minted before `authAt`
 *   existed counts from its sign-in time (`authenticatedAt`, set at mint by
 *   every sign-in but the dev provider's), else from its issue time
 *   (`exp - ttl`). The earlier of that and the issue time is used, so a raised
 *   `sessionTtlHours` can shorten a chain but not lengthen it. (Only a cookie
 *   with neither field, minted before a lowered TTL, can gain the difference,
 *   once.)
 * - A renewal is refused once `now - authAt` reaches `sessionMaxHours`, and the
 *   new lifetime is cut so the cookie never outlives `authAt + sessionMaxHours`.
 * - When the cut would leave the new cookie ending less than a minute after
 *   the old one, there is nothing worth renewing, so a session close to its
 *   cap is not re-minted on every request. With `sessionMaxHours` absent
 *   (equal to the TTL) the new cookie never ends later, so renewal is off.
 */
export function sessionRenewal(
  session: MemberSession, policy: { ttlSec: number; maxSec: number }, now: number = Date.now(),
): SessionRenewal | null {
  const expMs = session.exp * 1000;
  if (expMs - now > (policy.ttlSec * 1000) / 2) return null;
  const authAt = sessionChainStart(session, policy.ttlSec);
  const ttlSec = chainTtlSec(authAt, policy, now);
  if (ttlSec <= 0 || now + ttlSec * 1000 < expMs + RENEWAL_MIN_GAIN_MS) return null;
  return { authAt, ttlSec };
}

/**
 * When the chain a verified session belongs to began (ms), by the rule
 * `sessionRenewal` follows: the token's `authAt`, else its sign-in time
 * (`authenticatedAt`), never later than when the token was issued
 * (`exp - ttl`), and the issue time for a token with neither. Every way of
 * minting a session from a live one (a renewal, a device approval, staying
 * signed in after removing a sign-in) starts from this, so none of them
 * starts a new chain without a sign-in.
 */
export function sessionChainStart(session: MemberSession, ttlSec: number): number {
  const issuedAt = session.exp * 1000 - ttlSec * 1000;
  const stamped = session.user.authAt ?? session.user.authenticatedAt;
  return typeof stamped === 'number' && Number.isFinite(stamped) ? Math.min(stamped, issuedAt) : issuedAt;
}

/**
 * The lifetime (whole seconds) a cookie minted now in the chain that began at
 * `authAt` may have: a full TTL, cut so that it never outlives
 * `authAt + maxSec`. Zero or less means the chain has ended, and the caller
 * mints nothing: the person signs in again.
 */
export function chainTtlSec(authAt: number, policy: { ttlSec: number; maxSec: number }, now: number = Date.now()): number {
  if (!Number.isFinite(authAt)) return 0;
  return Math.floor((Math.min(now + policy.ttlSec * 1000, authAt + policy.maxSec * 1000) - now) / 1000);
}

export function mintGuestCookie(guest: GuestSession, secret: string, secure: boolean, ttlSec: number): string {
  const token = mintToken('lw/guest', guest, secret, ttlSec);
  return cookieValue(GUEST_COOKIE, token, { secure, maxAgeSec: ttlSec });
}

/** Member session wins when both cookies are present. Returns null when neither verifies. */
export function readPrincipal(cookieHeader: string | undefined, secret: string | readonly string[]): Principal | null {
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
