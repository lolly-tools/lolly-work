/**
 * The retired-key boundary (server/src/audit/retire.ts): after LW_SESSION_SECRET
 * is rotated without its old value, one MAC'd boundary row lets verification
 * count the older rows as retired-key rows instead of failing them, while every
 * hash link stays checked and every later row must verify under the current key.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  KEY_RETIRE_ACTION, deriveAuditMacKey, hashEvent, macEvent, nextEvent, retiredKeyNote, verifyChain,
  type AuditEvent, type AuditEventBody,
} from '../server/src/audit/chain.ts';
import { auditHead } from '../server/src/audit/head.ts';
import { checkRetireReason, parseExpectHead, planKeyRetire, retireAuditKey } from '../server/src/audit/retire.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { Store } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const K1 = deriveAuditMacKey('first-session-secret-for-tests');
const K2 = deriveAuditMacKey('second-session-secret-for-tests');
const K3 = deriveAuditMacKey('third-session-secret-for-tests');

let clock = 0;
function body(action = 'link.create'): AuditEventBody {
  clock++;
  return { at: new Date(Date.UTC(2026, 9, 1, 0, 0, clock)).toISOString(), actor: 'user:u1', action, subject: `link:${clock}` };
}

function append(events: AuditEvent[], key: string | undefined, n = 1, action?: string): AuditEvent[] {
  for (let i = 0; i < n; i++) events.push(nextEvent(events[events.length - 1] ?? null, body(action), key));
  return events;
}

/** A database holder's edit: re-chain rows[i..] in place so every public hash
 *  link holds again (they cannot redo the MACs; with stripMac they drop them). */
function rechainFrom(rows: AuditEvent[], i: number, opts: { stripMac?: boolean } = {}): AuditEvent[] {
  for (let j = i; j < rows.length; j++) {
    const r = rows[j]!;
    const { seq, prevHash: _p, hash: _h, mac: _m, ...b } = r;
    r.prevHash = j === 0 ? r.prevHash : rows[j - 1]!.hash;
    r.hash = hashEvent(r.prevHash, seq, b);
    if (opts.stripMac) delete r.mac;
  }
  return rows;
}

/** A boundary as retire.ts writes it, MAC'd under `key`. */
function retire(events: AuditEvent[], key: string | undefined, payload: Record<string, unknown> = {}): AuditEvent {
  const tail = events[events.length - 1]!;
  const evt = nextEvent(tail, {
    ...body(KEY_RETIRE_ACTION), actor: 'system', subject: 'audit:chain',
    payload: { retiredThroughSeq: tail.seq, retiredHeadHash: tail.hash, reason: 'rotation', retiredRows: 0, previousKeyChecked: false, ...payload },
  }, key);
  events.push(evt);
  return evt;
}

// ── verifyChain ──────────────────────────────────────────────────────────────

test('a rotation breaks every older MAC until a boundary retires them', () => {
  const events = append([], K1, 3);
  append(events, K2, 1); // the server, restarted on the new secret, writes on
  assert.deepEqual(verifyChain(events, null, K2), { ok: false, badSeq: 1, unkeyed: 0 });
  const boundary = retire(events, K2);
  append(events, K2, 2);
  assert.deepEqual(verifyChain(events, null, K2), {
    ok: true, unkeyed: 0, retiredKeyRows: 3, retiredThroughSeq: 4, retiredBefore: boundary.at,
  });
  // Hash-only verification and the old key are untouched by the new fields.
  assert.deepEqual(verifyChain(events), { ok: true });
  assert.equal(verifyChain(events, null, K1).ok, false, 'rows after the boundary are not K1 rows');
  assert.equal(retiredKeyNote(verifyChain(events, null, K2)), ` (3 rows signed with a retired key before ${boundary.at})`);
  assert.equal(retiredKeyNote({ ok: true } as never), '');
});

test('a chain without a boundary reports no retired fields (backward compatible)', () => {
  const events = append([], K1, 3);
  assert.deepEqual(verifyChain(events, null, K1), { ok: true, unkeyed: 0 });
  // A boundary over rows that all verify anyway retires nothing and adds nothing.
  retire(events, K1);
  assert.deepEqual(verifyChain(events, null, K1), { ok: true, unkeyed: 0 });
});

