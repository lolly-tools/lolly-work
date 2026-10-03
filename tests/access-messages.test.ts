/**
 * The people notices of invitations and access requests (plans/74 invite
 * spec 2.10; security rules 12, 19 and 20): every title, body, link, id and
 * end date, and what each one leaves out.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptedNotice, acceptedNoticeId, answerNotice, joinApprovedText, noticeContext, requestNotice, skippedNotice, welcomeNotice,
  type NoticeContext,
} from '../server/src/access/messages.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import type { AccessRequestRecord } from '../server/src/store/types.ts';

const ctx: NoticeContext = { workspace: 'lolly.ing', baseUrl: 'https://lolly.ing', appBase: '', at: '2026-10-04T10:00:00.000Z' };
const req = (over: Partial<AccessRequestRecord> = {}): AccessRequestRecord => ({
  id: 'req_1', kind: 'project', status: 'open', email: 'sam.k@gmail.com', userId: 'usr_sam', name: 'Sam Kim',
  projectId: 'prj_b', role: 'editor', currentRole: 'viewer',
  createdAt: '2026-10-04T10:00:00.000Z', expiresAt: '2026-10-18T10:00:00.000Z', ...over,
});

test('the context comes from the instance: name first, links without a trailing slash', () => {
  const config = parseConfig(JSON.stringify({ instance: { name: 'lolly.ing', baseUrl: 'https://lolly.ing/' }, policy: { defaultAccessMode: 'open' } }));
  assert.deepEqual(noticeContext(config, Date.parse(ctx.at)), ctx);
  const split = parseConfig(JSON.stringify({ instance: { name: 'W', baseUrl: 'https://w.example', appUrl: 'https://app.example/' }, policy: { defaultAccessMode: 'open' } }));
  assert.equal(noticeContext(split, 0).appBase, 'https://app.example');
});

test('a project request asks the approvers to review it on the project', () => {
  const m = requestNotice({ request: req({ note: 'For the\n  launch deck' }), approverIds: ['usr_a', 'usr_b'], provider: 'Google', projectName: 'Weekend B' }, ctx);
  assert.equal(m.id, 'msg_req_req_1');
  assert.equal(m.kind, 'request');
  assert.equal(m.severity, 'action');
  assert.deepEqual(m.audience, { users: ['usr_a', 'usr_b'] });
  assert.equal(m.title, 'Sam Kim asks to edit Weekend B');
  assert.equal(m.body, 'sam.k@gmail.com · Google · “For the launch deck”', 'the note on one line');
  assert.deepEqual(m.cta, { label: 'Review', url: '/#/team/project/prj_b' });
  assert.equal(m.endsAt, '2026-10-18T10:00:00.000Z', 'it goes when the request expires');
  assert.equal(m.dismissible, true);
  assert.deepEqual(m.data, {
    kind: 'access-request', at: ctx.at, requestId: 'req_1', requestKind: 'project', projectId: 'prj_b', role: 'editor', userId: 'usr_sam',
  });
  assert.equal(requestNotice({ request: req({ role: 'viewer' }), approverIds: ['usr_a'], projectName: 'Weekend B' }, ctx).title,
    'Sam Kim asks to view Weekend B');
  assert.equal(requestNotice({ request: req(), approverIds: ['usr_a'] }, ctx).body, 'sam.k@gmail.com', 'no provider, no note');
});

test('a split deploy links to the app; a session link is kept in data', () => {
  const m = requestNotice({ request: req({ viaSessionId: 'ses_9' }), approverIds: ['usr_a'], projectName: 'P' }, { ...ctx, appBase: 'https://app.example' });
  assert.equal(m.cta?.url, 'https://app.example/#/team/project/prj_b');
  assert.equal(m.data?.viaSessionId, 'ses_9');
});

test('a join request names the workspace and is answered in the console', () => {
  const m = requestNotice({
    request: req({ kind: 'join', userId: undefined, projectId: undefined, role: undefined, currentRole: undefined, idp: 'github', identitySub: 'github:1', note: 'E2E 8.5' }),
    approverIds: ['usr_a'], provider: 'GitHub',
  }, ctx);
  assert.equal(m.title, 'Sam Kim asks to join lolly.ing');
  assert.equal(m.body, 'sam.k@gmail.com · GitHub · “E2E 8.5”');
  assert.deepEqual(m.cta, { label: 'Review', url: 'https://lolly.ing/admin#/users' });
  assert.equal(m.data?.requestKind, 'join');
  assert.equal(m.data?.projectId, undefined);
});

test('a switch request carries the forwarded-link warning with the invited address masked', () => {
  const m = requestNotice({
    request: req({ kind: 'switch', userId: undefined, invitationId: 'inv_1', role: undefined, currentRole: undefined }),
    approverIds: ['usr_a'], provider: 'GitHub', maskedInvitee: 'an•••@suse.com',
  }, ctx);
  assert.equal(m.title, 'Sam Kim asks to use their own account for an invitation');
  assert.equal(m.body, 'sam.k@gmail.com · GitHub\nSomeone with the invitation for an•••@suse.com signed in as sam.k@gmail.com. '
    + 'Approve only if you know the address belongs to them.');
  assert.ok(!m.body?.includes('suse.com signed in as an'), 'the invited address appears only masked');
  assert.equal(m.data?.invitationId, 'inv_1');
  assert.equal(m.cta?.url, 'https://lolly.ing/admin#/users');
});

test('names never show an address, notes stay text, and long names are cut', () => {
  assert.equal(requestNotice({ request: req({ name: 'sam.k@gmail.com' }), approverIds: ['a'], projectName: 'P' }, ctx).title, 'sam.k asks to edit P');
  assert.equal(requestNotice({ request: req({ name: undefined }), approverIds: ['a'], projectName: 'P' }, ctx).title, 'sam.k asks to edit P');
  const html = requestNotice({ request: req({ note: '<b>x</b><script>alert(1)</script>' }), approverIds: ['a'], projectName: '<i>P</i>' }, ctx);
  assert.ok(html.body?.includes('“<b>x</b><script>alert(1)</script>”'), 'the note verbatim: the shell renders it as text');
  assert.equal(html.title, 'Sam Kim asks to edit <i>P</i>');
  const long = requestNotice({ request: req(), approverIds: ['a'], projectName: 'x'.repeat(300) }, ctx);
  assert.equal(long.title, `Sam Kim asks to edit ${'x'.repeat(120)}`, 'a project name is cut to 120 characters');
  assert.equal(requestNotice({ request: req(), approverIds: ['a'], projectName: '  ' }, ctx).title, 'Sam Kim asks to edit a project');
});

test('an approval names the approver and opens the project; a refusal names nobody', () => {
  const approver = { firstname: 'Andy', lastname: 'Fitz', email: 'andyfitz@gmail.com' };
  const yes = answerNotice({ request: req({ answerRole: 'viewer' }), outcome: 'approved', approver, projectName: 'Weekend B' }, ctx);
  assert.equal(yes.id, 'msg_ans_req_1');
  assert.equal(yes.kind, 'notice');
  assert.equal(yes.severity, 'info');
  assert.deepEqual(yes.audience, { users: ['usr_sam'] });
  assert.equal(yes.title, 'Andy Fitz gave you view access to Weekend B', 'the role given, not the role asked for');
  assert.deepEqual(yes.cta, { label: 'Open', url: '/#/team/project/prj_b' });
  assert.equal(yes.endsAt, '2026-11-03T10:00:00.000Z', '30 days');
  assert.equal(yes.data?.outcome, 'approved');
  assert.equal(yes.data?.role, 'viewer');
  assert.equal(answerNotice({ request: req(), outcome: 'approved', approver, projectName: 'W', role: 'manager' }, ctx).title,
    'Andy Fitz gave you manager access to W');
  assert.equal(answerNotice({ request: req(), outcome: 'approved', approver: { email: 'andyfitz@gmail.com' }, projectName: 'W' }, ctx).title,
    'andyfitz gave you edit access to W');
  const no = answerNotice({ request: req(), outcome: 'declined', approver, projectName: 'Weekend B' }, ctx);
  assert.equal(no.title, 'Your request for Weekend B was not approved');
  assert.equal(no.cta, undefined);
  assert.ok(!JSON.stringify(no).includes('Andy'), 'a refusal never says who manages the project');
  assert.equal(no.data?.role, undefined);
  assert.throws(() => answerNotice({ request: req({ userId: undefined }), outcome: 'approved', approver, projectName: 'W' }, ctx), /account/);
});

test('an accepted invitation tells each inviter once, about their own project', () => {
  const invitee = { id: 'usr_t1', firstname: 'Tess', email: 'andy.fitzsimon+t1@suse.com' };
  const withProject = acceptedNotice({ invitationId: 'inv_1', inviterId: 'usr_andy', invitee, project: { id: 'prj_a', name: 'Weekend A' } }, ctx);
  assert.equal(withProject.id, acceptedNoticeId('inv_1', 'usr_andy'));
  assert.match(withProject.id, /^msg_acc_[0-9a-f]{24}$/);
  assert.notEqual(withProject.id, acceptedNoticeId('inv_1', 'usr_priya'), 'one per inviter');
  assert.deepEqual(withProject.audience, { users: ['usr_andy'] });
  assert.equal(withProject.title, 'Tess accepted your invitation');
  assert.equal(withProject.body, 'andy.fitzsimon+t1@suse.com can now open Weekend A.');
  assert.deepEqual(withProject.cta, { label: 'Open', url: '/#/team/project/prj_a' });
  assert.equal(withProject.endsAt, '2026-11-03T10:00:00.000Z');
  const fromConsole = acceptedNotice({ invitationId: 'inv_1', inviterId: 'usr_andy', invitee, console: true }, ctx);
  assert.equal(fromConsole.body, 'andy.fitzsimon+t1@suse.com joined lolly.ing.');
  assert.deepEqual(fromConsole.cta, { label: 'Open People', url: 'https://lolly.ing/admin#/users?focus=usr_t1' });
  assert.equal(acceptedNotice({ invitationId: 'inv_1', inviterId: 'u', invitee }, ctx).cta, undefined);
  assert.equal(acceptedNotice({ invitationId: 'inv_1', inviterId: 'u', invitee: { id: 'x', email: 'sam@work.com' } }, ctx).title,
    'sam accepted your invitation');
});

test('a skipped project entry tells the invitee why and what to do', () => {
  const m = skippedNotice({ invitationId: 'inv_1', inviteeId: 'usr_t1', project: { id: 'prj_c', name: 'Weekend C' } }, ctx);
  assert.match(m.id, /^msg_skip_[0-9a-f]{24}$/);
  assert.notEqual(m.id, skippedNotice({ invitationId: 'inv_1', inviteeId: 'usr_t1', project: { id: 'prj_d', name: 'D' } }, ctx).id);
  assert.equal(m.title, 'Your invitation to Weekend C no longer works');
  assert.equal(m.body, 'The person who invited you can no longer add people to Weekend C, or the project was archived. '
    + 'Ask someone on the project to add you again.');
  assert.equal(m.cta, undefined);
  assert.equal(m.endsAt, undefined, 'it stays until dismissed');
});

test('the welcome names the inviter and the role, or the workspace when there is no name', () => {
  const inviter = { firstname: 'Andy', email: 'andyfitz@gmail.com' };
  const m = welcomeNotice({ invitationId: 'inv_1', inviteeId: 'usr_t1', inviter, project: { id: 'prj_a', name: 'Weekend A', role: 'editor' } }, ctx);
  assert.equal(m.id, 'msg_welcome_inv_1');
  assert.equal(m.title, 'Welcome to lolly.ing');
  assert.equal(m.body, 'Andy invited you. You can open Weekend A as an Editor.');
  assert.deepEqual(m.cta, { label: 'Open', url: '/#/team/project/prj_a' });
  assert.deepEqual(m.data, { kind: 'welcome', at: ctx.at, invitationId: 'inv_1', projectId: 'prj_a', role: 'editor' });
  assert.equal(welcomeNotice({ invitationId: 'inv_1', inviteeId: 'u', inviter, project: { id: 'p', name: 'P', role: 'viewer' } }, ctx).body,
    'Andy invited you. You can open P as a Viewer.');
  const plain = welcomeNotice({ invitationId: 'inv_2', inviteeId: 'usr_t2', inviter: null }, ctx);
  assert.equal(plain.body, 'lolly.ing invited you. Projects shared with you appear in Projects.');
  assert.equal(plain.cta, undefined);
});

test('every notice is personal: it names its audience and carries when it was written', () => {
  const all = [
    requestNotice({ request: req(), approverIds: ['a'], projectName: 'P' }, ctx),
    answerNotice({ request: req(), outcome: 'declined', approver: { email: 'a@b.c' }, projectName: 'P' }, ctx),
    acceptedNotice({ invitationId: 'i', inviterId: 'u', invitee: { id: 'x', email: 'x@y.z' } }, ctx),
    skippedNotice({ invitationId: 'i', inviteeId: 'x', project: { id: 'p', name: 'P' } }, ctx),
    welcomeNotice({ invitationId: 'i', inviteeId: 'x', inviter: null }, ctx),
  ];
  for (const m of all) {
    assert.ok(m.audience.users?.length, m.id);
    assert.equal(m.audience.groups, undefined, m.id);
    assert.equal(m.data?.at, ctx.at, m.id);
  }
});

test('the copied message after a join approval says where and as whom to sign in', () => {
  assert.equal(joinApprovedText({ email: 'sam.k@gmail.com', provider: 'GitHub' }, ctx),
    'You can now sign in to lolly.ing. Open https://lolly.ing and sign in as sam.k@gmail.com with GitHub.');
  assert.equal(joinApprovedText({ email: 'sam.k@gmail.com' }, { ...ctx, appBase: 'https://app.example' }),
    'You can now sign in to lolly.ing. Open https://app.example and sign in as sam.k@gmail.com.');
});
