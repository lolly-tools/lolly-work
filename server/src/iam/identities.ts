// SPDX-License-Identifier: MPL-2.0
/**
 * One person, many sign-ins (plans/74). Which user a verified sign-in belongs
 * to, and what the person sees about their linked sign-ins.
 *
 * The order is fixed and the first hit wins:
 *   1. a `user_identities` row for this subject: that user;
 *   2. a user created with this subject (`users.sub`) before identities were
 *      recorded: that user, and the caller writes the row;
 *   3. when the IdP links by email and vouched for the address: exactly one
 *      user holding a VERIFIED identity with the same address. Two or more is
 *      ambiguous and links nothing. A user whose verified rows for that
 *      address all come from IdPs pinned to a directory (`hostedDomain`,
 *      `tenantId`) is joined only by an IdP with the same pin: the pin is
 *      what ties that account to the organisation's directory, and an
 *      unpinned IdP such as GitHub never re-checks an address it once
 *      verified, so a former holder of a reassigned mailbox could still
 *      present it there;
 *   4. otherwise a new user.
 *
 * Reads only. The caller runs admission on the answer before writing
 * anything, so a refused sign-in leaves no row behind.
 */
import { sha256Hex } from '../lib/crypto.ts';
import type { Store, UserIdentityRecord, UserRecord, UserUpsert } from '../store/types.ts';

export type SignInResolution =
  | { via: 'identity' | 'legacy' | 'email'; user: UserRecord }
  /** `candidates` counts the users an ambiguous email matched (0 when none).
   *  `pinned` is set when the one match was held back by its IdP's pin. */
  | { via: 'new'; candidates: number; pinned?: true };

export interface SignInSubject {
  /** The namespaced subject: `<idp id>:<sub>`, the raw primary sub, or `proxy:<user>`. */
  sub: string;
  email: string;
  /** The IdP vouched for `email` (the admission rule's `emailIsVerified`). */
  emailVerified: boolean;
  /** The IdP's `linkByEmail` (config/instance.ts `linkByEmailFor`). */
  linkByEmail: boolean;
  /** This IdP's directory pin (`idpPin`), or null when it has none. */
  pin?: string | null;
  /** The pin of a stored row's IdP: null for an unpinned IdP, undefined for
   *  one no longer configured (treated as pinned to something else). */
  pinOf?: (idp: string) => string | null | undefined;
}

/** One string naming the directory an IdP is pinned to, or null when it has
 *  no pin. Two IdPs with equal pins vouch for the same directory. */
export function idpPin(c: { hostedDomain?: string; tenantId?: string }): string | null {
  const parts = [
    ...(c.hostedDomain ? [`hd:${c.hostedDomain.toLowerCase()}`] : []),
    ...(c.tenantId ? [`tid:${c.tenantId.toLowerCase()}`] : []),
  ];
  return parts.length ? parts.join('|') : null;
}

export async function resolveSignIn(store: Store, s: SignInSubject): Promise<SignInResolution> {
  const linked = await store.getUserByIdentity(s.sub);
  if (linked) return { via: 'identity', user: linked };
  const legacy = await store.getUserBySub(s.sub);
  if (legacy) return { via: 'legacy', user: legacy };
  const email = s.email.trim().toLowerCase();
  if (s.linkByEmail && s.emailVerified && email) {
    const matches = await store.findUsersByVerifiedEmail(email);
    if (matches.length !== 1) return { via: 'new', candidates: matches.length };
    const user = matches[0]!;
    const pin = s.pin ?? null;
    const pinOf = s.pinOf ?? (() => null);
    // The rows that make this user a target. One of them from an unpinned
    // IdP, or from an IdP with this sign-in's own pin, is enough.
    const proving = (await store.listIdentities(user.id)).filter((r) => r.emailVerified && r.email === email);
    const joinable = proving.some((r) => {
      const p = pinOf(r.idp);
      return p === null || (p !== undefined && p === pin);
    });
    return joinable ? { via: 'email', user } : { via: 'new', candidates: 0, pinned: true };
  }
  return { via: 'new', candidates: 0 };
}

/** Whether this sign-in is the one the user row was created with. That one
 *  re-syncs the profile; any other linked sign-in leaves the row's name and
 *  email alone. */
export function isAccountSignIn(resolution: SignInResolution, sub: string): boolean {
  return resolution.via === 'new' || resolution.user.sub === sub;
}