test('a boundary forged without the current key is ignored', () => {
  const unmacd = append([], K1, 3);
  retire(unmacd, undefined); // a database holder can write rows, but no MAC
  assert.deepEqual(verifyChain(unmacd, null, K2), { ok: false, badSeq: 1, unkeyed: 0 });

  const wrongKey = append([], K1, 3);
  retire(wrongKey, deriveAuditMacKey('a guess'));
  assert.equal(verifyChain(wrongKey, null, K2).badSeq, 1);

  // A real MAC lifted from another current-key row does not fit the boundary's hash.
  const lifted = append([], K1, 3);
  const donor = nextEvent(null, body(), K2);
  const forged = retire(lifted, undefined);
  forged.mac = donor.mac!;
  assert.equal(verifyChain(lifted, null, K2).badSeq, 1);

  // A real boundary's MAC cannot be reused for a later one: rows written under
  // the old key after the real boundary stay failures.
  const repointed = append([], K1, 3);
  const real = retire(repointed, K2);
  append(repointed, K1, 2); // rows the attacker wants covered, under the old key
  const fake = retire(repointed, undefined);
  fake.mac = real.mac!;
  assert.deepEqual(verifyChain(repointed, null, K2), {
    ok: false, badSeq: 5, unkeyed: 0, retiredKeyRows: 3, retiredThroughSeq: 3, retiredBefore: real.at,
  });
});

test('a boundary whose payload does not name the row before it is ignored', () => {
  const events = append([], K1, 3);
  retire(events, K2, { retiredThroughSeq: 2 });
  assert.equal(verifyChain(events, null, K2).badSeq, 1);
  const other = append([], K1, 3);
  retire(other, K2, { retiredHeadHash: 'f'.repeat(64) });
  assert.equal(verifyChain(other, null, K2).badSeq, 1);
});

test('tampering before the boundary is still caught by the hash links', () => {
  const events = append([], K1, 4);
  retire(events, K2);
  append(events, K2, 1);
  assert.equal(verifyChain(events, null, K2).ok, true);

  const edited = structuredClone(events);
  (edited[1] as { actor: string }).actor = 'user:evil';
  assert.deepEqual(verifyChain(edited, null, K2), { ok: false, badSeq: 2, unkeyed: 0, retiredKeyRows: 1, retiredThroughSeq: 4, retiredBefore: events[4]!.at });

  // Re-hashing the edited row and every one after it moves the boundary's own
  // hash, so its MAC fails and the old rows fail with it.
  const rechained: AuditEvent[] = [edited[0]!];
  for (const e of edited.slice(1)) {
    const { seq: _s, prevHash: _p, hash: _h, mac, ...b } = e;
    rechained.push({ ...nextEvent(rechained[rechained.length - 1]!, b), ...(mac ? { mac } : {}) });
  }
  assert.equal(verifyChain(rechained).ok, true, 'the public chain alone cannot see it');
  assert.deepEqual(verifyChain(rechained, null, K2), { ok: false, badSeq: 1, unkeyed: 0 });

  // Deleting a retired row breaks the sequence.
  const deleted = [...events.slice(0, 1), ...events.slice(2)];
  assert.equal(verifyChain(deleted, null, K2).badSeq, 3);
});

test('rows after the boundary must verify under the current key', () => {
  const events = append([], K1, 2);
  retire(events, K2);
  append(events, K2, 1);
  append(events, K1, 1); // a host still on the old secret wrote after the boundary
  append(events, K2, 1);
  assert.deepEqual(verifyChain(events, null, K2), {
    ok: false, badSeq: 5, unkeyed: 0, retiredKeyRows: 2, retiredThroughSeq: 2, retiredBefore: events[2]!.at,
  });
});

test('two rotations: the newest boundary covers everything before it', () => {
  const events = append([], K1, 3);
  retire(events, K2);
  append(events, K2, 2);
  const firstEra = events.slice();
  assert.equal(verifyChain(firstEra, null, K2).retiredKeyRows, 3, 'between the rotations');
  const second = retire(events, K3);
  append(events, K3, 2);
  // The first boundary is MAC'd under K2, itself retired now: it counts as a row.
  assert.deepEqual(verifyChain(events, null, K3), {
    ok: true, unkeyed: 0, retiredKeyRows: 6, retiredThroughSeq: 6, retiredBefore: second.at,
  });
});

test('a boundary stays anchor-aware: a retention trim through part of the old rows', () => {
  const events = append([], K1, 4);
  retire(events, K2);
  append(events, K2, 1);
  const anchor = { seq: 2, hash: events[1]!.hash };
  assert.deepEqual(verifyChain(events.slice(2), anchor, K2), {
    ok: true, unkeyed: 0, retiredKeyRows: 2, retiredThroughSeq: 4, retiredBefore: events[4]!.at,
  });
  // Trimmed through the boundary itself: nothing older is left to excuse.
  assert.deepEqual(verifyChain(events.slice(5), { seq: 5, hash: events[4]!.hash }, K2), { ok: true, unkeyed: 0 });
});

