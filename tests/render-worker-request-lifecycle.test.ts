import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestLifecycle } from '../workers/render/src/request-lifecycle.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('drain waits for every concurrent callback and refuses new work without removing the router', async () => {
  const requests = new RequestLifecycle(), a = gate(), b = gate();
  requests.setDeadline(Date.now() + 1000);
  const first = requests.track(() => a.promise, async () => assert.fail('existing request must complete'));
  const second = requests.track(() => b.promise, async () => assert.fail('existing request must complete'));
  let finished = false, refused = 0;
  const drained = requests.drain().then(() => { finished = true; });
  await requests.track(async () => assert.fail('new work must not start during drain'), async () => { refused++; });
  a.release(); await first; await tick(); assert.equal(finished, false);
  b.release(); await second; await drained;
  assert.equal(refused, 1); assert.equal(finished, true);
});

test('an ACTIVE failure stays fatal when recorded before or during drain; callbacks themselves always settle', async () => {
  for (const failDuringDrain of [false, true]) {
    const requests = new RequestLifecycle(), held = gate();
    requests.setDeadline(Date.now() + 1000);
    const tracked = requests.track(async () => { if (failDuringDrain) await held.promise; throw new Error('private credential'); }, async () => { throw new Error('abort also failed'); });
    if (!failDuringDrain) await tracked;
    const rejected = assert.rejects(requests.drain(), { message: 'A render request could not be completed.' });
    held.release(); await tracked; await rejected;
    await assert.rejects(requests.failure, { message: 'A render request could not be completed.' });
  }
});

test('pending requests use the remaining export deadline rather than a new full timeout', async () => {
  const requests = new RequestLifecycle();
  requests.setDeadline(Date.now() + 30);
  void requests.track(() => new Promise<void>(() => {}), async () => {});
  await assert.rejects(requests.drain(), { message: 'Render requests did not finish within the export deadline.' });
  requests.close();
});

test('explicit close wakes a drain even when the pending request never settles', async () => {
  const requests = new RequestLifecycle();
  requests.setDeadline(Date.now() + 60_000);
  void requests.track(() => new Promise<void>(() => {}), async () => {});
  const drained = requests.drain();
  requests.close();
  await drained;
  await requests.drain(); // a late completed run cannot reset CLOSING to DRAINING
});

test('closing consumes late fetch/fulfill and WebSocket refusal errors, but starts no new work', async () => {
  const requests = new RequestLifecycle(), held = gate();
  const tracked = requests.track(async () => { await held.promise; throw new Error('response disposed'); }, async () => assert.fail('do not retry after explicit close'));
  requests.close(); held.release(); await tracked;
  let refused = 0;
  await requests.track(async () => assert.fail('no fetch after close'), async () => { refused++; throw new Error('WebSocket closed'); });
  assert.equal(refused, 1);
});
