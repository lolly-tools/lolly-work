/**
 * SCIM provisioning bearer tokens (plans/31 §8).
 *
 * One opaque token per IdP connector. The secret is generated here, shown to
 * the admin ONCE at mint, and stored only as its sha256 - a leaked database
 * yields hashes, never usable tokens, the posture link passwords and the
 * session secret already take. Verification hashes the presented bearer and
 * looks the row up by that hash, so the cleartext never round-trips.
 *
 * These are NOT the HMAC session tokens in iam/tokens.ts: a SCIM token is a
 * long-lived service credential an external IdP holds, so it is a stored,
 * revocable secret rather than a self-describing signed one. Revoking it is a
 * database write, not a secret rotation.
 */
import { randomId, sha256Hex } from '../lib/crypto.ts';

/** The visible prefix on every SCIM secret, so a leaked one is recognizable in
 *  a log or a paste and can be grepped for. */
export const SCIM_TOKEN_PREFIX = 'scim_';

/** Mint a fresh secret and the hash to store. The secret is returned once and
 *  is not recoverable from the hash. 24 random bytes = 192 bits of entropy, so
 *  the hash lookup needs no rate-limit to be brute-force-proof. */
export function mintScimSecret(): { secret: string; tokenHash: string } {
  const secret = `${SCIM_TOKEN_PREFIX}${randomId(24)}`;
  return { secret, tokenHash: sha256Hex(secret) };
}

/** The hash to look a presented secret up by. */
export function hashScimSecret(secret: string): string {
  return sha256Hex(secret);
}

/** The bearer credential from an Authorization header, or null. Case-insensitive
 *  scheme, single space, trimmed - what real IdP clients send. */
export function bearerFromHeader(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return m ? (m[1] as string).trim() : null;
}
