/**
 * Behavioural conformance suite every Store driver must pass - run against
 * memory always (store-memory.test.ts) and against Postgres when
 * LW_TEST_DATABASE_URL is set (store-postgres.test.ts). One suite, two
 * drivers: the seam stays honest.
 */
import assert from 'node:assert/strict';
import { verifyChain } from '../server/src/audit/chain.ts';
import { createApproval, type Chain } from '../server/src/approvals/engine.ts';
import type { Message } from '../server/src/inbox/target.ts';
import type { Store } from '../server/src/store/types.ts';

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
}
