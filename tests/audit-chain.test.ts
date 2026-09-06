import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextEvent, verifyChain, macEvent, deriveAuditMacKey, type AuditEvent, type AuditEventBody } from '../server/src/audit/chain.ts';

function body(n: number): AuditEventBody {
  return { at: `2026-07-21T00:00:0${n}Z`, actor: 'user:u1', action: 'link.create', subject: `link:${n}` };
}

function chainOf(n: number): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (let i = 0; i < n; i++) events.push(nextEvent(events[events.length - 1] ?? null, body(i)));
  return events;
}

test('a well-formed chain verifies; an empty chain verifies', () => {
  assert.deepEqual(verifyChain(chainOf(5)), { ok: true });
  assert.deepEqual(verifyChain([]), { ok: true });
});

test('in-place tampering is detected at the exact seq', () => {
  const events = chainOf(5);
  (events[2] as { actor: string }).actor = 'user:evil';
  assert.deepEqual(verifyChain(events), { ok: false, badSeq: 3 });
});

test('truncation from the front (hiding history) is detected', () => {
  const events = chainOf(5).slice(1);
  assert.equal(verifyChain(events).ok, false);
});

test('re-hashing a tampered event still fails: the next link breaks', () => {
  const events = chainOf(5);
  const forgedBody = { ...body(9), subject: 'link:forged' };
  events[2] = nextEvent(events[1] ?? null, forgedBody); // valid hash for itself...
  const result = verifyChain(events);
  assert.equal(result.ok, false);
  assert.equal(result.badSeq, 4); // ...but event 4's prevHash no longer matches
});

const KEY = deriveAuditMacKey('session-secret-for-tests');

function keyedChainOf(n: number, key = KEY): AuditEvent[] {
  const events: AuditEvent[] = [];
  for (let i = 0; i < n; i++) events.push(nextEvent(events[events.length - 1] ?? null, body(i), key));
  return events;
}

test('keyed rows carry a MAC that verifies under the key and no other', () => {
  const events = keyedChainOf(4);
  assert.ok(events.every((e) => typeof e.mac === 'string'));
  assert.deepEqual(verifyChain(events, null, KEY), { ok: true, unkeyed: 0 });
  assert.equal(verifyChain(events, null, deriveAuditMacKey('another secret')).ok, false);
  // Without a key the chain still verifies by hash alone, and reports nothing about MACs.
  assert.deepEqual(verifyChain(events), { ok: true });
});

test('a rewrite that recomputes the public hash chain still fails the MAC', () => {
  const events = keyedChainOf(4);
  // A database holder edits row 2 and rebuilds every hash from there on, the
  // way a chain-only verifier would be fooled - but has no key for the MAC.
  const forged: AuditEvent[] = events.slice(0, 1);
  for (let i = 1; i < 4; i++) {
    const evt = nextEvent(forged[forged.length - 1] ?? null, { ...body(i), actor: i === 1 ? 'user:evil' : body(i).actor });
    forged.push({ ...evt, mac: events[i]!.mac });
  }
  assert.deepEqual(verifyChain(forged), { ok: true }, 'the chain alone cannot see it');
  assert.equal(verifyChain(forged, null, KEY).ok, false, 'the MAC can');
  assert.equal(verifyChain(forged, null, KEY).badSeq, 2);
});

test('rows written before the key existed are counted, not failed', () => {
  const legacy = chainOf(2);
  const keyed = [legacy[0]!, legacy[1]!];
  keyed.push(nextEvent(keyed[1]!, body(2), KEY));
  assert.deepEqual(verifyChain(keyed, null, KEY), { ok: true, unkeyed: 2 });
  assert.equal(macEvent(KEY, 'abc'), macEvent(KEY, 'abc'));
});
