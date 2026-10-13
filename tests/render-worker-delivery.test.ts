// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverResponse, ResponseBudget } from '../workers/render/src/request-delivery.ts';

function fixture(status = 200, body = Buffer.from('sample'), headers: Record<string, string> = {}) {
  const calls = { fetched: 0, fulfilled: 0, aborted: 0, disposed: 0, read: 0 };
  const response = {
    status: () => status, headers: () => headers,
    body: async () => { calls.read++; return body; }, dispose: async () => { calls.disposed++; },
  };
  const route = {
    fetch: async (options: { maxRedirects: number; timeout: number }) => {
      assert.equal(options.maxRedirects, 0); assert.ok(options.timeout > 0); calls.fetched++; return response;
    },
    fulfill: async (options: { body: Buffer }) => { assert.equal(options.body, body); calls.fulfilled++; },
    abort: async () => { calls.aborted++; },
  };
  return { route: route as never, calls };
}
const options = { timeout: 1000 };
const signal = () => new AbortController().signal;

test('every redirect response is refused before its body or location is delivered', async () => {
  for (const status of [300, 301, 302, 303, 305, 307, 308]) {
    const f = fixture(status, Buffer.from('sample'), { location: '/next' });
    await deliverResponse(f.route, new ResponseBudget(), signal(), options);
    assert.deepEqual(f.calls, { fetched: 1, fulfilled: 0, aborted: 1, disposed: 1, read: 0 });
  }
});

test('ordinary responses and revision checks finish before response disposal', async () => {
  const f = fixture();
  let verified = false;
  await deliverResponse(f.route, new ResponseBudget(), signal(), { ...options, verify: () => { verified = true; assert.equal(f.calls.fulfilled, 0); } });
  assert.equal(verified, true);
  assert.deepEqual(f.calls, { fetched: 1, fulfilled: 1, aborted: 0, disposed: 1, read: 1 });
});

test('request, declared size, body size and cumulative budgets all reject excess work', async () => {
  const declared = fixture(200, Buffer.from('x'), { 'content-length': '20' });
  await assert.rejects(deliverResponse(declared.route, new ResponseBudget(10), signal(), options), /budget/);
  assert.equal(declared.calls.read, 0);
  assert.equal(declared.calls.disposed, 1);
  const body = fixture(200, Buffer.alloc(11));
  await assert.rejects(deliverResponse(body.route, new ResponseBudget(10), signal(), options), /budget/);
  assert.equal(body.calls.fulfilled, 0);
  const budget = new ResponseBudget(10, 10, 2);
  const a = fixture(200, Buffer.alloc(6));
  await deliverResponse(a.route, budget, signal(), options);
  await assert.rejects(deliverResponse(fixture().route, budget, signal(), options), /budget/);
  const last = fixture();
  await assert.rejects(deliverResponse(last.route, budget, signal(), options), /count/);
  assert.equal(last.calls.fetched, 0);
});
