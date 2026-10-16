// SPDX-License-Identifier: MPL-2.0
/**
 * Gated interoperability canary for the signed-HTTPS delivery adapter against a
 * real organization-owned receiver. Point it at a receiver channel set aside for
 * the canary. One test sends an inert signed delivery the receiver must accept;
 * when its receipt carries a digest, that digest must match the bytes sent.
 * The other sends three deliveries it must refuse: one signed with another
 * secret, one with a day-old timestamp and one whose body does not match its
 * signed digest.
 *
 * The protocol has no delete contract (docs/delivery.md), so cleanup uses the
 * receiver's own management API. LW_HTTPS_CANARY_CLEANUP_URL is an HTTPS URL
 * with one {id} placeholder. In finally the canary fills it with each exact id
 * the receiver accepted (or the delivery id, when the outcome is unknown), sends
 * DELETE, and expects 404 or 410 from a GET of that same URL. It never prints
 * the HMAC secret or the cleanup credential.
 *
 * Run only with explicit local credentials:
 *   LW_HTTPS_CANARY=1 \
 *   LW_HTTPS_CANARY_URL=https://receiver.example/lolly-delivery/canary \
 *   LW_HTTPS_CANARY_SECRET=... \
 *   LW_HTTPS_CANARY_CLEANUP_URL='https://receiver.example/items/{id}' \
 *   LW_HTTPS_CANARY_CLEANUP_CREDENTIAL='bearer:<token>' \
 *   node --test tests/https-delivery-canary.test.ts
 *
 * LW_HTTPS_CANARY_CLEANUP_CREDENTIAL is optional and also accepts '<username>:<password>'.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHttpsDeliveryProvider } from '../server/src/delivery/https.ts';
import type { DeliveryInput, DeliveryReceipt } from '../server/src/delivery/types.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

const enabled = process.env.LW_HTTPS_CANARY === '1';
const skip = !enabled && 'set LW_HTTPS_CANARY=1 explicitly';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Settings { url: string; secret: string; cleanupUrl: string; cleanupCredential?: string }

function settings(): Settings {
  const url = process.env.LW_HTTPS_CANARY_URL;
  const secret = process.env.LW_HTTPS_CANARY_SECRET;
  const cleanupUrl = process.env.LW_HTTPS_CANARY_CLEANUP_URL;
  assert.ok(url && secret && cleanupUrl,
    'LW_HTTPS_CANARY_URL, LW_HTTPS_CANARY_SECRET and LW_HTTPS_CANARY_CLEANUP_URL are required');
  assert.equal(cleanupUrl.split('{id}').length, 2, 'LW_HTTPS_CANARY_CLEANUP_URL needs exactly one {id} placeholder');
  assert.equal(new URL(cleanupUrl.replace('{id}', 'id')).protocol, 'https:', 'LW_HTTPS_CANARY_CLEANUP_URL must be HTTPS');
  const cleanupCredential = process.env.LW_HTTPS_CANARY_CLEANUP_CREDENTIAL;
  return { url, secret, cleanupUrl, ...(cleanupCredential ? { cleanupCredential } : {}) };
}

function canaryInput(body = 'lolly-work https delivery canary v1\n'): DeliveryInput {
  const bytes = new TextEncoder().encode(body);
  return {
    deliveryId: `canary-${randomUUID()}`, bytes, sha256: sha256Hex(bytes),
    name: 'canary', format: 'txt', contentType: 'text/plain; charset=utf-8',
  };
}

function authorization(credential: string): string {
  return credential.toLowerCase().startsWith('bearer:')
    ? `Bearer ${credential.slice('bearer:'.length).trim()}`
    : `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`;
}

/** Deletes each exact id through the receiver's own API; returns the ids still present or unconfirmed. */
async function removeExact(s: Settings, ids: Iterable<string>): Promise<string[]> {
  const headers: Record<string, string> = s.cleanupCredential ? { authorization: authorization(s.cleanupCredential) } : {};
  const left: string[] = [];
  for (const id of ids) {
    const target = s.cleanupUrl.replace('{id}', encodeURIComponent(id));
    try {
      const removed = await fetch(target, { method: 'DELETE', headers, redirect: 'error' });
      await removed.body?.cancel();
      const check = await fetch(target, { headers, redirect: 'error' });
      await check.body?.cancel();
      const deleted = removed.ok || removed.status === 404 || removed.status === 410;
      if (!deleted || (check.status !== 404 && check.status !== 410)) left.push(id);
    } catch {
      left.push(id);
    }
  }
  return left;
}

test('a live receiver accepts a signed canary delivery', { skip }, async (t) => {
  const s = settings();
  const input = canaryInput();
  const written = new Set<string>();
  t.diagnostic(`canary delivery id ${input.deliveryId}`);
  try {
    let receipt: DeliveryReceipt;
    try {
      receipt = await createHttpsDeliveryProvider({ url: s.url }, s.secret).deliver(input);
    } catch (error) {
      // The receiver may have stored the bytes before the failure, so clean up by delivery id.
      written.add(input.deliveryId);
      throw error;
    }
    written.add(receipt.remoteId);
    t.diagnostic(`receiver id ${receipt.remoteId}, transformation ${receipt.transformation}`);
    // A canary channel has no reason to change inert text, so a different digest is a wire fault.
    assert.notEqual(receipt.transformation, 'provider-managed', 'the receiver reported different bytes from those sent');
  } finally {
    const left = await removeExact(s, written);
    assert.deepEqual(left, [], `canary cleanup failed for exact ids ${left.join(', ')}`);
  }
});

test('a live receiver refuses a foreign signature, a stale timestamp and a body that does not match its digest', { skip }, async (t) => {
  const s = settings();
  const target = { url: s.url };
  // Same length as the signed body, so only the digest disagrees.
  const mismatched = { ...canaryInput(), sha256: sha256Hex(new TextEncoder().encode('lolly-work https delivery canary v2\n')) };
  const probes = [
    { label: 'signature from another secret', input: canaryInput(),
      provider: createHttpsDeliveryProvider(target, randomBytes(32).toString('hex')) },
    { label: 'timestamp a day old', input: canaryInput(),
      provider: createHttpsDeliveryProvider(target, s.secret, fetch, () => Date.now() - DAY_MS) },
    { label: 'body that does not match the signed digest', input: mismatched,
      provider: createHttpsDeliveryProvider(target, s.secret) },
  ];
  const written = new Set<string>();
  const problems: string[] = [];
  try {
    for (const probe of probes) {
      t.diagnostic(`${probe.label}: delivery id ${probe.input.deliveryId}`);
      let receipt: DeliveryReceipt;
      try {
        receipt = await probe.provider.deliver(probe.input);
      } catch (error) {
        // A rate limit or timeout says nothing about the request itself.
        const message = (error as Error).message;
        if (!/^https delivery receiver 4\d\d$/.test(message) || /\b(408|429)$/.test(message)) {
          written.add(probe.input.deliveryId);
          problems.push(`${probe.label}: expected a 4xx refusal, got "${message}"`);
        }
        continue;
      }
      written.add(receipt.remoteId);
      problems.push(`${probe.label}: the receiver accepted it as ${receipt.remoteId}`);
    }
  } finally {
    const left = await removeExact(s, written);
    assert.deepEqual(left, [], `canary cleanup failed for exact ids ${left.join(', ')}`);
  }
  assert.deepEqual(problems, []);
});
