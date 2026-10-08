import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSnapshotReply, validateSnapshot, importArguments, IMPORT_LUA, SNAPSHOT_LUA, sourceSnapshot } from '../src/snapshot.mjs';

const key = 'lolly:rl:' + 'a'.repeat(64);
function fixture() {
  const now = Date.now();
  return { version: 1, sourceHost: 'store.example.com', capturedAtMs: now, exportedAtMs: now,
    quiescenceSha256: 'a'.repeat(64), records: [{ key, value: '123', expiresAtMs: now + 5000 }] };
}
test('atomic snapshot retains counter strings and original absolute expiry', () => {
  const s = fixture(), time = [String(Math.floor(s.capturedAtMs / 1000)), String((s.capturedAtMs % 1000) * 1000)];
  const parsed = parseSnapshotReply([key], [time, ['123', s.capturedAtMs + 5000], time], {
    sourceHost: s.sourceHost, exportedAtMs: s.exportedAtMs, quiescenceSha256: s.quiescenceSha256,
  });
  assert.deepEqual(parsed, s);
  assert.deepEqual(importArguments(parsed), { keys: [key], arguments: ['123', String(s.capturedAtMs + 5000)] });
  assert.ok(SNAPSHOT_LUA.includes("redis.call('TIME')") && SNAPSHOT_LUA.includes("redis.call('PEXPIRETIME',k)"));
});
test('expired keys are omitted and live keys without TTL refuse migration', () => {
  const s = fixture(), t = [String(Math.floor(s.capturedAtMs / 1000)), String(s.capturedAtMs % 1000 * 1000)];
  const meta = { sourceHost: s.sourceHost, exportedAtMs: s.exportedAtMs, quiescenceSha256: s.quiescenceSha256 };
  assert.equal(parseSnapshotReply([key], [t, [null, -2], t], meta).records.length, 0);
  assert.equal(parseSnapshotReply([key], [t, ['1', s.capturedAtMs], t], meta).records.length, 0);
  assert.throws(() => parseSnapshotReply([key], [t, ['1', -1], t], meta));
});
test('snapshot rejects duplicates, private keys, invalid values, renewed TTLs and extra fields', () => {
  for (const change of [s => s.records.push(s.records[0]), s => s.records[0].key = 'private:secret',
    s => s.records[0].value = '-1', s => s.records[0].value = '9223372036854775808',
    s => s.records[0].value = '0', s => s.records[0].expiresAtMs = s.capturedAtMs + 86_400_001,
    s => s.records[0].value = 123, s => s.extra = 'unexpected']) {
    const s = fixture(); change(s); assert.throws(() => validateSnapshot(s));
  }
});
test('stale snapshots and source/target clock skew refuse import', () => {
  const s = fixture(); assert.throws(() => validateSnapshot(s, s.exportedAtMs + 300001));
  s.capturedAtMs -= 1001; assert.throws(() => validateSnapshot(s));
});
test('64-bit counters are preserved exactly and import protects an empty candidate', () => {
  const s = fixture(); s.records[0].value = '9223372036854775807'; assert.equal(validateSnapshot(s), s);
  assert.ok(IMPORT_LUA.indexOf("redis.call('DBSIZE')") < IMPORT_LUA.indexOf("redis.call('SET'"));
  assert.ok(IMPORT_LUA.includes("'PXAT',ds,'NX'") && !IMPORT_LUA.includes('d-now'));
});

test('source scanning deduplicates keys before one atomic snapshot, and unknown keys refuse', async () => {
  const s = fixture(), calls = [];
  const command = async body => {
    calls.push(body);
    if (body[0] === 'SCAN') return ['0', body[3] === 'lolly:rl:*' ? [key, key] : []];
    const t = [String(Math.floor(s.capturedAtMs / 1000)), String(s.capturedAtMs % 1000 * 1000)];
    return [t, ['123', s.capturedAtMs + 5000], t];
  };
  const value = await sourceSnapshot({ command, sourceHost: s.sourceHost, quiescenceSha256: s.quiescenceSha256, now: () => s.exportedAtMs });
  assert.equal(value.records.length, 1); assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ['EVAL', SNAPSHOT_LUA, '1', key]);
  await assert.rejects(sourceSnapshot({ command: async () => ['0', ['private:key']], sourceHost: s.sourceHost, quiescenceSha256: s.quiescenceSha256 }));
});
