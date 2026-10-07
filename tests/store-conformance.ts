/**
 * Behavioural conformance suite every Store driver must pass - run against
 * memory always (store-memory.test.ts) and against Postgres when
 * LW_TEST_DATABASE_URL is set (store-postgres.test.ts). One suite, two
 * drivers: the seam stays honest.
 */
import assert from 'node:assert/strict';
import { verifyChain } from '../server/src/audit/chain.ts';
import { createApproval, type Chain } from '../server/src/approvals/engine.ts';
import type { CommentThread } from '@lolly-tools/core/canvas-review-v1';
import type { Message } from '../server/src/inbox/target.ts';
import { COMMENT_NOTICE_COUNT_MAX, commentNoticeId, type CommentNoticeWrite, type Store } from '../server/src/store/types.ts';
import { PROJECT_FILE_OVERHEAD_BYTES, type ProjectFileRecord } from '../server/src/projects/files.ts';
import { runErasureConformance } from './erasure-conformance.ts';

export async function runStoreConformance(store: Store): Promise<void> {
  // users: upsert by sub, re-upsert updates in place
  const u1 = await store.upsertUserBySub({ sub: 's1', email: 'a@x', groups: ['g1'], role: 'member' });
  const u1b = await store.upsertUserBySub({ sub: 's1', email: 'a@x', groups: ['g1', 'g2'], role: 'admin', title: 'Designer' });
  assert.equal(u1b.id, u1.id);
  assert.deepEqual(u1b.groups, ['g1', 'g2']);
  assert.equal((await store.getUserBySub('s1'))?.title, 'Designer');
  assert.equal(await store.getUserBySub('nope'), null);

  // …and by internal id, the shape every stored reference to a user uses
  // (LinkRecord.createdBy, a grant's `user:<id>` principal). Same row, same
  // fields - a driver that answered one of the two getters differently would
  // let the collab gateway's per-gesture inviter check disagree with the console.
  assert.deepEqual(await store.getUser(u1.id), await store.getUserBySub('s1'));
  assert.equal(await store.getUser('usr_nope'), null);

  // By email, case-insensitive, every row: one person can hold a row per IdP.
  const u1other = await store.upsertUserBySub({ sub: 'idp2:s1', email: ' A@X ', groups: [], role: 'member' });
  assert.deepEqual((await store.findUsersByEmail('a@x')).map((u) => u.id).sort(), [u1.id, u1other.id].sort());
  assert.deepEqual(await store.findUsersByEmail('nobody@x'), []);
  assert.deepEqual(await store.findUsersByEmail('  '), []);

  // A deployed role mapping applies to existing identities and paged directory queries.
  store.configureRoleGroups({ owner: ['g1'], viewer: ['g2'] });
  assert.equal((await store.getUser(u1.id))?.role, 'owner');
  assert.equal((await store.getUserBySub('s1'))?.role, 'owner');
  const mappedPage = await store.listUsersPage({ role: 'owner', sort: 'role', dir: 'asc', limit: 10, offset: 0 });
  assert.equal(mappedPage.total, 1); assert.equal(mappedPage.rows[0]?.id, u1.id);
  await store.upsertUserBySub({ sub: 's1', email: 'a@x', groups: ['g2'], role: 'member', title: 'Designer' });
  assert.equal((await store.getUser(u1.id))?.role, 'viewer');
  assert.equal((await store.listUsersPage({ role: 'owner', limit: 10, offset: 0 })).total, 0);
  await store.putLocalGroup({ name: 'g1', createdAt: new Date().toISOString() });
  await store.setLocalGroups(u1.id, ['g1']);
  assert.equal((await store.getUser(u1.id))?.role, 'owner');
  await store.deleteLocalGroup('g1');
  assert.equal((await store.getUser(u1.id))?.role, 'viewer');
  store.configureRoleGroups({});
  await store.upsertUserBySub({ sub: 's1', email: 'a@x', groups: ['g1', 'g2'], role: 'member', title: 'Designer' });

  await store.setTelemetryConsent(u1.id, true);
  assert.equal((await store.getUserBySub('s1'))?.telemetryConsent, true);

  // overlays
  await store.putOverlay({ toolId: 't1', version: 1, visibility: { groups: ['g1'] } });
  assert.equal((await store.listOverlays()).get('t1')?.version, 1);

  // overlay + chain deletion (policy-as-code prune): removes the row; unknown is a no-op
  await store.deleteOverlay('t1');
  assert.equal((await store.listOverlays()).has('t1'), false);
  await store.deleteOverlay('nope');
  await store.putChain({ id: 'tmp-chain', name: 'Tmp', steps: [{ name: 'S', approvers: { groups: ['x'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await store.deleteChain('tmp-chain');
  assert.equal(await store.getChain('tmp-chain'), null);
  await store.deleteChain('nope');

  // feature-flag governance: put round-trips; a no-opinion record clears the row
  await store.putFlagGovernance({ id: 'jelly-effects', default: 'off', visibility: 'hide', updatedAt: new Date().toISOString() });
  assert.equal((await store.listFlagGovernance()).get('jelly-effects')?.visibility, 'hide');
  await store.putFlagGovernance({ id: 'jelly-effects', updatedAt: new Date().toISOString() });
  assert.equal((await store.listFlagGovernance()).has('jelly-effects'), false);

  // schema readiness: both drivers are current when the suite runs (memory always;
  // postgres because the pg test applies every migration before constructing the store).
  assert.deepEqual(await store.pendingMigrations(), []);

  // grants: tuple-identified, put idempotent, delete exact-match only
  const g1 = { principal: 'group:mkt', action: 'export.download', resource: '*', effect: 'deny' as const };
  await store.putGrant(g1);
  await store.putGrant(g1); // idempotent - one row
  await store.putGrant({ ...g1, effect: 'allow' as const }); // different tuple - second row
  assert.equal((await store.listGrants()).filter((g) => g.principal === 'group:mkt').length, 2);
  await store.deleteGrant(g1);
  const remaining = (await store.listGrants()).filter((g) => g.principal === 'group:mkt');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.effect, 'allow', 'exact tuple deleted, near-miss survives');
  await store.deleteGrant({ ...g1, effect: 'allow' as const });

  // links: put/get/revoke round-trip preserving optional fields
  const exp = Math.floor(Date.now() / 1000) + 3600;
  await store.putLink({
    id: 'L1', kind: 'guest-edit', target: { toolId: 't1', params: { a: '1' } }, exp,
    createdBy: u1.id, createdAt: new Date().toISOString(), pwHash: 's1.x.y', projectId: 'p1',
  });
  const link = await store.getLink('L1');
  assert.equal(link?.exp, exp);
  assert.equal(link?.pwHash, 's1.x.y');
  assert.equal(link?.projectId, 'p1');
  assert.deepEqual(link?.target.params, { a: '1' });
  await store.revokeLink('L1', new Date().toISOString());
  assert.ok((await store.getLink('L1'))?.revokedAt);
  assert.equal((await store.listLinksBy(u1.id)).length, 1);
  assert.equal((await store.listAllLinks()).length, 1);
  assert.ok((await store.listUsers()).some((u) => u.sub === 's1'));

  // audit: chain survives the driver round-trip
  await store.appendAudit({ at: new Date().toISOString(), actor: `user:${u1.id}`, action: 'a.one', subject: 's' });
  await store.appendAudit({ at: new Date().toISOString(), actor: `user:${u1.id}`, action: 'a.two', subject: 's', payload: { n: 1 } });
  const audit = await store.listAudit();
  assert.ok(audit.length >= 2);
  assert.deepEqual(verifyChain(audit), { ok: true });
  // Filters apply across the stored history before the page limit, in both drivers.
  const filteredAudit = await store.listAuditBefore(0, 1, { action: 'a.one', actor: `user:${u1.id}` });
  assert.equal(filteredAudit.length, 1);
  assert.equal(filteredAudit[0]?.action, 'a.one');
  assert.equal(await store.countAudit({ action: 'a.one', subject: 's' }), 1);
  assert.equal((await store.listAuditBefore(filteredAudit[0]!.seq, 10, { action: 'a.one' })).length, 0);
  assert.equal(await store.countAudit({ since: '2999-01-01T00:00:00.000Z' }), 0);

  // telemetry
  await store.putEvents([
    { event: 'tool.open', at: new Date().toISOString(), attrs: { toolId: 't1' } },
    { event: 'render.export', at: new Date().toISOString(), userId: u1.id, attrs: { toolId: 't1', format: 'png' } },
  ]);
  const events = await store.listEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.userId, undefined);
  assert.equal(events[1]?.userId, u1.id);
  assert.equal(events[1]?.attrs.format, 'png');

  // messages + acks
  await store.putMessage({ id: 'm1', kind: 'announcement', severity: 'info', audience: {}, title: 'Hello' });
  assert.equal((await store.listMessages()).length, 1);
  await store.ackMessage('m1', u1.id);
  await store.ackMessage('m1', u1.id); // idempotent
  assert.deepEqual([...(await store.acksFor(u1.id))], ['m1']);
  assert.equal((await store.ackCounts()).get('m1'), 1);
  // `data` round-trips, and putMessage upserts BY ID - the whole of the collab
  // invite's idempotence (server/src/collab/invites.ts `inviteMessageId`): a
  // second invite for the same (session, invitee) must refresh one row, not add
  // a second. Absent on a message that never had one (no `data: undefined` key).
  assert.equal(Object.hasOwn((await store.listMessages())[0] as object, 'data'), false);
  const invite: Message = {
    id: 'msg_collab_x', kind: 'collab', severity: 'action',
    audience: { users: [u1.id] }, title: 'Ada invited you to edit Keynote together',
    cta: { label: 'Open', url: 'https://old.example/t/poster?session=ses_1' },
    data: { kind: 'collab-invite', sessionId: 'ses_1' },
    dismissible: true,
  };
  await store.putMessage({ ...invite });
  await store.putMessage({
    ...invite,
    title: 'Bo invited you to edit Keynote together',
    cta: { label: 'Open', url: 'https://new.example/t/poster?session=ses_1' },
    data: { ...invite.data, toolId: 'poster' },
    dismissible: false,
  });
  const invites = (await store.listMessages()).filter((m) => m.id === 'msg_collab_x');
  assert.equal(invites.length, 1, 'putMessage upserts by id — no duplicate invite row');
  assert.equal(invites[0]?.kind, 'collab');
  assert.equal(invites[0]?.title, 'Bo invited you to edit Keynote together');
  assert.deepEqual(invites[0]?.data, { kind: 'collab-invite', sessionId: 'ses_1', toolId: 'poster' });
  // A re-put replaces the WHOLE record in both drivers. `cta` and `dismissible`
  // are asserted because they were the columns a partial `on conflict` SET list
  // silently kept stale - an invite's cta.url is built from `instance.appUrl`,
  // so a driver that skipped it would serve a link to the instance's old host.
  assert.equal(invites[0]?.cta?.url, 'https://new.example/t/poster?session=ses_1', 'cta is replaced, not kept');
  assert.equal(invites[0]?.dismissible, false, 'dismissible is replaced, not kept');

  // clearAck: the dual of ackMessage, and the reason a DERIVED message id stays
  // re-deliverable. Dismiss the invite, re-put it (a second invite to the same
  // person for the same session), clear the ack - and it is pending again.
  // Without this the pair is permanently un-notifiable and the POST's 201 is a lie.
  await store.ackMessage('msg_collab_x', u1.id);
  assert.ok((await store.acksFor(u1.id)).has('msg_collab_x'));
  await store.clearAck('msg_collab_x', u1.id);
  assert.equal((await store.acksFor(u1.id)).has('msg_collab_x'), false, 'the dismissal is undone');
  assert.equal((await store.ackCounts()).get('msg_collab_x'), undefined, 'and it stops counting toward reach');
  await store.clearAck('msg_collab_x', u1.id); // idempotent
  await store.clearAck('no-such-message', u1.id); // unknown pair is a no-op
  assert.deepEqual([...(await store.acksFor(u1.id))], ['m1'], 'other acks are untouched');

  // fleet
  await store.recordClient({ shell: 'web', engine: '1.61.0' });
  await store.recordClient({ shell: 'web', engine: '1.61.0' });
  await store.recordClient({ shell: 'tauri', engine: '1.60.0' });
  const fleet = await store.fleetSummary();
  assert.equal(fleet.find((r) => r.info.shell === 'web')?.count, 2);
  assert.equal(fleet.find((r) => r.info.shell === 'tauri')?.count, 1);

  // fleet installs (plans/34 wave 3): upsert refreshes info/user/lastSeen but
  // an operator-set name survives - the operator set it, the device did not.
  await store.upsertInstall('ins_1', { shell: 'tauri', engine: '1.60.0', platform: 'macos' }, u1.id);
  const first = (await store.listInstalls()).find((i) => i.installId === 'ins_1');
  assert.equal(first?.userIdLastSeen, u1.id);
  assert.equal(first?.name, undefined);
  assert.equal((await store.renameInstall('ins_1', 'Studio laptop'))?.name, 'Studio laptop');
  await store.upsertInstall('ins_1', { shell: 'tauri', engine: '1.61.0', platform: 'macos' }, u1.id);
  const refreshed = (await store.listInstalls()).find((i) => i.installId === 'ins_1');
  assert.equal(refreshed?.info.engine, '1.61.0', 'the refresh carries the new versions');
  assert.equal(refreshed?.name, 'Studio laptop', 'the operator-set name survives the refresh');
  assert.equal(refreshed?.firstSeenAt, first?.firstSeenAt, 'firstSeenAt is the first sight, not the last');
  assert.equal((await store.renameInstall('ins_1', null))?.name, undefined, 'null clears the name');
  assert.equal(await store.renameInstall('ins_nope', 'x'), null, 'renaming an unknown install reports it');
  await store.forgetInstall('ins_1');
  assert.equal((await store.listInstalls()).some((i) => i.installId === 'ins_1'), false, 'forget is a row delete');
  await store.forgetInstall('ins_1'); // idempotent

  // service tokens (plans/35 wave 2): hash lookup, touch, revoke-once
  await store.putApiToken({ id: 'tok_1', label: 'ci', role: 'admin', tokenHash: 'hash-a', createdBy: 'user:u1', createdAt: new Date().toISOString() });
  assert.equal((await store.findApiTokenByHash('hash-a'))?.label, 'ci');
  assert.equal(await store.findApiTokenByHash('nope'), null);
  await store.touchApiToken('tok_1', '2026-08-24T12:00:00.000Z');
  assert.equal((await store.listApiTokens()).find((t) => t.id === 'tok_1')?.lastUsedAt, '2026-08-24T12:00:00.000Z');
  assert.equal(await store.revokeApiToken('tok_1', '2026-08-24T13:00:00.000Z'), true);
  assert.equal(await store.revokeApiToken('tok_1', '2026-08-24T13:00:00.000Z'), false, 'a revoked token revokes once');

  // invitations (plans/74 W-ID-2): one active row per email, lowercased;
  // re-inviting returns the active row; an expired pending row makes way;
  // acceptance happens once and only while pending and unexpired.
  const invAt = '2026-10-02T10:00:00.000Z';
  const inv1 = await store.createInvitation({ id: 'inv_1', email: 'Ana@Example.COM', groups: ['team', 'team', 'brand'], invitedBy: 'user:u1', createdAt: invAt });
  assert.equal(inv1.created, true);
  assert.equal(inv1.invitation.email, 'ana@example.com', 'stored lowercased');
  assert.deepEqual(inv1.invitation.groups, ['team', 'brand'], 'groups deduped, order kept');
  assert.equal(inv1.invitation.acceptedAt, undefined);
  const again = await store.createInvitation({ id: 'inv_2', email: 'ana@example.com', groups: ['other'], invitedBy: 'user:u2', createdAt: '2026-10-02T11:00:00.000Z' });
  assert.equal(again.created, false, 'one active invitation per email');
  assert.equal(again.invitation.id, 'inv_1');
  assert.deepEqual(again.invitation.groups, ['team', 'brand'], 'the active row is returned unchanged');
  assert.equal(await store.getInvitation('inv_2'), null, 'no second row was written');
  assert.equal((await store.findActiveInvitation(' ANA@example.com '))?.id, 'inv_1', 'lookup is case-insensitive');
  assert.equal(await store.findActiveInvitation('nobody@example.com'), null);

  // Acceptance: once, pending only, never after expiry.
  const accepted = await store.acceptInvitation('inv_1', 'usr_ana', '2026-10-02T12:00:00.000Z');
  assert.equal(accepted?.acceptedUserId, 'usr_ana');
  assert.equal(accepted?.acceptedAt, '2026-10-02T12:00:00.000Z');
  assert.equal(await store.acceptInvitation('inv_1', 'usr_other', '2026-10-02T12:01:00.000Z'), null, 'accepted exactly once');
  assert.equal((await store.findActiveInvitation('ana@example.com'))?.acceptedUserId, 'usr_ana', 'an accepted invitation stays active');
  assert.equal((await store.createInvitation({ id: 'inv_3', email: 'ana@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2027-01-01T00:00:00.000Z' })).created, false,
    'an accepted invitation is still the active one, whatever its old expiry');

  // Expiry: a lapsed pending row is revoked and replaced by a fresh one.
  await store.createInvitation({ id: 'inv_4', email: 'bo@example.com', groups: ['team'], invitedBy: 'user:u1', createdAt: invAt, expiresAt: '2026-10-03T00:00:00.000Z' });
  assert.equal(await store.acceptInvitation('inv_4', 'usr_bo', '2026-10-03T00:00:00.000Z'), null, 'no acceptance at or after expiry');
  assert.equal((await store.findActiveInvitation('bo@example.com'))?.id, 'inv_4', 'an expired pending row is still found; the caller judges expiry');
  const before = await store.createInvitation({ id: 'inv_5', email: 'bo@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-02T23:00:00.000Z' });
  assert.equal(before.created, false, 'not yet expired: the pending row stands');
  const fresh = await store.createInvitation({ id: 'inv_6', email: 'bo@example.com', groups: ['brand'], invitedBy: 'user:u1', createdAt: '2026-10-04T00:00:00.000Z' });
  assert.equal(fresh.created, true, 'an expired pending row makes way');
  assert.equal((await store.getInvitation('inv_4'))?.revokedAt, '2026-10-04T00:00:00.000Z', 'the lapsed row is revoked at the replacing instant');
  assert.equal((await store.findActiveInvitation('bo@example.com'))?.id, 'inv_6');

  // Revocation: once; the email is then free for a new invitation.
  const revoked = await store.revokeInvitation('inv_6', '2026-10-05T00:00:00.000Z');
  assert.equal(revoked?.email, 'bo@example.com');
  assert.equal(await store.revokeInvitation('inv_6', '2026-10-05T00:00:00.000Z'), null, 'a revoked invitation revokes once');
  assert.equal(await store.revokeInvitation('inv_nope', '2026-10-05T00:00:00.000Z'), null);
  assert.equal(await store.acceptInvitation('inv_6', 'usr_bo', '2026-10-05T00:00:01.000Z'), null, 'a revoked invitation is never accepted');
  assert.equal(await store.findActiveInvitation('bo@example.com'), null);
  assert.equal((await store.createInvitation({ id: 'inv_7', email: 'bo@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-06T00:00:00.000Z' })).created, true);
  const invList = await store.listInvitations();
  assert.deepEqual(invList.map((i) => i.id), ['inv_7', 'inv_6', 'inv_4', 'inv_1'], 'newest first, revoked rows kept');
  assert.equal(invList.find((i) => i.id === 'inv_7')?.expiresAt, undefined, 'no expiry reads as absent');

  // Projects on an invitation (plans/74, migration 0040): stored, read back,
  // empty by default, and replaceable only while the invitation is pending.
  assert.deepEqual(invList.find((i) => i.id === 'inv_7')?.projects ?? [], [], 'no projects reads as empty');
  const withProjects = await store.createInvitation({
    id: 'inv_8', email: 'cy@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-06T00:00:00.000Z',
    projects: [{ projectId: 'prj_x', role: 'editor' }],
  });
  assert.deepEqual(withProjects.invitation.projects, [{ projectId: 'prj_x', role: 'editor' }]);
  const extended = await store.setInvitationProjects('inv_8', [{ projectId: 'prj_x', role: 'manager' }, { projectId: 'prj_y', role: 'viewer' }]);
  assert.deepEqual(extended?.projects, [{ projectId: 'prj_x', role: 'manager' }, { projectId: 'prj_y', role: 'viewer' }]);
  assert.deepEqual((await store.findActiveInvitation('cy@example.com'))?.projects, extended?.projects);
  assert.equal(await store.setInvitationProjects('inv_1', []), null, 'an accepted invitation keeps its projects');
  assert.equal(await store.setInvitationProjects('inv_6', []), null, 'a revoked invitation keeps its projects');
  assert.equal(await store.setInvitationProjects('inv_nope', []), null);
  // Each entry keeps who put it there; the route writes the origin.
  const byEntry = await store.setInvitationProjects('inv_8', [{ projectId: 'prj_x', role: 'manager', invitedBy: 'user:u9' }]);
  assert.deepEqual(byEntry?.projects, [{ projectId: 'prj_x', role: 'manager', invitedBy: 'user:u9' }]);
  assert.equal((await store.getInvitation('inv_8'))?.createdVia, undefined, 'a row written without an origin reads as console');
  const fromProject = await store.createInvitation({
    id: 'inv_9', email: 'dy@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-06T00:00:00.000Z',
    expiresAt: '2026-10-08T00:00:00.000Z', projects: [{ projectId: 'prj_x', role: 'viewer', invitedBy: 'user:u1' }], createdVia: 'project',
  });
  assert.equal(fromProject.invitation.createdVia, 'project');
  assert.equal((await store.getInvitation('inv_9'))?.createdVia, 'project');
  // Open invitations by project: pending, unexpired, carrying the project.
  const openFor = async (projectId: string, at: string) => (await store.listOpenInvitationsForProject(projectId, at)).map((i) => i.id);
  assert.deepEqual(await openFor('prj_x', '2026-10-07T00:00:00.000Z'), ['inv_9', 'inv_8'], 'newest first');
  assert.deepEqual(await openFor('prj_x', '2026-10-09T00:00:00.000Z'), ['inv_8'], 'an expired one is left out');
  assert.deepEqual(await openFor('prj_y', '2026-10-07T00:00:00.000Z'), [], 'a project taken off is left out');
  assert.deepEqual(await openFor('prj_none', '2026-10-07T00:00:00.000Z'), []);
  // A pending-only revoke leaves an accepted row alone, so a revoke racing
  // an acceptance never undoes it.
  await store.acceptInvitation('inv_9', 'usr_dy', '2026-10-06T01:00:00.000Z');
  assert.deepEqual(await openFor('prj_x', '2026-10-07T00:00:00.000Z'), ['inv_8'], 'an accepted one is left out');
  assert.equal(await store.revokeInvitation('inv_9', '2026-10-06T02:00:00.000Z', { pendingOnly: true }), null);
  assert.equal((await store.getInvitation('inv_9'))?.revokedAt, undefined, 'still active');
  assert.ok((await store.revokeInvitation('inv_8', '2026-10-06T02:00:00.000Z', { pendingOnly: true }))?.revokedAt, 'a pending row is revoked');
  assert.deepEqual(await openFor('prj_x', '2026-10-07T00:00:00.000Z'), [], 'a revoked one is left out');
  // Dropping one project off a pending invitation: the others keep their
  // order and fields; the last one revokes the row only when asked and only
  // when it carries no groups.
  await store.createInvitation({
    id: 'inv_10', email: 'ey@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-06T00:00:00.000Z', createdVia: 'project',
    projects: [{ projectId: 'prj_a', role: 'viewer' }, { projectId: 'prj_b', role: 'editor', invitedBy: 'user:u2' }, { projectId: 'prj_c', role: 'manager' }],
  });
  const dropped = await store.dropInvitationProject('inv_10', 'prj_b', '2026-10-06T03:00:00.000Z', { revokeWhenEmpty: true });
  assert.deepEqual(dropped?.projects, [{ projectId: 'prj_a', role: 'viewer' }, { projectId: 'prj_c', role: 'manager' }]);
  assert.equal(dropped?.revokedAt, undefined, 'projects remain, so it stays open');
  assert.equal(await store.dropInvitationProject('inv_10', 'prj_b', '2026-10-06T03:00:00.000Z'), null, 'a project it no longer carries');
  await store.dropInvitationProject('inv_10', 'prj_a', '2026-10-06T03:00:00.000Z', { revokeWhenEmpty: true });
  const keptOpen = await store.dropInvitationProject('inv_10', 'prj_c', '2026-10-06T03:00:00.000Z');
  assert.deepEqual(keptOpen?.projects, []);
  assert.equal(keptOpen?.revokedAt, undefined, 'empty, but not asked to revoke');
  assert.equal((await store.findActiveInvitation('ey@example.com'))?.id, 'inv_10');
  await store.createInvitation({
    id: 'inv_11', email: 'fy@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-06T00:00:00.000Z', createdVia: 'project',
    projects: [{ projectId: 'prj_a', role: 'viewer' }],
  });
  const revokedEmpty = await store.dropInvitationProject('inv_11', 'prj_a', '2026-10-06T04:00:00.000Z', { revokeWhenEmpty: true });
  assert.deepEqual(revokedEmpty?.projects, []);
  assert.equal(revokedEmpty?.revokedAt, '2026-10-06T04:00:00.000Z', 'nothing left, so revoked in the same step');
  assert.equal(await store.findActiveInvitation('fy@example.com'), null);
  assert.equal(await store.dropInvitationProject('inv_11', 'prj_a', '2026-10-06T04:00:00.000Z'), null, 'a revoked row is left alone');
  await store.createInvitation({
    id: 'inv_12', email: 'gy@example.com', groups: ['design'], invitedBy: 'user:u1', createdAt: '2026-10-06T00:00:00.000Z', createdVia: 'project',
    projects: [{ projectId: 'prj_a', role: 'viewer' }],
  });
  const withGroups = await store.dropInvitationProject('inv_12', 'prj_a', '2026-10-06T04:00:00.000Z', { revokeWhenEmpty: true });
  assert.equal(withGroups?.revokedAt, undefined, 'its groups keep it open');
  assert.deepEqual(withGroups?.groups, ['design']);
  await store.createInvitation({
    id: 'inv_13', email: 'hy@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-06T00:00:00.000Z',
    projects: [{ projectId: 'prj_a', role: 'viewer' }],
  });
  await store.acceptInvitation('inv_13', 'usr_hy', '2026-10-06T01:00:00.000Z');
  assert.equal(await store.dropInvitationProject('inv_13', 'prj_a', '2026-10-06T04:00:00.000Z', { revokeWhenEmpty: true }), null,
    'an accepted invitation keeps its projects');
  assert.deepEqual((await store.getInvitation('inv_13'))?.projects, [{ projectId: 'prj_a', role: 'viewer' }]);

  // Invitation links (migration 0043): a new row starts at link version 1,
  // not opened, with password setup only when asked. Older rows read the
  // same way. "New link" raises the version and clears Opened, and only an
  // active, unaccepted row takes it.
  const linkAt = '2026-10-07T00:00:00.000Z';
  const linkRow = await store.createInvitation({
    id: 'inv_14', email: 'iy@example.com', groups: [], invitedBy: 'user:u1', createdAt: linkAt, expiresAt: '2026-10-10T00:00:00.000Z',
    projects: [{ projectId: 'prj_l', role: 'editor' }], createdVia: 'request', passwordSetup: true,
  });
  assert.equal(linkRow.invitation.linkVersion, 1);
  assert.equal(linkRow.invitation.openedAt, undefined);
  assert.equal(linkRow.invitation.passwordSetup, true);
  assert.equal((await store.getInvitation('inv_14'))?.createdVia, 'request');
  assert.equal((await store.getInvitation('inv_1'))?.linkVersion, 1, 'an earlier row reads as version 1');
  assert.equal((await store.getInvitation('inv_1'))?.passwordSetup, undefined, 'absent means off');
  assert.equal((await store.createInvitation({ id: 'inv_14b', email: 'iz@example.com', groups: [], invitedBy: 'user:u1', createdAt: linkAt, passwordSetup: false }))
    .invitation.passwordSetup, undefined, 'false is stored as off');
  assert.equal(await store.markInvitationOpened('inv_14', '2026-10-07T01:00:00.000Z'), true, 'the first start sets Opened');
  assert.equal(await store.markInvitationOpened('inv_14', '2026-10-07T02:00:00.000Z'), false, 'later starts do not');
  assert.equal((await store.getInvitation('inv_14'))?.openedAt, '2026-10-07T01:00:00.000Z');
  assert.equal(await store.markInvitationOpened('inv_6', '2026-10-07T01:00:00.000Z'), false, 'a revoked row is never opened');
  assert.equal(await store.markInvitationOpened('inv_nope', '2026-10-07T01:00:00.000Z'), false);
  const rotated = await store.rotateInvitationLink('inv_14');
  assert.equal(rotated?.linkVersion, 2);
  assert.equal(rotated?.openedAt, undefined, 'a new link has not been opened');
  assert.equal(rotated?.passwordSetup, true, 'the rest of the row is kept');
  assert.deepEqual(rotated?.projects, [{ projectId: 'prj_l', role: 'editor' }]);
  assert.equal((await store.rotateInvitationLink('inv_14'))?.linkVersion, 3);
  assert.equal(await store.rotateInvitationLink('inv_1'), null, 'an accepted invitation keeps its link');
  assert.equal(await store.rotateInvitationLink('inv_6'), null, 'a revoked invitation has no link');
  assert.equal(await store.rotateInvitationLink('inv_nope'), null);
  assert.equal((await store.setInvitationPasswordSetup('inv_14', false))?.passwordSetup, undefined);
  assert.equal((await store.setInvitationPasswordSetup('inv_14', true))?.passwordSetup, true);
  assert.equal((await store.getInvitation('inv_14'))?.linkVersion, 3, 'the toggle leaves the link alone');
  assert.equal(await store.setInvitationPasswordSetup('inv_1', true), null, 'not on an accepted invitation');
  assert.equal(await store.setInvitationPasswordSetup('inv_6', true), null, 'not on a revoked invitation');

  // The project panel's list: pending, plus those that expired inside the
  // window; never an older expired one, an accepted one or a revoked one.
  const panelEntry = { projectId: 'prj_l', role: 'viewer' as const };
  await store.createInvitation({ id: 'inv_15', email: 'jy@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-05T00:00:00.000Z', projects: [panelEntry] });
  await store.createInvitation({ id: 'inv_16', email: 'ky@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-02T00:00:00.000Z', projects: [panelEntry] });
  await store.createInvitation({ id: 'inv_17', email: 'ly@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-01T00:00:00.000Z', projects: [panelEntry] });
  await store.acceptInvitation('inv_17', 'usr_ly', '2026-10-02T00:00:00.000Z');
  await store.createInvitation({ id: 'inv_18', email: 'my@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-01T00:00:00.000Z', projects: [panelEntry] });
  await store.revokeInvitation('inv_18', '2026-10-02T00:00:00.000Z');
  await store.createInvitation({ id: 'inv_19', email: 'ny@example.com', groups: [], invitedBy: 'user:u1', createdAt: '2026-10-06T00:00:00.000Z', projects: [panelEntry] });
  const panel = async (now: string, expiredSince: string) => (await store.listProjectInvitations('prj_l', { now, expiredSince })).map((i) => i.id);
  assert.deepEqual(await panel('2026-10-08T00:00:00.000Z', '2026-10-04T00:00:00.000Z'), ['inv_14', 'inv_19', 'inv_15'], 'newest first');
  assert.deepEqual(await panel('2026-10-08T00:00:00.000Z', '2026-10-06T00:00:00.000Z'), ['inv_14', 'inv_19'], 'expired before the window');
  assert.deepEqual(await panel('2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z'), ['inv_19'], 'only the one with no end');
  assert.deepEqual((await store.listProjectInvitations('prj_none', { now: linkAt, expiredSince: '2026-01-01T00:00:00.000Z' })), []);

  // The invitation an account accepted, newest first; never a revoked one.
  assert.equal((await store.findInvitationAcceptedBy('usr_ana'))?.id, 'inv_1');
  assert.equal((await store.findInvitationAcceptedBy('usr_ly'))?.id, 'inv_17');
  await store.revokeInvitation('inv_17', '2026-10-03T00:00:00.000Z');
  assert.equal(await store.findInvitationAcceptedBy('usr_ly'), null, 'a revoked acceptance no longer counts');
  assert.equal(await store.findInvitationAcceptedBy('usr_nobody'), null);

  // Linked sign-ins (plans/74, migration 0039): one person, many sign-ins.
  // A link is refreshed in place for its own user, refused for anyone else's
  // (a link row or that user's own users.sub), and only verified rows answer
  // the email lookup.
  const idA = await store.upsertUserBySub({ sub: 'ident-a', email: 'ident@example.com', groups: [], role: 'member' });
  const idB = await store.upsertUserBySub({ sub: 'gh:ident-b', email: 'other@example.com', groups: [], role: 'member' });
  assert.equal(await store.getUserByIdentity('ident-a'), null, 'no row until one is written');
  const linkedA = await store.linkIdentity({ identitySub: 'ident-a', userId: idA.id, idp: 'primary', email: ' Ident@Example.com ', emailVerified: true, linkedAt: '2026-10-02T00:00:00.000Z', lastLoginAt: '2026-10-02T00:00:00.000Z' });
  assert.equal(linkedA?.created, true);
  assert.equal(linkedA?.identity.email, 'ident@example.com', 'email stored lowercased');
  assert.equal((await store.getUserByIdentity('ident-a'))?.id, idA.id);
  const linkedGh = await store.linkIdentity({ identitySub: 'github:42', userId: idA.id, idp: 'github', email: 'ident@example.com', emailVerified: false, linkedAt: '2026-10-02T01:00:00.000Z' });
  assert.equal(linkedGh?.created, true);
  assert.equal(linkedGh?.identity.lastLoginAt, undefined, 'no sign-in yet reads as absent');
  const relinked = await store.linkIdentity({ identitySub: 'github:42', userId: idA.id, idp: 'github', email: 'ident@example.com', emailVerified: true, linkedAt: '2026-10-03T00:00:00.000Z', lastLoginAt: '2026-10-03T00:00:00.000Z' });
  assert.equal(relinked?.created, false, 'a second link of the same pair refreshes the row');
  assert.equal(relinked?.identity.linkedAt, '2026-10-02T01:00:00.000Z', 'linkedAt is kept');
  assert.equal(relinked?.identity.lastLoginAt, '2026-10-03T00:00:00.000Z');
  assert.equal(relinked?.identity.emailVerified, true);
  // The groups a sign-in asserted: none on a new row, replaced when given,
  // kept when a write leaves them out.
  assert.deepEqual(relinked?.identity.groups, [], 'a row starts with no asserted groups');
  const grouped = await store.linkIdentity({ identitySub: 'ident-a', userId: idA.id, idp: 'primary', email: 'ident@example.com', emailVerified: true, groups: ['admins', 'admins', 'design'], linkedAt: '2026-10-03T00:00:00.000Z', lastLoginAt: '2026-10-03T00:00:00.000Z' });
  assert.deepEqual(grouped?.identity.groups, ['admins', 'design'], 'stored once each');
  const kept = await store.linkIdentity({ identitySub: 'ident-a', userId: idA.id, idp: 'primary', email: 'ident@example.com', emailVerified: true, linkedAt: '2026-10-03T00:00:00.000Z' });
  assert.deepEqual(kept?.identity.groups, ['admins', 'design'], 'absent keeps what was stored');
  assert.deepEqual((await store.listIdentities(idA.id)).find((r) => r.identitySub === 'ident-a')?.groups, ['admins', 'design']);
  const cleared = await store.linkIdentity({ identitySub: 'ident-a', userId: idA.id, idp: 'primary', email: 'ident@example.com', emailVerified: true, groups: [], linkedAt: '2026-10-03T00:00:00.000Z' });
  assert.deepEqual(cleared?.identity.groups, [], 'an empty list clears them');
  assert.equal(await store.linkIdentity({ identitySub: 'github:42', userId: idB.id, idp: 'github', emailVerified: true, linkedAt: '2026-10-03T00:00:00.000Z' }), null,
    "another user's link is refused");
  assert.equal(await store.linkIdentity({ identitySub: 'gh:ident-b', userId: idA.id, idp: 'gh', emailVerified: true, linkedAt: '2026-10-03T00:00:00.000Z' }), null,
    "another user's own sub is refused");
  assert.equal(await store.linkIdentity({ identitySub: 'nobody:1', userId: 'usr_nope', idp: 'nobody', emailVerified: true, linkedAt: '2026-10-03T00:00:00.000Z' }), null,
    'an unknown user is refused');
  assert.equal((await store.getUserByIdentity('github:42'))?.id, idA.id, 'the refused writes changed nothing');
  assert.deepEqual((await store.listIdentities(idA.id)).map((r) => r.identitySub), ['ident-a', 'github:42'], 'oldest link first');
  assert.deepEqual(await store.listIdentities(idB.id), []);
  // Verified email: each user once, whatever the case; unverified rows never answer.
  assert.deepEqual((await store.findUsersByVerifiedEmail('IDENT@example.com')).map((u) => u.id), [idA.id]);
  await store.linkIdentity({ identitySub: 'gh:ident-b', userId: idB.id, idp: 'gh', email: 'shared@example.com', emailVerified: false, linkedAt: '2026-10-03T00:00:00.000Z' });
  assert.deepEqual(await store.findUsersByVerifiedEmail('shared@example.com'), [], 'an unverified address links nothing');
  assert.deepEqual(await store.findUsersByVerifiedEmail('  '), []);
  // Unlink: only this user's own row, once.
  assert.equal(await store.unlinkIdentity(idB.id, 'github:42'), false, "never another user's row");
  assert.equal(await store.unlinkIdentity(idA.id, 'github:42'), true);
  assert.equal(await store.unlinkIdentity(idA.id, 'github:42'), false);
  assert.equal(await store.getUserByIdentity('github:42'), null);
  assert.ok(await store.linkIdentity({ identitySub: 'github:42', userId: idB.id, idp: 'github', emailVerified: true, linkedAt: '2026-10-04T00:00:00.000Z' }),
    'an unlinked identity can be linked again, to anyone');

  // durable automation jobs: principal isolation, idempotency lookup and delete
  const jobAt = '2026-09-04T12:00:00.000Z';
  await store.putAutomationJob({ id: 'job_1', principal: 'user:a', verb: 'render', request: { toolId: 'card' }, state: 'queued', createdAt: jobAt, updatedAt: jobAt, idempotencyKey: 'idem-1', priority: 0, attempt: 0 });
  assert.equal((await store.getAutomationJob('job_1', 'user:a'))?.verb, 'render');
  assert.equal(await store.getAutomationJob('job_1', 'user:b'), null, 'jobs are principal-isolated');
  assert.equal((await store.findAutomationJobByIdempotency('user:a', 'idem-1'))?.id, 'job_1');
  assert.equal((await store.listAutomationJobs('user:a')).length, 1);
  assert.equal(await store.deleteAutomationJob('job_1', 'user:b'), false);
  assert.equal(await store.deleteAutomationJob('job_1', 'user:a'), true);
  assert.equal(await store.getAutomationJob('job_1', 'user:a'), null);
  assert.ok((await store.findApiTokenByHash('hash-a'))?.revokedAt, 'revoked rows are returned, callers refuse them');

  // organization deliveries: principal isolation, idempotency, lifecycle
  // updates, and immutable output/target facts across those updates.
  const deliveryAt = '2026-09-05T10:00:00.000Z';
  await store.putAutomationJob({
    id: 'job_delivery_source', principal: 'user:a', verb: 'render', request: { toolId: 'card', format: 'png' },
    state: 'done', createdAt: deliveryAt, updatedAt: deliveryAt, finishedAt: deliveryAt,
    resultRef: 'automation/job_delivery_source/result', resultMime: 'image/png',
    resultSha256: 'd'.repeat(64), priority: 0, attempt: 1,
  });
  await store.putDelivery({
    id: 'del_1', principal: 'user:a', destinationId: 'archive', destinationVersion: 'v1',
    name: 'poster', format: 'png', contentType: 'image/png', size: 12, sha256: 'a'.repeat(64),
    requestHash: 'b'.repeat(64), sourceRef: 'automation/job_delivery_source/result',
    sourceJobId: 'job_delivery_source', state: 'queued', attempt: 0,
    idempotencyKey: 'delivery-idem-1', createdAt: deliveryAt, updatedAt: deliveryAt,
  });
  assert.equal((await store.getDelivery('del_1', 'user:a'))?.destinationId, 'archive');
  assert.equal(await store.getDelivery('del_1', 'user:b'), null, 'deliveries are principal-isolated');
  assert.equal((await store.findDeliveryByIdempotency('user:a', 'delivery-idem-1'))?.id, 'del_1');
  assert.equal((await store.findDeliveryBySourceJob('user:a', 'job_delivery_source'))?.id, 'del_1');
  assert.equal(await store.findDeliveryBySourceJob('user:b', 'job_delivery_source'), null);
  assert.equal((await store.listDeliveries('user:a')).length, 1);
  await store.putDelivery({
    ...(await store.getDelivery('del_1', 'user:a'))!,
    destinationId: 'must-not-change', sha256: 'c'.repeat(64), state: 'delivered', attempt: 1,
    remoteId: 'archive/del_1/poster.png', deliveredSha256: 'a'.repeat(64), transformation: 'none',
    updatedAt: '2026-09-05T10:01:00.000Z', deliveredAt: '2026-09-05T10:01:00.000Z',
  });
  const delivered = await store.getDelivery('del_1', 'user:a');
  assert.equal(delivered?.state, 'delivered');
  assert.equal(delivered?.destinationId, 'archive', 'destination identity is immutable');
  assert.equal(delivered?.sha256, 'a'.repeat(64), 'output digest is immutable');
  assert.equal(delivered?.sourceJobId, 'job_delivery_source', 'source relation is immutable');
  assert.equal(delivered?.remoteId, 'archive/del_1/poster.png');
  assert.equal(await store.deleteAutomationJob('job_delivery_source', 'user:a'), false,
    'a retained delivery keeps its immutable job output alive');

  // SIEM cursor + windowed audit reads (plans/35 wave 2)
  assert.equal(await store.getSiemCursor(), 0, 'no deliveries yet reads as zero');
  const allAudit = await store.listAudit();
  const lastSeq = allAudit[allAudit.length - 1]?.seq ?? 0;
  assert.ok(lastSeq > 0, 'earlier sections appended audit rows');
  const windowed = await store.listAuditAfter(0, 2);
  assert.equal(windowed.length, 2);
  assert.ok((windowed[1] as { seq: number }).seq > (windowed[0] as { seq: number }).seq, 'ascending');
  assert.deepEqual(await store.listAuditAfter(lastSeq, 10), [], 'past the head is empty');
  await store.setSiemCursor(lastSeq);
  assert.equal(await store.getSiemCursor(), lastSeq);

  // retention primitives (plans/35 wave 3): anchor before delete, tail survives
  const auditRows = await store.listAudit();
  const firstRow = auditRows[0] as { seq: number; hash: string };
  const headRow = auditRows[auditRows.length - 1] as { seq: number };
  assert.equal(await store.getAuditAnchor(), null, 'never-trimmed reads as no anchor');
  await store.setAuditAnchor({ seq: firstRow.seq, hash: firstRow.hash });
  assert.deepEqual(await store.getAuditAnchor(), { seq: firstRow.seq, hash: firstRow.hash });
  assert.equal(await store.trimAudit(firstRow.seq), 1);
  const remainingAudit = await store.listAudit();
  assert.equal(remainingAudit[0]?.seq, firstRow.seq + 1, 'rows at or under the anchor are gone');
  assert.deepEqual(verifyChain(remainingAudit, await store.getAuditAnchor()), { ok: true }, 'the anchored chain verifies');
  const appended = await store.appendAudit({ at: new Date().toISOString(), actor: 'user:u1', action: 'a.after-trim', subject: 's' });
  assert.equal(appended.seq, headRow.seq + 1, 'appends continue from the surviving tail');

  // telemetry trim, attribution scrub, user deletion (plans/35 wave 3)
  await store.putEvents([
    { event: 'app.boot', at: '2020-01-01T00:00:00.000Z', attrs: {} },
    { event: 'tool.open', at: new Date().toISOString(), attrs: {}, userId: u1.id },
  ]);
  assert.equal(await store.trimTelemetry('2021-01-01T00:00:00.000Z'), 1, 'only the dated-out event goes');
  // Two attributed events by now: the telemetry section's render.export and
  // the tool.open just stored.
  assert.equal(await store.scrubTelemetryUser(u1.id), 2);
  assert.equal((await store.listEvents()).some((e) => e.userId === u1.id), false, 'attribution is gone, the event stays');
  const disposable = await store.upsertUserBySub({ sub: 's-erase', email: 'erase@x', groups: [], role: 'member' });
  assert.equal(await store.deleteUser(disposable.id), true);
  assert.equal(await store.getUser(disposable.id), null);
  assert.equal(await store.deleteUser(disposable.id), false, 'a deleted user deletes once');

  // approvals: chain round-trip + approval round-trip with created_by / state / eligibleGroups filters
  const brandChain: Chain = {
    id: 'brand-review', name: 'Brand review',
    steps: [{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }],
    onReject: 'return-to-submitter',
  };
  await store.putChain(brandChain);
  assert.equal((await store.getChain('brand-review'))?.name, 'Brand review');
  assert.equal(await store.getChain('nope'), null);
  assert.ok((await store.listChains()).some((c) => c.id === 'brand-review'));

  const approval = createApproval({
    id: 'apr_1', subjectType: 'asset', subjectRef: 'sess:1', title: 'A deck',
    chain: brandChain, nominees: ['n1'], createdBy: u1.id, now: new Date().toISOString(),
  });
  await store.putApproval(approval);
  const got = await store.getApproval('apr_1');
  assert.equal(got?.title, 'A deck');
  assert.equal(got?.chain.id, 'brand-review'); // chain snapshot survives the round-trip
  assert.deepEqual(got?.nominees, ['n1']);
  assert.equal((await store.listApprovals({ createdBy: u1.id })).length, 1);
  assert.equal((await store.listApprovals({ createdBy: 'nobody' })).length, 0);
  assert.equal((await store.listApprovals({ state: 'in_review' })).length, 1);
  assert.equal((await store.listApprovals({ state: 'approved' })).length, 0);
  assert.equal((await store.listApprovals({ eligibleGroups: ['brand'] })).length, 1);
  assert.equal((await store.listApprovals({ eligibleGroups: ['legal'] })).length, 0);

  // catalog lifecycle: put/get/list round-trip, re-put updates in place
  assert.equal(await store.getLifecycle('acme/logo/primary'), null);
  await store.putLifecycle({ assetId: 'acme/logo/primary', validUntil: '2026-09-30T00:00:00.000Z', onExpiry: 'hide' });
  const lc1 = await store.getLifecycle('acme/logo/primary');
  assert.equal(lc1?.validUntil, '2026-09-30T00:00:00.000Z');
  assert.equal(lc1?.onExpiry, 'hide');
  assert.equal(lc1?.revokedAt, undefined);
  await store.putLifecycle({
    assetId: 'acme/logo/primary', validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: '2026-09-30T00:00:00.000Z', revokedAt: '2026-07-21T00:00:00.000Z', onExpiry: 'warn',
  });
  const lc2 = await store.getLifecycle('acme/logo/primary');
  assert.equal(lc2?.onExpiry, 'warn');
  assert.equal(lc2?.validFrom, '2026-01-01T00:00:00.000Z');
  assert.equal(lc2?.revokedAt, '2026-07-21T00:00:00.000Z');
  await store.putLifecycle({ assetId: 'acme/palette/core', onExpiry: 'hide' });
  const rows = await store.listLifecycle();
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.assetId === 'acme/palette/core'));

  // hold rides on the same row as jsonb, round-trips, and clears back to absent
  await store.putLifecycle({ assetId: 'acme/palette/core', onExpiry: 'hide', hold: { by: 'user:u1', at: '2026-08-13T00:00:00.000Z', note: 'legal hold' } });
  const held = await store.getLifecycle('acme/palette/core');
  assert.deepEqual(held?.hold, { by: 'user:u1', at: '2026-08-13T00:00:00.000Z', note: 'legal hold' });
  await store.putLifecycle({ assetId: 'acme/palette/core', onExpiry: 'hide' });
  assert.equal((await store.getLifecycle('acme/palette/core'))?.hold, undefined, 'hold clears when omitted');

  // catalog content-credential detections: put/get/list round-trip, re-scan updates in place
  assert.equal(await store.getCredential('acme/logo/primary'), null);
  await store.putCredential({ assetId: 'acme/logo/primary', status: 'embedded', container: 'png', sniffedAt: '2026-08-13T00:00:00.000Z', sourceUpdatedAt: '2026-08-01T00:00:00.000Z' });
  const cr1 = await store.getCredential('acme/logo/primary');
  assert.equal(cr1?.status, 'embedded');
  assert.equal(cr1?.container, 'png');
  assert.equal(cr1?.sourceUpdatedAt, '2026-08-01T00:00:00.000Z');
  await store.putCredential({ assetId: 'acme/logo/primary', status: 'none', sniffedAt: '2026-08-14T00:00:00.000Z' });
  const cr2 = await store.getCredential('acme/logo/primary');
  assert.equal(cr2?.status, 'none');
  assert.equal(cr2?.container, undefined, 'container drops when the re-scan finds nothing');
  assert.equal((await store.listCredentials()).length, 1);

  // delete (the exit's cutover MOVES rows off the ext id)
  await store.deleteCredential('acme/logo/primary');
  assert.equal(await store.getCredential('acme/logo/primary'), null);
  await store.deleteLifecycle('acme/logo/primary');
  await store.deleteLifecycle('acme/palette/core');
  assert.equal((await store.listLifecycle()).length, 0, 'lifecycle rows deletable');

  // instance assets: full record (entry + blobs + origin) round-trips as jsonb
  assert.equal(await store.getInstanceAsset('inst/abc'), null);
  await store.putInstanceAsset({
    id: 'inst/abc', entry: { id: 'inst/abc', name: 'Materialized', formats: [{ format: 'png', url: '/catalog/inst/abc/png', size: 10, checksum: 'sha' }] },
    blobs: { png: 'inst/abc/png' }, refMap: { att1: 'png' }, groups: ['design'],
    origin: { provider: 'dam1', providerKind: 'mock', remoteId: 'a1', materializedAt: '2026-08-13T00:00:00.000Z' }, createdAt: '2026-08-13T00:00:00.000Z',
  });
  const ia = await store.getInstanceAsset('inst/abc');
  assert.equal(ia?.entry.name, 'Materialized');
  assert.equal(ia?.blobs.png, 'inst/abc/png');
  assert.equal(ia?.origin?.remoteId, 'a1');
  assert.deepEqual(ia?.groups, ['design']);
  assert.equal((await store.listInstanceAssets()).length, 1);
  await store.deleteInstanceAsset('inst/abc');
  assert.equal(await store.getInstanceAsset('inst/abc'), null);

  // A submitted instance asset (plans/31 §3): the submission block round-trips
  // whole, and the generated submission_state/submitted_by columns the postgres
  // driver adds in 0017 must not change what comes back out.
  await store.putInstanceAsset({
    id: 'inst/sub1',
    entry: { id: 'inst/sub1', name: 'Campaign Hero', formats: [{ format: 'png', url: '/catalog/inst/sub1/png', size: 12, checksum: 'shaX' }] },
    blobs: { png: 'inst/sub1/png' },
    submission: {
      state: 'submitted', by: 'user:usr_1', at: '2026-08-19T00:00:00.000Z',
      checksum: 'shaX', size: 12, contentType: 'image/png', width: 4, height: 3, approvalId: 'apr_1',
    },
    createdAt: '2026-08-19T00:00:00.000Z',
  });
  const sub = await store.getInstanceAsset('inst/sub1');
  assert.equal(sub?.submission?.state, 'submitted');
  assert.equal(sub?.submission?.by, 'user:usr_1');
  assert.equal(sub?.submission?.approvalId, 'apr_1');
  assert.equal(sub?.submission?.width, 4);
  await store.putInstanceAsset({ ...sub!, submission: { ...sub!.submission!, state: 'live' } });
  assert.equal((await store.getInstanceAsset('inst/sub1'))?.submission?.state, 'live');
  await store.deleteInstanceAsset('inst/sub1');

  // Org-defined metadata (plans/31 section 4, migrations/0018). Definitions are
  // policy and round-trip whole, including the select options and the required
  // flag the editor enforces; listing is id-ordered so the policy document, the
  // console and the CLI cannot disagree about the order of the form.
  assert.deepEqual(await store.listCatalogFields(), []);
  await store.putCatalogField({ id: 'region', label: 'Region', kind: 'select', required: true, options: ['EMEA', 'AMER'] });
  await store.putCatalogField({ id: 'campaign', label: 'Campaign', kind: 'text' });
  assert.deepEqual((await store.listCatalogFields()).map((f) => f.id), ['campaign', 'region'], 'definitions list by id');
  const region = (await store.listCatalogFields()).find((f) => f.id === 'region');
  assert.equal(region?.required, true);
  assert.deepEqual(region?.options, ['EMEA', 'AMER']);
  await store.putCatalogField({ id: 'region', label: 'Sales region', kind: 'select', options: ['EMEA'] });
  assert.equal((await store.listCatalogFields()).find((f) => f.id === 'region')?.label, 'Sales region', 'put is an upsert');
  await store.deleteCatalogField('campaign');
  assert.deepEqual((await store.listCatalogFields()).map((f) => f.id), ['region']);

  // Values are an overlay keyed by CATALOG ASSET ID, which is the whole reason
  // it is its own table: all three id shapes take one - an instance asset, a
  // federated ext/* asset whose record belongs to a DAM, and a pack asset whose
  // record is a file on disk. A driver that could only key the first would make
  // org metadata an instance-assets-only feature.
  assert.equal(await store.getAssetMeta('inst/abc'), null);
  for (const assetId of ['inst/meta1', 'ext/dam1/a1', 'suse/tokens/brand']) {
    await store.putAssetMeta({
      assetId, fields: { region: 'EMEA' }, updatedBy: 'user:usr_1', updatedAt: '2026-08-19T00:00:00.000Z',
    });
    const got = await store.getAssetMeta(assetId);
    assert.equal(got?.assetId, assetId);
    assert.equal(got?.fields.region, 'EMEA');
    assert.equal(got?.updatedBy, 'user:usr_1');
  }
  assert.equal((await store.listAssetMeta()).length, 3);
  await store.putAssetMeta({ assetId: 'inst/meta1', fields: {}, updatedBy: 'user:usr_2', updatedAt: '2026-08-19T01:00:00.000Z' });
  assert.deepEqual((await store.getAssetMeta('inst/meta1'))?.fields, {}, 'a cleared bag round-trips as empty, not as absent');
  await store.deleteAssetMeta('inst/meta1');
  assert.equal(await store.getAssetMeta('inst/meta1'), null);
  assert.equal((await store.listAssetMeta()).length, 2);
  // Retiring a DEFINITION never touches the values filed under it: the served
  // bag filters to live definitions instead, so re-adding one brings them back.
  await store.deleteCatalogField('region');
  assert.equal((await store.getAssetMeta('ext/dam1/a1'))?.fields.region, 'EMEA');
  await store.deleteAssetMeta('ext/dam1/a1');
  await store.deleteAssetMeta('suse/tokens/brand');

  // Collections (plans/31 section 5, migrations/0019). Two properties are the
  // whole storage contract, and both are ones a join table would lose: MEMBER
  // ORDER is the curator's (a lookbook is a sequence), and a member may be an
  // inst/*, an ext/* or a pack id, only the first of which this database holds
  // a row for.
  assert.deepEqual(await store.listCollections(), []);
  assert.equal(await store.getCollection('launch'), null);
  const launch = {
    id: 'launch',
    name: 'Launch kit',
    description: 'Everything for the spring launch.',
    members: ['ext/dam1/a1', 'inst/hero', 'suse/tokens/brand'],
    groups: ['design', 'sales'],
    curator: 'user:usr_1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
  };
  await store.putCollection(launch);
  await store.putCollection({ ...launch, id: 'archive', name: 'Archive', members: [], groups: '*' as const });
  const readBack = await store.getCollection('launch');
  assert.deepEqual(readBack?.members, ['ext/dam1/a1', 'inst/hero', 'suse/tokens/brand'], 'member ORDER round-trips exactly');
  assert.deepEqual(readBack?.groups, ['design', 'sales']);
  assert.equal(readBack?.curator, 'user:usr_1');
  assert.equal(readBack?.description, 'Everything for the spring launch.');
  assert.deepEqual((await store.listCollections()).map((c) => c.id), ['archive', 'launch'], 'listing is name-ordered');
  assert.equal((await store.getCollection('archive'))?.groups, '*', "'*' visibility round-trips as itself");
  await store.putCollection({ ...launch, name: 'Launch kit 2026', members: ['inst/hero'] });
  assert.equal((await store.getCollection('launch'))?.name, 'Launch kit 2026', 'put is an upsert');
  assert.deepEqual((await store.getCollection('launch'))?.members, ['inst/hero'], 'an upsert replaces the member list whole');
  await store.deleteCollection('archive');
  assert.equal(await store.getCollection('archive'), null);
  await store.deleteCollection('nope'); // unknown id is a no-op
  await store.deleteCollection('launch');
  assert.deepEqual(await store.listCollections(), []);

  // Asset versions (plans/31 section 6, migrations/0020). Keyed (assetId,
  // version), listed oldest-first, and an upsert replaces the snapshot whole -
  // the format SET is what a head move and a rollback swap, so a driver that
  // merged format lists would make a two-format version un-rollbackable.
  assert.deepEqual(await store.listAssetVersions('inst/ver1'), []);
  assert.equal(await store.getAssetVersion('inst/ver1', 1), null);
  const v1 = {
    assetId: 'inst/ver1', version: 1,
    formats: [{ format: 'png', blobId: 'inst/ver1/png', size: 10, checksum: 'sha1', contentType: 'image/png' }],
    by: 'user:usr_1', at: '2026-08-20T00:00:00.000Z',
  };
  await store.putAssetVersion(v1);
  await store.putAssetVersion({
    ...v1, version: 2, at: '2026-08-20T01:00:00.000Z', note: 'new crop', width: 8, height: 6,
    formats: [
      { format: 'png', blobId: 'inst/ver1/v2/png', size: 20, checksum: 'sha2' },
      { format: 'svg', blobId: 'inst/ver1/v2/svg', size: 5, checksum: 'sha3' },
    ],
  });
  // A second asset's rows must not leak into the first's history.
  await store.putAssetVersion({ ...v1, assetId: 'inst/ver2', version: 1 });
  const history = await store.listAssetVersions('inst/ver1');
  assert.deepEqual(history.map((r) => r.version), [1, 2], 'versions list oldest-first, one asset at a time');
  assert.equal(history[1]?.note, 'new crop');
  assert.equal(history[1]?.width, 8);
  assert.deepEqual(history[1]?.formats.map((f) => f.format), ['png', 'svg'], 'the whole format set round-trips');
  assert.equal((await store.getAssetVersion('inst/ver1', 1))?.formats[0]?.contentType, 'image/png');
  await store.putAssetVersion({ ...v1, formats: [{ format: 'png', blobId: 'inst/ver1/png', size: 11, checksum: 'sha1b' }] });
  assert.equal((await store.getAssetVersion('inst/ver1', 1))?.formats[0]?.checksum, 'sha1b', 'put is an upsert on (assetId, version)');
  await store.deleteAssetVersion('inst/ver1', 1);
  assert.deepEqual((await store.listAssetVersions('inst/ver1')).map((r) => r.version), [2], 'a deleted version leaves a hole');
  await store.deleteAssetVersion('inst/ver1', 99); // unknown is a no-op
  await store.deleteAssetVersion('inst/ver1', 2);
  await store.deleteAssetVersion('inst/ver2', 1);
  assert.deepEqual(await store.listAssetVersions('inst/ver1'), []);

  // The HEAD is a number on the instance-asset record, never a flag on a row:
  // a driver that dropped it would silently serve version 1 forever.
  await store.putInstanceAsset({
    id: 'inst/headed',
    entry: { id: 'inst/headed', name: 'Headed', formats: [{ format: 'png', url: '/catalog/inst/headed/png' }] },
    blobs: { png: 'inst/headed/v3/png' },
    headVersion: 3,
    versionSeq: 5,
    createdAt: '2026-08-20T00:00:00.000Z',
  });
  assert.equal((await store.getInstanceAsset('inst/headed'))?.headVersion, 3);
  assert.equal((await store.getInstanceAsset('inst/headed'))?.versionSeq, 5,
    'the high-water mark round-trips too, or a deleted version number could be handed out twice');
  await store.deleteInstanceAsset('inst/headed');

  // Submit quota: cumulative, created on first add, addressed by scope, and the
  // add returns the row AFTER the increment (the caller charges, then reads).
  assert.equal(await store.getSubmitQuota('design'), null);
  const q1 = await store.addSubmitQuota('design', 100, 1);
  assert.equal(q1.bytes, 100);
  assert.equal(q1.count, 1);
  const q2 = await store.addSubmitQuota('design', 250, 1);
  assert.equal(q2.bytes, 350);
  assert.equal(q2.count, 2);
  await store.addSubmitQuota('sales', 7, 1);
  assert.equal((await store.getSubmitQuota('design'))?.bytes, 350);
  assert.equal((await store.listSubmitQuota()).length, 2);
  // Charging first is what enforces the cap, so a refused submission has to be
  // able to give its charge back: a negative delta releases it, and only that.
  const released = await store.addSubmitQuota('design', -250, -1);
  assert.equal(released.bytes, 100);
  assert.equal(released.count, 1);

  // catalog aliases: old id → new id round-trip
  assert.equal(await store.getAlias('ext/dam1/a1'), null);
  await store.putAlias('ext/dam1/a1', 'inst/abc');
  await store.putAlias('ext/dam1/a1/att1', 'inst/abc/png');
  assert.equal(await store.getAlias('ext/dam1/a1/att1'), 'inst/abc/png');
  assert.equal((await store.listAliases()).length, 2);

  // catalog providers: config, credential, and state travel independently - 
  // a config upsert must never clobber a stored credential or sync state.
  const pnow = new Date().toISOString();
  assert.equal(await store.getProvider('bf'), null);
  await store.putProvider({
    id: 'bf', kind: 'mock', label: 'Brand Source', managedBy: 'db', enabled: false,
    options: { flavour: 'x' }, mapping: { defaultType: 'image' }, exposure: { groups: ['design'] }, sync: { ttlSeconds: 60 },
    createdAt: pnow, updatedAt: pnow, state: { assetCount: 0 },
  });
  const p1 = await store.getProvider('bf');
  assert.equal(p1?.label, 'Brand Source');
  assert.equal(p1?.enabled, false);
  assert.deepEqual(p1?.exposure, { groups: ['design'] });
  assert.equal(p1?.credentialFingerprint, undefined);

  await store.putProviderCredential('bf', { ciphertext: new Uint8Array([9, 8, 7, 6]), fingerprint: 'deadbeef…-123', updatedAt: pnow });
  const p2 = await store.getProvider('bf');
  assert.equal(p2?.credentialFingerprint, 'deadbeef…-123');
  assert.ok(Buffer.from(p2?.credentialCiphertext ?? []).equals(Buffer.from([9, 8, 7, 6])), 'ciphertext bytes round-trip');

  await store.putProviderState('bf', {
    lastSyncAt: pnow, assetCount: 2,
    fragment: { assets: [{ id: 'ext/bf/a1' }], syncedAt: pnow, hash: 'h1' },
  });
  // Config re-upsert (label change) preserves credential AND state.
  await store.putProvider({
    id: 'bf', kind: 'mock', label: 'Renamed', managedBy: 'db', enabled: true,
    options: {}, mapping: {}, exposure: {}, sync: {},
    createdAt: pnow, updatedAt: new Date().toISOString(), state: { assetCount: 0 },
  });
  const p3 = await store.getProvider('bf');
  assert.equal(p3?.label, 'Renamed');
  assert.equal(p3?.enabled, true);
  assert.equal(p3?.credentialFingerprint, 'deadbeef…-123', 'credential survives config upsert');
  assert.equal(p3?.state.assetCount, 2, 'state survives config upsert');
  assert.equal(p3?.state.fragment?.hash, 'h1');

  const metadata = await store.getProvider('bf', { includeFragment: false });
  assert.equal(metadata?.state.fragment, undefined);
  assert.equal(metadata?.state.assetCount, 2);
  assert.equal(metadata?.credentialFingerprint, p3?.credentialFingerprint);
  assert.deepEqual(metadata?.credentialCiphertext, p3?.credentialCiphertext);
  assert.deepEqual(metadata?.exposure, p3?.exposure);
  const listedMetadata = (await store.listProviders({ includeFragment: false })).find(p => p.id === 'bf');
  assert.deepEqual(listedMetadata, metadata);
  assert.equal((await store.getProvider('bf'))?.state.fragment?.hash, 'h1', 'metadata reads preserve the stored fragment');

  await store.putProviderCredential('bf', null);
  assert.equal((await store.getProvider('bf'))?.credentialFingerprint, undefined, 'credential cleared');
  assert.ok((await store.listProviders()).some((p) => p.id === 'bf'));
  await store.deleteProvider('bf');
  assert.equal(await store.getProvider('bf'), null);

  // projects + sessions: create, list-by-visibility-agnostic (store is dumb),
  // rev CAS bookkeeping, tombstone exclusion, bounded revision history.
  const now = new Date().toISOString();
  await store.putProject({ id: 'prj_p', name: 'Personal', visibility: 'private', ownerId: u1.id, createdAt: now });
  await store.putProject({ id: 'prj_t', name: 'Team', visibility: { groups: ['g1'] }, ownerId: u1.id, createdAt: now });
  assert.equal((await store.getProject('prj_t'))?.name, 'Team');
  assert.deepEqual((await store.getProject('prj_t'))?.visibility, { groups: ['g1'] });
  assert.equal((await store.getProject('prj_p'))?.visibility, 'private');
  assert.equal(await store.getProject('nope'), null);
  assert.equal((await store.listProjects()).length, 2);
  // re-put updates in place (archive)
  await store.putProject({ id: 'prj_p', name: 'Personal', visibility: 'private', ownerId: u1.id, createdAt: now, archivedAt: now });
  assert.equal((await store.getProject('prj_p'))?.archivedAt, now);
  const folder = { id: 'fld_conformance', projectId: 'prj_t', parentId: null, name: 'Assets', createdAt: now, createdBy: u1.id, items: [] };
  await store.putProjectFolder(folder);
  await store.putProjectFolder({ ...folder, id: 'fld_child', parentId: folder.id, name: 'Images' });
  await assert.rejects(store.putProjectFolder({ ...folder, id: 'fld_wrong', projectId: 'prj_p', parentId: folder.id }));
  await store.assignProjectFolderItem('prj_t', folder.id, 'session', 'reference_a');
  await store.assignProjectFolderItem('prj_t', 'fld_child', 'session', 'reference_a');
  let tree = await store.listProjectFolders('prj_t');
  assert.deepEqual(tree.find(f => f.id === folder.id)?.items, []);
  assert.deepEqual(tree.find(f => f.id === 'fld_child')?.items, [{ kind: 'session', ref: 'reference_a' }]);
  await store.putProjectFolder({ ...folder, name: 'New name' });
  assert.equal((await store.listProjectFolders('prj_t')).find(f => f.id === folder.id)?.name, 'New name');
  await store.assignProjectFolderItem('prj_t', null, 'session', 'reference_a');
  tree = await store.listProjectFolders('prj_t'); assert.ok(tree.every(f => !f.items.length));
  assert.deepEqual(await store.listProjectFolders('prj_p'), []);
  assert.equal(await store.moveProjectFolder('prj_t', folder.id, 'fld_child'), 'invalid');
  assert.equal(await store.moveProjectFolder('prj_p', folder.id, null), 'missing');
  assert.equal(await store.moveProjectFolder('prj_t', 'fld_child', null), 'moved');
  assert.equal(await store.moveProjectFolder('prj_t', 'fld_child', folder.id), 'moved');
  await store.assignProjectFolderItem('prj_t', 'fld_child', 'session', 'reference_a');
  assert.equal(await store.deleteProjectFolder('prj_p', 'fld_child'), false);
  assert.equal(await store.deleteProjectFolder('prj_t', 'fld_child'), true);
  assert.deepEqual((await store.listProjectFolders('prj_t')).find(f => f.id === folder.id)?.items, [{ kind: 'session', ref: 'reference_a' }]);
  await store.putProjectFolder({ ...folder, id: 'fld_survivor', parentId: folder.id });
  assert.equal(await store.deleteProjectFolder('prj_t', folder.id), true);
  tree = await store.listProjectFolders('prj_t');
  assert.equal(tree.find(f => f.id === 'fld_survivor')?.parentId, null);
  assert.ok(tree.every(f => !f.items.length));
  assert.equal(await store.deleteProjectFolder('prj_t', folder.id), false);


  await store.putSession({
    id: 'ses_a', projectId: 'prj_t', toolId: 'poster', toolVersion: '1.0.0',
    inputs: { title: 'Hi', size: 42 }, meta: { label: 'Draft' },
    createdBy: u1.id, updatedBy: u1.id, rev: 1, updatedAt: now,
  });
  await store.putSession({
    id: 'ses_b', projectId: 'prj_t', toolId: 'flyer', toolVersion: '2.0.0',
    inputs: {}, meta: {}, createdBy: u1.id, updatedBy: u1.id, rev: 1, updatedAt: now,
  });
  const a = await store.getSession('ses_a');
  assert.equal(a?.toolId, 'poster');
  assert.deepEqual(a?.inputs, { title: 'Hi', size: 42 });
  assert.equal(a?.meta.label, 'Draft');
  assert.equal(await store.getSession('nope'), null);
  assert.equal((await store.listSessions('prj_t')).length, 2);
  assert.equal((await store.listSessionsFiltered({ toolId: 'poster' })).length, 1);
  assert.equal((await store.listSessionsFiltered({ projectId: 'prj_t', toolId: 'flyer' })).length, 1);
  assert.equal((await store.listSessionsFiltered({})).length, 2);
  // listings read counts and summaries, never the documents themselves
  const summaries = await store.listSessionSummaries('prj_t');
  assert.deepEqual(summaries.map((s) => s.id).sort(), ['ses_a', 'ses_b']);
  assert.ok(summaries.every((s) => !('inputs' in s)), 'a summary carries no inputs');
  assert.equal(summaries.find((s) => s.id === 'ses_a')?.meta.label, 'Draft');
  assert.equal(summaries.find((s) => s.id === 'ses_b')?.toolVersion, '2.0.0');
  assert.deepEqual(await store.listSessionSummaries('prj_p'), []);
  assert.deepEqual(await store.projectSessionStats(), [{ projectId: 'prj_t', count: 2, updatedAt: now, updatedBy: u1.id }], 'a project with no live session has no entry');
  assert.deepEqual(await store.projectSessionStats('prj_t'), [{ projectId: 'prj_t', count: 2, updatedAt: now, updatedBy: u1.id }]);
  assert.deepEqual(await store.projectSessionStats('prj_p'), []);

  // project activity + members (plans/74, migration 0040). The store stores;
  // the routes decide who may change what.
  await store.putProject({ id: 'prj_m', name: 'Members', visibility: 'private', ownerId: u1.id, createdAt: now });
  assert.equal((await store.getProject('prj_m'))?.updatedAt, undefined, 'an unchanged project has no updatedAt');
  const renamedAt = new Date(Date.parse(now) + 1000).toISOString();
  await store.putProject({ id: 'prj_m', name: 'Members 2', visibility: 'private', ownerId: u1.id, createdAt: now, updatedAt: renamedAt, updatedBy: u1.id });
  assert.equal((await store.getProject('prj_m'))?.updatedAt, renamedAt);
  assert.equal((await store.getProject('prj_m'))?.updatedBy, u1.id);
  const mA = await store.upsertUserBySub({ sub: 'member-a', email: 'member-a@example.com', groups: [], role: 'member' });
  const mB = await store.upsertUserBySub({ sub: 'member-b', email: 'member-b@example.com', groups: [], role: 'member' });
  assert.deepEqual(await store.listProjectMembers('prj_m'), []);
  assert.equal(await store.getProjectMember('prj_m', mA.id), null);
  const addedAt = '2026-10-02T09:00:00.000Z';
  await store.putProjectMember({ projectId: 'prj_m', userId: mA.id, role: 'viewer', addedBy: `user:${u1.id}`, addedAt });
  await store.putProjectMember({ projectId: 'prj_m', userId: mB.id, role: 'editor', addedBy: `user:${u1.id}`, addedAt: '2026-10-02T09:30:00.000Z' });
  await store.putProjectMember({ projectId: 'prj_t', userId: mA.id, role: 'manager', addedBy: `user:${u1.id}`, addedAt });
  assert.deepEqual((await store.listProjectMembers('prj_m')).map((m) => [m.userId, m.role]), [[mA.id, 'viewer'], [mB.id, 'editor']], 'oldest first');
  assert.deepEqual(await store.getProjectMember('prj_m', mA.id), { projectId: 'prj_m', userId: mA.id, role: 'viewer', addedBy: `user:${u1.id}`, addedAt });
  assert.deepEqual((await store.listUserProjectMemberships(mA.id)).map((m) => `${m.projectId}:${m.role}`).sort(), ['prj_m:viewer', 'prj_t:manager']);
  // A role change keeps who first added the person, and when.
  await store.putProjectMember({ projectId: 'prj_m', userId: mA.id, role: 'manager', addedBy: 'user:someone-else', addedAt: '2026-10-03T00:00:00.000Z' });
  assert.deepEqual(await store.getProjectMember('prj_m', mA.id), { projectId: 'prj_m', userId: mA.id, role: 'manager', addedBy: `user:${u1.id}`, addedAt });
  // A role change through updateProjectMemberRole never inserts: a person
  // removed between a read and the write stays removed.
  assert.deepEqual(await store.updateProjectMemberRole('prj_m', mB.id, 'viewer'),
    { projectId: 'prj_m', userId: mB.id, role: 'viewer', addedBy: `user:${u1.id}`, addedAt: '2026-10-02T09:30:00.000Z' });
  assert.equal(await store.updateProjectMemberRole('prj_m', 'usr_nobody', 'editor'), null);
  assert.equal(await store.getProjectMember('prj_m', 'usr_nobody'), null, 'nothing was inserted');
  assert.equal(await store.deleteProjectMember('prj_m', mB.id), true);
  assert.equal(await store.updateProjectMemberRole('prj_m', mB.id, 'manager'), null, 'a removed member is not put back');
  assert.equal(await store.getProjectMember('prj_m', mB.id), null);
  await store.putProjectMember({ projectId: 'prj_m', userId: mB.id, role: 'editor', addedBy: `user:${u1.id}`, addedAt: '2026-10-02T09:30:00.000Z' });
  assert.equal(await store.deleteProjectMember('prj_m', mB.id), true);
  assert.equal(await store.deleteProjectMember('prj_m', mB.id), false, 'a missing row deletes once');
  assert.deepEqual((await store.listProjectMembers('prj_m')).map((m) => m.userId), [mA.id]);
  assert.deepEqual((await store.getUsersByIds([mA.id, mB.id, mA.id, 'usr_nobody'])).map((u) => u.email).sort(), ['member-a@example.com', 'member-b@example.com']);
  assert.deepEqual(await store.getUsersByIds([]), []);
  // A membership goes with its user at erasure; it never blocks one.
  assert.deepEqual((await store.eraseUserAccount(mA.id)).status, 'erased');
  assert.deepEqual(await store.listUserProjectMemberships(mA.id), []);
  assert.deepEqual(await store.listProjectMembers('prj_m'), []);
  assert.equal(await store.getProjectMember('prj_t', mA.id), null);

  // shared project files (plans/74, migration 0041). Budgets and the pending
  // limits count ready files and unexpired uploads only, a budget counts each
  // file at its size plus R, the instance budget spans projects, and ready
  // files list newest first.
  {
    const hour = 60 * 60 * 1000, t = Date.now(), sum = 'a'.repeat(64), R = PROJECT_FILE_OVERHEAD_BYTES;
    const iso = (ms: number) => new Date(ms).toISOString();
    const pf = (id: string, projectId: string, size: number, createdAt: number, expiresIn = hour, createdBy = u1.id): ProjectFileRecord => ({
      id, projectId, name: `${id}.png`, size, checksum: sum, contentType: 'image/png', parts: [{ size, checksum: sum }],
      asset: { type: 'raster', format: 'png' }, createdBy, createdAt: iso(createdAt), expiresAt: iso(createdAt + expiresIn), ready: false,
    });
    const roomy = { projectBudgetBytes: 1000 + 4 * R, instanceBudgetBytes: 1000 + 4 * R, maxPending: 16, maxPendingBytes: 10_000 };
    await store.putProject({ id: 'prj_f1', name: 'Files', visibility: 'private', ownerId: u1.id, createdAt: now });
    await store.putProject({ id: 'prj_f2', name: 'Files 2', visibility: 'private', ownerId: u1.id, createdAt: now });
    const other = await store.upsertUserBySub({ sub: 'files-other', email: 'files-other@example.com', groups: [], role: 'member' });
    assert.equal(await store.reserveProjectFile(pf('pf_a', 'prj_f1', 10, t - 3000), roomy), 'reserved');
    assert.equal(await store.reserveProjectFile(pf('pf_a', 'prj_f1', 10, t - 3000), roomy), 'refused', 'an id is reserved once');
    assert.equal(await store.reserveProjectFile(pf('pf_x', 'prj_none', 10, t), roomy), 'refused', 'no such project');
    assert.equal(await store.reserveProjectFile(pf('pf_c', 'prj_f1', 30, t - 2000), roomy), 'reserved');
    assert.equal(await store.reserveProjectFile(pf('pf_b', 'prj_f1', 20, t - 2000), roomy), 'reserved');
    assert.deepEqual(await store.getProjectFile('pf_a'), pf('pf_a', 'prj_f1', 10, t - 3000));
    assert.equal(await store.getProjectFile('pf_nope'), null);
    assert.deepEqual(await store.listProjectFiles('prj_f1'), [], 'unfinished uploads are not listed');
    for (const id of ['pf_a', 'pf_b', 'pf_c']) assert.equal(await store.completeProjectFile(id), true);
    assert.equal(await store.completeProjectFile('pf_a'), true, 'completing again is harmless');
    assert.equal(await store.completeProjectFile('pf_nope'), false);
    assert.deepEqual((await store.listProjectFiles('prj_f1')).map((f) => f.id), ['pf_b', 'pf_c', 'pf_a'], 'newest first, then id');
    assert.equal((await store.listProjectFiles('prj_f1'))[0]?.ready, true);
    assert.deepEqual(await store.listProjectFiles('prj_f2'), []);

    // An expired upload never completes and counts toward nothing.
    assert.equal(await store.reserveProjectFile(pf('pf_old', 'prj_f1', 900, t - 3 * hour), roomy), 'reserved');
    assert.equal(await store.completeProjectFile('pf_old'), false, 'an expired upload cannot be completed');
    assert.deepEqual(await store.projectFileUsage('prj_f1'), { projectBytes: 60 + 3 * R, instanceBytes: 60 + 3 * R }, 'the expired upload is not counted');
    assert.equal(await store.reserveProjectFile(pf('pf_d', 'prj_f1', 940, t - 1000), roomy), 'reserved', 'the budget ignores expired uploads');
    assert.equal(await store.reserveProjectFile(pf('pf_e', 'prj_f1', 1, t), roomy), 'project-budget');
    // The instance budget spans projects.
    assert.equal(await store.reserveProjectFile(pf('pf_f', 'prj_f2', 1, t), { ...roomy, projectBudgetBytes: 2000 + 4 * R }), 'instance-budget');
    assert.equal(await store.reserveProjectFile(pf('pf_f', 'prj_f2', 100, t), { ...roomy, instanceBudgetBytes: 1100 + 5 * R }), 'reserved');
    assert.deepEqual(await store.projectFileUsage('prj_f2'), { projectBytes: 100 + R, instanceBytes: 1100 + 5 * R });
    // The pending limits are per person: u1 has pf_d (940) and pf_f (100)
    // unfinished; pf_old has expired. Bytes count declared sizes.
    const wide = { projectBudgetBytes: 10_000 + 10 * R, instanceBudgetBytes: 10_000 + 10 * R, maxPending: 2, maxPendingBytes: 10_000 };
    assert.equal(await store.reserveProjectFile(pf('pf_g', 'prj_f2', 1, t), wide), 'pending');
    assert.equal(await store.reserveProjectFile(pf('pf_g', 'prj_f2', 1, t, hour, other.id), wide), 'reserved', "another person's uploads are not mine");
    assert.equal(await store.reserveProjectFile(pf('pf_h', 'prj_f2', 6, t), { ...wide, maxPending: 16, maxPendingBytes: 1045 }), 'pending', 'pending bytes');
    assert.equal(await store.reserveProjectFile(pf('pf_h', 'prj_f2', 6, t), { ...wide, maxPending: 16, maxPendingBytes: 1046 }), 'reserved');

    // Unfinished uploads by uploader and by expiry, earliest expiry first.
    assert.deepEqual((await store.listUnfinishedProjectFiles({ createdBy: u1.id }, 10)).map((f) => f.id), ['pf_old', 'pf_d', 'pf_f', 'pf_h']);
    assert.deepEqual((await store.listUnfinishedProjectFiles({ createdBy: u1.id }, 1)).map((f) => f.id), ['pf_old']);
    assert.deepEqual((await store.listUnfinishedProjectFiles({ expiredBy: iso(t - hour) }, 10)).map((f) => f.id), ['pf_old']);
    assert.deepEqual((await store.listUnfinishedProjectFiles({ createdBy: other.id, expiredBy: iso(t - hour) }, 10)), []);

    // A touch moves an unfinished upload's expiry out, never in; an expired
    // or missing file refuses it, and a ready one keeps no expiry.
    assert.equal(await store.touchProjectFile('pf_d', iso(t + 2 * hour)), true);
    assert.equal((await store.getProjectFile('pf_d'))?.expiresAt, iso(t + 2 * hour));
    assert.equal(await store.touchProjectFile('pf_d', iso(t)), true);
    assert.equal((await store.getProjectFile('pf_d'))?.expiresAt, iso(t + 2 * hour), 'never earlier');
    assert.equal(await store.touchProjectFile('pf_old', iso(t + 2 * hour)), false, 'expired');
    assert.equal(await store.touchProjectFile('pf_nope', iso(t + 2 * hour)), false);
    assert.equal(await store.touchProjectFile('pf_a', iso(t + 2 * hour)), true, 'ready');
    assert.equal((await store.getProjectFile('pf_a'))?.expiresAt, iso(t - 3000 + hour));

    // Which live sessions of the project use a file.
    const used = { projectId: 'prj_f1', toolId: 'poster', toolVersion: '1.0.0', meta: { label: 'Uses it' }, createdBy: u1.id, updatedBy: u1.id, rev: 1, updatedAt: now };
    await store.putSession({ ...used, id: 'ses_f1', inputs: { image: { assetId: 'user/team/pf_b', version: sum } } });
    await store.putSession({ ...used, id: 'ses_f2', inputs: { image: 'user/team/pf_b' }, deletedAt: now });
    await store.putSession({ ...used, id: 'ses_f3', projectId: 'prj_f2', inputs: { image: 'user/team/pf_b' } });
    const users = await store.listSessionsUsingProjectFile('prj_f1', 'pf_b');
    assert.deepEqual(users.map((s) => s.id), ['ses_f1'], 'live sessions of this project only');
    assert.equal(users[0]?.meta.label, 'Uses it');
    assert.ok(!('inputs' in users[0]!), 'no session document comes back');
    assert.deepEqual(await store.listSessionsUsingProjectFile('prj_f1', 'pf_c'), []);

    // Ready files block erasure of their uploader; unfinished ones are counted nowhere.
    assert.equal((await store.previewUserErasure(u1.id)).references.projectFiles, 3);
    assert.equal((await store.previewUserErasure(other.id)).references.projectFiles, 0);

    assert.equal(await store.deleteProjectFile('pf_b'), true);
    assert.equal(await store.deleteProjectFile('pf_b'), false, 'a row deletes once');
    assert.equal(await store.getProjectFile('pf_b'), null);
    assert.deepEqual((await store.listProjectFiles('prj_f1')).map((f) => f.id), ['pf_c', 'pf_a']);
    // Leave no rows behind for the erasure suite.
    for (const id of ['pf_a', 'pf_c', 'pf_old', 'pf_d', 'pf_f', 'pf_g', 'pf_h']) assert.equal(await store.deleteProjectFile(id), true, id);
    for (const id of ['ses_f1', 'ses_f3']) await store.putSession({ ...used, id, projectId: id === 'ses_f3' ? 'prj_f2' : 'prj_f1', inputs: {}, deletedAt: now });
  }

  // CAS on rev: the write a concurrent editor needs. Wrong rev writes nothing;
  // right rev writes and the row moves; a tombstoned row refuses outright, so a
  // record read before a DELETE cannot be written back after it.
  const casBase = (await store.getSession('ses_a')) as NonNullable<typeof a>;
  assert.equal(
    await store.casSession({ ...casBase, inputs: { title: 'stale' }, rev: casBase.rev + 1 }, casBase.rev + 5),
    false,
    'a CAS against the wrong rev writes nothing',
  );
  assert.deepEqual((await store.getSession('ses_a'))?.inputs, { title: 'Hi', size: 42 }, 'and leaves the row alone');
  assert.equal(
    await store.casSession({ ...casBase, inputs: { title: 'won' }, rev: casBase.rev + 1 }, casBase.rev),
    true,
  );
  const afterCas = await store.getSession('ses_a');
  assert.equal(afterCas?.rev, casBase.rev + 1);
  assert.deepEqual(afterCas?.inputs, { title: 'won' });
  assert.equal(
    await store.casSession({ ...casBase, inputs: { title: 'lost' }, rev: casBase.rev + 1 }, casBase.rev),
    false,
    'the loser of the race is refused rather than silently overwriting the winner',
  );
  assert.deepEqual((await store.getSession('ses_a'))?.inputs, { title: 'won' });
  assert.equal(await store.casSession({ ...casBase, id: 'nope', rev: 2 }, 1), false, 'unknown id');
  // restore the fixture the rest of the suite reads
  await store.putSession({ ...(afterCas as NonNullable<typeof a>), inputs: { title: 'Hi', size: 42 }, rev: casBase.rev });

  // A live room's lease: CAS refuses at the CURRENT rev, and collabLeaseActive is
  // how a caller tells that refusal from a revision conflict. A batch that
  // accepted nothing stores its receipts under the same fence as commitCollab and
  // changes nothing else.
  const leased = (await store.getSession('ses_a')) as NonNullable<typeof a>;
  const historyBefore = await store.listSessionRevisions('ses_a');
  assert.equal(await store.collabLeaseActive('ses_a'), false, 'no room, no lease');
  assert.equal(await store.collabLeaseActive('nope'), false, 'unknown id');
  assert.equal(await store.claimCollab('ses_a', 'conformance-room', 30_000), true);
  assert.equal(await store.collabLeaseActive('ses_a'), true);
  assert.equal(await store.casSession({ ...leased, inputs: { title: 'REST' }, rev: leased.rev + 1 }, leased.rev), false,
    'a live room refuses a CAS even at the current rev');
  const refusal = { sessionId: 'ses_a', owner: 'conformance-room', principal: u1.id, expectedRev: leased.rev,
    receipts: [{ id: 'refused-op', digest: 'digest', accepted: false }] };
  await assert.rejects(store.commitCollabReceipts({ ...refusal, owner: 'another-room' }), /collab-owner-conflict/);
  await assert.rejects(store.commitCollabReceipts({ ...refusal, expectedRev: leased.rev + 1 }), /collab-owner-conflict/);
  await assert.rejects(store.commitCollabReceipts({ ...refusal, receipts: [{ ...refusal.receipts[0]!, accepted: true }] }), /accepted-receipt/,
    'an accepted receipt needs its operation committed');
  await store.commitCollabReceipts(refusal);
  assert.deepEqual(await store.getCollabReceipts('ses_a', u1.id, ['refused-op']),
    [{ id: 'refused-op', digest: 'digest', accepted: false, revision: leased.rev }]);
  await assert.rejects(store.commitCollabReceipts(refusal), 'a receipt is written once');
  assert.deepEqual(await store.getSession('ses_a'), leased, 'rev, inputs, updatedBy and updatedAt unchanged');
  assert.deepEqual(await store.listSessionRevisions('ses_a'), historyBefore, 'no revision row');
  assert.equal((await store.getCollabJournal('ses_a', 0)).length, 0, 'no journal row');
  await store.releaseCollab('ses_a', 'conformance-room');
  assert.equal(await store.collabLeaseActive('ses_a'), false, 'released');

  // revision history: append two, newest-first, round-trips inputs/meta
  await store.appendSessionRevision({ sessionId: 'ses_a', rev: 2, inputs: { title: 'Hi2' }, meta: { label: 'Draft' }, actor: u1.id, at: now });
  await store.appendSessionRevision({ sessionId: 'ses_a', rev: 3, inputs: { title: 'Hi3' }, meta: { label: 'Draft' }, actor: u1.id, at: now });
  await store.appendSessionRevision({ sessionId: 'ses_a', rev: 3, inputs: { title: 'Hi3' }, meta: { label: 'Draft' }, actor: u1.id, at: now }); // idempotent replay
  const revs = await store.listSessionRevisions('ses_a');
  assert.equal(revs.length, 2, 'replayed rev is not duplicated');
  assert.equal(revs[0]?.rev, 3, 'newest first');
  assert.deepEqual(revs[0]?.inputs, { title: 'Hi3' });

  // collab room snapshots (plans/14 §6): at most one per session, put REPLACES
  // (there is no update log), delete is idempotent, and `inputs` round-trips
  // structurally - nested blocks rows included, since that is the whole payload.
  assert.equal(await store.getCollabSnapshot('ses_b'), null, 'no room, no row');
  await store.putCollabSnapshot({
    sessionId: 'ses_b', baseRev: 1, ops: 12, updatedAt: now,
    inputs: { title: 'live', slides: [{ id: 'r1', heading: 'One' }], logo: { assetId: 'x/y', width: 12 } },
  });
  const snap1 = await store.getCollabSnapshot('ses_b');
  assert.equal(snap1?.baseRev, 1);
  assert.equal(snap1?.ops, 12);
  assert.deepEqual(snap1?.inputs.slides, [{ id: 'r1', heading: 'One' }], 'blocks rows survive the round-trip');
  assert.deepEqual(snap1?.inputs.logo, { assetId: 'x/y', width: 12 }, 'an unsynced input rides along verbatim');
  await store.putCollabSnapshot({
    sessionId: 'ses_b', baseRev: 2, ops: 40, updatedAt: now, inputs: { title: 'later' },
  });
  const snap2 = await store.getCollabSnapshot('ses_b');
  assert.equal(snap2?.ops, 40, 'put replaces rather than appending');
  assert.deepEqual(snap2?.inputs, { title: 'later' });
  // a stored snapshot must not alias the caller's object (jsonb parity)
  assert.notEqual(snap1?.inputs, snap2?.inputs);
  await store.deleteCollabSnapshot('ses_b');
  assert.equal(await store.getCollabSnapshot('ses_b'), null);
  await store.deleteCollabSnapshot('ses_b'); // idempotent
  await store.deleteCollabSnapshot('nope');

  // tombstone: still fetchable by id (with deletedAt), excluded from lists
  await store.putSession({ ...(a as NonNullable<typeof a>), deletedAt: now });
  assert.ok((await store.getSession('ses_a'))?.deletedAt, 'tombstoned record still returned by id');
  assert.equal(
    await store.casSession({ ...(a as NonNullable<typeof a>), inputs: { title: 'back from the dead' }, rev: (a as NonNullable<typeof a>).rev + 1 }, (a as NonNullable<typeof a>).rev),
    false,
    'a CAS never resurrects a tombstone, however stale the record it is handed',
  );
  assert.ok((await store.getSession('ses_a'))?.deletedAt, 'still tombstoned after the refused CAS');
  assert.equal((await store.listSessions('prj_t')).length, 1, 'tombstone excluded from project list');
  assert.equal((await store.listSessionsFiltered({ toolId: 'poster' })).length, 0, 'tombstone excluded from filtered list');
  assert.deepEqual((await store.listSessionSummaries('prj_t')).map((s) => s.id), ['ses_b'], 'tombstone excluded from summaries');
  assert.deepEqual((await store.projectSessionStats('prj_t')).map((s) => s.count), [1], 'tombstone excluded from the count');

  // ── user group split: idp mirror vs durable local groups (plans/02 §4) ────
  const alice = await store.upsertUserBySub({
    sub: 'split:alice', email: 'alice@x', firstname: 'Alice', lastname: 'Zed', groups: ['brand', 'admin'], role: 'admin',
  });
  assert.deepEqual(alice.idpGroups, ['brand', 'admin']);
  assert.deepEqual(alice.localGroups, []);
  assert.deepEqual(alice.groups, ['brand', 'admin'], 'effective = idp when no local');
  assert.equal(alice.role, 'admin', 'role derived from the effective union');

  // local group registry: put/list/round-trip
  await store.putLocalGroup({ name: 'brand-council', description: 'Delegated brand approvers', createdAt: now });
  await store.putLocalGroup({ name: 'owner', createdAt: now }); // a local group can carry a role name
  const localDefs = await store.listLocalGroups();
  assert.ok(localDefs.some((g) => g.name === 'brand-council' && g.description === 'Delegated brand approvers'));

  // assign a local group: effective union grows, idp untouched
  const withLocal = await store.setLocalGroups(alice.id, ['brand-council']);
  assert.deepEqual(withLocal?.idpGroups, ['brand', 'admin']);
  assert.deepEqual(withLocal?.localGroups, ['brand-council']);
  assert.deepEqual(withLocal?.groups, ['brand', 'admin', 'brand-council'], 'union, stable order');

  // re-login: idp groups REFRESH (drop admin, add legal); local groups DURABLE
  const reload = await store.upsertUserBySub({ sub: 'split:alice', email: 'alice@x', groups: ['brand', 'legal'], role: 'member' });
  assert.equal(reload.id, alice.id);
  assert.deepEqual(reload.idpGroups, ['brand', 'legal'], 'idp mirror re-synced');
  assert.deepEqual(reload.localGroups, ['brand-council'], 'local groups survive re-login');
  assert.deepEqual(reload.groups, ['brand', 'legal', 'brand-council']);

  // a local group carrying a role name escalates via the union…
  const escalated = await store.setLocalGroups(alice.id, ['brand-council', 'owner']);
  assert.equal(escalated?.role, 'owner');
  // …and deleteLocalGroup strips it from every member, recomputing role
  await store.deleteLocalGroup('owner');
  const deescalated = await store.getUserBySub('split:alice');
  assert.ok(!deescalated?.groups.includes('owner'), 'membership stripped on group delete');
  assert.ok(!deescalated?.localGroups.includes('owner'));
  assert.equal(deescalated?.role, 'member', 'role recomputed after strip');
  assert.ok(!(await store.listLocalGroups()).some((g) => g.name === 'owner'), 'definition gone');

  // session epoch: defaults to 0; a bump increments and returns the record
  assert.equal((await store.getUserBySub('split:alice'))?.sessionEpoch, 0, 'epoch defaults to 0');
  const bumped = await store.bumpSessionEpoch(alice.id);
  assert.equal(bumped?.sessionEpoch, 1);
  assert.equal(await store.bumpSessionEpoch('nope'), null, 'unknown id → null');

  // disabled toggle: set then clear. Disabling also bumps the epoch (disable =
  // lockout AND revocation); re-enabling leaves it alone.
  const disabled = await store.setUserDisabled(alice.id, now);
  assert.ok(disabled?.disabledAt);
  assert.equal(disabled?.sessionEpoch, 2, 'disable bumps the epoch');
  const enabled = await store.setUserDisabled(alice.id, null);
  assert.equal(enabled?.disabledAt, undefined);
  assert.equal(enabled?.sessionEpoch, 2, 're-enable does not bump');
  assert.equal(await store.setUserDisabled('nope', null), null, 'unknown id → null');
  assert.equal(await store.setLocalGroups('nope', []), null, 'unknown id → null');

  // ── SCIM provisioning tokens (plans/31 §8) ────────────────────────────────
  await store.putScimToken({ id: 'sct_1', idp: 'keycloak', tokenHash: 'h1', createdBy: 'user:owner', createdAt: now });
  await store.putScimToken({ id: 'sct_2', idp: 'okta', tokenHash: 'h2', createdBy: 'user:owner', createdAt: now });
  assert.deepEqual((await store.listScimTokens()).map((t) => t.id).sort(), ['sct_1', 'sct_2']);
  assert.equal((await store.findScimTokenByHash('h1'))?.idp, 'keycloak', 'found by hash');
  assert.equal(await store.findScimTokenByHash('nope'), null, 'unknown hash → null');
  // Never the secret, only its hash: nothing on the record is the cleartext token.
  assert.equal((await store.findScimTokenByHash('h1'))?.tokenHash, 'h1');
  await store.touchScimToken('sct_1', now);
  assert.ok((await store.findScimTokenByHash('h1'))?.lastUsedAt, 'last-used stamped');
  // Revoke is one-way and idempotent-false: a revoked token is kept (still found)
  // with revokedAt set, and a second revoke reports nothing to do.
  assert.equal(await store.revokeScimToken('sct_1', now), true);
  assert.ok((await store.findScimTokenByHash('h1'))?.revokedAt, 'revoked, not deleted');
  assert.equal(await store.revokeScimToken('sct_1', now), false, 'already revoked → false');
  assert.equal(await store.revokeScimToken('nope', now), false, 'unknown id → false');

  // ── listUsersPage: filter + sort + paginate + total ───────────────────────
  // A unique group isolates these rows from users seeded earlier, so counts are
  // deterministic across drivers.
  const PG = 'pagetest';
  const seedRows: Array<[string, string, string]> = [
    ['Xavier', 'Ng', 'xn@pg'], ['Yara', 'Bloom', 'yb@pg'], ['Zoe', 'Ash', 'za@pg'],
    ['Wade', 'Cole', 'wc@pg'], ['Vera', 'Dane', 'vd@pg'],
  ];
  for (const [firstname, lastname, email] of seedRows) {
    await store.upsertUserBySub({ sub: `pg:${email}`, email, firstname, lastname, groups: [PG], role: 'member' });
  }
  // name sort asc: Vera, Wade, Xavier, Yara, Zoe - paginate 2 at a time
  const page1 = await store.listUsersPage({ group: PG, sort: 'name', dir: 'asc', limit: 2, offset: 0 });
  assert.equal(page1.total, 5, 'total is the full match count, not the page');
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.rows[0]?.firstname, 'Vera');
  assert.equal(page1.rows[1]?.firstname, 'Wade');
  const page3 = await store.listUsersPage({ group: PG, sort: 'name', dir: 'asc', limit: 2, offset: 4 });
  assert.equal(page3.rows.length, 1);
  assert.equal(page3.rows[0]?.firstname, 'Zoe');
  // q: case-insensitive substring on name/email
  const byQ = await store.listUsersPage({ group: PG, q: 'ASH', limit: 10, offset: 0 });
  assert.equal(byQ.total, 1);
  assert.equal(byQ.rows[0]?.firstname, 'Zoe');
  // email sort desc
  const byEmail = await store.listUsersPage({ group: PG, sort: 'email', dir: 'desc', limit: 1, offset: 0 });
  assert.equal(byEmail.rows[0]?.email, 'za@pg');
  // status filter after disabling one
  await store.setUserDisabled((await store.getUserBySub('pg:wc@pg'))!.id, now);
  assert.equal((await store.listUsersPage({ group: PG, status: 'active', limit: 10, offset: 0 })).total, 4);
  const disRows = await store.listUsersPage({ group: PG, status: 'disabled', limit: 10, offset: 0 });
  assert.equal(disRows.total, 1);
  assert.equal(disRows.rows[0]?.firstname, 'Wade');
  // consent is stored (it drives ingest attribution) but is deliberately NOT a
  // list filter - opting out must not be enumerable (plans/09 §2a)
  await store.setTelemetryConsent((await store.getUserBySub('pg:xn@pg'))!.id, true);
  assert.equal((await store.getUserBySub('pg:xn@pg'))?.telemetryConsent, true);
  // prefix (jump-to-letter): first letter of the name key; '#' = non a–z
  const byPrefix = await store.listUsersPage({ group: PG, prefix: 'w', limit: 10, offset: 0 });
  assert.equal(byPrefix.total, 1, 'prefix w matches Wade only');
  assert.equal(byPrefix.rows[0]?.firstname, 'Wade');
  assert.equal((await store.listUsersPage({ group: PG, prefix: 'q', limit: 10, offset: 0 })).total, 0, 'empty letter → none');
  await store.upsertUserBySub({ sub: 'pg:9@pg', email: '9lives@pg', groups: [PG], role: 'member' });
  const byHash = await store.listUsersPage({ group: PG, prefix: '#', limit: 10, offset: 0 });
  assert.equal(byHash.total, 1, "'#' catches names not starting with a letter");
  assert.equal(byHash.rows[0]?.email, '9lives@pg');
  // prefix composes with the other filters
  assert.equal((await store.listUsersPage({ group: PG, prefix: 'w', status: 'disabled', limit: 10, offset: 0 })).total, 1);
  assert.equal((await store.listUsersPage({ group: PG, prefix: 'v', status: 'disabled', limit: 10, offset: 0 })).total, 0);
  // Access requests (migration 0044): one open row per (kind, email,
  // project, invitation); a row past its expiry reads as expired, is never
  // answered, and makes way for a new one; of two racing answers one wins.
  const reqAt = '2026-10-07T00:00:00.000Z';
  const reqDay = (n: number): string => new Date(Date.parse(reqAt) + n * 86_400_000).toISOString();
  const asker = await store.upsertUserBySub({ sub: 'req-asker', email: 'Asker@Example.com', groups: [], role: 'member' });
  const asker2 = await store.upsertUserBySub({ sub: 'req-asker-2', email: 'asker2@example.com', groups: [], role: 'member' });
  const ask = {
    kind: 'project' as const, status: 'open' as const, email: 'Asker@Example.com', userId: asker.id, name: 'Asker A',
    projectId: 'prj_p', viaSessionId: 'ses_x', role: 'editor' as const, currentRole: 'viewer' as const, note: 'please <b>',
    createdAt: reqAt, expiresAt: reqDay(14),
  };
  const filed = await store.createAccessRequest({ ...ask, id: 'req_1' }, reqAt);
  assert.equal(filed.created, true);
  assert.deepEqual(filed.request, { ...ask, id: 'req_1', email: 'asker@example.com' }, 'every field round-trips, lowercased email');
  assert.deepEqual(await store.getAccessRequest('req_1'), filed.request);
  assert.equal(await store.getAccessRequest('req_nope'), null);
  const again2 = await store.createAccessRequest({ ...ask, id: 'req_2', role: 'viewer', createdAt: reqDay(1), expiresAt: reqDay(15) }, reqDay(1));
  assert.equal(again2.created, false, 'one open request per key');
  assert.equal(again2.request.id, 'req_1');
  assert.equal(again2.request.role, 'editor', 'the open row is returned unchanged');
  assert.equal(await store.getAccessRequest('req_2'), null, 'no second row was written');
  assert.equal((await store.createAccessRequest({ ...ask, id: 'req_3', projectId: 'prj_t' }, reqAt)).created, true, 'another project is another key');
  await store.createAccessRequest({ ...ask, id: 'req_4', email: 'asker2@example.com', userId: asker2.id, role: 'viewer', note: undefined, viaSessionId: undefined }, reqAt);
  assert.equal((await store.getAccessRequest('req_4'))?.note, undefined, 'an absent note reads as absent');

  const openIds = async (q: Omit<Parameters<Store['listAccessRequests']>[0], 'status' | 'now'>, now = reqDay(1)) =>
    (await store.listAccessRequests({ status: 'open', now, ...q })).map((r) => r.id);
  assert.deepEqual(await openIds({}), ['req_1', 'req_3', 'req_4'], 'oldest first');
  assert.deepEqual(await openIds({ projectIds: ['prj_t'] }), ['req_3']);
  assert.deepEqual(await openIds({ email: ' ASKER@example.com ' }), ['req_1', 'req_3']);
  assert.deepEqual(await openIds({ userId: asker2.id }), ['req_4']);
  assert.deepEqual(await openIds({ kinds: ['join'] }), []);
  assert.deepEqual(await openIds({ limit: 1 }), ['req_1']);

  const [won1, won2] = await Promise.all([
    store.answerAccessRequest('req_3', { status: 'approved', at: reqDay(1), by: 'user:u1', role: 'viewer' }, reqDay(1)),
    store.answerAccessRequest('req_3', { status: 'declined', at: reqDay(1), by: 'user:u2' }, reqDay(1)),
  ]);
  assert.equal([won1, won2].filter(Boolean).length, 1, 'exactly one of two racing answers wins');
  const answered = (won1 ?? won2)!;
  assert.equal((await store.getAccessRequest('req_3'))?.status, answered.status);
  if (answered.status === 'approved') assert.equal(answered.answerRole, 'viewer');
  assert.equal(answered.answeredAt, reqDay(1));
  assert.equal(await store.answerAccessRequest('req_3', { status: 'withdrawn', at: reqDay(2) }, reqDay(2)), null, 'an answered request stays answered');
  assert.equal(await store.answerAccessRequest('req_nope', { status: 'withdrawn', at: reqDay(2) }, reqDay(2)), null);
  assert.deepEqual(await openIds({}), ['req_1', 'req_4']);

  // Past its expiry an open row is refused, reported as expired, and makes
  // way for a new request with the same key.
  assert.equal(await store.answerAccessRequest('req_1', { status: 'approved', at: reqDay(14), by: 'user:u1' }, reqDay(14)), null, 'an expired request is never answered');
  assert.deepEqual(await openIds({}, reqDay(14)), [], 'expired at its expiry instant');
  const answeredRows = await store.listAccessRequests({ status: 'answered', now: reqDay(14), kinds: ['project'] });
  assert.deepEqual(answeredRows.map((r) => [r.id, r.status]), [['req_4', 'expired'], ['req_1', 'expired'], ['req_3', answered.status]],
    'newest answer or expiry first (then id), expired rows reported as expired');
  assert.deepEqual((await store.listAccessRequests({ status: 'answered', now: reqDay(14), answeredSince: reqDay(2) })).map((r) => r.id).sort(), ['req_1', 'req_4']);
  const renewed = await store.createAccessRequest({ ...ask, id: 'req_5', createdAt: reqDay(15), expiresAt: reqDay(29) }, reqDay(15));
  assert.equal(renewed.created, true, 'an expired open row makes way');
  assert.equal((await store.getAccessRequest('req_1'))?.status, 'expired', 'and is marked expired');
  assert.equal((await store.getAccessRequest('req_4'))?.status, 'open', 'another key is left as it was');

  // Supersede: closes only live open rows that match, honouring roleAtMost.
  await store.createAccessRequest({ ...ask, id: 'req_6', email: 'asker2@example.com', userId: asker2.id, role: 'viewer', createdAt: reqDay(15), expiresAt: reqDay(29) }, reqDay(15));
  const superseded = { status: 'superseded' as const, at: reqDay(16), by: 'user:u1' };
  assert.deepEqual((await store.closeAccessRequests({ kind: 'project', projectId: 'prj_p', roleAtMost: 'viewer' }, superseded, reqDay(16))).map((r) => r.id), ['req_6'],
    'an editor request outranks a viewer grant');
  assert.equal((await store.getAccessRequest('req_6'))?.answeredBy, 'user:u1');
  assert.equal((await store.getAccessRequest('req_5'))?.status, 'open');
  const closedAll = await store.closeAccessRequests({ projectId: 'prj_p', userId: asker.id, roleAtMost: 'editor' }, superseded, reqDay(16));
  assert.deepEqual(closedAll.map((r) => [r.id, r.status]), [['req_5', 'superseded']]);
  assert.deepEqual(await store.closeAccessRequests({ projectId: 'prj_p' }, superseded, reqDay(16)), [], 'nothing open is left');

  // Join and switch requests carry the sign-in that proved the address;
  // the caps count by kind, address, invitation and time.
  const join = {
    kind: 'join' as const, status: 'open' as const, email: 'joiner@example.com', identitySub: 'github:42', idp: 'github', name: 'Jo',
    createdAt: reqAt, expiresAt: reqDay(14),
  };
  await store.createAccessRequest({ ...join, id: 'req_j1' }, reqAt);
  assert.equal((await store.getAccessRequest('req_j1'))?.identitySub, 'github:42');
  assert.equal(await store.countAccessRequests({ kind: 'join', email: 'joiner@example.com', now: reqAt }), 1);
  assert.equal(await store.countAccessRequests({ kind: 'join', openOnly: true, now: reqAt }), 1);
  await store.answerAccessRequest('req_j1', { status: 'withdrawn', at: reqDay(1) }, reqDay(1));
  assert.equal(await store.countAccessRequests({ kind: 'join', openOnly: true, now: reqDay(1) }), 0);
  assert.equal((await store.createAccessRequest({ ...join, id: 'req_j2', createdAt: reqDay(2), expiresAt: reqDay(16) }, reqDay(2))).created, true,
    'a withdrawn request does not block a new one');
  assert.equal(await store.countAccessRequests({ kind: 'join', email: 'JOINER@example.com', now: reqDay(2) }), 2);
  assert.equal(await store.countAccessRequests({ kind: 'join', email: 'joiner@example.com', since: reqDay(1), now: reqDay(2) }), 1);
  assert.equal(await store.countAccessRequests({ kind: 'project', email: 'joiner@example.com', now: reqDay(2) }), 0);
  const switchAsk = { ...join, kind: 'switch' as const, invitationId: 'inv_14', projectId: 'prj_p' };
  await store.createAccessRequest({ ...switchAsk, id: 'req_s1' }, reqAt);
  assert.equal((await store.createAccessRequest({ ...switchAsk, id: 'req_s2', email: 'someone@example.com' }, reqAt)).created, true);
  assert.equal(await store.countAccessRequests({ kind: 'switch', invitationId: 'inv_14', now: reqAt }), 2);
  assert.equal(await store.countAccessRequests({ kind: 'switch', invitationId: 'inv_15', now: reqAt }), 0);
  assert.deepEqual((await store.closeAccessRequests({ kind: 'switch', invitationId: 'inv_14', email: 'joiner@example.com' },
    { status: 'superseded', at: reqDay(1), by: 'user:u1' }, reqDay(1))).map((r) => r.id), ['req_s1']);

  await runCommentReadsAndNoticesConformance(store);
  await runErasureConformance(store);
}

/** Comment reads, inbox notices and mention sends (plan 76 M4, migrations 0051
 *  and 0052): the max rule, the floor recorded once, one coalesced notice per
 *  person and thread, the count cap, prune, delete by its own person only,
 *  mention sends recorded once, threads by ids, and erasure (S-14). */
async function runCommentReadsAndNoticesConformance(store: Store): Promise<void> {
  const base = Date.now() - 2 * 86_400_000;
  const t = (minutes: number): string => new Date(base + minutes * 60_000).toISOString();
  const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));
  const user = (sub: string) => store.upsertUserBySub({ sub, email: `${sub}@example.invalid`, groups: [], role: 'member' });
  const owner = await user('cn-owner'), reader = await user('cn-reader'), actor = await user('cn-actor');
  const other = await user('cn-other'), pruned = await user('cn-pruned');
  await store.putProject({ id: 'prj_cn', name: 'Review', visibility: 'private', ownerId: owner.id, createdAt: t(0) });
  for (const id of ['ses_cn1', 'ses_cn2']) {
    await store.putSession({ id, projectId: 'prj_cn', toolId: 'poster', toolVersion: '1.0.0', inputs: {}, meta: {},
      createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: t(0) });
  }
  const thread = (id: string, sessionId: string): CommentThread => ({
    id, sessionId, anchor: { kind: 'canvas', surface: 'page-1', x: 10, y: 20 }, authorId: actor.id, authorName: 'Ana',
    revision: 1, createdAt: t(0), updatedAt: t(0),
    messages: [{ id: 'm1', authorId: actor.id, authorName: 'Ana', body: 'First note', createdAt: t(0) }],
  });
  for (const [id, sessionId] of [['thr_cn_a', 'ses_cn1'], ['thr_cn_b', 'ses_cn1'], ['thr_cn_c', 'ses_cn2'],
    ['thr_cn_p1', 'ses_cn2'], ['thr_cn_p2', 'ses_cn2'], ['thr_cn_p3', 'ses_cn2'], ['thr_cn_p4', 'ses_cn2']] as const) {
    assert.equal(await store.createCommentThread(thread(id, sessionId)), 'created');
  }

  // Reads: the floor is recorded once per person and document; a read time
  // only moves forward and never past now; other documents' threads are ignored.
  const before = Date.now();
  const first = await store.readCommentState(reader.id, 'ses_cn1');
  assert.deepEqual(first.reads, {});
  assert.ok(Date.parse(first.floorAt) >= before - 1 && Date.parse(first.floorAt) <= Date.now(), 'the floor is the current time');
  await pause();
  assert.equal((await store.readCommentState(reader.id, 'ses_cn1')).floorAt, first.floorAt, 'the floor is recorded once');
  for (const [userId, sessionId] of [[reader.id, 'ses_cn_none'], ['usr_cn_none', 'ses_cn1']] as const) {
    const a = await store.readCommentState(userId, sessionId);
    await pause();
    const b = await store.readCommentState(userId, sessionId);
    assert.deepEqual(b.reads, {});
    assert.ok(Date.parse(b.floorAt) > Date.parse(a.floorAt), 'an unknown person or document records no floor');
  }
  await store.markCommentsRead(reader.id, 'ses_cn1', [
    { threadId: 'thr_cn_a', at: t(10) },
    { threadId: 'thr_cn_c', at: t(10) }, // another document's thread
    { threadId: 'thr_cn_none', at: t(10) },
    { threadId: 'thr_cn_b', at: 'not a time' },
  ]);
  assert.deepEqual((await store.readCommentState(reader.id, 'ses_cn1')).reads, { thr_cn_a: t(10) });
  await store.markCommentsRead(reader.id, 'ses_cn1', [{ threadId: 'thr_cn_a', at: t(5) }]);
  assert.deepEqual((await store.readCommentState(reader.id, 'ses_cn1')).reads, { thr_cn_a: t(10) }, 'an earlier time never lowers a read');
  await store.markCommentsRead(reader.id, 'ses_cn1', [
    { threadId: 'thr_cn_a', at: t(20) }, { threadId: 'thr_cn_a', at: t(15) }, { threadId: 'thr_cn_b', at: t(12) },
  ]);
  assert.deepEqual((await store.readCommentState(reader.id, 'ses_cn1')).reads, { thr_cn_a: t(20), thr_cn_b: t(12) },
    'the latest of repeated entries wins');
  const beforeFuture = Date.now();
  await store.markCommentsRead(reader.id, 'ses_cn1', [{ threadId: 'thr_cn_b', at: new Date(Date.now() + 86_400_000).toISOString() }]);
  const clamped = Date.parse((await store.readCommentState(reader.id, 'ses_cn1')).reads.thr_cn_b!);
  assert.ok(clamped >= beforeFuture - 1 && clamped <= Date.now(), 'a read time is never later than now');
  assert.deepEqual((await store.readCommentState(other.id, 'ses_cn1')).reads, {}, 'reads are private to each person');
  assert.deepEqual((await store.readCommentState(reader.id, 'ses_cn2')).reads, {}, 'reads belong to their document');
  await store.markCommentsRead('usr_cn_none', 'ses_cn1', [{ threadId: 'thr_cn_a', at: t(10) }]);
  await store.markCommentsRead(reader.id, 'ses_cn1', []);

  // Notices: one row per (person, thread). A retry of the same message keeps
  // the count; a new message adds one and moves the row to its time; a mention
  // stays a mention.
  const write = (over: Partial<CommentNoticeWrite>): CommentNoticeWrite => ({
    userId: reader.id, threadId: 'thr_cn_a', sessionId: 'ses_cn1', projectId: 'prj_cn', kind: 'reply',
    actorId: actor.id, messageId: 'm2', at: t(30), mentioned: false, ...over,
  });
  const readerA = commentNoticeId(reader.id, 'thr_cn_a');
  assert.match(readerA, /^cn_[0-9a-f]{24}$/);
  assert.notEqual(commentNoticeId(other.id, 'thr_cn_a'), readerA);
  const notice = async (userId: string, threadId: string) =>
    (await store.listCommentNotices(userId)).find((n) => n.threadId === threadId);
  assert.equal(await store.upsertCommentNotice(write({})), 'created');
  assert.deepEqual(await store.listCommentNotices(reader.id), [{
    id: readerA, userId: reader.id, threadId: 'thr_cn_a', sessionId: 'ses_cn1', projectId: 'prj_cn', kind: 'reply',
    actorId: actor.id, messageId: 'm2', count: 1, createdAt: t(30),
  }], 'a notice holds ids, a count and a time');
  assert.equal(await store.upsertCommentNotice(write({ at: t(31) })), 'updated');
  assert.equal((await notice(reader.id, 'thr_cn_a'))?.count, 1, 'a retry of the same message does not raise the count');
  assert.equal((await notice(reader.id, 'thr_cn_a'))?.createdAt, t(30));
  assert.equal(await store.upsertCommentNotice(write({ messageId: 'm3', actorId: other.id, at: t(40) })), 'updated');
  assert.deepEqual(await notice(reader.id, 'thr_cn_a'), {
    id: readerA, userId: reader.id, threadId: 'thr_cn_a', sessionId: 'ses_cn1', projectId: 'prj_cn', kind: 'reply',
    actorId: other.id, messageId: 'm3', count: 2, createdAt: t(40),
  });
  await store.upsertCommentNotice(write({ messageId: 'm4', at: t(50), mentioned: true }));
  assert.equal((await notice(reader.id, 'thr_cn_a'))?.kind, 'mention');
  await store.upsertCommentNotice(write({ messageId: 'm5', actorId: other.id, at: t(60) }));
  assert.equal((await notice(reader.id, 'thr_cn_a'))?.kind, 'mention', 'a mention stays a mention');
  await store.upsertCommentNotice(write({ messageId: 'm6', actorId: other.id, at: t(45) }));
  assert.equal((await notice(reader.id, 'thr_cn_a'))?.count, 5);
  assert.equal((await notice(reader.id, 'thr_cn_a'))?.createdAt, t(60), 'an older message never moves the notice back');
  await store.upsertCommentNotice(write({ messageId: 'm6', actorId: other.id, at: t(45), mentioned: true }));
  assert.equal((await notice(reader.id, 'thr_cn_a'))?.count, 5);
  assert.equal(await store.upsertCommentNotice(write({ userId: other.id, at: t(35), mentioned: true })), 'created');
  assert.equal((await notice(other.id, 'thr_cn_a'))?.kind, 'mention', 'a first write can be a mention');

  // The count stops at its cap and later updates still succeed.
  for (let i = 0; i <= COMMENT_NOTICE_COUNT_MAX; i++) {
    await store.upsertCommentNotice(write({ threadId: 'thr_cn_b', messageId: `c${i}`, at: t(100) }));
  }
  assert.equal((await notice(reader.id, 'thr_cn_b'))?.count, COMMENT_NOTICE_COUNT_MAX);
  assert.equal(await store.upsertCommentNotice(write({ threadId: 'thr_cn_b', messageId: 'c-last', at: t(100) })), 'updated');
  assert.equal((await notice(reader.id, 'thr_cn_b'))?.count, COMMENT_NOTICE_COUNT_MAX);

  // A notice needs a real person, thread, document and project.
  await assert.rejects(store.upsertCommentNotice(write({ threadId: 'thr_cn_none' })));
  await assert.rejects(store.upsertCommentNotice(write({ userId: 'usr_cn_none' })));
  await assert.rejects(store.upsertCommentNotice(write({ threadId: 'thr_cn_c', sessionId: 'ses_cn_none' })));
  await assert.rejects(store.upsertCommentNotice(write({ threadId: 'thr_cn_c', sessionId: 'ses_cn2', projectId: 'prj_cn_none' })));
  assert.equal(await notice(reader.id, 'thr_cn_c'), undefined);

  // Newest first, then by id; the limit applies.
  await store.upsertCommentNotice(write({ threadId: 'thr_cn_c', sessionId: 'ses_cn2', messageId: 'm1', at: t(100) }));
  const sameTime = [commentNoticeId(reader.id, 'thr_cn_b'), commentNoticeId(reader.id, 'thr_cn_c')].sort().reverse();
  assert.deepEqual((await store.listCommentNotices(reader.id)).map((n) => n.id), [...sameTime, readerA]);
  assert.deepEqual((await store.listCommentNotices(reader.id, 1)).map((n) => n.id), [sameTime[0]]);

  // The actor backstop counts the notices whose newest event the actor caused.
  assert.equal(await store.countNoticesByActorSince(actor.id, t(0)), 3);
  assert.equal(await store.countNoticesByActorSince(actor.id, t(36)), 2);
  assert.equal(await store.countNoticesByActorSince(other.id, t(0)), 1);
  assert.equal(await store.countNoticesByActorSince('usr_cn_none', t(0)), 0);

  // Delete: only ever the given person's rows, and nothing for an empty filter.
  assert.equal(await store.deleteCommentNotices(other.id, { ids: [readerA], threadIds: ['thr_cn_b'], sessionIds: ['ses_cn2'] }), 0,
    "another person's ids delete nothing");
  assert.equal(await store.deleteCommentNotices(reader.id, {}), 0);
  assert.equal(await store.deleteCommentNotices(reader.id, { ids: [], threadIds: [], sessionIds: [] }), 0);
  assert.equal((await store.listCommentNotices(reader.id)).length, 3);
  assert.equal(await store.deleteCommentNotices(reader.id, { threadIds: ['thr_cn_b'] }), 1);
  assert.equal(await store.deleteCommentNotices(reader.id, { sessionIds: ['ses_cn2'] }), 1);
  assert.equal(await store.deleteCommentNotices(reader.id, { ids: [readerA, 'cn_none'] }), 1);
  assert.deepEqual(await store.listCommentNotices(reader.id), []);
  assert.equal((await store.listCommentNotices(other.id)).length, 1, "the other person's notice is kept");
  assert.equal(await store.upsertCommentNotice(write({ messageId: 'm7', at: t(70) })), 'created', 'a reply after an ack is a new notice');
  assert.equal((await notice(reader.id, 'thr_cn_a'))?.count, 1);

  // Prune: keep the newest `keep` and nothing older than the cutoff.
  for (const [threadId, at] of [['thr_cn_p1', t(-50 * 1440)], ['thr_cn_p2', t(10)], ['thr_cn_p3', t(20)], ['thr_cn_p4', t(30)]] as const) {
    await store.upsertCommentNotice(write({ userId: pruned.id, threadId, sessionId: 'ses_cn2', at }));
  }
  assert.equal(await store.pruneCommentNotices(pruned.id, 2, t(-30 * 1440)), 2);
  assert.deepEqual((await store.listCommentNotices(pruned.id)).map((n) => n.threadId), ['thr_cn_p4', 'thr_cn_p3']);
  assert.equal(await store.pruneCommentNotices(pruned.id, 5, t(25)), 1);
  assert.deepEqual((await store.listCommentNotices(pruned.id)).map((n) => n.threadId), ['thr_cn_p4']);
  assert.equal((await store.listCommentNotices(reader.id)).length, 1, "prune leaves other people's notices alone");
  await assert.rejects(store.pruneCommentNotices(pruned.id, Number.NaN, t(0)), RangeError, 'a bad keep count deletes nothing');
  await assert.rejects(store.pruneCommentNotices(pruned.id, -1, t(0)), RangeError);
  assert.equal((await store.listCommentNotices(pruned.id, Number.NaN)).length, 1, 'a bad limit reads as the default');

  // Mention sends: each person once per message, in the order given; unknown
  // people and threads are skipped; a message id belongs to its thread.
  assert.deepEqual(await store.recordMentionSends('thr_cn_a', 'm4', [reader.id, other.id, reader.id, 'usr_cn_none'], t(50)), [reader.id, other.id]);
  assert.deepEqual(await store.recordMentionSends('thr_cn_a', 'm4', [other.id, owner.id], t(51)), [owner.id]);
  assert.deepEqual(await store.recordMentionSends('thr_cn_b', 'm4', [reader.id], t(52)), [reader.id]);
  assert.deepEqual(await store.recordMentionSends('thr_cn_none', 'm4', [reader.id], t(52)), []);
  assert.deepEqual(await store.recordMentionSends('thr_cn_a', 'm8', [], t(52)), []);

  // Threads by ids: one read, in the order first given, unknown ids skipped.
  const [threadA, threadC] = [await store.getCommentThread('thr_cn_a'), await store.getCommentThread('thr_cn_c')];
  assert.deepEqual(await store.getCommentThreadsByIds(['thr_cn_c', 'thr_cn_none', 'thr_cn_a', 'thr_cn_c']), [threadC, threadA]);
  assert.deepEqual(await store.getCommentThreadsByIds([]), []);

  // Deleting a person removes their reads and received notices.
  const leaving = await user('cn-leaving');
  await store.upsertCommentNotice(write({ userId: leaving.id, threadId: 'thr_cn_c', sessionId: 'ses_cn2', actorId: owner.id, at: t(80) }));
  await store.markCommentsRead(leaving.id, 'ses_cn2', [{ threadId: 'thr_cn_c', at: t(80) }]);
  assert.equal(await store.deleteUser(leaving.id), true);
  assert.deepEqual(await store.listCommentNotices(leaving.id), []);
  assert.deepEqual((await store.readCommentState(leaving.id, 'ses_cn2')).reads, {});

  // S-14: erasure removes the person's reads, received notices and mention
  // sends, and the notices they caused; shared threads are unchanged.
  await store.upsertCommentNotice(write({ userId: other.id, threadId: 'thr_cn_b', actorId: owner.id, messageId: 'm9', at: t(90) }));
  assert.deepEqual(await store.eraseUserAccount(reader.id), { status: 'erased', scrubbed: 0 }, 'comment state never blocks erasure');
  assert.deepEqual(await store.listCommentNotices(reader.id), []);
  assert.deepEqual((await store.readCommentState(reader.id, 'ses_cn1')).reads, {});
  assert.deepEqual(await store.recordMentionSends('thr_cn_a', 'm4', [other.id, owner.id], t(53)), [], "other people's mention sends are kept");
  assert.deepEqual(await store.eraseUserAccount(actor.id), { status: 'erased', scrubbed: 0 });
  assert.deepEqual((await store.listCommentNotices(other.id)).map((n) => n.threadId), ['thr_cn_b'], 'the notices the actor caused are gone');
  assert.deepEqual(await store.listCommentNotices(pruned.id), []);
  assert.equal(await store.countNoticesByActorSince(actor.id, t(-100 * 1440)), 0);
  assert.deepEqual(await store.getCommentThread('thr_cn_a'), threadA, 'shared threads are unchanged');
  assert.deepEqual(await store.getCommentThreadsByIds(['thr_cn_a', 'thr_cn_c']), [threadA, threadC]);
}
