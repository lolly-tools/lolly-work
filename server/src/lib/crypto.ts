/**
 * Shared crypto helpers - node:crypto only, no dependencies.
 * HMAC values and tokens use base64url throughout (cookie/URL-safe).
 */
import { createHmac, createHash, randomBytes, timingSafeEqual, scryptSync, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

export function b64u(data: string | Uint8Array): string {
  return Buffer.from(data).toString('base64url');
}

export function b64uDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/** Constant-time compare of two base64url MACs (length leak is fine - MACs are fixed-size). */
export function macEquals(a: string, b: string): boolean {
  const ab = b64uDecode(a);
  const bb = b64uDecode(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Password hashing for link passwords - scrypt with a per-password salt. */
export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw.normalize('NFKC'), salt, 32);
  return `s1.${salt.toString('base64url')}.${key.toString('base64url')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split('.');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const salt = b64uDecode(parts[1] ?? '');
  const expect = b64uDecode(parts[2] ?? '');
  const key = scryptSync(pw.normalize('NFKC'), salt, 32);
  return expect.length === key.length && timingSafeEqual(key, expect);
}

const GCM_KEY_LEN = 32; // AES-256
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;

/**
 * At-rest sealing for stored secrets (catalog provider credentials, plans/17 §5).
 * AES-256-GCM under a key HKDF-derived from the master secret and a caller
 * `context` string - domain separation, so a ciphertext sealed for one record
 * cannot be replayed into another. Layout: iv(12) || tag(16) || ciphertext.
 */
export function sealSecret(plain: string, masterSecret: string, context: string): Buffer {
  const key = Buffer.from(hkdfSync('sha256', masterSecret, '', context, GCM_KEY_LEN));
  const iv = randomBytes(GCM_IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** Throws on tampered/foreign-context/wrong-key input (GCM tag mismatch). */
export function openSecret(sealed: Uint8Array, masterSecret: string, context: string): string {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (buf.length < GCM_IV_LEN + GCM_TAG_LEN + 1) throw new Error('sealed secret too short');
  const key = Buffer.from(hkdfSync('sha256', masterSecret, '', context, GCM_KEY_LEN));
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, GCM_IV_LEN));
  decipher.setAuthTag(buf.subarray(GCM_IV_LEN, GCM_IV_LEN + GCM_TAG_LEN));
  return Buffer.concat([decipher.update(buf.subarray(GCM_IV_LEN + GCM_TAG_LEN)), decipher.final()]).toString('utf8');
}

/** Display-safe identifier for a stored secret: sha256 prefix + last four
 *  characters (card-number style) - what APIs and audit entries show instead
 *  of the value. */
export function secretFingerprint(secret: string): string {
  return `${sha256Hex(secret).slice(0, 8)}…${secret.slice(-4)}`;
}

/** JSON.stringify with recursively sorted object keys - stable input for hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
