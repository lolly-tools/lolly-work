/**
 * The people-notice seam (plans/74 invite spec 2.10, decision D5): every
 * notice reaches the inbox; nothing is emailed until email is switched on
 * and the sender can confirm delivery, so no result ever claims a mail that
 * was not sent. Comment mentions use the same seam (plan 76 milestone 4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../server/src/config/instance.ts';
import type { Message } from '../server/src/inbox/target.ts';
import { createNotifier, type Notifier } from '../server/src/notify/notify.ts';
import { createPeopleNotifier } from '../server/src/notify/people.ts';
import { createActorCap, mentionMailParts, recordCommentNotices } from '../server/src/comments/notices.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';

const config = (notify: unknown = undefined) => parseConfig(JSON.stringify({
  instance: { name: 'lolly.ing', baseUrl: 'https://lolly.ing' }, policy: { defaultAccessMode: 'open' }, ...(notify ? { notify } : {}),
}));
const SMTP = { host: 'relay.example', from: 'no-reply@lolly.ing' };
const notice = (users: string[] | undefined): Message => ({
  id: 'msg_welcome_inv_1', kind: 'notice', severity: 'info', audience: users ? { users } : {}, title: 'Welcome to lolly.ing', dismissible: true,
});

/** A notifier with the confirming send email will need, recording each call. */
function confirming(answer: boolean | Error = true) {
  const sent: Array<{ to: string; subject: string; fromName?: string }> = [];
  const n: Notifier & { emailNow(to: string, subject: string, text: string, fromName?: string): Promise<boolean> } = {
    email() { throw new Error('the people seam never sends and forgets'); },
    event() {},
    async idle() {},
    async emailNow(to, subject, _text, fromName) {
      if (answer instanceof Error) throw answer;
      sent.push({ to, subject, ...(fromName ? { fromName } : {}) });
      return answer;
    },
  };
  return { n, sent };
}

test('people email is off by default, and the key is validated', () => {
  assert.deepEqual(config().notify.people, { email: false });
  assert.equal(config({ people: { email: true, fromName: '  lolly.ing  ' } }).notify.people.fromName, 'lolly.ing', 'trimmed');
  assert.throws(() => config({ people: { email: 'yes' } }), /notify\.people\.email/);
  assert.throws(() => config({ people: { email: true, fromName: 'x'.repeat(61) } }), /notify\.people\.fromName/);
  assert.throws(() => config({ people: { email: true, fromName: 'two\nlines' } }), /notify\.people\.fromName/);
  assert.throws(() => config({ people: { email: true, fromName: '' } }), /notify\.people\.fromName/);
});

test('email stays off unless it is switched on, a relay is set and the sender can confirm delivery', async () => {
  const store = createMemoryStore();
  const plain = createNotifier({ config: config({ smtp: SMTP, people: { email: true } }), secrets: { session: 's', link: 'l' } });
  assert.equal(createPeopleNotifier({ store, config: config(), notifier: confirming().n }).emailOn, false, 'not switched on');
  assert.equal(createPeopleNotifier({ store, config: config({ people: { email: true } }), notifier: confirming().n }).emailOn, false, 'no relay');
  const forgetful = createPeopleNotifier({ store, config: config({ smtp: SMTP, people: { email: true } }), notifier: plain });
  assert.equal(forgetful.emailOn, false, 'a sender that cannot confirm delivery never backs "Emailed"');
  assert.equal(await forgetful.mail('sam@example.com', { subject: 's', text: 't' }, 'join-approved'), 'off');
  assert.equal(createPeopleNotifier({ store, config: config({ smtp: SMTP, people: { email: true } }), notifier: confirming().n }).emailOn, true);
});

test('tell puts the notice in the inbox, and drops one that names nobody', async () => {
  const store = createMemoryStore();
  const people = createPeopleNotifier({ store, config: config(), notifier: confirming().n });
  await people.tell({ message: notice(['usr_1']), kind: 'accepted' });
  assert.deepEqual((await store.listMessages()).map((m) => m.id), ['msg_welcome_inv_1']);
  const empty = createMemoryStore();
  const quiet = createPeopleNotifier({ store: empty, config: config(), notifier: confirming().n });
  await quiet.tell({ message: notice([]), kind: 'accepted' });
  await quiet.tell({ message: notice(undefined), kind: 'accepted' });
  assert.deepEqual(await empty.listMessages(), [], 'an empty audience would reach everyone, so nothing is written');
});

test('with email off, tell writes the inbox only and mail answers off', async () => {
  const store = createMemoryStore();
  const { n, sent } = confirming();
  const people = createPeopleNotifier({ store, config: config({ smtp: SMTP }), notifier: n });
  await people.tell({ message: notice(['usr_1']), mail: { subject: 'Welcome', text: 'Hello' }, kind: 'accepted' });
  assert.equal(await people.mail('sam@example.com', { subject: 's', text: 't' }, 'join-approved'), 'off');
  assert.deepEqual(sent, []);
  assert.equal((await store.listMessages()).length, 1);
});

