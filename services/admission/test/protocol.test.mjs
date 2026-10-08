import assert from 'node:assert/strict';
import test from 'node:test';
import { RATE_LUA, BUDGET_LUA, counterKind, parseCommand, executeCommand } from '../src/protocol.mjs';

const key = 'lolly:rl:' + 'a'.repeat(64);
const cpu = 'lolly:budget:mcp:2026-10-07:cpu-ms', bytes = cpu.slice(0, -6) + 'egress-bytes';
const rate = ['EVAL', RATE_LUA, '1', key, '1000'];
const budget = ['EVAL', BUDGET_LUA, '2', cpu, bytes, '12', '42', '172800'];

test('existing rate and MCP budget wire shapes execute exact atomic scripts', async () => {
  const calls = [];
  const client = { eval: async (...a) => { calls.push(a); return [1, 1000]; }, mGet: async a => { calls.push(a); return ['12', '42']; } };
  await executeCommand(client, parseCommand(rate, 'ca'));
  await executeCommand(client, parseCommand(budget, 'mcp'));
  assert.deepEqual(await executeCommand(client, parseCommand(['MGET', cpu, bytes], 'mcp')), ['12', '42']);
  assert.deepEqual(calls[0], [RATE_LUA, { keys: [key], arguments: ['1000'] }]);
  assert.deepEqual(calls[1], [BUDGET_LUA, { keys: [cpu, bytes], arguments: ['12', '42', '172800'] }]);
});

test('CA credentials cannot access daily budgets and only exact scripts are accepted', () => {
  for (const command of [budget, ['MGET', cpu, bytes], ['CONFIG', 'SET', 'maxmemory', '0'],
    ['EVAL', RATE_LUA + '\nreturn 1', '1', key, '1000'], ['GET', key], ['FLUSHALL']]) {
    assert.throws(() => parseCommand(command, 'ca'));
  }
});

test('rate keys, TTL bounds, numeric string encoding and arity fail closed', () => {
  for (const bad of [0, '0', '-1', '999', '86400001', '1e3', '01000', '1000.0']) {
    assert.throws(() => parseCommand([...rate.slice(0, 4), bad], 'mcp'));
  }
  for (const bad of [key + 'x', 'private:password', 'lolly:rl:' + 'A'.repeat(64)]) {
    assert.throws(() => parseCommand([...rate.slice(0, 3), bad, '1000'], 'mcp'));
  }
  assert.throws(() => parseCommand([...rate, 'extra'], 'mcp'));
  assert.throws(() => parseCommand(rate, 'anonymous'));
  assert.throws(() => parseCommand({ command: rate }, 'mcp'));
});

test('daily budget pairs, valid dates, bounds and fixed expiry are enforced', () => {
  assert.equal(counterKind(cpu), 'budget');
  assert.equal(counterKind(cpu.replace('10-07', '02-30')), null);
  assert.throws(() => parseCommand(['MGET', cpu, bytes.replace('10-07', '10-08')], 'mcp'));
  for (const i of [5, 6, 7]) {
    const b = [...budget]; b[i] = i === 7 ? '172801' : '1000000000001';
    assert.throws(() => parseCommand(b, 'mcp'));
  }
  assert.throws(() => parseCommand(['MGET', bytes, cpu], 'mcp'));
});
