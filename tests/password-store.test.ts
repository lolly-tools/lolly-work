// SPDX-License-Identifier: MPL-2.0
/**
 * Email and password storage (plans/74; migration 0042), one suite for both
 * drivers: memory always, Postgres when LW_TEST_DATABASE_URL is set. Pinned
 * here: credentials are keyed by the lowercased email and keep their id across
 * resets; the failure counter locks at the limit and starts again; a link
 * works once and until its expiry, even when two uses race; a new link for an
 * email removes the earlier unused one; and erasing the account removes the
 * password rows for its address.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../server/src/store/memory.ts';
import type { Store } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const T0 = '2026-10-03T10:00:00.000Z';
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

async function passwordStoreConformance(store: Store): Promise<void> {
  // Credentials: one per email, lowercased; a reset keeps the id and clears the count.
  assert.equal(await store.getPasswordCredential('ana@example.com'), null);
  const first = await store.putPasswordCredential({ id: 'pwc_1', email: ' Ana@Example.COM ', hash: 'scrypt$15$8$1$a$b', at: T0, ownerIssued: false });
  assert.deepEqual(first, { id: 'pwc_1', email: 'ana@example.com', hash: 'scrypt$15$8$1$a$b', createdAt: T0, updatedAt: T0, failedCount: 0, ownerIssued: false });
  assert.deepEqual(await store.getPasswordCredential('ANA@example.com'), first);

  // Attempts are counted before the check; the one that reaches the limit locks.
  const opts = { maxFailures: 3, lockMs: 15 * 60_000 };
  const a1 = await store.reservePasswordAttempt('ana@example.com', at(1), opts);
  assert.equal(a1.status, 'reserved');
  assert.equal(a1.status === 'reserved' && a1.credential.failedCount, 1);
  assert.equal(a1.status === 'reserved' && a1.locks, false);
  assert.equal(a1.status === 'reserved' && a1.credential.hash, 'scrypt$15$8$1$a$b', 'the hash to check rides the reservation');
  await store.reservePasswordAttempt('ana@example.com', at(2), opts);
  const a3 = await store.reservePasswordAttempt('ana@example.com', at(3), opts);
  assert.equal(a3.status, 'reserved', 'the attempt that reaches the limit is still checked');
  assert.equal(a3.status === 'reserved' && a3.locks, true);
  assert.equal(a3.status === 'reserved' && a3.credential.failedCount, 0, 'the count starts again at the lock');
  assert.equal(a3.status === 'reserved' && a3.credential.lockedUntil, at(18), 'locked for lockMs from the attempt that reached the limit');
  // During the lock nothing is counted, so guesses cannot renew it.
  const during = await store.reservePasswordAttempt('ana@example.com', at(10), opts);
  assert.equal(during.status, 'locked');
  assert.equal(during.status === 'locked' && during.credential.lockedUntil, at(18));
  assert.equal((await store.getPasswordCredential('ana@example.com'))?.lockedUntil, at(18), 'not renewed');
  assert.deepEqual(await store.reservePasswordAttempt('nobody@example.com', at(3), opts), { status: 'none' });
  // After the lock: counted again from zero, and the stale lock is cleared.
  const afterLock = await store.reservePasswordAttempt('ana@example.com', at(18), opts);
  assert.equal(afterLock.status, 'reserved');
  assert.equal(afterLock.status === 'reserved' && afterLock.credential.failedCount, 1);
  assert.equal(afterLock.status === 'reserved' && afterLock.credential.lockedUntil, undefined);

  await store.clearPasswordFailures('ana@example.com');
  const cleared = await store.getPasswordCredential('ana@example.com');
  assert.equal(cleared?.failedCount, 0);
  assert.equal(cleared?.lockedUntil, undefined);

  // A burst: of many attempts at once, exactly maxFailures are let through.
  const burst = await Promise.all(Array.from({ length: 8 }, () => store.reservePasswordAttempt('ana@example.com', at(20), opts)));
  assert.equal(burst.filter((b) => b.status === 'reserved').length, 3, JSON.stringify(burst.map((b) => b.status)));
  assert.equal(burst.filter((b) => b.status === 'reserved' && b.locks).length, 1);
  assert.equal(burst.filter((b) => b.status === 'locked').length, 5);
  await store.clearPasswordFailures('ana@example.com');

  await store.reservePasswordAttempt('ana@example.com', at(40), opts);
  const reset = await store.putPasswordCredential({ id: 'pwc_other', email: 'ana@example.com', hash: 'scrypt$15$8$1$c$d', at: at(41), ownerIssued: true });
  assert.deepEqual(reset, { id: 'pwc_1', email: 'ana@example.com', hash: 'scrypt$15$8$1$c$d', createdAt: T0, updatedAt: at(41), failedCount: 0, ownerIssued: true },
    'a reset replaces the hash, keeps the id and createdAt, clears the count and records who stood behind it');

  // A rehash only replaces the hash it was computed from.
  assert.equal(await store.rehashPasswordCredential('ana@example.com', 'scrypt$15$8$1$a$b', 'scrypt$16$8$1$x$y', at(42)), false, 'stale: a reset came in between');
  assert.equal(await store.rehashPasswordCredential('ana@example.com', 'scrypt$15$8$1$c$d', 'scrypt$16$8$1$x$y', at(42)), true);
  const rehashed = await store.getPasswordCredential('ana@example.com');
  assert.equal(rehashed?.hash, 'scrypt$16$8$1$x$y');
  assert.equal(rehashed?.ownerIssued, true, 'a rehash keeps where the password came from');

  // Links: live until used or expired; single use even under a race.
  const link = { tokenHash: 'h1', email: 'Bo@Example.com', purpose: 'setup' as const, createdBy: 'user:u1', createdAt: T0, expiresAt: at(60) };
  await store.createPasswordLink(link);
  assert.deepEqual(await store.findLivePasswordLink('h1', at(1)), { ...link, email: 'bo@example.com' });
  assert.equal(await store.findLivePasswordLink('h1', at(60)), null, 'not at or after expiry');
  assert.equal(await store.consumePasswordLink('h1', at(60)), null, 'an expired link cannot be spent');
  const spent = await Promise.all([store.consumePasswordLink('h1', at(2)), store.consumePasswordLink('h1', at(2))]);
  assert.equal(spent.filter(Boolean).length, 1, 'exactly one of two racing uses wins');
  assert.equal(spent.find(Boolean)?.usedAt, at(2));
  assert.equal(await store.findLivePasswordLink('h1', at(3)), null);
  assert.equal(await store.consumePasswordLink('h1', at(3)), null);
  assert.equal(await store.consumePasswordLink('unknown', at(3)), null);

  // A new link removes the email's unused ones, not another email's.
  await store.createPasswordLink({ ...link, tokenHash: 'h2', email: 'cy@example.com', createdAt: at(10), expiresAt: at(70) });
  await store.createPasswordLink({ ...link, tokenHash: 'h3', email: 'cy@example.com', purpose: 'reset', createdAt: at(11), expiresAt: at(71) });
  await store.createPasswordLink({ ...link, tokenHash: 'h4', email: 'dee@example.com', createdAt: at(11), expiresAt: at(71) });
  assert.equal(await store.findLivePasswordLink('h2', at(12)), null, 'the earlier link for cy is gone');
  assert.equal((await store.findLivePasswordLink('h3', at(12)))?.purpose, 'reset');
  assert.ok(await store.findLivePasswordLink('h4', at(12)), "another address's link stays");
  // Issued at the same moment, still only one stays live.
  await Promise.all(['h6', 'h7', 'h8'].map((h) => store.createPasswordLink({ ...link, tokenHash: h, email: 'fay@example.com', createdAt: at(12), expiresAt: at(72) })));
  const live = (await Promise.all(['h6', 'h7', 'h8'].map((h) => store.findLivePasswordLink(h, at(13))))).filter(Boolean);
  assert.equal(live.length, 1, 'one live link per address, even when issued at once');

  // Revoking an address's links ("Disable access") leaves used and other links alone.
  assert.equal(await store.revokePasswordLinks('Dee@Example.com'), 1);
  assert.equal(await store.findLivePasswordLink('h4', at(12)), null);
  assert.ok(await store.findLivePasswordLink('h3', at(12)));

  // Removing a credential by id takes its address's unused links with it.
  await store.putPasswordCredential({ id: 'pwc_cy', email: 'cy@example.com', hash: 'scrypt$15$8$1$g$h', at: T0, ownerIssued: false });
  const removed = await store.deletePasswordCredential('pwc_cy');
  assert.equal(removed?.email, 'cy@example.com');
  assert.equal(await store.getPasswordCredential('cy@example.com'), null);
  assert.equal(await store.findLivePasswordLink('h3', at(12)), null, "the address's unused link went too");
  assert.equal(await store.deletePasswordCredential('pwc_cy'), null);

  // Erasure takes the address's password rows with the account.
  const user = await store.upsertUserBySub({ sub: 'password:pwc_e', email: 'Eve@Example.com', groups: [], role: 'member' });
  await store.putPasswordCredential({ id: 'pwc_e', email: 'eve@example.com', hash: 'scrypt$15$8$1$e$f', at: T0, ownerIssued: false });
  await store.createPasswordLink({ ...link, tokenHash: 'h5', email: 'eve@example.com', createdAt: at(20), expiresAt: at(80) });
  assert.equal((await store.eraseUserAccount(user.id)).status, 'erased');
  assert.equal(await store.getPasswordCredential('eve@example.com'), null);
  assert.equal(await store.findLivePasswordLink('h5', at(21)), null);
  assert.ok(await store.getPasswordCredential('ana@example.com'), 'other credentials stay');

  // ... and the credential its password sign-in names under another address,
  // even while another account still carries that address.
  const gil = await store.upsertUserBySub({ sub: 'github:g1', email: 'gil@example.com', groups: [], role: 'member' });
  await store.upsertUserBySub({ sub: 'github:g2', email: 'gil@work.example', groups: [], role: 'member' });
  await store.putPasswordCredential({ id: 'pwc_g', email: 'gil@work.example', hash: 'scrypt$15$8$1$i$j', at: T0, ownerIssued: false });
  await store.linkIdentity({ identitySub: 'password:pwc_g', userId: gil.id, idp: 'email', email: 'gil@work.example', emailVerified: false, linkedAt: T0, lastLoginAt: T0 });
  await store.createPasswordLink({ ...link, tokenHash: 'h9', email: 'gil@work.example', createdAt: at(20), expiresAt: at(80) });
  assert.equal((await store.eraseUserAccount(gil.id)).status, 'erased');
  assert.equal(await store.getPasswordCredential('gil@work.example'), null);
  assert.equal(await store.findLivePasswordLink('h9', at(21)), null);
}

test('password storage: memory driver', async () => {
  await passwordStoreConformance(createMemoryStore());
});

const pgUrl = process.env.LW_TEST_DATABASE_URL;
test('password storage: Postgres driver', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl as string, passwordStoreConformance);
});