/** How long, by default, what one sign-in proved carries over to the
 *  person's other sign-ins: its IdP groups, and (for the account's own
 *  sign-in) the standing that admits a linked sign-in the lists refuse.
 *  `idp.linkedStandingDays` overrides it. */
export const LINKED_STANDING_DAYS = 30;

/** Whether a stored sign-in was seen within the window. A row never used to
 *  sign in (a hand link not yet used, a seeded row) is not. */
export function seenWithin(row: UserIdentityRecord, nowMs: number, windowMs: number): boolean {
  if (!row.lastLoginAt) return false;
  const t = Date.parse(row.lastLoginAt);
  return Number.isFinite(t) && nowMs - t <= windowMs;
}

/**
 * The IdP groups a sign-in leaves on the account: what this sign-in
 * asserted, plus what each of the person's other sign-ins asserted at its
 * own latest sign-in, if that was within the window. Each IdP speaks only
 * for its own groups, so a GitHub sign-in (no groups) neither clears the
 * groups a work IdP sent nor keeps them alive: once the work sign-in has not
 * been seen for the window, its groups lapse, the way they would if the work
 * IdP had deleted the person.
 */
export function standingGroups(
  current: readonly string[], rows: readonly UserIdentityRecord[], sub: string, nowMs: number, windowMs: number,
): string[] {
  const out = new Set(current.filter(Boolean));
  for (const r of rows) {
    if (r.identitySub === sub || !seenWithin(r, nowMs, windowMs)) continue;
    for (const g of r.groups ?? []) if (g) out.add(g);
  }
  return [...out];
}

/** Whether the account's own sign-in (the one `users.sub` names, which always
 *  passes admission on its own) was seen within the window. A linked sign-in
 *  that the admission lists refuse is admitted on the account's standing only
 *  while this holds, so deleting the person at their work IdP still locks
 *  them out once the window has passed. */
export function accountSignInSeen(user: UserRecord, rows: readonly UserIdentityRecord[], nowMs: number, windowMs: number): boolean {
  const own = rows.find((r) => r.identitySub === user.sub);
  return !!own && seenWithin(own, nowMs, windowMs);
}

/**
 * The upsert a sign-in performs. The account's own sign-in writes the IdP's
 * profile, as before linking existed. A linked sign-in keeps the row's email
 * and names. Either way the IdP groups are `groups` (`standingGroups`), and
 * `lastSeenAt` is refreshed.
 */
export function signInUpsert(resolution: SignInResolution, sub: string, profile: UserUpsert, groups: string[]): UserUpsert {
  if (isAccountSignIn(resolution, sub)) return { ...profile, sub, groups };
  const u = (resolution as Extract<SignInResolution, { user: UserRecord }>).user;
  return {
    sub: u.sub, email: u.email, groups, role: u.role,
    ...(u.firstname ? { firstname: u.firstname } : {}),
    ...(u.lastname ? { lastname: u.lastname } : {}),
    ...(u.title ? { title: u.title } : {}),
  };
}

/** The handle a client uses for one linked sign-in: sha256 hex of the
 *  subject, first 16 characters, so a raw IdP subject never travels. */
export function subjectHash(identitySub: string): string {
  return sha256Hex(identitySub).slice(0, 16);
}

/** Why a sign-in cannot be removed, or null when it can. The sign-in the
 *  account was created with stays (the session cookie names it, and the next
 *  sign-in through it would find the row again), and so does the last one. */
export function unlinkBlock(identity: UserIdentityRecord, user: UserRecord, all: UserIdentityRecord[]): 'account' | 'last' | null {
  if (identity.identitySub === user.sub) return 'account';
  if (all.length <= 1) return 'last';
  return null;
}

export interface IdentityWire {
  idp: string;
  subjectHash: string;
  displayName: string;
  email: string | null;
  emailVerified: boolean;
  linkedAt: string;
  lastLoginAt: string | null;
  canUnlink: boolean;
  /** Present when `canUnlink` is false. */
  unlinkBlocked?: 'account' | 'last';
}

export function identityWire(identity: UserIdentityRecord, user: UserRecord, all: UserIdentityRecord[], displayName: string): IdentityWire {
  const block = unlinkBlock(identity, user, all);
  return {
    idp: identity.idp,
    subjectHash: subjectHash(identity.identitySub),
    displayName,
    email: identity.email ?? null,
    emailVerified: identity.emailVerified,
    linkedAt: identity.linkedAt,
    lastLoginAt: identity.lastLoginAt ?? null,
    canUnlink: block === null,
    ...(block ? { unlinkBlocked: block } : {}),
  };
}
