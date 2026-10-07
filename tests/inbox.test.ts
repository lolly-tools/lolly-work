import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceMatches, compareVersions, targetedMessages, type Message } from '../server/src/inbox/target.ts';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import type { Store } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { NOTICE_GONE_BODY, noticeMessage } from '../server/src/inbox/comment-notices.ts';

test('version compare handles unequal lengths and double digits', () => {
  assert.equal(compareVersions('1.61.0', '1.61.0'), 0);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.61', '1.61.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('audience matrix: groups × shells × version range', () => {
  const upgradeNudge = { groups: ['*'], shells: ['tauri'], maxEngine: '1.52.99' };
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri', engineVersion: '1.50.0' }), true);
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri', engineVersion: '1.61.0' }), false);
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'web', engineVersion: '1.50.0' }), false);
  // version-scoped messages don't reach clients whose version is unknown
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri' }), false);
  assert.equal(audienceMatches({ groups: ['brand-team'] }, { groups: ['marketing'] }), false);
  assert.equal(audienceMatches({ groups: ['brand-team'] }, { groups: ['brand-team', 'x'] }), true);
  assert.equal(audienceMatches({}, { groups: [] }), true); // default = everyone
});

test('per-user audience: only the named users match, and it ANDs with groups', () => {
  const aud = { users: ['u1', 'u2'] };
  assert.equal(audienceMatches(aud, { groups: [], userId: 'u1' }), true);
  assert.equal(audienceMatches(aud, { groups: [], userId: 'u3' }), false);
  assert.equal(audienceMatches(aud, { groups: [] }), false); // no userId → no match
  // combined with a group selector, BOTH must hold
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['brand'], userId: 'u1' }), true);
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['legal'], userId: 'u1' }), false);
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['brand'], userId: 'u2' }), false);
});

function msg(id: string, over: Partial<Message> = {}): Message {
  return { id, kind: 'announcement', severity: 'info', audience: {}, title: id, ...over };
}

test('targeting excludes acked and out-of-window messages', () => {
  const now = new Date('2026-07-21T12:00:00Z');
  const messages = [
    msg('live'),
    msg('acked'),
    msg('future', { startsAt: '2026-08-01T00:00:00Z' }),
    msg('ended', { endsAt: '2026-07-01T00:00:00Z' }),
    msg('ends-now', { endsAt: now.toISOString() }),
    msg('starts-now', { startsAt: now.toISOString() }),
  ];
  const out = targetedMessages(messages, { groups: [] }, new Set(['acked']), now);
  assert.deepEqual(out.map((m) => m.id), ['live', 'starts-now']);
});

// ── GET /api/v1/inbox over HTTP (plans/74 invite spec R5) ───────────────────
// The shell asks on focus and once a minute while visible, so a quiet read
// must be a 304, and anything the caller would see differently must not be.

test('GET /api/v1/inbox: an ETag over what the caller sees, a 304 when nothing moved, and the unread count', async (t) => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-inbox-'));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Inbox Hub', baseUrl: 'https://team.example', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'ana@test', groups: [] }, { email: 'bo@test', groups: [] }] },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sIb', link: 'lIb' } });
  const server = createServer((req, res) => void app(req, res));
  t.after(() => server.close());
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = async (email: string) => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  const ana = await login('ana@test');
  const bo = await login('bo@test');
  const anaId = (await store.findUsersByEmail('ana@test'))[0]!.id;
  const read = (cookie: string, etag?: string) => fetch(`${base}/api/v1/inbox`, { headers: { cookie, ...(etag ? { 'if-none-match': etag } : {}) } });

  await store.putMessage(msg('m1', { audience: { users: [anaId] }, data: { kind: 'welcome', at: new Date().toISOString() } }));
  const first = await read(ana);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag')!;
  assert.match(etag, /^"ib-[0-9a-f]{16}"$/);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const body = await first.json() as { messages: Message[]; unread: number };
  assert.deepEqual([body.messages.map((m) => m.id), body.unread], [['m1'], 1]);

  // Nothing moved: 304 with the same tag and no body, a weak tag or a list included.
  const quiet = await read(ana, etag);
  assert.deepEqual([quiet.status, quiet.headers.get('etag'), await quiet.text()], [304, etag, '']);
  assert.equal((await read(ana, `"ib-0000000000000000", W/${etag}`)).status, 304);
  // Someone else's inbox has its own tag.
  assert.notEqual((await read(bo)).headers.get('etag'), etag);

  // A new message, and an acknowledgement, each move it.
  await store.putMessage(msg('m2', { audience: { users: [anaId] } }));
  const grown = await read(ana, etag);
  assert.equal(grown.status, 200);
  const grownTag = grown.headers.get('etag')!;
  assert.equal((await grown.json() as { unread: number }).unread, 2);
  assert.equal((await fetch(`${base}/api/v1/inbox/m1/ack`, { method: 'POST', headers: { cookie: ana } })).status, 200);
  const acked = await read(ana, grownTag);
  assert.equal(acked.status, 200);
  const ackedBody = await acked.json() as { messages: Message[]; unread: number };
  assert.deepEqual([ackedBody.messages.map((m) => m.id), ackedBody.unread], [['m2'], 1]);
  assert.equal((await fetch(`${base}/api/v1/inbox`)).status, 401);
});

