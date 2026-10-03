// SPDX-License-Identifier: MPL-2.0
/**
 * Sign-in passwords (plans/74, email and password sign-in). Hashing, the
 * password rules and the email form one place, so the routes, the store and
 * the tests agree on them.
 *
 * Hashes are scrypt, stored as `scrypt$<log2 N>$<r>$<p>$<salt>$<key>` (salt
 * and key base64url). The parameters ride the stored string, so a hash made
 * under weaker settings still verifies, and `needsRehash` tells the caller to
 * store a fresh one after a successful sign-in. Each derivation runs off the
 * event loop through node's async scrypt and inside the process-wide cap in
 * lib/crypto.ts (two at once), so a burst of guesses costs at most two
 * derivations' memory at any moment.
 *
 * The rules follow NIST SP 800-63B: a length floor and ceiling counted in
 * code points, no composition rules, and not the email address itself. The
 * password is NFKC-normalised before it is checked or hashed, so the same
 * characters typed on two keyboards give one hash.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { b64uDecode, withScryptSlot } from '../lib/crypto.ts';

/** The parameters every new hash uses. */
export const PASSWORD_PARAMS = { log2N: 15, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
/** Upper bound on scrypt memory for one derivation under the current parameters. */
const MAXMEM = 64 * 1024 * 1024;
/** What a stored hash may ask for. A corrupt or hostile row outside these
 *  bounds verifies as false instead of costing the process its memory. */
const BOUNDS = { log2N: [10, 17], r: [1, 16], p: [1, 4], keyLen: [16, 64] } as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

/** How long a one-time sign-in link works. */
export const PASSWORD_LINK_TTL_MS = 7 * 86_400_000;
/** `created_by` on a link written by scripts/password-link.ts. It stands
 *  with an owner's authority. */
export const OPERATOR_LINK_ISSUER = 'operator';
/** The address a one-time sign-in link opens. */
export function passwordSetUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/api/auth/password/set?token=${token}`;
}

/** The one form an email takes in credentials, links and lookups. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** The form a password is checked and hashed in. */
export function normalisePassword(raw: string): string {
  return raw.normalize('NFKC');
}

/** Why a new password is refused, or null when it may be used. */
export type PasswordRuleFailure = 'too-short' | 'too-long' | 'is-email';

export function checkPasswordRules(password: string, email: string): PasswordRuleFailure | null {
  const pw = normalisePassword(password);
  const length = [...pw].length;
  if (length < PASSWORD_MIN_LENGTH) return 'too-short';
  if (length > PASSWORD_MAX_LENGTH) return 'too-long';
  if (pw.trim().toLowerCase() === normaliseEmail(email)) return 'is-email';
  return null;
}

/** The message a person sees for a refused password. */
export function passwordRuleMessage(failure: PasswordRuleFailure): string {
  return {
    'too-short': `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
    'too-long': `Use at most ${PASSWORD_MAX_LENGTH} characters.`,
    'is-email': 'Use something other than your email address.',
  }[failure];
}

interface ScryptParams { log2N: number; r: number; p: number }

function derive(password: string, salt: Buffer, params: ScryptParams, keyLen: number): Promise<Buffer> {
  const N = 2 ** params.log2N;
  // node refuses when 128 * N * r exceeds maxmem; a stronger stored hash gets
  // the room it needs, within BOUNDS.
  const maxmem = Math.max(MAXMEM, 2 * 128 * N * params.r);
  return withScryptSlot(() => new Promise<Buffer>((resolve, reject) => {
    scrypt(normalisePassword(password), salt, keyLen, { N, r: params.r, p: params.p, maxmem }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  }));
}

export async function hashPassword(password: string): Promise<string> {
  const { log2N, r, p, keyLen, saltLen } = PASSWORD_PARAMS;
  const salt = randomBytes(saltLen);
  const key = await derive(password, salt, { log2N, r, p }, keyLen);
  return `scrypt$${log2N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

interface ParsedHash extends ScryptParams { salt: Buffer; key: Buffer }

const inside = (v: number, [lo, hi]: readonly [number, number]): boolean => Number.isInteger(v) && v >= lo && v <= hi;

export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [log2N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!inside(log2N, BOUNDS.log2N) || !inside(r, BOUNDS.r) || !inside(p, BOUNDS.p)) return null;
  const salt = b64uDecode(parts[4] ?? '');
  const key = b64uDecode(parts[5] ?? '');
  if (salt.length < 8 || !inside(key.length, BOUNDS.keyLen)) return null;
  return { log2N, r, p, salt, key };
}

/** Whether a stored hash was made with weaker settings than new hashes get. */
export function isWeakerThanCurrent(parsed: ScryptParams & { key: Buffer }): boolean {
  return parsed.log2N < PASSWORD_PARAMS.log2N || parsed.r < PASSWORD_PARAMS.r || parsed.p < PASSWORD_PARAMS.p
    || parsed.key.length < PASSWORD_PARAMS.keyLen;
}

/** A fixed salt for the stand-in derivation below. Its output is thrown away. */
const DUMMY_SALT = Buffer.alloc(PASSWORD_PARAMS.saltLen, 0x5a);

/**
 * Check a password against a stored hash. With no stored hash (no credential
 * for that email) one derivation still runs under the current parameters and
 * the answer is false, so the response time does not say whether the
 * account exists. A malformed stored hash is treated the same way.
 */
export async function verifyPassword(
  password: string, stored: string | null,
): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = stored ? parsePasswordHash(stored) : null;
  if (!parsed) {
    const { log2N, r, p, keyLen } = PASSWORD_PARAMS;
    await derive(password, DUMMY_SALT, { log2N, r, p }, keyLen);
    return { ok: false, needsRehash: false };
  }
  const key = await derive(password, parsed.salt, parsed, parsed.key.length);
  const ok = timingSafeEqual(key, parsed.key);
  return { ok, needsRehash: ok && isWeakerThanCurrent(parsed) };
}