test('unkeyed rows before a boundary stay counted as unkeyed', () => {
  const events = append([], undefined, 2);
  append(events, K1, 2);
  retire(events, K2);
  assert.deepEqual(verifyChain(events, null, K2), {
    ok: true, unkeyed: 2, retiredKeyRows: 2, retiredThroughSeq: 4, retiredBefore: events[4]!.at,
  });
});

test('a row without a MAC after a keyed row breaks the chain: a stripped MAC is not an old row', () => {
  const plain = append([], undefined, 2);
  append(plain, K1, 2);
  assert.deepEqual(verifyChain(plain, null, K1), { ok: true, unkeyed: 2 }, 'leading unkeyed rows still pass');
  append(plain, undefined, 1);
  assert.deepEqual(verifyChain(plain, null, K1), { ok: false, badSeq: 5, unkeyed: 2 });

  // After a valid boundary: edit a row, re-chain it and strip the MACs.
  const events = append([], K1, 3);
  retire(events, K2);
  append(events, K2, 3);
  const before = verifyChain(events, null, K2);
  assert.equal(before.ok, true);
  (events[5] as { actor: string }).actor = 'user:evil';
  rechainFrom(events, 5, { stripMac: true });
  assert.deepEqual(verifyChain(events, null, K2), {
    ok: false, badSeq: 6, unkeyed: 0, retiredKeyRows: 3, retiredThroughSeq: 3, retiredBefore: events[3]!.at,
  });
  assert.equal(verifyChain(events).ok, true, 'the public links alone cannot see it');
});

// ── planKeyRetire / retireAuditKey ───────────────────────────────────────────

test('planKeyRetire: current, broken, retire, and the previous-key check', () => {
  const events = append([], K1, 3);
  assert.equal(planKeyRetire(events, null, K1).status, 'current');
  append(events, K2, 1); // the restarted server's first row: the witness
  const plan = planKeyRetire(events, null, K2);
  assert.equal(plan.status, 'retire');
  assert.deepEqual([plan.staleRows, plan.firstStaleSeq, plan.lastStaleSeq, plan.witnessRows, plan.tail?.seq], [3, 1, 3, 1, 4]);
  assert.equal(plan.previousKeyChecked, false);
  assert.equal(plan.currentSeq, undefined);
  assert.equal(planKeyRetire(events, null, K2, { previousMacKey: K1 }).previousKeyChecked, true);
  assert.equal(planKeyRetire(events, null, K2, { previousMacKey: K1 }).status, 'retire');
  const wrong = planKeyRetire(events, null, K2, { previousMacKey: K3 });
  assert.deepEqual([wrong.status, wrong.badSeq], ['previous-mismatch', 1]);
  const broken = structuredClone(events);
  (broken[1] as { subject: string }).subject = 'link:moved';
  assert.deepEqual([planKeyRetire(broken, null, K2).status, planKeyRetire(broken, null, K2).badSeq], ['broken', 2]);
  assert.equal(planKeyRetire([], null, K2).status, 'current', 'an empty log has nothing to retire');
});

test('planKeyRetire refuses what a key change does not leave behind', () => {
  // No rotation at all: a database holder edits row 3 and re-chains from there.
  // The public links hold; rows 1-2 still verify, rows 3-6 do not.
  const noRotation = append([], K1, 6);
  (noRotation[2] as { actor: string }).actor = 'user:evil';
  rechainFrom(noRotation, 2);
  const a1 = planKeyRetire(noRotation, null, K1);
  assert.deepEqual([a1.status, a1.currentSeq, a1.badSeq], ['interleaved', 1, 3]);

  // A real rotation, then an edit of a current-key row, re-chained.
  const afterRotation = append(append([], K1, 3), K2, 3);
  (afterRotation[4] as { actor: string }).actor = 'user:evil';
  rechainFrom(afterRotation, 4);
  const a2 = planKeyRetire(afterRotation, null, K2);
  assert.deepEqual([a2.status, a2.currentSeq, a2.badSeq], ['interleaved', 4, 5]);

  // A MAC stripped instead of redone.
  const stripped = append([], K1, 3);
  append(stripped, undefined, 1);
  assert.deepEqual([planKeyRetire(stripped, null, K2).status, planKeyRetire(stripped, null, K2).badSeq], ['stripped', 4]);

  // The command run with a key the server does not use: nothing verifies.
  const rotated = append(append([], K1, 3), K2, 1);
  const wrongKey = planKeyRetire(rotated, null, K3);
  assert.deepEqual([wrongKey.status, wrongKey.witnessRows, wrongKey.staleRows], ['no-witness', 0, 4]);
  assert.equal(planKeyRetire(rotated, null, K3, { noWitness: true }).status, 'retire', '--no-witness overrides');

  // A host still on the old secret after the switch: refused, unless told.
  const lateHost = append(append(append([], K1, 3), K2, 2), K1, 1);
  const late = planKeyRetire(lateHost, null, K2);
  assert.deepEqual([late.status, late.currentSeq, late.badSeq], ['interleaved', 4, 6]);
  const allowed = planKeyRetire(lateHost, null, K2, { allowInterleaved: true });
  assert.deepEqual([allowed.status, allowed.currentSeq, allowed.witnessRows], ['no-witness', 4, 0], 'nothing after row 6 verifies yet');
  append(lateHost, K2, 1);
  assert.equal(planKeyRetire(lateHost, null, K2, { allowInterleaved: true }).status, 'retire');

  // Two rotations: K1 rows, a K2 boundary and K2 rows are all old under K3.
  const twice = append([], K1, 3);
  retire(twice, K2);
  append(twice, K2, 2);
  append(twice, K3, 1);
  const plan = planKeyRetire(twice, null, K3);
  assert.deepEqual([plan.status, plan.staleRows, plan.witnessRows], ['retire', 6, 1]);
});