// ── Comment notices in the inbox (plan 76 milestone 4) ──────────────────────
// S-3 (read side), S-4 (read side), S-12 and S-24, and the W2 rows of 2.16:
// the ETag moves when a notice is written or acknowledged, `inboxUnread`
// matches the inbox, and GET /inbox with 200 notices stays inside its budget.

const SECRET = 'the launch date is the ninth';
type InboxBody = { messages: Message[]; unread: number };

/** ana owns a private project with one session; ben edits, cat reviews,
 *  out has no access. Each dev account is named by its first name only. */
async function commentWorld(store: Store = createMemoryStore(), o: { appUrl?: string } = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-inbox-comments-'));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Inbox Hub', baseUrl: 'https://team.example', pack, ...(o.appUrl ? { appUrl: o.appUrl } : {}) },
    rateLimit: { enabled: false },
    policy: { comments: { enabled: true } },
    dev: { enabled: true, users: ['Ana', 'Ben', 'Cat', 'Out'].map((name) => ({ email: `${name.toLowerCase()}@test`, name, groups: [] })) },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sIbC', link: 'lIbC' } });
  const serverTimes: number[] = [];
  const server = createServer((req, res) => {
    const started = performance.now();
    res.on('finish', () => { if (req.url === '/api/v1/inbox') serverTimes.push(performance.now() - started); });
    void app(req, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookies = new Map<string, string>(), ids = new Map<string, string>();
  for (const name of ['ana', 'ben', 'cat', 'out']) {
    const res = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    cookies.set(name, res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    ids.set(name, (await store.findUsersByEmail(`${name}@test`))[0]!.id);
  }
  const id = (name: string) => ids.get(name)!;
  const now = new Date().toISOString();
  await store.putProject({ id: 'project', ownerId: id('ana'), name: 'Review', visibility: 'private', createdAt: now, updatedAt: now });
  for (const [name, role] of [['ben', 'editor'], ['cat', 'viewer']] as const)
    await store.putProjectMember({ projectId: 'project', userId: id(name), role, addedBy: id('ana'), addedAt: now });
  await store.putSession({ id: 'session', projectId: 'project', toolId: 'design', toolVersion: '1', inputs: {}, meta: { label: 'Spring poster' },
    createdBy: id('ana'), updatedBy: id('ana'), rev: 1, updatedAt: now });
  const call = (name: string, method: string, path: string, body?: object, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { cookie: cookies.get(name)!, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const inbox = async (name: string, etag?: string) => {
    const res = await call(name, 'GET', '/api/v1/inbox', undefined, etag ? { 'if-none-match': etag } : {});
    return { status: res.status, etag: res.headers.get('etag')!, body: res.status === 200 ? await res.json() as InboxBody : null };
  };
  const unread = async (name: string) => (await (await call(name, 'GET', '/api/v1/org-config')).json() as { inboxUnread: number }).inboxUnread;
  /** The inbox and org-config agree; returns the comment rows. */
  const notices = async (name: string) => {
    const { body } = await inbox(name);
    assert.equal(await unread(name), body!.unread, `${name}: org-config inboxUnread matches the inbox`);
    return body!.messages.filter((m) => m.id.startsWith('cn_'));
  };
  const comments = '/api/v1/sessions/session/comments';
  const anchor = { kind: 'canvas', surface: 'page', x: 10, y: 20 };
  const write = async (name: string, path: string, body: object) => {
    const res = await call(name, 'POST', path, body);
    assert.ok(res.status === 200 || res.status === 201, `${name} ${path}: ${res.status} ${await res.clone().text()}`);
    return (await res.json() as { thread: { revision: number } }).thread.revision;
  };
  const close = async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); };
  return { config, store, call, inbox, unread, notices, id, comments, anchor, write, serverTimes, close };
}

async function noticeLifecycle(store: Store) {
  const w = await commentWorld(store);
  try {
    let rev = await w.write('ben', w.comments, { id: 't1', messageId: 'm1', anchor: w.anchor, body: `@Cat ${SECRET}`, mentions: [w.id('cat')] });
    const first = await w.inbox('cat');
    assert.equal(first.status, 200);
    const [mention] = first.body!.messages;
    assert.equal(first.body!.unread, 1);
    assert.match(mention!.id, /^cn_[0-9a-f]{24}$/);
    assert.deepEqual({ ...mention, data: { ...mention!.data, at: 'at' } }, {
      id: mention!.id, kind: 'comment', severity: 'info', audience: { users: [w.id('cat')] },
      title: 'Ben mentioned you in Spring poster', body: `@Cat ${SECRET}`,
      cta: { label: 'Open thread', url: '/#/team/session?thread=t1' },
      data: { kind: 'comment-mention', sessionId: 'session', projectId: 'project', threadId: 't1', actorName: 'Ben', label: 'Spring poster', count: '1', at: 'at' },
      dismissible: true,
    });
    assert.ok(Number.isFinite(Date.parse(mention!.data!.at!)));
    assert.equal(await w.unread('cat'), 1, 'org-config counts the notice');
    assert.equal((await w.inbox('cat', first.etag)).status, 304, 'nothing moved');

    // S-4: an edited message's old text is gone from the inbox at once.
    rev = await w.write('ben', `${w.comments}/t1`, { revision: rev, action: 'edit', messageId: 'm1', body: 'Moved the date' });
    const edited = await w.inbox('cat', first.etag);
    assert.equal(edited.status, 200, 'an edit moves the ETag: the excerpt is built when read');
    assert.equal(edited.body!.messages[0]!.body, 'Moved the date');
    assert.ok(!JSON.stringify(edited.body).includes(SECRET));
    assert.equal(edited.body!.messages[0]!.data!.count, '1', 'an edit is not a new notice');

    // Replies: the thread's author is told; several replies say how many.
    rev = await w.write('ana', `${w.comments}/t1`, { revision: rev, action: 'reply', messageId: 'm2', body: 'Looks good' });
    let [ben] = await w.notices('ben');
    assert.deepEqual([ben!.title, ben!.body, ben!.data!.kind, ben!.data!.actorName], ['Ana replied in Spring poster', 'Looks good', 'comment-reply', 'Ana']);
    const long = `Long note ${'x'.repeat(300)}`;
    rev = await w.write('cat', `${w.comments}/t1`, { revision: rev, action: 'reply', messageId: 'm3', body: long });
    [ben] = await w.notices('ben');
    assert.deepEqual([ben!.title, ben!.data!.count, ben!.data!.actorName], ['New replies in Spring poster: 2', '2', 'Cat']);
    assert.equal(ben!.body, long.slice(0, 140), 'the excerpt is the first 140 characters of the newest message by someone else');
    assert.equal((await w.notices('cat'))[0]!.body, 'Looks good', 'never the recipient\'s own message');

    // S-4: a deleted message's text never appears; with none left, the body says so.
    rev = await w.write('cat', `${w.comments}/t1`, { revision: rev, action: 'delete', messageId: 'm3' });
    assert.equal((await w.notices('ben'))[0]!.body, 'Looks good');
    rev = await w.write('ana', `${w.comments}/t1`, { revision: rev, action: 'delete', messageId: 'm2' });
    assert.equal((await w.notices('ben'))[0]!.body, 'This comment is no longer available.');

    // S-24: an acknowledgement deletes only the caller's row and never writes the message-ack table.
    const before = await w.inbox('ben');
    const benNotice = before.body!.messages[0]!.id;
    assert.equal((await w.call('out', 'POST', `/api/v1/inbox/${benNotice}/ack`)).status, 200);
    assert.equal((await w.call('cat', 'POST', `/api/v1/inbox/${benNotice}/ack`)).status, 200);
    assert.equal((await w.notices('ben')).length, 1, 'acking someone else\'s notice deletes nothing');
    assert.equal((await w.call('ben', 'POST', `/api/v1/inbox/${benNotice}/ack`)).status, 200);
    const acked = await w.inbox('ben', before.etag);
    assert.equal(acked.status, 200, 'an acknowledgement moves the ETag');
    assert.deepEqual([acked.body!.messages, acked.body!.unread, await w.unread('ben')], [[], 0, 0]);
    for (const name of ['ben', 'cat', 'out']) assert.deepEqual([...await w.store.acksFor(w.id(name))], [], 'no message-ack row');
    assert.equal((await w.store.listCommentNotices(w.id('ben'))).length, 0);
    // A new reply shows a notice again.
    rev = await w.write('cat', `${w.comments}/t1`, { revision: rev, action: 'reply', messageId: 'm4', body: 'One more thing' });
    [ben] = await w.notices('ben');
    assert.deepEqual([ben!.id, ben!.title, ben!.body], [benNotice, 'Cat replied in Spring poster', 'One more thing']);
    assert.notEqual((await w.inbox('ben')).etag, acked.etag, 'a new notice moves the ETag');
    assert.ok(!JSON.stringify(await w.inbox('ben')).includes('@test'), 'names never carry an address');
  } finally { await w.close(); }
}

test('noticeMessage: an unknown actor is Member, an address-shaped name is cut, a thread from elsewhere has no excerpt', () => {
  const at = '2026-10-07T12:00:00.000Z';
  const notice = { id: 'cn_0123456789abcdef01234567', userId: 'u-cat', threadId: 't1', sessionId: 's1', projectId: 'p-old', kind: 'reply' as const,
    actorId: 'u-gone', messageId: 'm1', count: 1, createdAt: at };
  const session = { id: 's1', projectId: 'p1', toolId: 'design', toolVersion: '1', inputs: {}, meta: {}, createdBy: 'u', updatedBy: 'u', rev: 1, updatedAt: at };
  const thread = { id: 't1', sessionId: 's1', anchor: { kind: 'canvas' as const, surface: 'page', x: 0, y: 0 }, authorId: 'u-ben', authorName: 'Ben',
    revision: 1, createdAt: at, updatedAt: at, messages: [{ id: 'm1', authorId: 'u-ben', authorName: 'Ben', body: 'Hello', createdAt: at }] };
  const gone = noticeMessage(notice, { session, thread, actor: undefined, appBase: '' });
  assert.deepEqual([gone.title, gone.data!.actorName, gone.data!.label, gone.data!.projectId, gone.body],
    ['Member replied in design', 'Member', 'design', 'p1', 'Hello'], 'the label falls back to the tool; the project comes from the session');
  const named = noticeMessage({ ...notice, kind: 'mention' }, { session, thread: { ...thread, sessionId: 'other' }, actor: { firstname: 'ana@corp.example', email: 'ana@corp.example' }, appBase: '' });
  assert.deepEqual([named.title, named.body], ['ana mentioned you in design', NOTICE_GONE_BODY]);
  assert.equal(noticeMessage(notice, { session: { ...session, meta: { label: 'L'.repeat(500) } }, thread, actor: undefined, appBase: '' }).data!['label']!.length, 120);
});

test('the thread link starts at instance.appUrl when the app is served elsewhere', async () => {
  const w = await commentWorld(createMemoryStore(), { appUrl: 'https://app.example/' });
  try {
    await w.write('ben', w.comments, { id: 'thread_1', messageId: 'm1', anchor: w.anchor, body: 'Hello', mentions: [w.id('cat')] });
    assert.equal((await w.notices('cat'))[0]!.cta!.url, 'https://app.example/#/team/session?thread=thread_1');
  } finally { await w.close(); }
});

async function readPredicate(store: Store) {
  const w = await commentWorld(store);
  try {
    await w.write('ben', w.comments, { id: 't1', messageId: 'm1', anchor: w.anchor, body: 'Look', mentions: [w.id('cat')] });
    const shown = async () => (await w.notices('cat')).length;
    const stored = async () => (await w.store.listCommentNotices(w.id('cat'))).length;
    assert.deepEqual([await shown(), await w.unread('cat')], [1, 1]);

    // A later deny on comment.view hides it and keeps the row, so lifting the deny shows it again.
    const deny = { principal: `user:${w.id('cat')}`, action: 'comment.view', resource: 'session:session', effect: 'deny' as const };
    await w.store.putGrant(deny);
    assert.deepEqual([await shown(), await w.unread('cat'), await stored()], [0, 0, 1]);
    await w.store.deleteGrant(deny);
    assert.equal(await shown(), 1);
    // Policy: comments off, or notices off, hide every notice and delete none.
    for (const comments of [{ enabled: false }, { enabled: true, notices: false }]) {
      w.config.policy.comments = comments;
      assert.deepEqual([await shown(), await w.unread('cat'), await stored()], [0, 0, 1], JSON.stringify(comments));
    }
    w.config.policy.comments = { enabled: true };
    assert.equal(await shown(), 1);

    // Removed from the project: the notice can never come back, so it is deleted.
    assert.equal(await w.store.deleteProjectMember('project', w.id('cat')), true);
    assert.deepEqual([await shown(), await w.unread('cat'), await stored()], [0, 0, 0]);

    // The session deleted: deleted for everyone told about it.
    await w.write('ana', w.comments, { id: 't3', messageId: 'm3', anchor: w.anchor, body: 'For Ben', mentions: [w.id('ben')] });
    assert.equal((await w.notices('ben')).length, 1);
    assert.equal((await w.call('ana', 'DELETE', '/api/v1/sessions/session')).status, 200);
    assert.deepEqual([(await w.notices('ben')).length, await w.unread('ben'), (await w.store.listCommentNotices(w.id('ben'))).length], [0, 0, 0]);
  } finally { await w.close(); }
}

async function lostSubjects(store: Store) {
  const w = await commentWorld(store);
  try {
    const at = new Date().toISOString();
    const cat = w.id('cat'), ben = w.id('ben');
    await w.store.putMessage({ id: 'share-cat', kind: 'share', severity: 'info', audience: { users: [cat] }, title: 'Ana shared Review with you',
      data: { kind: 'project-share', projectId: 'project', role: 'viewer', at } });
    await w.store.putMessage({ id: 'invite-cat', kind: 'collab', severity: 'action', audience: { users: [cat] }, title: 'Ana invited you',
      data: { kind: 'collab-invite', sessionId: 'session', projectId: 'project', toolId: 'design', toolVersion: '1' } });
    await w.store.putMessage({ id: 'request-ben', kind: 'request', severity: 'action', audience: { users: [ben] }, title: 'Out asks to view Review',
      data: { kind: 'access-request', requestKind: 'project', projectId: 'project', requestId: 'r1', at } });
    await w.store.putMessage({ id: 'join-ben', kind: 'request', severity: 'action', audience: { users: [ben] }, title: 'Someone asks to join',
      data: { kind: 'access-request', requestKind: 'join', requestId: 'r2', at } });
    const ids = async (name: string) => {
      const { body } = await w.inbox(name);
      assert.equal(await w.unread(name), body!.unread, `${name}: org-config inboxUnread matches the inbox`);
      return body!.messages.map((m) => m.id).sort();
    };
    assert.deepEqual(await ids('cat'), ['invite-cat', 'share-cat']);
    assert.deepEqual(await ids('ben'), ['join-ben'], 'an editor who does not manage the project is not shown its request');
    await w.store.putProjectMember({ projectId: 'project', userId: ben, role: 'manager', addedBy: w.id('ana'), addedAt: at });
    assert.deepEqual(await ids('ben'), ['join-ben', 'request-ben'], 'a manager is');
    assert.ok(await w.store.updateProjectMemberRole('project', ben, 'editor'));
    assert.deepEqual(await ids('ben'), ['join-ben'], 'and stops seeing it once demoted');

    // A deleted session hides its invite; a lost project hides both.
    const session = (await w.store.getSession('session'))!;
    await w.store.putSession({ ...session, deletedAt: at });
    assert.deepEqual(await ids('cat'), ['share-cat']);
    await w.store.putSession({ ...session });
    assert.deepEqual(await ids('cat'), ['invite-cat', 'share-cat'], 'hidden, not deleted');
    assert.equal(await w.store.deleteProjectMember('project', cat), true);
    assert.deepEqual(await ids('cat'), []);
  } finally { await w.close(); }
}

const pgUrl = process.env.LW_TEST_DATABASE_URL;
const onPostgres = { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' };
for (const [name, body] of [
  ['comment notices in the inbox: built when read, no stale text, ETag, unread and the cn_ acknowledgement (S-4, S-24)', noticeLifecycle],
  ['S-3: one predicate at read; a refused notice is hidden and inboxUnread falls; a lost document or project deletes it', readPredicate],
  ['S-12: share, invite and request messages hide once their subject is out of reach', lostSubjects],
] as const) {
  test(`${name} (memory)`, () => body(createMemoryStore()));
  test(`${name} (postgres)`, onPostgres, () => withFreshPostgres(pgUrl!, body));
}

/** GET /inbox with 200 comment notices across 20 documents. The plan 76
 *  budget (p95 100 ms server time) is asserted on Postgres, where it is
 *  defined; the in-memory run reports the figure without failing on a busy
 *  machine. A round is 40 reads; up to three rounds are measured and the best
 *  one counts, so a slower build fails every round while a burst of load on a
 *  shared machine does not fail the suite. */
async function noticeBudget(store: Store, report: (message: string) => void, enforce: boolean) {
  const w = await commentWorld(store);
  try {
    const ben = w.id('ben'), cat = w.id('cat');
    const inputs = { boxes: Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, kind: 'box', x: i, y: i, w: 10, h: 10 })) };
    for (let s = 0; s < 20; s++) {
      const at = new Date().toISOString();
      await store.putSession({ id: `doc${s}`, projectId: 'project', toolId: 'design', toolVersion: '1', inputs, meta: { label: `Document ${s}` },
        createdBy: ben, updatedBy: ben, rev: 1, updatedAt: at });
      for (let t = 0; t < 10; t++) {
        const id = `doc${s}t${t}`;
        assert.equal(await store.createCommentThread({ id, sessionId: `doc${s}`, anchor: { kind: 'canvas', surface: 'page', x: t, y: t },
          authorId: ben, authorName: 'Ben', revision: 1, createdAt: at, updatedAt: at,
          messages: [{ id: `${id}m`, authorId: ben, authorName: 'Ben', body: `Note ${t} on document ${s} `.repeat(6), createdAt: at }] }), 'created');
        await store.upsertCommentNotice({ userId: cat, threadId: id, sessionId: `doc${s}`, projectId: 'project', kind: t % 2 ? 'reply' : 'mention',
          actorId: ben, messageId: `${id}m`, at: new Date(Date.now() - (s * 10 + t) * 1000).toISOString(), mentioned: t % 2 === 0 });
      }
    }
    assert.equal((await w.notices('cat')).length, 200);
    for (let i = 0; i < 10; i++) assert.equal((await w.inbox('cat')).status, 200);
    let best = Infinity;
    for (let round = 1; round <= 3 && best > 100; round++) {
      w.serverTimes.length = 0;
      for (let i = 0; i < 40; i++) assert.equal((await w.inbox('cat')).status, 200);
      const times = w.serverTimes.slice(0, 40).sort((a, b) => a - b);
      const p50 = times[Math.floor(times.length * 0.5)]!, p95 = times[Math.ceil(times.length * 0.95) - 1]!;
      report(`GET inbox with 200 notices (${store.storageKind}), round ${round}: server time p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
      best = Math.min(best, p95);
      if (!enforce) break;
    }
    if (enforce) assert.ok(best <= 100, `GET inbox with 200 notices: p95 ${best.toFixed(1)} ms in the best round is over the 100 ms budget`);
  } finally { await w.close(); }
}
test('GET inbox with 200 comment notices (memory: reported)', (t) => noticeBudget(createMemoryStore(), (m) => t.diagnostic(m), false));
test('GET inbox with 200 comment notices on Postgres stays inside the 100 ms budget', onPostgres, async (t) => {
  await withFreshPostgres(pgUrl!, (store) => noticeBudget(store, (m) => t.diagnostic(m), true));
});
