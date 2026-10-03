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
  // Credentials: one per email, lowercased; a reset keeps the id and clears failures.
  assert.equal(await store.getPasswordCredential('ana@example.com'), null);
  const first = await store.putPasswordCredential({ id: 'pwc_1', email: ' Ana@Example.COM ', hash: 'scrypt$15$8$1$a$b', at: T0 });
  assert.deepEqual(first, { id: 'pwc_1', email: 'ana@example.com', hash: 'scrypt$15$8$1$a$b', createdAt: T0, updatedAt: T0, failedCount: 0 });
  assert.deepEqual(await store.getPasswordCredential('ANA@example.com'), first);

  const opts = { maxFailures: 3, lockMs: 15 * 60_000 };
  assert.equal((await store.recordPasswordFailure('ana@example.com', at(1), opts))?.failedCount, 1);
  assert.equal((await store.recordPasswordFailure('ana@example.com', at(2), opts))?.failedCount, 2);
  const locked = await store.recordPasswordFailure('ana@example.com', at(3), opts);
  assert.equal(locked?.failedCount, 0, 'the count starts again at the lock');
  assert.equal(locked?.lockedUntil, at(18), 'locked for lockMs from the failure that reached the limit');
  assert.equal(await store.recordPasswordFailure('nobody@example.com', at(3), opts), null, 'no credential, no row');

  await store.clearPasswordFailures('ana@example.com');
  const cleared = await store.getPasswordCredential('ana@example.com');
  assert.equal(cleared?.failedCount, 0);
  assert.equal(cleared?.lockedUntil, undefined);

  await store.recordPasswordFailure('ana@example.com', at(4), opts);
  const reset = await store.putPasswordCredential({ id: 'pwc_other', email: 'ana@example.com', hash: 'scrypt$15$8$1$c$d', at: at(5) });
  assert.deepEqual(reset, { id: 'pwc_1', email: 'ana@example.com', hash: 'scrypt$15$8$1$c$d', createdAt: T0, updatedAt: at(5), failedCount: 0 },
    'a reset replaces the hash, keeps the id and createdAt, and clears the count');

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

  // Erasure takes the address's password rows with the account.
  const user = await store.upsertUserBySub({ sub: 'password:pwc_e', email: 'Eve@Example.com', groups: [], role: 'member' });
  await store.putPasswordCredential({ id: 'pwc_e', email: 'eve@example.com', hash: 'scrypt$15$8$1$e$f', at: T0 });
  await store.createPasswordLink({ ...link, tokenHash: 'h5', email: 'eve@example.com', createdAt: at(20), expiresAt: at(80) });
  assert.equal((await store.eraseUserAccount(user.id)).status, 'erased');
  assert.equal(await store.getPasswordCredential('eve@example.com'), null);
  assert.equal(await store.findLivePasswordLink('h5', at(21)), null);
  assert.ok(await store.getPasswordCredential('ana@example.com'), 'other credentials stay');
}

test('password storage: memory driver', async () => {
  await passwordStoreConformance(createMemoryStore());
});

const pgUrl = process.env.LW_TEST_DATABASE_URL;
test('password storage: Postgres driver', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl as string, passwordStoreConformance);
});
