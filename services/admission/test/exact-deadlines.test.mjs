// Exact-deadline regression fixtures. No Redis, provider or other live calls.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  IMPORT_LUA, SNAPSHOT_LUA, importArguments, parseSnapshotReply,
  sourceSnapshot, validateSnapshot,
} from '../src/snapshot.mjs';

const rate = 'lolly:rl:' + 'b'.repeat(64);
const int64 = '9223372036854775807';
const time = ms => [String(Math.floor(ms / 1000)), String(ms % 1000 * 1000)];

function fixture() {
  const capturedAtMs = Date.now();
  return {
    capturedAtMs, beforeMs: capturedAtMs - 37, deadline: capturedAtMs + 5000,
    metadata: { sourceHost: 'synthetic.example.invalid', exportedAtMs: capturedAtMs,
      quiescenceSha256: 'c'.repeat(64) },
  };
}

function reply(f, entries, before = f.beforeMs, after = f.capturedAtMs) {
  return [time(before), ...entries, time(after)];
}

test('biased TIME and hypothetical PTTL cannot alter the exact PEXPIRETIME deadline', () => {
  const f = fixture();
  const early = parseSnapshotReply([rate], reply(f, [['123', f.deadline]]), f.metadata);
  const later = parseSnapshotReply([rate], reply(f, [['123', f.deadline]], f.capturedAtMs - 2), f.metadata);
  assert.equal(early.capturedAtMs, f.capturedAtMs);
  assert.equal(later.capturedAtMs, f.capturedAtMs);
  assert.equal(early.records[0].expiresAtMs, f.deadline);
  assert.deepEqual(early.records, later.records);
  // The old TIME-before + PTTL observation could differ by37ms. The parser
  // accepts only the exact expiry returned by Redis, with no inferred TTL.
  assert.notEqual(f.beforeMs + (f.deadline - f.capturedAtMs), f.deadline);
  assert.match(SNAPSHOT_LUA, /redis\.call\('PEXPIRETIME',\s*k\)/);
  assert.doesNotMatch(SNAPSHOT_LUA, /redis\.call\('PTTL'/);
  assert.ok((SNAPSHOT_LUA.match(/redis\.call\('TIME'\)/g) ?? []).length >= 2);
});

test('snapshot Lua type-checks each key before reading a counter value', () => {
  const type = SNAPSHOT_LUA.indexOf("redis.call('TYPE',k)");
  const get = SNAPSHOT_LUA.indexOf("redis.call('GET',k)");
  assert.ok(type >= 0 && type < get);
  assert.match(SNAPSHOT_LUA, /string/);
  assert.match(SNAPSHOT_LUA, /none/);
  assert.match(SNAPSHOT_LUA, /redis\.error_reply/);
});

test('missing rows require both a missing value and Redis missing-expiry sentinel', () => {
  const f = fixture();
  for (const missing of [false, null]) {
    assert.deepEqual(parseSnapshotReply([rate], reply(f, [[missing, -2]]), f.metadata).records, []);
  }
  for (const malformed of [['1', -2], [false, f.deadline], [null, f.deadline], [false, -1], [null, -1]]) {
    assert.throws(() => parseSnapshotReply([rate], reply(f, [malformed]), f.metadata));
  }
});

test('persistent or malformed expiry rows refuse migration instead of acquiring a new window', () => {
  const f = fixture();
  for (const expiry of [-1, -2, 0, '5000', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseSnapshotReply([rate], reply(f, [['1', expiry]]), f.metadata));
  }
});

test('keys expired between the bracketed reads are omitted without deadline renewal', () => {
  const f = fixture();
  for (const expiry of [f.beforeMs - 1, f.beforeMs, f.capturedAtMs - 1, f.capturedAtMs]) {
    const value = parseSnapshotReply([rate], reply(f, [['1', expiry]]), f.metadata);
    assert.deepEqual(value.records, []);
  }
  const value = parseSnapshotReply([rate], reply(f, [['1', f.capturedAtMs + 1]]), f.metadata);
  assert.equal(value.records[0].expiresAtMs, f.capturedAtMs + 1);
});

test('counter strings preserve int64 high waters through exact absolute import arguments', () => {
  const f = fixture();
  const snapshot = parseSnapshotReply([rate], reply(f, [[int64, f.deadline]]), f.metadata);
  assert.equal(snapshot.records[0].value, int64);
  assert.equal(validateSnapshot(snapshot), snapshot);
  assert.deepEqual(importArguments(snapshot), { keys: [rate], arguments: [int64, String(f.deadline)] });
  for (const value of ['9223372036854775808', '0001', '-1', '1.0', 123, {}, []]) {
    assert.throws(() => parseSnapshotReply([rate], reply(f, [[value, f.deadline]]), f.metadata));
  }
});

test('import Lua validates all rows before writing absolute PXAT deadlines', () => {
  const set = IMPORT_LUA.indexOf("redis.call('SET'");
  assert.ok(IMPORT_LUA.indexOf("redis.call('DBSIZE')") < set);
  assert.ok(IMPORT_LUA.indexOf("redis.error_reply('invalid snapshot')") < set);
  assert.match(IMPORT_LUA, /'PXAT'/);
  assert.match(IMPORT_LUA, /'NX'/);
  assert.doesNotMatch(IMPORT_LUA, /'PX',/);
  assert.doesNotMatch(IMPORT_LUA, /ttl|d\s*-\s*now/);
  assert.doesNotMatch(IMPORT_LUA, /tonumber\(v\)/);
});

test('malformed or reversed TIME brackets refuse the snapshot', () => {
  const f = fixture();
  const variants = [
    [time(f.capturedAtMs + 1), ['1', f.deadline], time(f.capturedAtMs)],
    [['invalid', '0'], ['1', f.deadline], time(f.capturedAtMs)],
    [time(f.beforeMs), ['1', f.deadline], ['1', '1000000']],
    [time(f.beforeMs), ['1', f.deadline]],
  ];
  for (const value of variants) {
    assert.throws(() => parseSnapshotReply([rate], value, f.metadata));
  }
});

test('mocked source commands return exact deadlines and only one atomic read', async () => {
  const f = fixture();
  const calls = [];
  const command = async body => {
    calls.push(body);
    if (body[0] === 'SCAN') return ['0', body[3] === 'lolly:rl:*' ? [rate, rate] : []];
    assert.deepEqual(body, ['EVAL', SNAPSHOT_LUA, '1', rate]);
    return reply(f, [[int64, f.deadline]]);
  };
  const snapshot = await sourceSnapshot({ command, ...f.metadata, now: () => f.metadata.exportedAtMs });
  assert.equal(calls.length, 3);
  assert.deepEqual(snapshot.records, [{ key: rate, value: int64, expiresAtMs: f.deadline }]);
  assert.deepEqual(importArguments(snapshot).arguments, [int64, String(f.deadline)]);
});

test('foreign source keys are rejected before issuing the atomic read', async () => {
  const calls = [];
  await assert.rejects(sourceSnapshot({
    command: async body => { calls.push(body); return ['0', ['foreign:key']]; },
    sourceHost: 'synthetic.example.invalid', quiescenceSha256: 'c'.repeat(64),
  }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'SCAN');
});
