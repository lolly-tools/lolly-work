/**
 * Shared crypto helpers - node:crypto only, no dependencies.
 * HMAC values and tokens use base64url throughout (cookie/URL-safe).
 */
import { createHmac, createHash, randomBytes, timingSafeEqual, scrypt, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

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

/**
 * Password hashing for link passwords - scrypt with a per-password salt.
 *
 * `s2.<log2 N>.<salt>.<key>`: N = 2^16, r = 8, p = 1 (64 MiB per derivation),
 * run off the event loop through the async `scrypt` and at most
 * SCRYPT_CONCURRENCY at a time, so a burst of guesses against a public link
 * cannot stall the process or balloon its memory. `s1.` rows from before
 * this (N = 2^14, the node default) still verify; a rehash happens the next
 * time the link is minted, never in place.
 */
const SCRYPT_LOG2N = 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_CONCURRENCY = 2;
let scryptInflight = 0;
const scryptWaiters: (() => void)[] = [];

function scryptDerive(pw: string, salt: Buffer, log2N: number): Promise<Buffer> {
  const N = 2 ** log2N;
  return new Promise((resolve, reject) => {
    scrypt(pw.normalize('NFKC'), salt, 32, { N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * N * SCRYPT_R * 2 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

async function withScryptSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (scryptInflight >= SCRYPT_CONCURRENCY) await new Promise<void>((r) => scryptWaiters.push(r));
  scryptInflight++;
  try {
    return await fn();
  } finally {
    scryptInflight--;
    scryptWaiters.shift()?.();
  }
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await withScryptSlot(() => scryptDerive(pw, salt, SCRYPT_LOG2N));
  return `s2.${SCRYPT_LOG2N}.${salt.toString('base64url')}.${key.toString('base64url')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('.');
  let log2N: number;
  let saltB64: string;
  let keyB64: string;
  if (parts.length === 3 && parts[0] === 's1') {
    log2N = 14;
    saltB64 = parts[1] ?? '';
    keyB64 = parts[2] ?? '';
  } else if (parts.length === 4 && parts[0] === 's2') {
    log2N = Number(parts[1]);
    if (!Number.isInteger(log2N) || log2N < 10 || log2N > 20) return false;
    saltB64 = parts[2] ?? '';
    keyB64 = parts[3] ?? '';
  } else {
    return false;
  }
  const salt = b64uDecode(saltB64);
  const expect = b64uDecode(keyB64);
  if (salt.length === 0 || expect.length !== 32) return false;
  const key = await withScryptSlot(() => scryptDerive(pw, salt, log2N));
  return timingSafeEqual(key, expect);
}

/** HKDF-derive a purpose-bound key from a master secret. */
export function deriveKey(masterSecret: string, context: string): string {
  return Buffer.from(hkdfSync('sha256', masterSecret, '', context, 32)).toString('base64url');
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

/** Display-safe identifier for a stored secret: the first twelve hex digits
 *  of its sha256 - what APIs, audit entries and SIEM rows show instead of the
 *  value. No cleartext characters, however few: a fingerprint travels further
 *  than the secret ever should. */
export function secretFingerprint(secret: string): string {
  return sha256Hex(secret).slice(0, 12);
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