test('--expect-head pins every row up to the head recorded before the rotation', () => {
  const events = append([], K1, 4);
  const head = { seq: 4, hash: events[3]!.hash };
  append(events, K1, 1); // the old host wrote once more before it was switched
  append(events, K2, 2);
  const ok = planKeyRetire(events, null, K2, { expectHead: head });
  assert.deepEqual([ok.status, ok.staleRows, ok.staleAfterHead], ['retire', 5, 1]);

  // An edit before the recorded head, re-chained, with the server writing on
  // top: the order of old and current rows looks like a key change, the head does not.
  const edited = append([], K1, 4);
  const recorded = { seq: 4, hash: edited[3]!.hash };
  (edited[1] as { actor: string }).actor = 'user:evil';
  rechainFrom(edited, 1);
  append(edited, K2, 2);
  assert.equal(planKeyRetire(edited, null, K2).status, 'retire', 'without the head this is indistinguishable');
  const caught = planKeyRetire(edited, null, K2, { expectHead: recorded });
  assert.deepEqual([caught.status, caught.badSeq], ['head-mismatch', 4]);

  // Truncated below the recorded head, or a head from somewhere else.
  assert.equal(planKeyRetire(events, null, K2, { expectHead: { seq: 99, hash: head.hash } }).status, 'head-mismatch');
  // A retention trim that anchored exactly on the recorded head still matches it.
  const trimmed = planKeyRetire(events.slice(4), { seq: 4, hash: head.hash }, K2, { expectHead: head });
  assert.deepEqual([trimmed.status, trimmed.staleRows], ['retire', 1]);

  assert.deepEqual(parseExpectHead(` 4:${head.hash} `), head);
  assert.throws(() => parseExpectHead(`4:${head.hash.toUpperCase()}`), /<seq>:<hash>/);
  assert.throws(() => parseExpectHead('0:' + 'a'.repeat(64)), /<seq>:<hash>/);
  assert.throws(() => parseExpectHead('4'), /<seq>:<hash>/);
});

test('checkRetireReason wants one short line', () => {
  assert.throws(() => checkRetireReason(undefined), /reason is required/);
  assert.throws(() => checkRetireReason('   '), /reason is required/);
  assert.throws(() => checkRetireReason('x'.repeat(201)), /longer than 200/);
  assert.throws(() => checkRetireReason('two\nlines'), /one line/);
  assert.equal(checkRetireReason('  secret rotation 2026-10-04 '), 'secret rotation 2026-10-04');
});

/** The rotation as a store sees it: rows under the old key, a restart on the
 *  new one, and the server writing on before anyone retires anything. */
async function rotatedStore(store: Store, oldKey: string, newKey: string): Promise<void> {
  store.setAuditMacKey!(oldKey);
  for (let i = 0; i < 3; i++) await store.appendAudit(body());
  store.setAuditMacKey!(newKey);
  await store.appendAudit(body('auth.login'));
}

