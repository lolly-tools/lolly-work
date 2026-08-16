// SPDX-License-Identifier: MPL-2.0
/**
 * Guest seats in a live collab room - the "temporary external collaboration is
 * the same room, not a separate mechanism" half of plans/14 §6, over the guest
 * principals plans/02 §8 defines.
 *
 * A guest holds NO role row and NO grants. `rbac/evaluate.ts`'s `ROLE_ACTIONS`
 * gives the `guest` role the empty list on purpose ("their access is entirely
 * link-scoped"), so running a guest through `evaluate()` could only ever answer
 * from a wildcard grant somebody wrote for members - an accident, never an
 * intention. This module therefore imports nothing from `../rbac`, and
 * `tests/collab/guests.test.ts` asserts that structurally, exactly as
 * `rooms.ts`'s presence path is kept out of the policy engine by its import
 * list rather than by a reviewer remembering.
 *
 * WHAT AUTHORIZES A GUEST IS ITS LINK, and nothing else:
 *
 *   - WHERE it may be - `LinkRecord.target.sessionId`, the one session a
 *     guest-edit link binds to. That single field is the whole of a guest's
 *     reach; every other session id is refused with the same close/refusal an
 *     unauthorized member gets.
 *   - WHETHER it may write - `LinkKind`. `guest-edit` is a writer seat. There is
 *     no view-only guest tier today: `GET /l/:id` mints a guest cookie for
 *     `guest-edit` and for nothing else (share/embed/download render bytes and
 *     mint no principal at all), so `guestLinkRole` returning `null` for those
 *     kinds is a defensive floor rather than a live branch. When a read-only
 *     tier does arrive it is one arm added HERE, and the gateway's
 *     writer/observer split needs no change - it already asks this function.
 *   - HOW LONG - the link's own `exp` and `revokedAt`. That is what makes
 *     plans/02 §8's "revoking the link kills all its live guest sessions
 *     immediately" true of a socket that is already open: the gateway re-reads
 *     the link per gesture and per keepalive, so a revocation lands on the next
 *     gesture exactly as a grant revocation does for a member.
 *
 * The guest COOKIE is a bearer, not the authority. It is HMAC-signed by this
 * instance (`iam/sessions.ts`), so its claims cannot be edited - but it is a
 * SNAPSHOT of the link at mint time, and a link can be revoked, expire, or (in
 * principle) be re-put under the same id afterwards. The stored `LinkRecord` is
 * therefore the authority for every decision, and the cookie's own copy of the
 * bound session is checked to AGREE with it: a disagreement means the two were
 * minted apart, and neither reading is safe to write with.
 */
import { guestActor, type GuestSession } from '../iam/sessions.ts';
import { displayName } from '../iam/member.ts';
import type { LinkRecord } from '../links/sign.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { MemberRole } from './rooms.ts';

/**
 * The synthetic group every guest carries into the policy overlay (plans/02 §8:
 * "a synthetic `guests` group … input locks still apply, so a guest can be given
 * the narrowest input surface of anyone").
 *
 * This is the operator's real lever over what a guest may touch, and it is the
 * reason the overlay veto is NOT skipped for guests: `resolveInputAccess` takes
 * a group list, so an `inputAccess` rule scoped to `guests` locks, hides or
 * choice-restricts an input for every guest in every room without naming one.
 * It is not an RBAC group - nothing grants on it - so it can never widen what a
 * guest may do, only narrow it.
 */
export const GUEST_GROUP = 'guests';

/** Shown when a guest never chose a name - plans/02 §8's pseudonymous v1, and
 *  the same default `GET /l/:id` stamps when the `name` param is absent. */
export const GUEST_FALLBACK_NAME = 'Guest';

/** Longest name part rendered into a roster/presence entry. Matches the cap
 *  `GET /l/:id` applies when minting the cookie; re-applied here because the
 *  inviter's display name comes from a different place and a name is relayed to
 *  every peer in the room. */
export const MAX_GUEST_NAME_CHARS = 60;

/** C0/C1 controls, stripped from anything that becomes a display name. The
 *  presence relay sanitizes what a CLIENT sends (`rooms.ts` `sanitizePresence`)
 *  but stamps the SERVER's name over it verbatim - so the server's name has to
 *  arrive clean, or the one field a peer cannot forge becomes the one field that
 *  can smuggle a terminal escape. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Parens, stripped from a guest's CHOSEN name only (never from the inviter's,
 *  which is a real member's directory name, not user input). The only marker
 *  the roster/admin console has for "this member is external" is the literal
 *  suffix ` (guest of <inviter>)` this module appends -- a chosen name that
 *  contains its own `(guest of ...)` composes a forged second clause after
 *  the real one (`"Alice Eng (guest of Ada Admin) (guest of Bob Sales)"`),
 *  and any console that truncates a long name can end up showing only the
 *  fabricated half. Stripping parens outright is cheaper and more robust than
 *  matching the phrase itself (which the attacker could vary in case,
 *  spacing or wording) -- losing literal parentheses from a display name is a
 *  trivial cosmetic cost against a forged provenance clause. */
const PARENS = /[()]/g;

/** A guest seat, resolved. Everything the gateway needs and nothing it does not:
 *  no user record (there is none), no grants (there are none). */
