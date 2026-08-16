/**
 * Rate-card catalog awareness (plans/18) - the envelope sanity check and the
 * lifecycle derivation. Pure-function tests, matching catalog-lifecycle's
 * split: the HTTP/lifecycle enforcement itself is already covered there, and
 * these rows feed that same machinery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ratecardEnvelope, ratecardLifecycleRow } from '../server/src/catalog/rate-cards.ts';
import { assetState } from '../server/src/catalog/lifecycle.ts';

const card = (over: Record<string, unknown> = {}): string => JSON.stringify({
  currency: 'EUR',
  issuer: { name: 'Acme Print', issued: '2026-01-01', validUntil: '2026-12-31' },
  lines: [{ id: 'plates', kind: 'perPlate' }],
  ...over,
});

test('a shaped card yields its claims — currency, issuer, window, line count', () => {
  const env = ratecardEnvelope(card());
  assert.ok(env.ok);
  assert.equal(env.currency, 'EUR');
  assert.equal(env.issuerName, 'Acme Print');
  assert.equal(env.validUntil, '2026-12-31');
  assert.equal(env.lineCount, 1);
  assert.equal(env.confidential, false);
});

test('confidential is lifted only from an explicit true', () => {
  const env = ratecardEnvelope(card({ confidential: true }));
  assert.ok(env.ok && env.confidential);
  const env2 = ratecardEnvelope(card({ confidential: 'yes' }));
  assert.ok(env2.ok && !env2.confidential);
});

test('refusals name the reason: not-json / not-a-rate-card / no-lines / no-currency', () => {
  assert.deepEqual(ratecardEnvelope('nope{'), { ok: false, reason: 'not-json' });
  assert.deepEqual(ratecardEnvelope('[1,2]'), { ok: false, reason: 'not-a-rate-card' });
  assert.deepEqual(ratecardEnvelope('{"currency":"EUR"}'), { ok: false, reason: 'not-a-rate-card' });
  assert.deepEqual(ratecardEnvelope(card({ lines: [] })), { ok: false, reason: 'no-lines' });
  assert.deepEqual(ratecardEnvelope(card({ currency: '€' })), { ok: false, reason: 'no-currency' });
  assert.deepEqual(ratecardEnvelope(card({ currency: undefined })), { ok: false, reason: 'no-currency' });
});

test('there is no default currency anywhere: a currency-less card is refused at ingest', () => {
  const env = ratecardEnvelope(JSON.stringify({ lines: [{}] }));
  assert.deepEqual(env, { ok: false, reason: 'no-currency' });
});

test('lifecycle derives from the card window, onExpiry always warn (never hide)', () => {
  const env = ratecardEnvelope(card());
  assert.ok(env.ok);
  const row = ratecardLifecycleRow('acme/rates/2026', env)!;
  assert.equal(row.assetId, 'acme/rates/2026');
  assert.equal(row.validFrom, '2026-01-01');
  assert.equal(row.validUntil, '2026-12-31');
  assert.equal(row.onExpiry, 'warn');
  // …and the row means what lifecycle.ts thinks it means:
  assert.equal(assetState(row, Date.parse('2026-06-01')), 'live');
  assert.equal(assetState(row, Date.parse('2027-01-05')), 'expired');
  assert.equal(assetState(row, Date.parse('2025-06-01')), 'scheduled');
});

test('no claimed window ⇒ no row (lifecycle never stricter than the file said)', () => {
  const env = ratecardEnvelope(card({ issuer: { name: 'Acme Print' } }));
  assert.ok(env.ok);
  assert.equal(ratecardLifecycleRow('a', env), null);
});

test('a malformed date is treated as no claim, not a surprise state', () => {
  const env = ratecardEnvelope(card({ issuer: { validUntil: 'next spring' } }));
  assert.ok(env.ok);
  assert.equal(ratecardLifecycleRow('a', env), null);
});