async function exerciseRetire(store: Store): Promise<void> {
  await rotatedStore(store, K1, K2);
  const broken = await auditHead(store, K2);
  assert.equal(broken.chainIntact, false);
  assert.equal(broken.badSeq, 1);

  const dry = await retireAuditKey(store, { macKey: K2, reason: 'secret rotation 2026-10-04', dryRun: true });
  assert.equal(dry.written, false);
  assert.equal(dry.status, 'retire');
  assert.equal((await store.listAudit()).length, 4, 'a dry run writes nothing');

  const recorded = { seq: 3, hash: (await store.listAudit())[2]!.hash }; // the last old-key row
  const done = await retireAuditKey(store, { macKey: K2, reason: 'secret rotation 2026-10-04', expectHead: recorded });
  assert.equal(done.written, true);
  if (!done.written) return;
  assert.equal(done.event.seq, 5);
  assert.equal(done.event.action, KEY_RETIRE_ACTION);
  assert.equal(done.staleAfterHead, 0);
  assert.deepEqual(done.event.payload, {
    retiredThroughSeq: 4, retiredHeadHash: done.tail!.hash, reason: 'secret rotation 2026-10-04', retiredRows: 3, previousKeyChecked: false,
    expectedHead: recorded,
  });
  assert.equal(done.event.mac, macEvent(K2, done.event.hash));
  assert.equal(done.after.ok, true);

  await store.appendAudit(body('auth.login'));
  const head = await auditHead(store, K2);
  assert.equal(head.chainIntact, true);
  assert.equal(head.retiredKeyRows, 3);
  assert.equal(head.retiredThroughSeq, 4);
  assert.equal(head.retiredBefore, done.event.at);
  assert.equal(head.badSeq, undefined);

  // Idempotent: a second run finds nothing to retire and writes nothing.
  const again = await retireAuditKey(store, { macKey: K2, reason: 'secret rotation 2026-10-04' });
  assert.equal(again.status, 'current');
  assert.equal(again.written, false);
  assert.equal((await store.listAudit()).length, 6);
}

test('retireAuditKey on the memory store: dry run, write, verify, idempotent', async () => {
  await exerciseRetire(createMemoryStore());
});

test('retireAuditKey checks the old rows against a known previous key, and refuses a broken chain', async () => {
  const checked = createMemoryStore();
  await rotatedStore(checked, K1, K2);
  const ok = await retireAuditKey(checked, { macKey: K2, previousMacKey: K1, reason: 'rotation with the old value known' });
  assert.equal(ok.written && ok.event.payload?.previousKeyChecked, true);

  const mismatch = createMemoryStore();
  await rotatedStore(mismatch, K1, K2);
  const refused = await retireAuditKey(mismatch, { macKey: K2, previousMacKey: K3, reason: 'wrong previous value' });
  assert.deepEqual([refused.status, refused.written, refused.badSeq], ['previous-mismatch', false, 1]);
  assert.equal((await mismatch.listAudit()).length, 4);

  const tampered = createMemoryStore();
  await rotatedStore(tampered, K1, K2);
  ((await tampered.listAudit())[1] as { actor: string }).actor = 'user:evil'; // the memory store hands out its own rows
  const refusedBroken = await retireAuditKey(tampered, { macKey: K2, reason: 'cover an edit' });
  assert.deepEqual([refusedBroken.status, refusedBroken.written, refusedBroken.badSeq], ['broken', false, 2]);
});

test('retireAuditKey writes nothing on a lost race and plans again against the new tail', async () => {
  const store = createMemoryStore();
  await rotatedStore(store, K1, K2);
  const appendIfTail = store.appendAuditIfTail!.bind(store);
  let raced = false;
  store.appendAuditIfTail = async (tail, b) => {
    if (!raced) { raced = true; await store.appendAudit(body('auth.login')); }
    return appendIfTail(tail, b);
  };
  const done = await retireAuditKey(store, { macKey: K2, reason: 'rotation under load' });
  assert.equal(done.written, true);
  if (!done.written) return;
  const events = await store.listAudit();
  // seq 5 = the racing login, 6 = the boundary. No stray boundary row.
  assert.equal(done.event.seq, 6);
  assert.deepEqual(events.map((e) => e.action).filter((a) => a === KEY_RETIRE_ACTION), [KEY_RETIRE_ACTION]);
  assert.deepEqual(verifyChain(events, null, K2), {
    ok: true, unkeyed: 0, retiredKeyRows: 3, retiredThroughSeq: 5, retiredBefore: done.event.at,
  });
  assert.equal(await store.appendAuditIfTail!({ seq: 5, hash: events[4]!.hash }, body()), null, 'a stale tail writes nothing');
  assert.equal((await store.listAudit()).length, 6);
});

