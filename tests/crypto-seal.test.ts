/**
 * At-rest secret sealing (plans/17 §5): AES-256-GCM round-trip, HKDF context
 * domain separation (a ciphertext sealed for one provider cannot open under
 * another's context), tamper detection, and the display fingerprint shape.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSecret, sealSecret, secretFingerprint } from '../server/src/lib/crypto.ts';

const MASTER = 'a-32-byte-or-longer-master-secret!';

test('seal/open round-trips and is IV-randomised', () => {
  const a = sealSecret('api-key-123', MASTER, 'catalog-provider-credential:bf');
  const b = sealSecret('api-key-123', MASTER, 'catalog-provider-credential:bf');
  assert.notDeepEqual(a, b, 'same plaintext seals differently (random IV)');
  assert.equal(openSecret(a, MASTER, 'catalog-provider-credential:bf'), 'api-key-123');
  assert.equal(openSecret(b, MASTER, 'catalog-provider-credential:bf'), 'api-key-123');
});

test('context domain separation: another provider id cannot open the box', () => {
  const sealed = sealSecret('api-key-123', MASTER, 'catalog-provider-credential:bf');
  assert.throws(() => openSecret(sealed, MASTER, 'catalog-provider-credential:other'));
});

test('wrong master key and tampered bytes both refuse', () => {
  const sealed = sealSecret('api-key-123', MASTER, 'ctx');
  assert.throws(() => openSecret(sealed, 'not-the-master-key-at-all-here!!', 'ctx'));
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] = (sealed[sealed.length - 1] as number) ^ 0xff;
  assert.throws(() => openSecret(tampered, MASTER, 'ctx'));
  assert.throws(() => openSecret(new Uint8Array(4), MASTER, 'ctx'), /too short/);
});

test('fingerprint shows hash prefix + last four, never the middle', () => {
  const fp = secretFingerprint('super-secret-token-abcd');
  assert.match(fp, /^[0-9a-f]{8}…abcd$/);
  assert.ok(!fp.includes('super-secret'), 'no plaintext prefix leaks');
});
