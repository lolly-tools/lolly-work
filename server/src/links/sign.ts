/**
 * Signed, expiring, revocable links (plans/07 §5).
 *
 * The URL carries `/l/{id}?s={sig}` where the signature covers id + kind +
 * expiry + a digest of the resolved target - so neither the target nor the
 * expiry can be tampered with in the URL bar. Revocation and passwords live
 * on the stored record; expiry is enforced from the signature alone (a link
 * outlives a lost database row only until its own expiry).
 */
import { canonicalJson, hmac, macEquals, sha256Hex } from '../lib/crypto.ts';

export type LinkKind = 'share' | 'embed' | 'download' | 'guest-edit' | 'project-invite';

export interface LinkTarget {
  projectInvite?: { projectId: string; role: 'editor' | 'commenter' | 'viewer'; allowNewPeople: boolean };
  toolId?: string;
  sessionId?: string;
  /**
   * A catalog asset a `share` / `embed` / `download` link points at instead of
   * a tool render (plans/31 §2 1b): `inst/<id>`, `ext/<provider>/<remoteId>`,
   * or a pack asset id. The id is opaque to the signature, which covers the
   * whole target digest, so an asset link needs no schema of its own - but it
   * is NOT a bearer capability over the catalog: exposure is checked when the
   * link is minted (the minter must see the asset) and lifecycle is re-checked
   * on every resolve, so an expired or revoked asset stops serving on a link
   * that is still live.
   */
  assetId?: string;
  /**
   * A CATALOG COLLECTION a `share` / `download` link points at (plans/31 §5).
   * The same signed-target machinery as `assetId`, one level up: `share` serves
   * the collection's own listing page and `download` serves the zip-all, with
   * exposure checked once at mint (the minter must see the collection) and
   * LIFECYCLE re-checked per member on every resolve - so an expired or revoked
   * member disappears from both the page and the archive without the link
   * changing. `embed` is refused: a collection is a list, not a byte stream, so
   * there is nothing for an `<img>` to point at.
   */
  collectionId?: string;
  /** Render params baked at mint time - URL-bar tampering impossible. */
  params?: Record<string, unknown>;
  /** Render format for a tool target; the format ref for an asset target. */
  format?: string;
  /**
   * Recipients may change the render: an opt-in on a `share`, `embed` or
   * `download` link to a tool. The link then lays the recipient's own URL params
   * (the tool's inputs, size and format) over the baked ones, and each new set
   * renders a new asset. Policy still holds: locked and hidden inputs stay as the
   * tool's policy sets them. Covered by the signature like the rest of the target,
   * so editing the URL cannot switch it on.
   */
  open?: boolean;
  /**
   * Files the licence gate holds back that the minter, a member of staff,
   * chose to send anyway after a dry run (plans/82 M4). Each names one file
   * and the fingerprint of the facts it was chosen against, so a file added
   * to a collection later, or a new version of one, is never covered. Set by
   * the server at mint, never taken from the request, and covered by the
   * signature with the rest of the target.
   */
  includeHeld?: Array<{ id: string; fingerprint: string }>;
}

export interface LinkRecord {
  id: string;
  kind: LinkKind;
  target: LinkTarget;
  exp: number; // unix seconds
  createdBy: string;
  createdAt: string;
  pwHash?: string;
  revokedAt?: string;
  /** guest-edit only: destination project for the guest's work. */
  projectId?: string;
}

/**
 * The RBAC resource selectors a link's target satisfies - the resource half of
 * every `link.create` / `link.create-guest` decision.
 *
 * It lives here, next to the target it is derived from, because TWO surfaces
 * must ask the identical question and a disagreement between them is silent:
 *
 *   - `POST /api/v1/links` authorizes the MINT, and
 *   - `collab/gateway.ts` re-checks, per gesture, that the inviter STILL holds
 *     `link.create-guest` (plans/02 §8: "the inviter losing `link.create-guest`
 *     kills all its live guest sessions immediately").
 *
 * A gateway that asked with `['*']` alone would silently disagree with a
 * tool-scoped grant - an inviter allowed only `tool:event-badge` would look
 * un-granted on every gesture and their guests would be evicted immediately.
 * One function, so the two cannot drift.
 */
export function linkResourceSelectors(target: LinkTarget): string[] {
  return target.toolId ? [`tool:${target.toolId}`, '*'] : ['*'];
}

/** The longest a link may last, in hours, except a guest link, which follows the guest link policy. */
export const LINK_MAX_TTL_HOURS = 24 * 365;
/** Longest a link's password cookie lasts; never past the link's own expiry. */
export const LINK_ACCESS_MAX_SEC = 12 * 3600;

export const DEFAULT_TTL_SEC: Record<LinkKind, number> = {
  share: 7 * 24 * 3600,
  embed: 90 * 24 * 3600,
  download: 24 * 3600,
  'guest-edit': 72 * 3600,
  'project-invite': 7 * 24 * 3600,
};

function sigBase(id: string, kind: LinkKind, exp: number, target: LinkTarget): string {
  return `${id}.${kind}.${exp}.${sha256Hex(canonicalJson(target))}`;
}

export function signLink(link: Pick<LinkRecord, 'id' | 'kind' | 'exp' | 'target'>, secret: string): string {
  return hmac(sigBase(link.id, link.kind, link.exp, link.target), secret);
}

export function linkPath(link: Pick<LinkRecord, 'id' | 'kind' | 'exp' | 'target'>, secret: string): string {
  return `/l/${link.kind === 'project-invite' ? 'join/' : ''}${link.id}?s=${signLink(link, secret)}`;
}

export type LinkStatus = 'ok' | 'expired' | 'revoked' | 'bad-signature' | 'password-required';

export function checkLink(
  link: LinkRecord,
  sig: string,
  secret: string | readonly string[],
  opts: { now?: number; passwordOk?: boolean } = {},
): LinkStatus {
  const now = opts.now ?? Date.now();
  // Dual-key rotation (plans/35 wave 4): a link signed under the previous key
  // keeps resolving through the rotation window; minting always signs current.
  const keys = typeof secret === 'string' ? [secret] : secret;
  if (!keys.some((k) => macEquals(sig, signLink(link, k)))) return 'bad-signature';
  if (link.exp * 1000 <= now) return 'expired';
  if (link.revokedAt) return 'revoked';
  if (link.pwHash && !opts.passwordOk) return 'password-required';
  return 'ok';
}
