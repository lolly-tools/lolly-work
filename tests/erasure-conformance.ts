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
  const upload = (id: string, createdBy: string) => ({
    id, projectId: project.id, name: `${id}.png`, size: 3, checksum: 'b'.repeat(64), contentType: 'image/png',
    parts: [{ size: 3, checksum: 'b'.repeat(64) }], asset: {}, createdBy, createdAt: now,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), ready: false,
  });
  const roomy = { projectBudgetBytes: 1e6, instanceBudgetBytes: 1e6, maxPending: 16, maxPendingBytes: 1e6 };
  for (const kind of ['projects', 'sessions', 'links', 'approvals', 'messageAcks', 'projectFiles'] as const) {
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
    if (kind === 'projectFiles') {
      assert.equal(await store.reserveProjectFile(upload('erasure-file', target.id), roomy), 'reserved');
      assert.equal(await store.completeProjectFile('erasure-file'), true);
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

  // An unfinished upload is not a shared reference, but its row still names
  // the account: both drivers refuse until the route has removed it.
  const uploading = await user('erasure-uploading');
  assert.equal(await store.reserveProjectFile(upload('erasure-unfinished', uploading.id), roomy), 'reserved');
  assert.equal((await store.previewUserErasure(uploading.id)).references.projectFiles, 0, 'only ready files are references');
  assert.deepEqual(await store.eraseUserAccount(uploading.id), { status: 'referenced' });
  assert.equal(await store.deleteProjectFile('erasure-unfinished'), true);
  assert.deepEqual(await store.eraseUserAccount(uploading.id), { status: 'erased', scrubbed: 0 });

  // Ownership transfer must persist in the database too. Otherwise an API
  // transfer appears successful but the retained project still blocks erasure.
  const departedOwner = await user('erasure-transferred-owner');
  const transferredProject = { ...project, id: 'erasure-transferred', ownerId: departedOwner.id, archivedAt: now };
  await store.putProject(transferredProject);
  await store.putProject({ ...transferredProject, ownerId: keeper.id });
  assert.equal((await store.getProject(transferredProject.id))?.ownerId, keeper.id);
  assert.equal((await store.previewUserErasure(departedOwner.id)).references.projects, 0);
  assert.deepEqual(await store.eraseUserAccount(departedOwner.id), { status: 'erased', scrubbed: 0 });
  assert.deepEqual(await store.getProject(transferredProject.id), { ...transferredProject, ownerId: keeper.id });

  // Invitations (plans/74): an erased account's accepted invitation would keep
  // admitting the address and keeps the email, so erasure removes it. A row
  // for an address another account still carries is left alone.
  const invited = await user('erasure-invited');
  await store.createInvitation({ id: 'inv_erase', email: invited.email, groups: [], invitedBy: `user:${keeper.id}`, createdAt: now });
  await store.acceptInvitation('inv_erase', invited.id, now);
  await store.createInvitation({ id: 'inv_keep', email: keeper.email, groups: [], invitedBy: `user:${keeper.id}`, createdAt: now });
  assert.deepEqual(await store.eraseUserAccount(invited.id), { status: 'erased', scrubbed: 0 });
  assert.equal(await store.getInvitation('inv_erase'), null, 'the accepted invitation went with the account');
  assert.equal(await store.findActiveInvitation(invited.email), null, 'nothing admits the erased address any more');
  assert.ok(await store.getInvitation('inv_keep'), "another account's invitation is untouched");

  // Linked sign-ins (migration 0039) are the person's own mapping and go with
  // the account, so the identity is free to sign in as someone new.
  const linked = await user('erasure-linked');
  await store.linkIdentity({ identitySub: 'erasure-linked-gh', userId: linked.id, idp: 'gh', email: linked.email, emailVerified: true, linkedAt: now });
  assert.deepEqual(await store.eraseUserAccount(linked.id), { status: 'erased', scrubbed: 0 });
  assert.equal(await store.getUserByIdentity('erasure-linked-gh'), null, 'the linked sign-in went with the account');
  assert.deepEqual(await store.findUsersByVerifiedEmail(linked.email), []);
}
