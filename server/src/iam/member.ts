/**
 * "Which live member is this request?" — the one place cookie → UserRecord
 * happens, so every entry point applies the same revocation rules.
 *
 * Extracted from the HTTP app's `memberOf` closure because the collab ws gateway
 * must authenticate the UPGRADE request before the handshake completes (OSS
 * plans/100 §7 item 1) with byte-identical semantics: a disabled account or a
 * pre-epoch token must die on a socket exactly as it dies on a route.
 *
 * Member-only by construction: a guest cookie yields null here, matching the
 * project/session routes (guests reach sessions through their link-scoped
 * routes, never these).
 *
 * That is still true of the collab gateway, and deliberately so now rather than
 * pending: guest rooms landed (plans/14 §6, plans/02 §8) as a SECOND branch in
 * `gateway.ts`'s `admit`, not as a widening of this function. A guest is not a
 * degenerate member — it has no user row, no groups and no grants — so making
 * this return something for one would have handed every member-only caller a
 * principal it has no rules for. `collab/guests.ts` resolves the guest seat from
 * its link instead, and this stays the one answer to "which live MEMBER is this".
 */
import type { Store, UserRecord } from '../store/types.ts';
import { readPrincipal } from './sessions.ts';

export async function resolveMember(
  store: Store,
  cookieHeader: string | undefined,
  sessionSecret: string,
): Promise<UserRecord | null> {
  const p = readPrincipal(cookieHeader, sessionSecret);
  if (p?.kind !== 'member') return null;
  const user = await store.getUserBySub(p.user.sub);
  if (!user || user.disabledAt) return null;
  // Pre-expiry revocation: a token minted before the user's current epoch is
  // dead. Tokens from before the epoch existed carry none — a missing epoch
  // reads as 0, which matches the column default, so pre-upgrade sessions stay
  // valid until an actual bump.
  if ((p.user.epoch ?? 0) < user.sessionEpoch) return null;
  return user;
}

/**
 * "Firstname Lastname", falling back to email when neither name part is set.
 *
 * Lives beside `resolveMember` for the same reason it does: how a person is
 * NAMED must not fork between surfaces. The HTTP app renders it into user rows,
 * approver nominations and activity actors; `collab/invites.ts` renders it into
 * the invite autocomplete and the invite copy. One function, so a directory row
 * and the invite that names the same colleague can never read differently.
 */
export function displayName(u: { firstname?: string; lastname?: string; email: string }): string {
  return [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email;
}