export interface GuestSeat {
  guest: GuestSession;
  link: LinkRecord;
  /** The session this guest is bound to - read off the LINK, never off the
   *  cookie's copy (which is only checked to agree). */
  sessionId: string;
  /** `guest:<linkId>` - the audit actor, the connection-ceiling key, and the
   *  room seat's `userId`. */
  principalId: string;
  /** Derived from the link's KIND. Never from a role table. */
  role: MemberRole;
}

/**
 * Writer or observer, from the link alone - or `null` when this kind of link
 * admits no guest at all (see the module header: only `guest-edit` mints a guest
 * principal today, so `null` is the defensive floor for a cookie whose link has
 * since become something else).
 */
export function guestLinkRole(link: LinkRecord): MemberRole | null {
  return link.kind === 'guest-edit' ? 'writer' : null;
}

/**
 * "May this guest be in THIS room, right now?" - the pure decision, over rows the
 * caller has already read. The guest-side dual of the gateway's `seatAllows`,
 * and the one expression of the rule for all three places that must agree: the
 * upgrade, the per-gesture re-check, and the per-keepalive seat re-check.
 *
 * Returns null for every refusal, deliberately undifferentiated: the caller
 * answers one status for all of them, so a guest cannot use the reply to learn
 * whether a session it was never invited to exists.
 */
export function guestSeatOf(
  link: LinkRecord,
  guest: GuestSession,
  sessionId: string,
  now: number = Date.now(),
): GuestSeat | null {
  if (guest.linkId !== link.id) return null;
  if (link.revokedAt) return null;
  if (link.exp * 1000 <= now) return null;
  const role = guestLinkRole(link);
  if (!role) return null;
  // The binding. A guest-edit link may name only a tool (a blank-canvas invite);
  // such a link binds to no session, so its guest can join no room - there is
  // nothing for its work to save into (plans/02 §8's "destination project/session
  // so the guest's work saves server-side").
  const bound = link.target.sessionId;
  if (!bound || bound !== sessionId) return null;
  // …and the cookie must agree with it. Both were minted from the same record, so
  // a disagreement is not a stale claim to tolerate - it is two records that have
  // diverged, and a write authorized by the wrong one lands in the wrong session.
  if ((guest.sessionRef ?? bound) !== bound) return null;
  return { guest, link, sessionId: bound, principalId: guestActor(link.id), role };
}

/**
 * `"Sam (guest of Andy)"` - the name the roster, the peer-join broadcast and
 * every relayed presence frame carry for a guest (plans/02 §8, plans/14 §6).
 *
 * Server-side in full: the OSS shell renders whatever name the server sends, so
 * there is no client half to keep in step and no way for a peer to appear as a
 * colleague. A guest that never chose a name is `"Guest (guest of Andy)"` rather
 * than something apologetic - it still says exactly who vouched for them, which
 * is the part that matters.
 */
export function guestDisplayName(chosen: string | undefined, inviterName: string): string {
  // PARENS only on the GUEST's half: `inviterName` is a real member's directory
  // display name, never user input, so it is not this attack's payload.
  const name = clean(chosen).replace(PARENS, '') || GUEST_FALLBACK_NAME;
  const inviter = clean(inviterName) || 'a member';
  return `${name} (guest of ${inviter})`;
}

function clean(raw: string | undefined): string {
  return (raw ?? '').replace(CONTROLS, '').trim().slice(0, MAX_GUEST_NAME_CHARS);
}

/**
 * The inviter's live UserRecord - and, by returning null, the check that they
 * are still a live member at all.
 *
 * Accountability rides on the inviter (plans/02 §8), so a guest must not outlive
 * the account that vouched for it: a link whose creator has been disabled or
 * deleted admits nobody, and the room refuses the upgrade rather than rendering
 * "(guest of <an id nobody can resolve>)".
 *
 * A scan, because there is no by-id user getter on the Store - `api/app.ts`
 * resolves a user id the same way in half a dozen routes. Corrected 2026-08-09:
 * this is no longer run ONLY at admit. `guests.ts`'s own promise - "a gesture
 * must re-check the LINK" - was true of the link's own liveness (revoked,
 * expired) but silently dropped the inviter half of plans/02 §8's revocation
 * story: the caller (`gateway.ts`) now re-runs this on the per-gesture and
 * per-keepalive paths too, exactly where a member's own liveness is re-read,
 * so a disabled inviter's already-open guest sockets stop being able to write
 * (or even watch) rather than surviving to the link's own TTL.
 */
export async function resolveInviter(
  store: Pick<Store, 'listUsers'>,
  inviterId: string,
): Promise<UserRecord | null> {
  if (!inviterId) return null;
  const inviter = (await store.listUsers()).find((u) => u.id === inviterId);
  if (!inviter || inviter.disabledAt) return null;
  return inviter;
}

/** `displayName(await resolveInviter(...))` - kept as its own name because most
 *  callers only want the rendered name, never the record. */
export async function resolveInviterName(
  store: Pick<Store, 'listUsers'>,
  inviterId: string,
): Promise<string | null> {
  const inviter = await resolveInviter(store, inviterId);
  return inviter ? displayName(inviter) : null;
}
