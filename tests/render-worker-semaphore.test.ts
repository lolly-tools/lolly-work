/**
 * The render worker's hand-rolled counting semaphore (plans/22 §5, plans/23
 * §3.C) - the only concurrency guard between one Chromium and unbounded
 * `browser.newContext()` calls. Pure, no HTTP, no browser: exercises limit
 * enforcement, FIFO release order, and the no-leak-on-throw guarantee that
 * `run()` exists to provide.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSemaphore } from '../workers/render/src/semaphore.ts';

test('tryAcquire enforces the configured limit and refuses once capacity is exhausted', () => {
  const sem = createSemaphore(2);
  const r1 = sem.tryAcquire();
  const r2 = sem.tryAcquire();
  assert.ok(r1 && r2, 'both permits within the limit are granted');
  assert.equal(sem.atCapacity, true);
  assert.equal(sem.tryAcquire(), null, 'a third caller finds no permit free — no queueing from tryAcquire');
  r1();
  assert.equal(sem.atCapacity, false, 'releasing one permit frees capacity immediately');
  assert.ok(sem.tryAcquire(), 'the released permit is available to a new caller');
});

test('releasing a permit twice is a no-op — it never hands out a second permit', () => {
  const sem = createSemaphore(1);
  const release = sem.tryAcquire();
  assert.ok(release);
  release();
  release(); // double release must not create phantom capacity
  assert.equal(sem.inUse, 0);
  assert.ok(sem.tryAcquire(), 'first re-acquire after release succeeds');
  assert.equal(sem.tryAcquire(), null, 'limit is still 1 — the double release did not grant an extra permit');
});

test('acquire() serves queued waiters in FIFO order as permits free up', async () => {
  const sem = createSemaphore(1);
  const first = await sem.acquire(); // takes the only permit; nothing left to hand out

  // Each acquire() call below synchronously joins the wait line (the semaphore
  // is at capacity the instant it's called), so pushing order == FIFO order,
  // deterministically - no sleeps needed to pin this down.
  const order: number[] = [];
  const p1 = sem.acquire().then((release) => { order.push(1); return release; });
  const p2 = sem.acquire().then((release) => { order.push(2); return release; });
  const p3 = sem.acquire().then((release) => { order.push(3); return release; });
  assert.equal(sem.waiting, 3, 'all three callers are queued, none jumped ahead');

  first(); // free the held permit - the longest-waiting caller (1) should get it next
  const release1 = await p1;
  assert.deepEqual(order, [1]);

  release1();
  const release2 = await p2;
  assert.deepEqual(order, [1, 2], 'the SECOND-longest waiter is served next, not an arbitrary one');

  release2();
  const release3 = await p3;
  assert.deepEqual(order, [1, 2, 3]);

  release3();
  assert.equal(sem.inUse, 0);
  assert.equal(sem.waiting, 0);
});

test('run() releases the permit even when the task rejects, so a thrown render cannot leak capacity', async () => {
  const sem = createSemaphore(1);
  await assert.rejects(
    sem.run(async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(sem.inUse, 0, 'the permit came back despite the throw');
  assert.ok(sem.tryAcquire(), 'capacity is still fully usable after a failed task');
});

test('run() serializes work above the limit — a second task waits for the first to finish', async () => {
  const sem = createSemaphore(1);
  const events: string[] = [];
  let releaseFirst!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = sem.run(async () => {
    events.push('first-start');
    await gate;
    events.push('first-end');
  });
  // Give the first task's synchronous prefix a chance to run and take the permit.
  await Promise.resolve();
  assert.equal(sem.atCapacity, true);

  const second = sem.run(async () => { events.push('second-start'); });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start'], 'second never overlaps first');
});

test('a non-positive-integer limit is rejected at construction', () => {
  assert.throws(() => createSemaphore(0));
  assert.throws(() => createSemaphore(-1));
  assert.throws(() => createSemaphore(1.5));
});
