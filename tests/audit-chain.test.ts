import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextEvent, verifyChain, type AuditEvent, type AuditEventBody } from '../server/src/audit/chain.ts';

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