test('retireAuditKey refuses an edit a database holder re-chained, and records an override when one is given', async () => {
  const store = createMemoryStore();
  store.setAuditMacKey!(K1);
  for (let i = 0; i < 6; i++) await store.appendAudit(body());
  // The memory store hands out its own row objects: editing them edits the log.
  ((await store.listAudit())[2] as { actor: string }).actor = 'user:evil';
  rechainFrom(await store.listAudit(), 2);
  const refused = await retireAuditKey(store, { macKey: K1, reason: 'secret rotation' });
  assert.deepEqual([refused.status, refused.written, refused.currentSeq, refused.badSeq], ['interleaved', false, 1, 3]);
  assert.equal((await store.listAudit()).length, 6);
  assert.equal((await auditHead(store, K1)).chainIntact, false, 'still reported broken');

  const late = createMemoryStore();
  await rotatedStore(late, K1, K2);
  late.setAuditMacKey!(K1);
  await late.appendAudit(body()); // a host not yet switched
  late.setAuditMacKey!(K2);
  await late.appendAudit(body('auth.login'));
  const overridden = await retireAuditKey(late, { macKey: K2, reason: 'secret rotation', allowInterleaved: true });
  assert.equal(overridden.written, true);
  if (!overridden.written) return;
  assert.equal(overridden.event.payload?.allowInterleaved, true);
  assert.equal(overridden.event.payload?.noWitness, undefined);
  assert.equal(overridden.after.ok, true);
});

test('retireAuditKey refuses a store that cannot MAC rows', async () => {
  const store = createMemoryStore();
  delete (store as { setAuditMacKey?: unknown }).setAuditMacKey;
  await assert.rejects(retireAuditKey(store, { macKey: K2, reason: 'x' }), /cannot MAC audit rows/);
  const noConditional = createMemoryStore();
  delete (noConditional as { appendAuditIfTail?: unknown }).appendAuditIfTail;
  await assert.rejects(retireAuditKey(noConditional, { macKey: K2, reason: 'x' }), /append on a known tail/);
});

// ── over HTTP: the head the console and `lw audit head` read ────────────────

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

