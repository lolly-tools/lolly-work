// SPDX-License-Identifier: MPL-2.0
/**
 * Sign-in password hashing and rules (iam/password.ts, plans/74). Pinned
 * here: the stored format and its parameters, a round trip, that a hash made
 * under weaker parameters still verifies and asks to be rehashed, that a
 * missing or malformed hash verifies as false (after a derivation), NFKC
 * normalisation, the NIST-style rules counted in code points, and the
 * process-wide scrypt cap: two at once, 32 waiting, the rest turned away.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';

import {
  PASSWORD_PARAMS, checkPasswordRules, hashPassword, isWeakerThanCurrent, normaliseEmail, parsePasswordHash,
  passwordRuleMessage, verifyPassword,
} from '../server/src/iam/password.ts';
import { ScryptBusyError, scryptQueueFull, withScryptSlot } from '../server/src/lib/crypto.ts';

test('a hash is scrypt$15$8$1$salt$key and round-trips', async () => {
  const stored = await hashPassword('correct horse battery staple');
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ['scrypt', '15', '8', '1']);
  assert.equal(Buffer.from(parts[4]!, 'base64url').length, 16, '16-byte salt');
  assert.equal(Buffer.from(parts[5]!, 'base64url').length, 32, '32-byte key');
  assert.ok(!stored.includes('correct horse'), 'the password is not in the hash');

  assert.deepEqual(await verifyPassword('correct horse battery staple', stored), { ok: true, needsRehash: false });
  assert.deepEqual(await verifyPassword('correct horse battery stapl', stored), { ok: false, needsRehash: false });
  assert.notEqual(await hashPassword('correct horse battery staple'), stored, 'a fresh salt every time');
});

test('a hash under weaker parameters verifies and asks for a rehash; the new one does not', async () => {
  const salt = randomBytes(16);
  const weakKey = scryptSync('an older password here'.normalize('NFKC'), salt, 32, { N: 2 ** 14, r: 8, p: 1 });
  const weak = `scrypt$14$8$1$${salt.toString('base64url')}$${weakKey.toString('base64url')}`;
  assert.ok(isWeakerThanCurrent(parsePasswordHash(weak)!));
  assert.deepEqual(await verifyPassword('an older password here', weak), { ok: true, needsRehash: true });
  assert.deepEqual(await verifyPassword('not the older password', weak), { ok: false, needsRehash: false },
    'a wrong password never asks for a rehash');

  const lowR = scryptSync('an older password here', salt, 32, { N: 2 ** 15, r: 4, p: 1 });
  assert.equal((await verifyPassword('an older password here', `scrypt$15$4$1$${salt.toString('base64url')}$${lowR.toString('base64url')}`)).needsRehash, true);

  const fresh = await hashPassword('an older password here');
  assert.equal(isWeakerThanCurrent(parsePasswordHash(fresh)!), false);
  assert.equal(PASSWORD_PARAMS.log2N, 15);
});

test('no stored hash, or a malformed one, verifies as false', async () => {
  assert.deepEqual(await verifyPassword('anything at all here', null), { ok: false, needsRehash: false });
  for (const bad of ['', 's2.16.abc.def', 'scrypt$15$8$1$$', 'scrypt$40$8$1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'scrypt$15$8$1$AAAAAAAAAAA', 'bcrypt$15$8$1$AAAAAAAAAAA$AAAA']) {
    assert.deepEqual(await verifyPassword('anything at all here', bad), { ok: false, needsRehash: false }, bad);
  }
});

test('NFKC: the same characters typed two ways give one password', async () => {
  // U+FB01 (the "fi" ligature) and full-width digits normalise to plain text.
  const stored = await hashPassword('ﬁne passphrase １２３');
  assert.equal((await verifyPassword('fine passphrase 123', stored)).ok, true);
});

test('rules: 12 to 256 code points, not the email; no composition rules', () => {
  assert.equal(checkPasswordRules('short', 'a@x.example'), 'too-short');
  assert.equal(checkPasswordRules('elevenchars', 'a@x.example'), 'too-short');
  assert.equal(checkPasswordRules('twelve chars', 'a@x.example'), null);
  assert.equal(checkPasswordRules('alllowercaseletters', 'a@x.example'), null, 'no composition rules');
  // Twelve emoji are twelve code points (24 UTF-16 units).
  assert.equal(checkPasswordRules('🍭'.repeat(11), 'a@x.example'), 'too-short');
  assert.equal(checkPasswordRules('🍭'.repeat(12), 'a@x.example'), null);
  assert.equal(checkPasswordRules('x'.repeat(256), 'a@x.example'), null);
  assert.equal(checkPasswordRules('x'.repeat(257), 'a@x.example'), 'too-long');
  assert.equal(checkPasswordRules('Long.Name@Example.com', 'long.name@example.com'), 'is-email');
  assert.equal(checkPasswordRules('long.name@example.com', ' Long.Name@Example.COM '), 'is-email');
  assert.match(passwordRuleMessage('too-short'), /at least 12 characters/);
  assert.equal(normaliseEmail('  Ana@Example.COM '), 'ana@example.com');
});

test('scrypt work runs two at a time, queues 32, and turns the rest away at once', async () => {
  let running = 0;
  let most = 0;
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const task = () => withScryptSlot(async () => {
    running++;
    most = Math.max(most, running);
    await gate;
    await new Promise((r) => setImmediate(r));
    running--;
  });
  const queued = Array.from({ length: 34 }, task);
  assert.equal(scryptQueueFull(), true);
  await assert.rejects(task(), (e: unknown) => e instanceof ScryptBusyError && e.status === 503);
  open();
  await Promise.all(queued);
  assert.equal(most, 2, 'a finishing task hands its slot on; nobody slips in beside it');
  assert.equal(scryptQueueFull(), false);
  // Free again: a newcomer is not turned away.
  await withScryptSlot(async () => {});
});
