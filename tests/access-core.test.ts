/**
 * The access requests core (plans/74 invite spec 2.9; security rules 8, 9,
 * 10, 13, 20 and 22), driven against the memory store with a fixed clock:
 * what filing stores and tells, the caps, who may answer, expiry, and how
 * requests close when access arrives another way.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approversFor, closeRequestsForEmail, closeRequestsOnAccess, fileRequest, invitationLive, providerName, requestStateFor,
  retireRequestNotice, requestsAllowed,
} from '../server/src/access/requests.ts';
import type { RequestDeps } from '../server/src/access/types.ts';
import { parseConfig, type InstanceConfig } from '../server/src/config/instance.ts';
import { createNotifier } from '../server/src/notify/notify.ts';
import { createPeopleNotifier } from '../server/src/notify/people.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { UserRecord } from '../server/src/store/types.ts';

const DAY = 86_400_000;
const START = Date.parse('2026-10-04T10:00:00.000Z');

async function setup(requests: Record<string, unknown> = {}) {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'lolly.ing', baseUrl: 'https://lolly.ing' },
    policy: { defaultAccessMode: 'open', requests },
  }));
  const store = createMemoryStore();
  let clock = START;
  const iso = () => new Date(clock).toISOString();
  const d: RequestDeps = {
    store, config, now: () => clock,
    audit: (actor, action, subject, payload) => store.appendAudit({ at: iso(), actor, action, subject, ...(payload ? { payload } : {}) }),
    people: createPeopleNotifier({ store, config, notifier: createNotifier({ config, secrets: { session: 's', link: 'l' } }) }),
  };
  const user = (sub: string, groups: string[] = []) => store.upsertUserBySub({ sub, email: `${sub}@example.com`, firstname: sub, groups, role: 'member' });
  const owner = await user('olive');
  const admin = await user('ada', ['admin']);
  const manager = await user('max');
  const asker = await user('sam');
  await store.putProject({ id: 'prj_b', name: 'Weekend B', visibility: 'private', ownerId: owner.id, createdAt: iso() });
  await store.putProjectMember({ projectId: 'prj_b', userId: manager.id, role: 'manager', addedBy: `user:${owner.id}`, addedAt: iso() });
  const audits = async (action: string) => (await store.listAudit()).filter((e) => e.action === action);
  const messages = async () => store.listMessages();
  return {
    d, store, config, owner, admin, manager, asker, user, audits, messages,
    tick: (ms: number) => { clock += ms; },
    iso,
  };
}

const projectAsk = (user: UserRecord, over: Record<string, unknown> = {}) => ({
  kind: 'project' as const, user, projectId: 'prj_b', role: 'editor' as const, currentRole: 'none' as const, ...over,
});
const identity = { email: 'Sam.K@Gmail.com', idp: 'github', sub: 'github:42', name: 'Sam K' };

test('requests follow policy.requests: project on, join off, by default', async () => {
  const { config } = await setup();
  assert.deepEqual(config.policy.requests, { join: false, project: true, ttlDays: 14, joinOpenMax: 50 });
  assert.equal(requestsAllowed(config, 'project'), true);
  assert.equal(requestsAllowed(config, 'join'), false);
  assert.equal(requestsAllowed(config, 'switch'), true, 'a switch follows the live invitation');
  assert.equal(requestsAllowed(config, 'invite'), false, 'reserved');
});

test('a project request is stored, told to the owner and managers only, and audited without its note', async () => {
  const t = await setup();
  const filed = await fileRequest(t.d, projectAsk(t.asker, { note: '  For the <b>launch</b>  ', viaSessionId: 'ses_1', currentRole: 'viewer' }));
  assert.equal(filed.outcome, 'created');
  const r = filed.request!;
  assert.match(r.id, /^req_[A-Za-z0-9_-]+$/);
  assert.equal(r.email, 'sam@example.com');
  assert.equal(r.userId, t.asker.id);
  assert.equal(r.name, 'sam');
  assert.equal(r.note, 'For the <b>launch</b>', 'trimmed, otherwise raw');
  assert.equal(r.currentRole, 'viewer');
  assert.equal(r.expiresAt, new Date(START + 14 * DAY).toISOString());
  const [notice] = await t.messages();
  assert.equal(notice?.id, `msg_req_${r.id}`);
  assert.deepEqual(notice?.audience.users?.sort(), [t.owner.id, t.manager.id].sort(), 'not the admin: the project has managers');
  assert.equal(notice?.title, 'sam asks to edit Weekend B');
  assert.equal(notice?.endsAt, r.expiresAt);
  const [row] = await t.audits('access.request');
  assert.equal(row?.actor, `user:${t.asker.id}`);
  assert.equal(row?.subject, `request:${r.id}`);
  assert.deepEqual(row?.payload, {
    kind: 'project', requestId: r.id, email: 'sam@example.com', projectId: 'prj_b', viaSessionId: 'ses_1', role: 'editor', noteChars: 21,
  });
  assert.ok(!JSON.stringify(await t.store.listAudit()).includes('launch'), 'the note text is never audited');
});

test('filing again gives exists: one row, one notice, one audit row', async () => {
  const t = await setup();
  const first = await fileRequest(t.d, projectAsk(t.asker));
  t.tick(60_000);
  const again = await fileRequest(t.d, projectAsk(t.asker, { role: 'viewer', note: 'again' }));
  assert.equal(again.outcome, 'exists');
  assert.equal(again.request?.id, first.request?.id);
  assert.equal((await t.messages()).length, 1);
  assert.equal((await t.audits('access.request')).length, 1);
});

test('nothing to ask for is skipped, stores nothing and tells nobody', async () => {
  const t = await setup();
  await t.store.putProject({ id: 'prj_old', name: 'Old', visibility: 'private', ownerId: t.owner.id, createdAt: t.iso(), archivedAt: t.iso() });
  for (const [input, why] of [
    [projectAsk(t.asker, { projectId: 'prj_nope' }), 'an unknown project'],
    [projectAsk(t.asker, { projectId: 'prj_old' }), 'an archived project'],
    [projectAsk(t.asker, { currentRole: 'editor' }), 'already an editor'],
    [projectAsk(t.asker, { currentRole: 'manager', role: 'viewer' }), 'already more than asked'],
    [{ kind: 'join', identity }, 'join requests are off'],
  ] as const) {
    assert.deepEqual(await fileRequest(t.d, input as never), { outcome: 'skipped' }, why);
  }
  const off = await setup({ project: false });
  assert.deepEqual(await fileRequest(off.d, projectAsk(off.asker)), { outcome: 'skipped' }, 'project requests are off');
  for (const s of [t, off]) {
    assert.deepEqual(await s.store.listAccessRequests({ status: 'open', now: s.iso() }), []);
    assert.deepEqual(await s.messages(), []);
    assert.equal((await s.store.listAudit()).length, 0);
  }
});

test('a join request goes to the people who may invite, from a verified sign-in', async () => {
  const t = await setup({ join: true });
  const filed = await fileRequest(t.d, { kind: 'join', identity, note: 'E2E 8.5' });
  assert.equal(filed.outcome, 'created');
  assert.equal(filed.request?.email, 'sam.k@gmail.com');
  assert.equal(filed.request?.identitySub, 'github:42');
  assert.equal(filed.request?.idp, 'github');
  assert.equal(filed.request?.name, 'Sam K');
  assert.equal(filed.request?.userId, undefined);
  const [notice] = await t.messages();
  assert.deepEqual(notice?.audience.users, [t.admin.id], 'admins and owners; not the project manager');
  assert.equal(notice?.title, 'Sam K asks to join lolly.ing');
  assert.equal((await t.audits('access.request'))[0]?.actor, 'anonymous', 'before admission there is no account');
});

test('join caps: three per address in 30 days, then held and audited; the workspace cap holds too', async () => {
  const t = await setup({ join: true });
  for (let i = 0; i < 3; i++) {
    const r = await fileRequest(t.d, { kind: 'join', identity });
    assert.equal(r.outcome, 'created');
    await t.store.answerAccessRequest(r.request!.id, { status: 'withdrawn', at: t.iso() }, t.iso());
    t.tick(DAY);
  }
  assert.deepEqual(await fileRequest(t.d, { kind: 'join', identity }), { outcome: 'held' });
  const [held] = await t.audits('access.request.held');
  assert.equal(held?.subject, 'request');
  assert.deepEqual(held?.payload, { kind: 'join', email: 'sam.k@gmail.com', reason: 'per-email' });
  t.tick(30 * DAY);
  assert.equal((await fileRequest(t.d, { kind: 'join', identity })).outcome, 'created', 'the window moves on');

  const full = await setup({ join: true, joinOpenMax: 2 });
  assert.equal((await fileRequest(full.d, { kind: 'join', identity: { ...identity, email: 'a@x.example' } })).outcome, 'created');
  assert.equal((await fileRequest(full.d, { kind: 'join', identity: { ...identity, email: 'b@x.example' } })).outcome, 'created');
  assert.deepEqual(await fileRequest(full.d, { kind: 'join', identity: { ...identity, email: 'c@x.example' } }), { outcome: 'held' });
  assert.equal((await full.audits('access.request.held'))[0]?.payload?.reason, 'workspace-cap');
  assert.equal((await fileRequest(full.d, { kind: 'join', identity: { ...identity, email: 'a@x.example' } })).outcome, 'exists',
    'an open request is still found under the cap');
});

test('a switch request needs a live invitation for another address, and is capped per invitation', async () => {
  const t = await setup();
  await t.store.createInvitation({
    id: 'inv_w1', email: 'w1@suse.example', groups: [], invitedBy: `user:${t.owner.id}`, createdAt: t.iso(),
    expiresAt: new Date(START + 30 * DAY).toISOString(), projects: [{ projectId: 'prj_b', role: 'editor', invitedBy: `user:${t.owner.id}` }],
  });
  const sw = (over: Record<string, unknown> = {}) => fileRequest(t.d, { kind: 'switch', identity, invitationId: 'inv_w1', projectId: 'prj_b', ...over } as never);
  const filed = await sw({ userId: t.asker.id, note: 'E2E 8.6' });
  assert.equal(filed.outcome, 'created');
  assert.equal(filed.request?.invitationId, 'inv_w1');
  assert.equal(filed.request?.projectId, 'prj_b');
  assert.equal(filed.request?.userId, t.asker.id);
  const [notice] = await t.messages();
  assert.deepEqual(notice?.audience.users, [t.owner.id, t.manager.id, t.admin.id], 'the link project\'s managers, then who may invite');
  assert.match(notice?.body ?? '', /invitation for w•••@suse\.example signed in as sam\.k@gmail\.com/);
  assert.equal((await t.audits('access.request'))[0]?.actor, `user:${t.asker.id}`);

  assert.equal((await sw({ projectId: 'prj_other', identity: { ...identity, email: 'x@y.example' } })).request?.projectId, undefined,
    'a project the invitation does not carry reads as a workspace link');
  assert.equal((await sw({ identity: { ...identity, email: 'z@y.example' } })).outcome, 'created');
  assert.deepEqual(await sw({ identity: { ...identity, email: 'q@y.example' } }), { outcome: 'held' }, 'three a day per invitation');
  assert.equal((await t.audits('access.request.held'))[0]?.payload?.reason, 'per-invitation');
  assert.deepEqual(await sw({ identity: { ...identity, email: 'W1@suse.example' } }), { outcome: 'skipped' }, 'the invited address just accepts');
  assert.deepEqual(await sw({ invitationId: 'inv_nope' }), { outcome: 'skipped' });
  await t.store.revokeInvitation('inv_w1', t.iso());
  assert.deepEqual(await sw({ identity: { ...identity, email: 'r@y.example' } }), { outcome: 'skipped' }, 'a revoked invitation');
});

test('approvers are worked out now: a demoted or disabled manager drops out, admins step in when nobody manages', async () => {
  const t = await setup();
  const { request } = await fileRequest(t.d, projectAsk(t.asker));
  const ids = async () => (await approversFor(t.d, request!)).map((u) => u.id).sort();
  assert.deepEqual(await ids(), [t.owner.id, t.manager.id].sort());
  await t.store.updateProjectMemberRole('prj_b', t.manager.id, 'editor');
  assert.deepEqual(await ids(), [t.owner.id], 'a demoted manager is no longer asked');
  await t.store.setUserDisabled(t.owner.id, t.iso());
  assert.deepEqual(await ids(), [t.admin.id], 'with no enabled manager, admins manage through project.manage');
  assert.deepEqual(await approversFor(t.d, { ...request!, projectId: 'prj_gone' }), [], 'an unknown project has nobody');
  const self = await approversFor(t.d, { ...request!, userId: t.admin.id });
  assert.ok(!self.some((u) => u.id === t.admin.id), 'nobody answers their own request');
});

test('approvers are capped at 50', async () => {
  const t = await setup({ join: true });
  for (let i = 0; i < 60; i++) await t.user(`admin${String(i).padStart(2, '0')}`, ['admin']);
  const { request } = await fileRequest(t.d, { kind: 'join', identity });
  assert.equal((await approversFor(t.d, request!)).length, 50);
  assert.equal((await t.messages())[0]?.audience.users?.length, 50);
});

test('nobody to answer means no notice, never a broadcast', async () => {
  const t = await setup({ join: true });
  await t.store.setUserDisabled(t.admin.id, t.iso());
  assert.equal((await fileRequest(t.d, { kind: 'join', identity })).outcome, 'created');
  assert.deepEqual(await t.messages(), [], 'the console still lists it');
});

test('a request and its notice expire after ttlDays; a new one can then be filed', async () => {
  const t = await setup({ ttlDays: 3 });
  const first = (await fileRequest(t.d, projectAsk(t.asker))).request!;
  assert.equal(first.expiresAt, new Date(START + 3 * DAY).toISOString());
  assert.equal((await t.messages())[0]?.endsAt, first.expiresAt, 'the notice goes on its own, no sweep');
  t.tick(3 * DAY);
  assert.deepEqual(await t.store.listAccessRequests({ status: 'open', now: t.iso() }), []);
  assert.equal(await t.store.answerAccessRequest(first.id, { status: 'approved', at: t.iso() }, t.iso()), null, 'too late to answer');
  const second = await fileRequest(t.d, projectAsk(t.asker));
  assert.equal(second.outcome, 'created');
  assert.notEqual(second.request?.id, first.id);
  assert.equal((await t.store.getAccessRequest(first.id))?.status, 'expired');
});

test('requestStateFor shows the open request and a refusal for seven days', async () => {
  const t = await setup({ join: true });
  assert.deepEqual(await requestStateFor(t.d, { kind: 'join', email: 'sam.k@gmail.com' }), {});
  const { request } = await fileRequest(t.d, { kind: 'join', identity });
  assert.equal((await requestStateFor(t.d, { kind: 'join', email: 'SAM.K@gmail.com' })).open?.id, request!.id);
  t.tick(DAY);
  await t.store.answerAccessRequest(request!.id, { status: 'declined', at: t.iso(), by: `user:${t.admin.id}` }, t.iso());
  const declined = await requestStateFor(t.d, { kind: 'join', email: 'sam.k@gmail.com' });
  assert.equal(declined.open, undefined);
  assert.equal(declined.lastDeclined?.id, request!.id);
  t.tick(8 * DAY);
  assert.deepEqual(await requestStateFor(t.d, { kind: 'join', email: 'sam.k@gmail.com' }), {}, 'after a week the form is back');
});

test('access given another way supersedes requests up to that role, retiring their notices', async () => {
  const t = await setup();
  const editor = (await fileRequest(t.d, projectAsk(t.asker))).request!;
  t.tick(1000);
  await closeRequestsOnAccess(t.d, { projectId: 'prj_b', userId: t.asker.id, role: 'viewer' }, `user:${t.owner.id}`);
  assert.equal((await t.store.getAccessRequest(editor.id))?.status, 'open', 'a viewer grant leaves an edit request open');
  await closeRequestsOnAccess(t.d, { projectId: 'prj_b', userId: t.asker.id, role: 'editor' }, `user:${t.owner.id}`);
  const closed = await t.store.getAccessRequest(editor.id);
  assert.equal(closed?.status, 'superseded');
  assert.equal(closed?.answeredBy, `user:${t.owner.id}`);
  assert.equal((await t.messages())[0]?.endsAt, t.iso(), 'the approvers\' notice ends now');
  const [row] = await t.audits('access.supersede');
  assert.equal(row?.actor, `user:${t.owner.id}`);
  assert.deepEqual(row?.payload, { kind: 'project', by: 'membership' });
  assert.equal((await t.messages()).filter((m) => m.id.startsWith('msg_ans_')).length, 0, 'no answer notice: the share says it');
});

test('an invitation for the address supersedes its join request and the switch requests on that invitation', async () => {
  const t = await setup({ join: true });
  for (const id of ['inv_a', 'inv_b']) {
    await t.store.createInvitation({ id, email: `${id}@suse.example`, groups: [], invitedBy: `user:${t.admin.id}`, createdAt: t.iso() });
  }
  const join = (await fileRequest(t.d, { kind: 'join', identity })).request!;
  const swA = (await fileRequest(t.d, { kind: 'switch', identity: { ...identity, email: 'p@q.example' }, invitationId: 'inv_a' })).request!;
  const swB = (await fileRequest(t.d, { kind: 'switch', identity: { ...identity, email: 'p@q.example' }, invitationId: 'inv_b' })).request!;
  await closeRequestsForEmail(t.d, { email: 'Sam.K@gmail.com', invitationId: 'inv_a' }, `user:${t.admin.id}`);
  assert.equal((await t.store.getAccessRequest(join.id))?.status, 'superseded');
  assert.equal((await t.store.getAccessRequest(swA.id))?.status, 'superseded');
  assert.equal((await t.store.getAccessRequest(swB.id))?.status, 'open', 'another invitation is untouched');
  assert.deepEqual((await t.audits('access.supersede')).map((e) => e.payload?.by), ['invitation', 'invitation']);
});

test('retiring a notice ends it now, once; an unknown one is left alone', async () => {
  const t = await setup();
  const r = (await fileRequest(t.d, projectAsk(t.asker))).request!;
  t.tick(5000);
  await retireRequestNotice(t.d, r);
  const ended = (await t.messages())[0];
  assert.equal(ended?.endsAt, t.iso());
  assert.equal(ended?.title, 'sam asks to edit Weekend B', 'the rest of the notice is kept');
  t.tick(5000);
  await retireRequestNotice(t.d, r);
  assert.equal((await t.messages())[0]?.endsAt, new Date(Date.parse(t.iso()) - 5000).toISOString(), 'an ended notice stays ended');
  await retireRequestNotice(t.d, { ...r, id: 'req_none' });
  assert.equal((await t.messages()).length, 1);
});

test('notes and names are cut to their limits', async () => {
  const t = await setup({ join: true });
  const r = (await fileRequest(t.d, { kind: 'join', identity: { ...identity, name: 'n'.repeat(200) }, note: '\u{1F600}'.repeat(300) })).request!;
  assert.equal(Array.from(r.note ?? '').length, 280);
  assert.equal(r.name?.length, 120);
  const blank = (await fileRequest(t.d, { kind: 'join', identity: { ...identity, email: 'blank@x.example', name: '  ' }, note: '   ' })).request!;
  assert.equal(blank.note, undefined);
  assert.equal(blank.name, undefined);
});

test('invitationLive and providerName', () => {
  const inv = { id: 'i', email: 'e@x', groups: [], invitedBy: 'u', createdAt: '2026-10-01T00:00:00.000Z', linkVersion: 1 };
  assert.equal(invitationLive(inv, START), true);
  assert.equal(invitationLive({ ...inv, expiresAt: '2026-10-04T10:00:00.000Z' }, START), false, 'ended at that instant');
  assert.equal(invitationLive({ ...inv, acceptedAt: '2026-10-02T00:00:00.000Z' }, START), false);
  assert.equal(invitationLive({ ...inv, revokedAt: '2026-10-02T00:00:00.000Z' }, START), false);
  const cfg = {
    idp: { issuer: 'https://accounts.google.com', displayName: 'Google', additional: [
      { id: 'github', kind: 'github', displayName: 'GitHub' }, { id: 'email', kind: 'password', displayName: 'Email and password' },
    ] },
    proxyAuth: { displayName: 'YunoHost' },
  } as unknown as Pick<InstanceConfig, 'idp' | 'proxyAuth'>;
  assert.equal(providerName(cfg, 'primary'), 'Google');
  assert.equal(providerName(cfg, 'github'), 'GitHub');
  assert.equal(providerName(cfg, 'email'), 'Email and password');
  assert.equal(providerName(cfg, 'proxy'), 'YunoHost');
  assert.equal(providerName(cfg, 'nope'), null);
  assert.equal(providerName(cfg, undefined), null);
});
