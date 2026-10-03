// SPDX-License-Identifier: MPL-2.0
/**
 * Personal invite links (plans/74 invite spec 2.6, plans/75 J4 step 2).
 *
 * Every invitation, and every project entry on it, has a link at
 * `/l/invite/<token>`. The token names the invitation, the project the link
 * was made for (none for a workspace link) and the invitation's link
 * version, and is signed with the link secret:
 *
 *   body  = base64url(invitationId + "\n" + (projectId ?? "") + "\n" + version)
 *   token = body + "." + base64url(HMAC-SHA256(secret, "lw/invite." + body))
 *
 * The token is derived, never stored. One invitation row is shared by every
 * inviter who adds a project to it, and each of them must be able to copy a
 * working link later, so the link is minted again whenever it is shown.
 * "New link" raises `link_version`, which ends every link copied before.
 *
 * A token identifies an invitation; it never admits anyone. The sign-in that
 * follows still has to prove the invited address (plans/75 4.8 rule 1).
 * The "lw/invite." prefix keeps a link token (`lw/link`) or any other signed
 * value from passing as an invite token. Pure: no store, no clock.
 */
import { b64u, b64uDecode, hmac, macEquals } from '../lib/crypto.ts';

/** What an invite token names. */
export interface InviteLinkRef {
  invitationId: string;
  /** The project the link was made for, or null for a workspace link. */
  projectId: string | null;
  /** The invitation's `linkVersion` when the link was minted. */
  version: number;
}

/** Longest token `readInviteToken` looks at. A real one is about 120 characters. */
export const INVITE_TOKEN_MAX = 400;
const TOKEN_CHARS = /^[A-Za-z0-9_.-]+$/;
/** Invitation and project ids are 'inv_' / 'prj_' plus base64url. */
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;

const macFor = (body: string, secret: string): string => hmac(`lw/invite.${body}`, secret);

/** Mint the token for one entry of an invitation. `secret` is the current link secret. */
export function mintInviteToken(ref: InviteLinkRef, secret: string): string {
  const body = b64u(`${ref.invitationId}\n${ref.projectId ?? ''}\n${ref.version}`);
  return `${body}.${macFor(body, secret)}`;
}

/**
 * Read a token back, or null for anything that is not one this server
 * signed: too long, a character outside base64url and ".", a bad MAC under
 * every key in `secrets` (current first, then the previous one during a
 * rotation), or a body that is not exactly three well-formed lines. Never
 * throws. Whether the invitation still exists, and still has this version,
 * is the caller's question.
 */
export function readInviteToken(token: string, secrets: readonly string[]): InviteLinkRef | null {
  if (typeof token !== 'string' || token.length > INVITE_TOKEN_MAX || !TOKEN_CHARS.test(token)) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  if (!body || !mac) return null;
  if (!secrets.some((k) => macEquals(mac, macFor(body, k)))) return null;
  const lines = b64uDecode(body).toString('utf8').split('\n');
  if (lines.length !== 3) return null;
  const [invitationId, projectId, version] = lines as [string, string, string];
  if (!ID.test(invitationId) || (projectId !== '' && !ID.test(projectId)) || !VERSION.test(version)) return null;
  return { invitationId, projectId: projectId || null, version: Number(version) };
}

/** The invite page's address for a token. */
export function invitePageUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/l/invite/${token}`;
}
