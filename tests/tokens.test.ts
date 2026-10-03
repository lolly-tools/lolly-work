import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mintToken, verifyToken } from '../server/src/iam/tokens.ts';

const SECRET = 'test-secret';

test('token round-trips its payload', () => {
  const t = mintToken('lw/session', { sub: 'u1' }, SECRET, 60);
  assert.deepEqual(verifyToken('lw/session', t, SECRET), { sub: 'u1' });
});

test('domain separation: a session token never verifies as a guest token', () => {
  const t = mintToken('lw/session', { sub: 'u1' }, SECRET, 60);
  assert.equal(verifyToken('lw/guest', t, SECRET), null);
  assert.equal(verifyToken('lw/link', t, SECRET), null);
});

test('expiry is enforced', () => {
  const t = mintToken('lw/session', { sub: 'u1' }, SECRET, 60, Date.now() - 120_000);
  assert.equal(verifyToken('lw/session', t, SECRET), null);
});

test('tampered body or wrong secret fails; garbage never throws', () => {
  const t = mintToken('lw/session', { sub: 'u1' }, SECRET, 60);
  const [body, sig] = t.split('.') as [string, string];
  const forged = `${Buffer.from(JSON.stringify({ typ: 'lw/session', exp: 9e9, p: { sub: 'evil' } })).toString('base64url')}.${sig}`;
  assert.equal(verifyToken('lw/session', forged, SECRET), null);
  assert.equal(verifyToken('lw/session', t, 'other-secret'), null);
  assert.equal(verifyToken('lw/session', 'not-a-token', SECRET), null);
  assert.equal(verifyToken('lw/session', `${body}.`, SECRET), null);
  assert.equal(verifyToken('lw/session', '', SECRET), null);
});

test('an ask token (lw/ask) is its own domain: never a session, never a form token', () => {
  const ask = mintToken('lw/ask', { e: 'sam@example.com', idp: 'github', sub: 'github:42' }, SECRET, 1800);
  assert.deepEqual(verifyToken('lw/ask', ask, SECRET), { e: 'sam@example.com', idp: 'github', sub: 'github:42' });
  assert.equal(verifyToken('lw/session', ask, SECRET), null);
  assert.equal(verifyToken('lw/form', ask, SECRET), null);
  assert.equal(verifyToken('lw/ask', mintToken('lw/session', { sub: 'u1' }, SECRET, 60), SECRET), null);
});
