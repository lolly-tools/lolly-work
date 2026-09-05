import assert from 'node:assert/strict';
import { newRender, parseRenderSpec } from '../server/src/renders/request.ts';
import type { RenderRecord, RenderResult, RenderStore } from '../server/src/renders/types.ts';
import { evidenceFixture } from './render-evidence-fixture.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const output: RenderResult = { name: 'default', ref: 'result/winner', mime: 'image/svg+xml', size: 3, sha256: sha256Hex('svg'), cacheKey: 'key', evidence: evidenceFixture(Buffer.from('svg')) };
const spec = parseRenderSpec({ toolId: 'card', format: 'svg', inputs: { title: 'Hi' } });

export async function runRenderStoreConformance(store: RenderStore): Promise<void> {
  const principal = 'user:render-conformance';
  const first = newRender(principal, spec, 'same');
  const submissions = await Promise.all(Array.from({ length: 8 }, () => store.insertRender(newRender(principal, spec, 'same'))));
  assert.equal(submissions.filter((s) => !s.reused).length, 1, 'one atomic idempotency winner');
  assert.equal(new Set(submissions.map((s) => s.record.id)).size, 1);
  const r = submissions[0]!.record;
  assert.equal(await store.getRender(r.id, 'user:other'), null);
  assert.deepEqual(await store.listRenders('user:other', 100, 0), []);
  const conflict = await store.insertRender({ ...first, requestHash: 'different' });
  assert.equal(conflict.record.requestHash, r.requestHash, 'idempotency conflict never overwrites original');
  r.request.inputs.title = 'mutated';
  assert.equal((await store.getRender(r.id, principal))!.request.inputs.title, 'Hi');

  await store.insertRender(newRender(principal, { ...spec, priority: 9 }));
  const claims = await Promise.all(Array.from({ length: 6 }, () => store.claimRender(10_000)));
  const owned = claims.filter((v): v is RenderRecord => !!v);
  assert.equal(owned.length, 2, 'concurrent replicas claim each request once');
  assert.equal(new Set(owned.map((v) => v.id)).size, 2);
  for (const claim of owned) {
    assert.equal(claim.attempt, 1);
    assert.equal(await store.heartbeatRender(claim.id, 'wrong-token', 10_000), false);
    assert.equal(await store.heartbeatRender(claim.id, claim.leaseToken!, 10_000), true);
    assert.equal(await store.settleRender(claim.id, 'wrong-token', { state: 'succeeded', output }), false);
    assert.equal(await store.settleRender(claim.id, claim.leaseToken!, { state: 'succeeded', output }), true);
    assert.equal(await store.settleRender(claim.id, claim.leaseToken!, { state: 'failed', error: { code: 'OLD', message: 'late' } }), false);
    assert.equal((await store.cancelRender(claim.id, principal))!.state, 'succeeded');
    assert.deepEqual((await store.getRender(claim.id, principal))!.output!.evidence, output.evidence, 'receipt and bytes publish under the same lease');
  }

  const recovering = (await store.insertRender(newRender(principal, spec))).record;
  const abandoned = (await store.claimRender(60))!;
  assert.equal(abandoned.id, recovering.id);
  await delay(90);
  assert.equal(await store.heartbeatRender(abandoned.id, abandoned.leaseToken!, 1_000), false, 'an expired heartbeat cannot resurrect ownership');
  const recovered = (await store.claimRender(10_000))!;
  assert.equal(recovered.id, abandoned.id);
  assert.equal(recovered.attempt, 2);
  assert.notEqual(recovered.leaseToken, abandoned.leaseToken);
  assert.equal(await store.settleRender(abandoned.id, abandoned.leaseToken!, { state: 'succeeded', output: { ...output, ref: 'loser' } }), false);
  assert.equal(await store.settleRender(recovered.id, recovered.leaseToken!, { state: 'succeeded', output }), true);
  assert.equal((await store.getRender(recovered.id, principal))!.output!.ref, 'result/winner');

  const cancelled = (await store.insertRender(newRender(principal, spec))).record;
  assert.equal(await store.cancelRender(cancelled.id, 'user:other'), null);
  assert.equal((await store.cancelRender(cancelled.id, principal))!.state, 'cancelled');
  assert.equal(await store.claimRender(1_000), null, 'cancelled queued work is never executed');
  const active = (await store.insertRender(newRender(principal, spec))).record;
  const activeClaim = (await store.claimRender(1_000))!;
  assert.equal((await store.cancelRender(active.id, principal))!.state, 'cancelled');
  assert.equal(await store.settleRender(active.id, activeClaim.leaseToken!, { state: 'succeeded', output }), false);

  const exhausted = (await store.insertRender(newRender(principal, { ...spec, maxAttempts: 1 }))).record;
  await store.claimRender(30);
  await delay(60);
  assert.equal(await store.claimRender(1_000), null);
  assert.equal((await store.getRender(exhausted.id, principal))!.state, 'failed');
  assert.equal((await store.getRender(exhausted.id, principal))!.error!.code, 'ATTEMPTS_EXHAUSTED');

  const retried = (await store.insertRender(newRender(principal, spec, undefined, exhausted.id))).record;
  const attempt = (await store.claimRender(1_000))!;
  assert.equal(await store.settleRender(attempt.id, attempt.leaseToken!, { state: 'failed', error: { code: 'BUSY', message: 'retry' }, retryAfterMs: 100 }), true);
  assert.equal(await store.claimRender(1_000), null, 'retry backoff is observed');
  await delay(130);
  const next = (await store.claimRender(10_000))!;
  assert.equal(next.id, retried.id); assert.equal(next.attempt, 2);
  await store.settleRender(next.id, next.leaseToken!, { state: 'succeeded', output });
  assert.equal((await store.getRender(retried.id, principal))!.retryOf, exhausted.id);

  const page = await store.listRenders(principal, 2, 0);
  assert.equal(page.length, 2);
  assert.equal((await store.listRenders(principal, 2, 2)).length, 2);
  assert.notEqual(page[0]!.id, (await store.listRenders(principal, 2, 2))[0]!.id);
}
