// SPDX-License-Identifier: MPL-2.0
// These exact scripts are shared by Lolly's existing MCP and CA clients.
export const RATE_LUA = [
  "local n = redis.call('INCR', KEYS[1])",
  "if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end",
  "local ttl = redis.call('PTTL', KEYS[1])",
  'return {n, ttl}',
].join('\n');

export const BUDGET_LUA = [
  "local c = redis.call('INCRBY', KEYS[1], ARGV[1])",
  "local e = redis.call('INCRBY', KEYS[2], ARGV[2])",
  "if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[3]) end",
  "if redis.call('TTL', KEYS[2]) < 0 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end",
  'return {c, e}',
].join('\n');

export function requireCondition(ok) {
  if (!ok) throw new Error('Unsupported admission command');
}

function integer(value, min, max) {
  requireCondition(typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value));
  const n = Number(value);
  requireCondition(Number.isSafeInteger(n) && n >= min && n <= max);
}

export function counterKind(key) {
  if (typeof key !== 'string') return null;
  if (/^lolly:rl:[a-f0-9]{64}$/.test(key)) return 'rate';
  const m = /^lolly:budget:mcp:(\d{4}-\d{2}-\d{2}):(cpu-ms|egress-bytes)$/.exec(key);
  if (m && !Number.isNaN(Date.parse(m[1])) && new Date(m[1]).toISOString().slice(0, 10) === m[1]) return 'budget';
  return null;
}

function budgetKeys(cpu, egress) {
  requireCondition(counterKind(cpu) === 'budget' && cpu.endsWith(':cpu-ms') &&
    egress === cpu.slice(0, -6) + 'egress-bytes');
}

export function parseCommand(body, role) {
  requireCondition(role === 'mcp' || role === 'ca');
  requireCondition(Array.isArray(body) && body.every(v => typeof v === 'string'));
  if (body.length === 5 && body[0] === 'EVAL' && body[1] === RATE_LUA && body[2] === '1') {
    requireCondition(counterKind(body[3]) === 'rate');
    integer(body[4], 1000, 86_400_000);
    return { kind: 'rate', script: RATE_LUA, keys: [body[3]], arguments: [body[4]] };
  }
  requireCondition(role === 'mcp');
  if (body.length === 3 && body[0] === 'MGET') {
    budgetKeys(body[1], body[2]);
    return { kind: 'read-budget', keys: body.slice(1) };
  }
  requireCondition(body.length === 8 && body[0] === 'EVAL' && body[1] === BUDGET_LUA && body[2] === '2');
  budgetKeys(body[3], body[4]);
  integer(body[5], 0, 1_000_000_000_000);
  integer(body[6], 0, 1_000_000_000_000);
  requireCondition(body[7] === '172800');
  return { kind: 'write-budget', script: BUDGET_LUA, keys: body.slice(3, 5), arguments: body.slice(5) };
}

export async function executeCommand(client, command) {
  if (command.kind === 'read-budget') return client.mGet(command.keys);
  return client.eval(command.script, { keys: command.keys, arguments: command.arguments });
}
