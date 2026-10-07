import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { makeHandler } from '../src/http.mjs';
import { RATE_LUA, BUDGET_LUA } from '../src/protocol.mjs';

const tokens = { mcp: 'm'.repeat(40), ca: 'c'.repeat(40) };
const rate = ['EVAL', RATE_LUA, '1', 'lolly:rl:' + 'a'.repeat(64), '1000'];
async function server(t, options = {}) {
  const s = createServer(makeHandler({ tokens, ready: () => true, execute: async () => [1, 1000], ...options }));
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); }));
  return `http://127.0.0.1:${s.address().port}`;
}
const request = (url, token = tokens.mcp, body = rate, headers = {}) => fetch(url + '/', {
  method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('credentials must be distinct and sufficiently long', () => {
  for (const bad of [{ mcp: 'short', ca: tokens.ca }, { mcp: tokens.mcp, ca: tokens.mcp }]) {
    assert.throws(() => makeHandler({ tokens: bad }));
  }
});
test('authenticated existing wire response and credential-free probes', async t => {
  const url = await server(t);
  const r = await request(url); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { result: [1, 1000] });
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(url + '/readyz')).status, 200);
  assert.equal((await fetch(url + '/livez')).status, 200);
  assert.equal((await fetch(url + '/')).status, 404);
});
test('unauthorized, malformed and oversized bodies cannot execute Redis', async t => {
  let calls = 0;
  const url = await server(t, { execute: async () => { calls++; } });
  assert.equal((await request(url, 'wrong')).status, 401);
  assert.equal((await request(url, tokens.mcp, ['GET', 'private:secret'])).status, 400);
  assert.equal((await request(url, tokens.mcp, rate, { 'content-type': 'text/plain' })).status, 415);
  const r = await request(url, tokens.mcp, ['x'.repeat(5000)]).catch(() => null);
  assert.ok(!r || r.status === 413); assert.equal(calls, 0);
});
test('CA authorization cannot invoke budget script or read totals', async t => {
  const url = await server(t);
  const c = 'lolly:budget:mcp:2026-10-07:cpu-ms', e = c.slice(0, -6) + 'egress-bytes';
  assert.equal((await request(url, tokens.ca, ['MGET', c, e])).status, 400);
  assert.equal((await request(url, tokens.ca, ['EVAL', BUDGET_LUA, '2', c, e, '1', '1', '172800'])).status, 400);
});
test('store errors and unreadiness fail closed without exposing error contents', async t => {
  const url = await server(t, { execute: async () => { throw new Error('redis://password@host/private'); } });
  const r = await request(url); assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'store-unavailable' }); assert.equal(r.headers.get('retry-after'), '1');
  const down = await server(t, { ready: () => false });
  assert.equal((await request(down)).status, 503); assert.equal((await fetch(down + '/readyz')).status, 503);
  assert.equal((await fetch(down + '/livez')).status, 200);
});
test('timed-out increments never retry and unresolved commands retain bounded slots', async t => {
  let resolve, calls = 0;
  const pending = new Promise(r => { resolve = r; });
  const url = await server(t, { maxActive: 1, timeoutMs: 10, execute: () => { calls++; return pending; } });
  assert.equal((await request(url)).status, 503);
  assert.equal((await request(url)).status, 503); assert.equal(calls, 1);
  resolve([1, 1000]); await new Promise(r => setImmediate(r));
  assert.equal((await request(url)).status, 200); assert.equal(calls, 2);
});