test('with email on, each recipient is mailed at a verified address only, from the workspace', async () => {
  const store = createMemoryStore();
  const at = new Date().toISOString();
  const verified = await store.upsertUserBySub({ sub: 'v', email: 'Vera@Example.com', groups: [], role: 'member' });
  await store.linkIdentity({ identitySub: 'gh:v', userId: verified.id, idp: 'gh', email: 'vera@example.com', emailVerified: true, linkedAt: at });
  const unverified = await store.upsertUserBySub({ sub: 'u', email: 'una@example.com', groups: [], role: 'member' });
  await store.linkIdentity({ identitySub: 'gh:u', userId: unverified.id, idp: 'gh', email: 'una@example.com', emailVerified: false, linkedAt: at });
  const off = await store.upsertUserBySub({ sub: 'o', email: 'otto@example.com', groups: [], role: 'member' });
  await store.linkIdentity({ identitySub: 'gh:o', userId: off.id, idp: 'gh', email: 'otto@example.com', emailVerified: true, linkedAt: at });
  await store.setUserDisabled(off.id, at);
  const { n, sent } = confirming();
  const people = createPeopleNotifier({ store, config: config({ smtp: SMTP, people: { email: true } }), notifier: n });
  await people.tell({ message: notice([verified.id, unverified.id, off.id, verified.id, 'usr_gone']), mail: { subject: 'Welcome', text: 'Hi' }, kind: 'accepted' });
  assert.deepEqual(sent, [{ to: 'vera@example.com', subject: 'Welcome', fromName: 'lolly.ing' }]);
  await people.tell({ message: notice([verified.id]), kind: 'accepted' });
  assert.equal(sent.length, 1, 'no mail parts, no mail');
});

test('mail reports what the relay said, never more', async () => {
  const store = createMemoryStore();
  const on = config({ smtp: SMTP, people: { email: true, fromName: 'Andy via lolly.ing' } });
  const ok = confirming(true);
  assert.equal(await createPeopleNotifier({ store, config: on, notifier: ok.n }).mail('sam@example.com', { subject: 's', text: 't' }, 'join-approved'), 'sent');
  assert.equal(ok.sent[0]?.fromName, 'Andy via lolly.ing');
  assert.equal(await createPeopleNotifier({ store, config: on, notifier: confirming(false).n }).mail('sam@example.com', { subject: 's', text: 't' }, 'join-approved'), 'failed');
  assert.equal(await createPeopleNotifier({ store, config: on, notifier: confirming(new Error('relay down')).n }).mail('sam@example.com', { subject: 's', text: 't' }, 'join-approved'), 'failed');
  assert.equal(await createPeopleNotifier({ store, config: on, notifier: ok.n }).mail('not-an-address', { subject: 's', text: 't' }, 'join-approved'), 'failed');
});

// ── Comment mentions (plan 76 milestone 4, S-7) ─────────────────────────────
// A mention may be mailed to the person's verified address once email is on.
// The mail never carries the comment text, and names the document only when
// the operator opts in with policy.comments.emailTitles.

test('mailUser answers off while email is off, and mails only a verified, enabled account', async () => {
  const store = createMemoryStore();
  const at = new Date().toISOString();
  const vera = await store.upsertUserBySub({ sub: 'v', email: 'vera@example.com', groups: [], role: 'member' });
  await store.linkIdentity({ identitySub: 'gh:v', userId: vera.id, idp: 'gh', email: 'vera@example.com', emailVerified: true, linkedAt: at });
  const una = await store.upsertUserBySub({ sub: 'u', email: 'una@example.com', groups: [], role: 'member' });
  const off = createPeopleNotifier({ store, config: config({ smtp: SMTP }), notifier: confirming().n });
  assert.equal(await off.mailUser(vera.id, { subject: 's', text: 't' }, 'mention'), 'off', 'no SMTP switched on, no mail');
  const { n, sent } = confirming();
  const on = createPeopleNotifier({ store, config: config({ smtp: SMTP, people: { email: true } }), notifier: n });
  assert.equal(await on.mailUser(vera.id, { subject: 'Ana mentioned you on lolly.ing', text: 't' }, 'mention'), 'sent');
  assert.equal(await on.mailUser(una.id, { subject: 's', text: 't' }, 'mention'), 'failed', 'no verified address');
  assert.equal(await on.mailUser('usr_gone', { subject: 's', text: 't' }, 'mention'), 'failed');
  await store.setUserDisabled(vera.id, at);
  assert.equal(await on.mailUser(vera.id, { subject: 's', text: 't' }, 'mention'), 'failed', 'a disabled account is not mailed');
  assert.deepEqual(sent.map((m) => m.to), ['vera@example.com']);
});

