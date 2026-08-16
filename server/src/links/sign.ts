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

export type LinkKind = 'share' | 'embed' | 'download' | 'guest-edit';

export interface LinkTarget {
  toolId?: string;
  sessionId?: string;
  /** Render params baked at mint time - URL-bar tampering impossible. */
  params?: Record<string, unknown>;
  format?: string;
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

export const DEFAULT_TTL_SEC: Record<LinkKind, number> = {
  share: 7 * 24 * 3600,
  embed: 90 * 24 * 3600,
  download: 24 * 3600,
  'guest-edit': 72 * 3600,
};

function sigBase(id: string, kind: LinkKind, exp: number, target: LinkTarget): string {
  return `${id}.${kind}.${exp}.${sha256Hex(canonicalJson(target))}`;
}

export function signLink(link: Pick<LinkRecord, 'id' | 'kind' | 'exp' | 'target'>, secret: string): string {
  return hmac(sigBase(link.id, link.kind, link.exp, link.target), secret);
}

export function linkPath(link: Pick<LinkRecord, 'id' | 'kind' | 'exp' | 'target'>, secret: string): string {
  return `/l/${link.id}?s=${signLink(link, secret)}`;
}

export type LinkStatus = 'ok' | 'expired' | 'revoked' | 'bad-signature' | 'password-required';

export function checkLink(
  link: LinkRecord,
  sig: string,
  secret: string,
  opts: { now?: number; passwordOk?: boolean } = {},
): LinkStatus {
  const now = opts.now ?? Date.now();
  if (!macEquals(sig, signLink(link, secret))) return 'bad-signature';
  if (link.exp * 1000 <= now) return 'expired';
  if (link.revokedAt) return 'revoked';
  if (link.pwHash && !opts.passwordOk) return 'password-required';
  return 'ok';
}
