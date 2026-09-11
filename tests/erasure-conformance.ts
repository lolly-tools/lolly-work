/** Exercise the same referential and atomicity rules in memory and PostgreSQL. */
import assert from 'node:assert/strict';
import type { Store } from '../server/src/store/types.ts';
import { createApproval } from '../server/src/approvals/engine.ts';

export async function runErasureConformance(store: Store): Promise<void> {
  const now = new Date().toISOString();
  const user = (sub: string) => store.upsertUserBySub({ sub, email: `${sub}@example.invalid`, groups: [], role: 'member' });
  const keeper = await user('erasure-keeper');
  const project = { id: 'erasure-shared', name: 'Shared', ownerId: keeper.id, visibility: 'private' as const, createdAt: now };
  await store.putProject(project);
  for (const kind of ['projects', 'sessions', 'links', 'approvals', 'messageAcks'] as const) {
    const target = await user(`erasure-${kind}`);
    await store.putEvents([{ at: now, event: 'tool.open', attrs: {}, userId: target.id }]);
    if (kind === 'projects') await store.putProject({ ...project, id: 'erasure-archived', ownerId: target.id, archivedAt: now });
    if (kind === 'sessions') await store.putSession({ id: 'erasure-session', projectId: project.id, toolId: 'test', toolVersion: '1', inputs: {}, meta: {}, createdBy: target.id, updatedBy: keeper.id, rev: 1, updatedAt: now, deletedAt: now });
    if (kind === 'links') await store.putLink({ id: 'erasure-link', kind: 'share', target: { toolId: 'test', params: {} }, exp: 1, createdBy: target.id, createdAt: now, revokedAt: now });
    if (kind === 'approvals') await store.putApproval(createApproval({ id: 'erasure-approval', subjectType: 'asset', subjectRef: 'test', title: 'Test', createdBy: target.id, now, nominees: [], chain: { id: 'erasure-chain', name: 'Test', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' } }));
    if (kind === 'messageAcks') {
      await store.putMessage({ id: 'erasure-message', title: 'Test', kind: 'announcement', severity: 'info', audience: {} });
      await store.ackMessage('erasure-message', target.id);
    }
    const preview = await store.previewUserErasure(target.id);
    assert.equal(preview.references[kind], 1, kind);
    assert.equal(preview.telemetryEvents, 1);
    assert.deepEqual(await store.eraseUserAccount(target.id), { status: 'referenced' }, kind);
    assert.ok(await store.getUser(target.id), `${kind}: identity unchanged`);
    assert.equal((await store.listEvents()).filter((e) => e.userId === target.id).length, 1, `${kind}: telemetry unchanged`);
  }
  const unreferenced = await user('erasure-unreferenced');
  await store.putEvents([{ at: now, event: 'tool.open', attrs: {}, userId: unreferenced.id }]);
  assert.deepEqual(await store.eraseUserAccount(unreferenced.id), { status: 'erased', scrubbed: 1 });
  assert.equal(await store.getUser(unreferenced.id), null);
  assert.equal((await store.listEvents()).some((e) => e.userId === unreferenced.id), false);
  assert.deepEqual(await store.eraseUserAccount(unreferenced.id), { status: 'not-found' });
}
