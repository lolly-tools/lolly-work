// SPDX-License-Identifier: MPL-2.0
/**
 * The render worker's per-render request budget follows the shell it renders
 * with, and stays a bound (plans/82 M3, W-M3-6). The browser canary in
 * render-request-budget.browser.test.ts renders real tools under it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createShellBudget, requestBudgetFor, shellAppFiles,
  REQUEST_BUDGET_CEILING, REQUEST_BUDGET_FALLBACK, REQUEST_BUDGET_FLOOR, REQUEST_BUDGET_HEADROOM, REQUEST_BUDGET_REFRESH_MS,
} from '../workers/render/src/request-budget.ts';
import { ResponseBudget } from '../workers/render/src/request-delivery.ts';

const precache = (files: number) => JSON.stringify({ version: 'x', groups: { app: Array.from({ length: files }, (_, i) => ({ url: `/_app/c${i}.js`, size: 1 })), ort: [{ url: '/ort/a.wasm' }] } });

test('the budget is the shell\'s app files plus headroom, between the floor and the ceiling', () => {
  assert.equal(requestBudgetFor(2432), 2432 + REQUEST_BUDGET_HEADROOM);
  assert.equal(requestBudgetFor(10), REQUEST_BUDGET_FLOOR, 'never below the old flat budget');
  assert.equal(requestBudgetFor(1_000_000), REQUEST_BUDGET_CEILING, 'a shell cannot lift the bound');
  for (const unreadable of [null, -1, 1.5, Number.NaN]) assert.equal(requestBudgetFor(unreadable), REQUEST_BUDGET_FALLBACK);
  assert.ok(REQUEST_BUDGET_FLOOR <= REQUEST_BUDGET_FALLBACK && REQUEST_BUDGET_FALLBACK <= REQUEST_BUDGET_CEILING);
});

test('only the app group counts', () => {
  assert.equal(shellAppFiles(JSON.parse(precache(3))), 3);
  assert.equal(shellAppFiles({ groups: {} }), null);
  assert.equal(shellAppFiles({ groups: { app: 'no' } }), null);
  assert.equal(shellAppFiles(null), null);
});

test('measured shells fit: a Design rules tool and countdown-timer', () => {
  // Requests one export made, counted in a browser against the Lolly web shell
  // built from main with M3 (2026-11-07), whose precache.json lists 2432 app
  // files. The old flat budget of 512 refused the first and left 6 to spare on
  // the second.
  const budget = requestBudgetFor(2432);
  for (const [tool, requests] of [['Design rules tool (Partner data sheet)', 535], ['countdown-timer', 506]] as const) {
    assert.ok(requests <= budget, `${tool}: ${requests} requests within ${budget}`);
  }
  assert.ok(535 > 512, 'the case that failed before');
});

test('the shell\'s list is read once per interval, one reading at a time', async () => {
  let reads = 0;
  let clock = 0;
  const shell = createShellBudget('http://shell.test', { now: () => clock, fetch: (async (url: string) => {
    reads++;
    assert.equal(url, 'http://shell.test/precache.json');
    return new Response(precache(800), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch });
  assert.deepEqual(await Promise.all([shell.current(), shell.current()]), [1056, 1056]);
  assert.equal(reads, 1, 'concurrent renders share one reading');
  clock += REQUEST_BUDGET_REFRESH_MS - 1;
  assert.equal(await shell.current(), 1056);
  assert.equal(reads, 1);
  clock += 1;
  assert.equal(await shell.current(), 1056);
  assert.equal(reads, 2, 'read again once the interval passes, so a new shell release is followed');
});

test('a failed reading keeps the last good budget, or the fallback when there is none', async () => {
  let clock = 0;
  let answer: () => Response = () => new Response('gone', { status: 404 });
  const reasons: string[] = [];
  const shell = createShellBudget('http://shell.test', { now: () => clock, onFallback: (r) => reasons.push(r), fetch: (async () => answer()) as typeof fetch });
  assert.equal(await shell.current(), REQUEST_BUDGET_FALLBACK);
  assert.deepEqual(reasons, ['the shell answered 404']);
  clock += REQUEST_BUDGET_REFRESH_MS;
  answer = () => new Response(precache(2000));
  assert.equal(await shell.current(), 2256);
  clock += REQUEST_BUDGET_REFRESH_MS;
  answer = () => { throw new Error('down'); };
  assert.equal(await shell.current(), 2256, 'the last good budget');
  clock += REQUEST_BUDGET_REFRESH_MS;
  answer = () => new Response('x', { headers: { 'content-length': String(64 * 1024 * 1024) } });
  assert.equal(await shell.current(), 2256);
  clock += REQUEST_BUDGET_REFRESH_MS;
  answer = () => new Response('{"groups":{}}');
  assert.equal(await shell.current(), 2256);
  assert.deepEqual(reasons.slice(1), ['the file list could not be read', 'the file list is larger than the worker reads', 'the file list has no app files']);
});

test('a response budget refuses the request past its count', () => {
  const budget = new ResponseBudget(undefined, undefined, 2);
  budget.begin(); budget.begin();
  assert.throws(() => budget.begin(), /request count exceeds/);
  const rasterise = new ResponseBudget();
  assert.equal(rasterise.requestCount, REQUEST_BUDGET_FLOOR, 'a rasterise runs no app code and keeps the floor');
});
