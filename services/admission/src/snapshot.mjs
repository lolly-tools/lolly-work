// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { counterKind, requireCondition } from './protocol.mjs';

export const MAX_COUNTERS = 20004;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const SNAPSHOT_LUA = [
  "local t=redis.call('TIME')",
  'local r={t}',
  'for i,k in ipairs(KEYS) do',
  "local kind=redis.call('TYPE',k).ok",
  "if kind~='string' and kind~='none' then return redis.error_reply('invalid counter type') end",
  "local v=redis.call('GET',k)",
  "local p=redis.call('PEXPIRETIME',k)",
  'r[#r+1]={v or false,p}',
  'end',
  "r[#r+1]=redis.call('TIME')",
  'return r',
].join('\n');

// Validate the whole input and empty destination before any write. Redis runs
// this bounded script without interleaving another client's commands. OOM or a
// storage error can still leave partial writes: never activate a failed import.
export const IMPORT_LUA = [
  "if redis.call('DBSIZE')~=0 then return redis.error_reply('destination not empty') end",
  "local t=redis.call('TIME')",
  'local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)',
  'for i,k in ipairs(KEYS) do',
  'local v=ARGV[(i-1)*2+1];local ds=ARGV[(i-1)*2+2];local d=tonumber(ds)',
  "if not v or not string.match(v,'^%d+$') or (#v>1 and string.sub(v,1,1)=='0') or #v>19 or (#v==19 and v>'9223372036854775807') or not ds or not string.match(ds,'^[1-9]%d*$') or #ds>16 or not d or d>9007199254740991 or d~=math.floor(d) then return redis.error_reply('invalid snapshot') end",
  'end',
  'local imported=0;local expired=0',
  'for i,k in ipairs(KEYS) do',
  'local ds=ARGV[(i-1)*2+2];local d=tonumber(ds)',
  "if d>now then redis.call('SET',k,ARGV[(i-1)*2+1],'PXAT',ds,'NX');imported=imported+1 else expired=expired+1 end",
  'end',
  'return {imported,expired}',
].join('\n');

function exactKeys(value, keys) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','));
}

export function validateSnapshot(snapshot, now = Date.now()) {
  exactKeys(snapshot, ['version', 'sourceHost', 'capturedAtMs', 'exportedAtMs', 'quiescenceSha256', 'records']);
  requireCondition(snapshot.version === 1 && typeof snapshot.sourceHost === 'string' && snapshot.sourceHost &&
    /^[a-f0-9]{64}$/.test(snapshot.quiescenceSha256));
  requireCondition(Number.isSafeInteger(snapshot.capturedAtMs) && Number.isSafeInteger(snapshot.exportedAtMs) &&
    Math.abs(snapshot.capturedAtMs - snapshot.exportedAtMs) <= 1000 &&
    now >= snapshot.exportedAtMs - 1000 && now - snapshot.exportedAtMs <= 300_000);
  requireCondition(Array.isArray(snapshot.records) && snapshot.records.length <= MAX_COUNTERS);
  const seen = new Set();
  for (const record of snapshot.records) {
    exactKeys(record, ['key', 'value', 'expiresAtMs']);
    const kind = counterKind(record.key);
    requireCondition(kind && !seen.has(record.key)); seen.add(record.key);
    requireCondition(typeof record.value === 'string' && /^(0|[1-9][0-9]*)$/.test(record.value) &&
      record.value.length <= 19 && BigInt(record.value) <= 9223372036854775807n);
    requireCondition(kind !== 'rate' || record.value !== '0');
    requireCondition(Number.isSafeInteger(record.expiresAtMs) && record.expiresAtMs > snapshot.capturedAtMs &&
      record.expiresAtMs - snapshot.capturedAtMs <= (kind === 'rate' ? 86_400_000 : 172_800_000));
  }
  return snapshot;
}

export function parseSnapshotReply(keys, reply, metadata) {
  requireCondition(Array.isArray(reply) && reply.length === keys.length + 2);
  const timeMs = value => {
    requireCondition(Array.isArray(value) && value.length === 2 &&
      value.every(v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)));
    const seconds = Number(value[0]), micros = Number(value[1]);
    const ms = seconds * 1000 + Math.floor(micros / 1000);
    requireCondition(Number.isSafeInteger(seconds) && Number.isSafeInteger(micros) &&
      micros < 1_000_000 && Number.isSafeInteger(ms) && ms > 0);
    return ms;
  };
  const beforeMs = timeMs(reply[0]);
  const capturedAtMs = timeMs(reply.at(-1));
  requireCondition(capturedAtMs >= beforeMs && capturedAtMs - beforeMs <= 1000);
  const records = [];
  keys.forEach((key, i) => {
    const entry = reply[i + 1];
    requireCondition(Array.isArray(entry) && entry.length === 2);
    const [value, expiresAtMs] = entry;
    const missing = value === null || value === false;
    if (missing || expiresAtMs === -2) {
      requireCondition(missing && expiresAtMs === -2); return;
    }
    requireCondition(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) &&
      value.length <= 19 && BigInt(value) <= 9223372036854775807n &&
      counterKind(key) && (counterKind(key) !== 'rate' || value !== '0'));
    // PEXPIRETIME is the server's stored deadline. TIME brackets freshness;
    // it never reconstructs or renews an expiry from a sampled relative TTL.
    requireCondition(Number.isSafeInteger(expiresAtMs) && expiresAtMs > 0);
    if (expiresAtMs <= capturedAtMs) return;
    records.push({ key, value, expiresAtMs });
  });
  return validateSnapshot({ version: 1, ...metadata, capturedAtMs, records });
}

export function importArguments(snapshot) {
  return { keys: snapshot.records.map(r => r.key),
    arguments: snapshot.records.flatMap(r => [r.value, String(r.expiresAtMs)]) };
}

export async function sourceSnapshot({ command, sourceHost, quiescenceSha256, now = () => Date.now() }) {
  const started = Date.now();
  const keys = new Set();
  for (const match of ['lolly:rl:*', 'lolly:budget:mcp:*']) {
    let cursor = '0', pages = 0;
    do {
      requireCondition(Date.now() - started <= 30000);
      const reply = await command(['SCAN', cursor, 'MATCH', match, 'COUNT', '1000']);
      requireCondition(Array.isArray(reply) && reply.length === 2 && Array.isArray(reply[1]) &&
        /^(0|[1-9][0-9]*)$/.test(String(reply[0])) && ++pages <= 1000);
      cursor = String(reply[0]);
      for (const key of reply[1]) {
        requireCondition(counterKind(key)); keys.add(key);
        requireCondition(keys.size <= MAX_COUNTERS);
      }
    } while (cursor !== '0');
  }
  const sorted = [...keys].sort();
  requireCondition(Date.now() - started <= 30000);
  const reply = await command(['EVAL', SNAPSHOT_LUA, String(sorted.length), ...sorted]);
  return parseSnapshotReply(sorted, reply, { sourceHost, exportedAtMs: now(), quiescenceSha256 });
}
