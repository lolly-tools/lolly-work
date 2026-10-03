/**
 * Access requests under concurrency (migration 0044; security rules 9 and
 * 11), on both drivers: memory always, Postgres when LW_TEST_DATABASE_URL is
 * set. However many calls race, one key has one open row, one answer wins,
 * and a supersede never closes a row someone else already answered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { AccessRequestRecord, Store } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const url = process.env.LW_TEST_DATABASE_URL;
const AT = '2026-10-04T10:00:00.000Z';
const at = (days: number): string => new Date(Date.parse(AT) + days * 86_400_000).toISOString();
const join = (id: string, email: string, createdAt = AT, expiresAt = at(14)): AccessRequestRecord => ({
  id, kind: 'join', status: 'open', email, identitySub: `gh:${email}`, idp: 'github', createdAt, expiresAt,
});

async function races(store: Store): Promise<void> {
  const filed = await Promise.all(Array.from({ length: 8 }, (_, i) => store.createAccessRequest(join(`req_r${i}`, 'race@example.com'), AT)));
  assert.equal(filed.filter((f) => f.created).length, 1, 'one insert wins');
  assert.equal(new Set(filed.map((f) => f.request.id)).size, 1, 'every caller gets the same open row');
  const id = filed[0]!.request.id;

  const answers = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    store.answerAccessRequest(id, { status: i % 2 ? 'approved' : 'declined', at: at(1), by: `user:a${i}` }, at(1))));
  const won = answers.filter(Boolean);
  assert.equal(won.length, 1, 'one answer wins');
  assert.equal((await store.getAccessRequest(id))?.answeredBy, won[0]!.answeredBy, 'and it is the one stored');

  await store.createAccessRequest(join('req_c', 'close@example.com'), AT);
  const [answered, closed] = await Promise.all([
    store.answerAccessRequest('req_c', { status: 'approved', at: at(1), by: 'user:approver' }, at(1)),
    store.closeAccessRequests({ kind: 'join', email: 'close@example.com' }, { status: 'superseded', at: at(1), by: 'user:sharer' }, at(1)),
  ]);
  assert.equal(Number(!!answered) + closed.length, 1, 'an answer and a supersede never both close the row');

  await store.createAccessRequest(join('req_old', 'renew@example.com'), AT);
  const renewed = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    store.createAccessRequest(join(`req_new${i}`, 'renew@example.com', at(15), at(29)), at(15))));
  assert.equal(renewed.filter((f) => f.created).length, 1, 'after expiry, one new row');
  assert.equal((await store.getAccessRequest('req_old'))?.status, 'expired');
  assert.equal((await store.listAccessRequests({ status: 'open', now: at(15), email: 'renew@example.com' })).length, 1);
}

test('memory: racing requests keep one open row and one answer', async () => {
  await races(createMemoryStore());
});

test('postgres: racing requests keep one open row and one answer', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url!, races);
});