test('mention mail: no comment text ever, and the document title only with emailTitles', async () => {
  const plain = mentionMailParts({ actorName: 'Ana', instance: 'lolly.ing', url: 'https://lolly.ing/#/team/s?thread=t', label: 'Spring poster', emailTitles: false });
  assert.deepEqual(plain, { subject: 'Ana mentioned you on lolly.ing', text: 'Ana mentioned you on lolly.ing.\n\nOpen the thread: https://lolly.ing/#/team/s?thread=t\n' });
  const titled = mentionMailParts({ actorName: 'Ana', instance: 'lolly.ing', url: 'u', label: 'Spring poster', emailTitles: true });
  assert.equal(titled.subject, 'Ana mentioned you in Spring poster');
  assert.equal(titled.text, 'Ana mentioned you in Spring poster on lolly.ing.\n\nOpen the thread: u\n');

  // End to end through the notice writer, with email on and a relay that confirms.
  const secret = 'the launch date is the ninth';
  for (const emailTitles of [false, true]) {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    const ana = await store.upsertUserBySub({ sub: 'a', email: 'ana@example.com', firstname: 'Ana', groups: [], role: 'member' });
    const ben = await store.upsertUserBySub({ sub: 'b', email: 'ben@example.com', firstname: 'Ben', groups: [], role: 'member' });
    await store.linkIdentity({ identitySub: 'gh:b', userId: ben.id, idp: 'gh', email: 'ben@example.com', emailVerified: true, linkedAt: now });
    await store.putProject({ id: 'p', ownerId: ana.id, name: 'P', visibility: 'private', createdAt: now, updatedAt: now });
    await store.putProjectMember({ projectId: 'p', userId: ben.id, role: 'editor', addedBy: ana.id, addedAt: now });
    await store.putSession({ id: 's', projectId: 'p', toolId: 'design', toolVersion: '1', inputs: {}, meta: { label: 'Spring poster' }, createdBy: ana.id, updatedBy: ana.id, rev: 1, updatedAt: now });
    const cfg = parseConfig(JSON.stringify({ instance: { name: 'lolly.ing', baseUrl: 'https://lolly.ing' },
      policy: { defaultAccessMode: 'open', comments: { enabled: true, emailTitles } }, notify: { smtp: SMTP, people: { email: true } } }));
    const mails: Array<{ subject: string; text: string }> = [];
    const notifier: Notifier & { emailNow(to: string, subject: string, text: string): Promise<boolean> } = {
      email() { throw new Error('never send and forget'); }, event() {}, async idle() {},
      async emailNow(_to, subject, text) { mails.push({ subject, text }); return true; },
    };
    const people = createPeopleNotifier({ store, config: cfg, notifier });
    const message = { id: 'm1', authorId: ana.id, authorName: 'Ana', body: `@Ben ${secret}`, createdAt: now, mentions: [{ id: ben.id, name: 'Ben' }] };
    const thread = { id: 't', sessionId: 's', anchor: { kind: 'canvas' as const, surface: 'page', x: 0, y: 0 }, authorId: ana.id, authorName: 'Ana', revision: 1, createdAt: now, updatedAt: now, messages: [message] };
    assert.equal(await store.createCommentThread(thread), 'created');
    const deps = { store, config: cfg, people, cap: createActorCap(), audit: async () => undefined };
    const session = (await store.getSession('s'))!, project = (await store.getProject('p'))!;
    const result = await recordCommentNotices(deps, { session, project, thread, message, actor: ana, mentioned: [ben.id], kind: 'create' });
    await result.mailed;
    assert.equal(mails.length, 1);
    assert.ok(!mails[0]!.subject.includes(secret) && !mails[0]!.text.includes(secret), 'the comment text never reaches a mail');
    assert.equal(mails[0]!.text.includes('Spring poster'), emailTitles, `title in the mail only when emailTitles is ${emailTitles}`);
    assert.match(mails[0]!.text, /Open the thread: https:\/\/lolly\.ing\/#\/team\/s\?thread=t\n$/);
    // A reply by Ben tells Ana in the inbox, and is never mailed.
    const reply = { id: 'm2', authorId: ben.id, authorName: 'Ben', body: 'ok', createdAt: now };
    await store.linkIdentity({ identitySub: 'gh:a', userId: ana.id, idp: 'gh', email: 'ana@example.com', emailVerified: true, linkedAt: now });
    await (await recordCommentNotices(deps, { session, project, thread: { ...thread, revision: 2, messages: [message, reply] }, message: reply, actor: ben, mentioned: [], kind: 'reply' })).mailed;
    assert.equal(mails.length, 1, 'replies are not emailed');
    assert.equal((await store.listCommentNotices(ana.id)).length, 1);
  }
});
