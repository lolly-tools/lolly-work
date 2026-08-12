import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLink, linkPath, signLink, type LinkRecord } from '../server/src/links/sign.ts';
import { hashPassword, verifyPassword } from '../server/src/lib/crypto.ts';

const SECRET = 'link-secret';
const NOW = 1_800_000_000_000;

function record(over: Partial<LinkRecord> = {}): LinkRecord {
  return {
    id: 'lnk1',
    kind: 'guest-edit',
    target: { toolId: 'event-badge' },
    exp: Math.floor(NOW / 1000) + 3600,
    createdBy: 'u1',
    createdAt: new Date(NOW).toISOString(),
    ...over,
  };
}

test('a signed link verifies; the path embeds the signature', () => {
  const link = record();
  const sig = signLink(link, SECRET);
  assert.equal(checkLink(link, sig, SECRET, { now: NOW }), 'ok');
  assert.ok(linkPath(link, SECRET).startsWith(`/l/${link.id}?s=`));
});

test('expiry, revocation, bad signature', () => {
  const link = record();
  const sig = signLink(link, SECRET);
  assert.equal(checkLink(link, sig, SECRET, { now: NOW + 2 * 3600_000 }), 'expired');
  assert.equal(checkLink({ ...link, revokedAt: 'x' }, sig, SECRET, { now: NOW }), 'revoked');
  assert.equal(checkLink(link, sig.slice(0, -2) + 'aa', SECRET, { now: NOW }), 'bad-signature');
  assert.equal(checkLink(link, sig, 'other', { now: NOW }), 'bad-signature');
});

test('target and expiry are tamper-proof: changing either invalidates the signature', () => {
  const link = record();
  const sig = signLink(link, SECRET);
  const retargeted = { ...link, target: { toolId: 'other-tool' } };
  assert.equal(checkLink(retargeted, sig, SECRET, { now: NOW }), 'bad-signature');
  const extended = { ...link, exp: link.exp + 999_999 };
  assert.equal(checkLink(extended, sig, SECRET, { now: NOW }), 'bad-signature');
  // Baked params can't be swapped either (URL-bar tampering, plans/07 §5).
  const paramsSwapped = { ...link, target: { toolId: 'event-badge', params: { discount: '99' } } };
  assert.equal(checkLink(paramsSwapped, sig, SECRET, { now: NOW }), 'bad-signature');
});

test('password gate: required until passwordOk, scrypt verifies', () => {
  const pwHash = hashPassword('open sesame');
  const link = record({ pwHash });
  const sig = signLink(link, SECRET);
  assert.equal(checkLink(link, sig, SECRET, { now: NOW }), 'password-required');
  assert.equal(checkLink(link, sig, SECRET, { now: NOW, passwordOk: true }), 'ok');
  assert.equal(verifyPassword('open sesame', pwHash), true);
  assert.equal(verifyPassword('wrong', pwHash), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});