test('GET /api/v1/audit/head reports a retired-key boundary as intact, with the count and the date', async () => {
  const { parseConfig } = await import('../server/src/config/instance.ts');
  const { createMemoryBlobStore } = await import('../server/src/blobs/memory.ts');
  const { buildApp } = await import('../server/src/api/app.ts');
  const pack = await mkdtemp(join(tmpdir(), 'lw-retire-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const store = createMemoryStore();
  // History written under the old secret, then a boot on the new one (main.ts
  // installs the key derived from the session secret).
  store.setAuditMacKey!(deriveAuditMacKey('old-session-secret'));
  for (let i = 0; i < 3; i++) await store.appendAudit(body());
  store.setAuditMacKey!(deriveAuditMacKey('new-session-secret'));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Retire Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'new-session-secret', link: 'l' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  const session = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  assert.ok(session, `dev sign-in answered ${login.status} without a session`);
  const cookie = session.split(';')[0]!;
  const head = async () => (await fetch(`${base}/api/v1/audit/head`, { headers: { cookie } })).json() as Promise<Record<string, unknown>>;

  const before = await head();
  assert.equal(before.chainIntact, false);
  assert.equal(before.badSeq, 1);

  const done = await retireAuditKey(store, { macKey: deriveAuditMacKey('new-session-secret'), reason: 'secret rotation 2026-10-04' });
  assert.equal(done.written, true);
  const afterRetire = await head();
  assert.equal(afterRetire.chainIntact, true);
  assert.equal(afterRetire.retiredKeyRows, 3);
  assert.equal(afterRetire.retiredBefore, done.written ? done.event.at : null);
  assert.equal('badSeq' in afterRetire, false);
});

// ── the operator command, against Postgres ──────────────────────────────────

const pgUrl = process.env.LW_TEST_DATABASE_URL;
const skipPg = !pgUrl && 'set LW_TEST_DATABASE_URL to run';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

/** Run an entry point with only the variables it is meant to see. */
async function command(file: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [join(ROOT, file), ...args], { env: { PATH: process.env.PATH ?? '', ...env }, cwd: ROOT });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('retireAuditKey on the Postgres store: dry run, write, verify, idempotent', { skip: skipPg }, async () => {
  await withFreshPostgres(pgUrl!, exerciseRetire);
});

test('scripts/audit-retire-key.ts and `lw audit retire-key` write one boundary on Postgres', { skip: skipPg }, async () => {
  const oldSecret = 'old-session-secret-0123456789abcdef';
  const newSecret = 'new-session-secret-0123456789abcdef';
  await withFreshPostgres(pgUrl!, async (store) => {
    await rotatedStore(store, deriveAuditMacKey(oldSecret), deriveAuditMacKey(newSecret));
    const env = { DATABASE_URL: pgUrl!, LW_SESSION_SECRET: newSecret };

    const noSecret = await command('scripts/audit-retire-key.ts', ['--reason', 'x'], { DATABASE_URL: pgUrl! });
    assert.equal(noSecret.code, 1);
    assert.match(noSecret.stderr, /LW_SESSION_SECRET is not set/);
    const noReason = await command('scripts/audit-retire-key.ts', [], env);
    assert.equal(noReason.code, 1);
    assert.match(noReason.stderr, /reason is required/);

    const lastOld = (await store.listAudit())[2]!;
    const dry = await command('cli/lw.ts', ['audit', 'retire-key', '--reason', 'secret rotation 2026-10-04', '--dry-run',
      '--expect-head', `${lastOld.seq}:${lastOld.hash}`], env);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /dry run: would retire 3 rows \(#1 to #3\)/);
    assert.match(dry.stdout, /the head recorded before the rotation still has its hash; 0 of these rows came after it/);
    assert.match(dry.stdout, /1 later row verify under this key/);
    assert.equal((await store.listAudit()).length, 4);

    const wrote = await command('scripts/audit-retire-key.ts', ['--reason', 'secret rotation 2026-10-04', '--json'], env);
    assert.equal(wrote.code, 0, wrote.stderr);
    const result = JSON.parse(wrote.stdout) as { status: string; written: boolean; event: AuditEvent; after: { ok: boolean } };
    assert.deepEqual([result.status, result.written, result.event.seq, result.after.ok], ['retire', true, 5, true]);
    for (const out of [dry.stdout, dry.stderr, wrote.stdout, wrote.stderr]) {
      assert.ok(!out.includes(newSecret) && !out.includes(deriveAuditMacKey(newSecret)), 'no secret or derived key is printed');
    }

    const head = await auditHead(store, deriveAuditMacKey(newSecret));
    assert.equal(head.chainIntact, true);
    assert.equal(head.retiredKeyRows, 3);
    assert.equal(head.seq, 5);

    const again = await command('cli/lw.ts', ['audit', 'retire-key', '--reason', 'secret rotation 2026-10-04'], env);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /nothing to retire/);
    assert.equal((await store.listAudit()).length, 5);

    // Under the OLD secret, rows 1-3 verify and the later ones do not: the
    // command refuses instead of writing a boundary the server would ignore.
    const stale = await command('scripts/audit-retire-key.ts', ['--reason', 'wrong host', '--dry-run'], { DATABASE_URL: pgUrl!, LW_SESSION_SECRET: oldSecret });
    assert.equal(stale.code, 2, stale.stderr);
    assert.match(stale.stdout, /refusing: row #1 verifies under the current key but the later row #4 does not/);
  });
});

/** The database holder's way past the append-only trigger: the retention
 *  trim's own setting admits a DELETE, and re-chained rows go back in. */
async function rewriteOnPostgres(url: string, rows: AuditEvent[], fromSeq: number): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("set local lolly_work.audit_trim = 'on'");
    await client.query('delete from audit_log where seq >= $1', [fromSeq]);
    for (const r of rows.filter((e) => e.seq >= fromSeq)) {
      await client.query(
        'insert into audit_log (seq, at, actor, action, subject, payload, prev_hash, hash, mac) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)',
        [r.seq, r.at, r.actor, r.action, r.subject, r.payload ? JSON.stringify(r.payload) : null, r.prevHash, r.hash, r.mac ?? null],
      );
    }
    await client.query('commit');
  } finally {
    await client.end();
  }
}

test('on Postgres, the command refuses an edit a database holder re-chained, with no rotation at all', { skip: skipPg }, async () => {
  const secret = 'only-session-secret-0123456789abcdef';
  await withFreshPostgres(pgUrl!, async (store) => {
    store.setAuditMacKey!(deriveAuditMacKey(secret));
    for (let i = 0; i < 6; i++) await store.appendAudit(body());
    const rows = await store.listAudit();
    (rows[2] as { actor: string }).actor = 'user:evil';
    await rewriteOnPostgres(pgUrl!, rechainFrom(rows, 2), 3);
    assert.equal((await auditHead(store, deriveAuditMacKey(secret))).badSeq, 3);

    const res = await command('scripts/audit-retire-key.ts', ['--reason', 'secret rotation 2026-10-04'], { DATABASE_URL: pgUrl!, LW_SESSION_SECRET: secret });
    assert.equal(res.code, 2, res.stderr);
    assert.match(res.stdout, /refusing: row #1 verifies under the current key but the later row #3 does not/);
    assert.equal((await store.listAudit()).length, 6, 'nothing written');
    assert.equal((await auditHead(store, deriveAuditMacKey(secret))).chainIntact, false);
  });
});

test('on Postgres, the head recorded before a rotation catches an edit made before retire-key ran', { skip: skipPg }, async () => {
  const oldSecret = 'old-session-secret-0123456789abcdef';
  const newSecret = 'new-session-secret-0123456789abcdef';
  await withFreshPostgres(pgUrl!, async (store) => {
    store.setAuditMacKey!(deriveAuditMacKey(oldSecret));
    for (let i = 0; i < 4; i++) await store.appendAudit(body());

    // Before the rotation, in the container that still has the old secret.
    const before = await command('scripts/audit-head.ts', ['--json'], { DATABASE_URL: pgUrl!, LW_SESSION_SECRET: oldSecret });
    assert.equal(before.code, 0, before.stderr);
    const head = JSON.parse(before.stdout) as { seq: number; hash: string; chainIntact: boolean; linksIntact: boolean; keyChecked: boolean };
    assert.deepEqual([head.seq, head.chainIntact, head.linksIntact, head.keyChecked], [4, true, true, true]);
    assert.ok(!before.stdout.includes(oldSecret) && !before.stdout.includes(deriveAuditMacKey(oldSecret)));

    // Row 2 edited and re-chained, then the server restarts on the new secret
    // and writes on top. Without the head this looks like a plain key change.
    const rows = await store.listAudit();
    (rows[1] as { actor: string }).actor = 'user:evil';
    await rewriteOnPostgres(pgUrl!, rechainFrom(rows, 1), 2);
    store.setAuditMacKey!(deriveAuditMacKey(newSecret));
    await store.appendAudit(body('auth.login'));
    const env = { DATABASE_URL: pgUrl!, LW_SESSION_SECRET: newSecret };

    const now = await command('scripts/audit-head.ts', ['--json'], env);
    assert.equal(now.code, 2);
    assert.deepEqual((({ chainIntact, linksIntact }) => [chainIntact, linksIntact])(JSON.parse(now.stdout) as { chainIntact: boolean; linksIntact: boolean }), [false, true]);
    const blind = await command('scripts/audit-retire-key.ts', ['--reason', 'secret rotation 2026-10-04', '--dry-run'], env);
    assert.match(blind.stdout, /dry run: would retire 4 rows/);
    assert.match(blind.stdout, /no --expect-head given/);

    const pinned = await command('scripts/audit-retire-key.ts', ['--reason', 'secret rotation 2026-10-04', '--expect-head', `${head.seq}:${head.hash}`], env);
    assert.equal(pinned.code, 2, pinned.stderr);
    assert.match(pinned.stdout, /refusing: row #4 is gone or no longer has the hash given with --expect-head/);
    assert.equal((await store.listAudit()).length, 5, 'nothing written');
    const bad = await command('scripts/audit-retire-key.ts', ['--reason', 'x', '--expect-head', 'latest'], env);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--expect-head takes <seq>:<hash>/);
  });
});

test('on Postgres, two retire-key runs at once write one boundary and no stray row', { skip: skipPg }, async () => {
  await withFreshPostgres(pgUrl!, async (store) => {
    await rotatedStore(store, K1, K2);
    const { createPostgresStore } = await import('../server/src/store/postgres.ts');
    const [s1, s2] = await Promise.all([createPostgresStore(pgUrl!), createPostgresStore(pgUrl!)]);
    try {
      const [a, b] = await Promise.all([
        retireAuditKey(s1, { macKey: K2, reason: 'rotation a' }),
        retireAuditKey(s2, { macKey: K2, reason: 'rotation b' }),
      ]);
      assert.deepEqual([a.written, b.written].sort(), [false, true]);
      assert.equal((a.written ? b : a).status, 'current');
      const rows = await store.listAudit();
      assert.deepEqual(rows.map((e) => e.action).filter((x) => x === KEY_RETIRE_ACTION), [KEY_RETIRE_ACTION]);
      assert.equal(rows.length, 5);
      assert.equal(verifyChain(rows, await store.getAuditAnchor(), K2).ok, true);
      // The conditional append itself: a stale tail writes nothing.
      assert.equal(await s1.appendAuditIfTail!({ seq: 4, hash: rows[3]!.hash }, body()), null);
      assert.equal((await store.listAudit()).length, 5);
    } finally {
      await s1.close();
      await s2.close();
    }
  });
});
