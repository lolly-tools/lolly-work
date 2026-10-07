// SPDX-License-Identifier: MPL-2.0
/**
 * Comment notices (plan 76 milestone 4, S-3 write side, S-4, S-5, S-6, S-22).
 *
 * One inbox row per person per thread, holding ids only; written after the
 * comment is saved, best effort; capped per message and per writer; a mention
 * notifies a person once per message however often an edit adds it again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { CommentMessage, CommentThread } from '@lolly-tools/core/canvas-review-v1';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { mayReadComments, mayReceiveNotices } from '../server/src/comments/access.ts';
import { createActorCap, recordCommentNotices, NOTICE_FANOUT_LIMIT, type NoticeDeps } from '../server/src/comments/notices.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { Store, UserRecord } from '../server/src/store/types.ts';

const NAMES = ['ana', 'ben', 'cat', 'dan', 'out'] as const;
type Name = typeof NAMES[number];
const SECRET = 'the launch date is the ninth';

/** ana owns a private project; ben and dan edit, cat reviews, out has no access. */
async function world(o: { comments?: Record<string, unknown>; wrap?: (store: Store) => Store } = {}) {
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false }, policy: { comments: { enabled: true, ...o.comments } }, dev: { enabled: true,
    users: NAMES.map((name) => ({ email: `${name}@test`, name, groups: [] })) } }));
  const raw = createMemoryStore(), store = o.wrap ? o.wrap(raw) : raw;
  const events: Array<{ sessionId: string; threadId: string; revision: number }> = [];
  const server = createServer(buildApp({ config, store, secrets: { session: 'notices-session', link: 'notices-link' },
    roomEvents: (sessionId, frame) => events.push({ sessionId, threadId: frame.threadId, revision: frame.revision }) }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookies = new Map<Name, string>(), users = new Map<Name, UserRecord>();
  for (const name of NAMES) {
    const response = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    cookies.set(name, response.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    users.set(name, (await raw.findUsersByEmail(`${name}@test`))[0]!);
  }
  const id = (name: Name) => users.get(name)!.id;
  const now = new Date().toISOString();
  await raw.putProject({ id: 'project', ownerId: id('ana'), name: 'Review', visibility: 'private', createdAt: now, updatedAt: now });
  for (const [name, role] of [['ben', 'editor'], ['cat', 'viewer'], ['dan', 'editor']] as const)
    await raw.putProjectMember({ projectId: 'project', userId: id(name), role, addedBy: id('ana'), addedAt: now });
  await raw.putSession({ id: 'session', projectId: 'project', toolId: 'design', toolVersion: '1', inputs: {}, meta: { label: 'Spring poster' },
    createdBy: id('ana'), updatedBy: id('ana'), rev: 1, updatedAt: now });
  const call = (name: Name, method: string, path: string, body?: object) => fetch(base + path, { method,
    headers: { cookie: cookies.get(name)!, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const notices = async (name: Name) => raw.listCommentNotices(id(name));
  const close = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
  return { config, store: raw, call, id, users, notices, events, close };
}

const COMMENTS = '/api/v1/sessions/session/comments';
const anchor = { kind: 'canvas', surface: 'page', x: 10, y: 20 };
type Reply = { thread: CommentThread; notified: boolean };

test('mentions and replies notify the right people, once per thread, with ids only; resolve notifies nobody', async () => {
  const w = await world();
  try {
    const created = await w.call('ana', 'POST', COMMENTS, { id: 'thread', messageId: 'm1', anchor, body: `@ben ${SECRET}`, mentions: [w.id('ben')] });
    assert.equal(created.status, 201);
    let { thread, notified } = await created.json() as Reply;
    assert.equal(notified, true);
    const [mention] = await w.notices('ben');
    assert.equal(mention?.kind, 'mention');
    assert.equal(mention?.count, 1);
    assert.equal(mention?.actorId, w.id('ana'));
    assert.equal(mention?.messageId, 'm1');
    assert.match(mention!.id, /^cn_[0-9a-f]{24}$/);
    // S-4: the row is ids, a kind, a count and a time. No text, no names.
    assert.deepEqual(Object.keys(mention!).sort(), ['actorId', 'count', 'createdAt', 'id', 'kind', 'messageId', 'projectId', 'sessionId', 'threadId', 'userId']);
    assert.deepEqual(await w.notices('cat'), [], 'cat is neither mentioned nor in the thread');
    assert.deepEqual(await w.notices('ana'), [], 'the writer is never notified');

    const reply = async (name: Name, messageId: string, body: string, extra: object = {}) => {
      const response = await w.call(name, 'POST', `${COMMENTS}/thread`, { revision: thread.revision, action: 'reply', messageId, body, ...extra });
      assert.equal(response.status, 200, await response.clone().text());
      ({ thread, notified } = await response.json() as Reply);
    };
    await reply('cat', 'm2', 'Looks good');
    assert.equal(notified, true);
    assert.deepEqual((await w.notices('ana')).map((n) => [n.kind, n.count, n.actorId]), [['reply', 1, w.id('cat')]]);
    assert.equal((await w.notices('ben'))[0]?.count, 1, 'a mentioned person is not a thread participant until they write');
    // S-5: a retry of the same reply returns the saved thread and counts nothing.
    const retry = await w.call('cat', 'POST', `${COMMENTS}/thread`, { revision: thread.revision - 1, action: 'reply', messageId: 'm2', body: 'Looks good' });
    assert.equal(retry.status, 200);
    assert.equal((await w.notices('ana'))[0]?.count, 1);

    await reply('ben', 'm3', 'Fixed');
    assert.deepEqual((await w.notices('ana')).map((n) => [n.kind, n.count, n.actorId, n.messageId]), [['reply', 2, w.id('ben'), 'm3']], 'one row per person and thread, updated');
    assert.deepEqual((await w.notices('cat')).map((n) => n.kind), ['reply'], 'cat wrote in the thread, so cat is told');
    assert.deepEqual((await w.notices('ben')).map((n) => [n.kind, n.count]), [['mention', 1]], 'the writer of the reply is not told');

    const before = JSON.stringify(await Promise.all(NAMES.map((n) => w.notices(n))));
    const resolve = await w.call('dan', 'POST', `${COMMENTS}/thread`, { revision: thread.revision, action: 'resolve' });
    assert.equal(resolve.status, 200);
    assert.equal((await resolve.json() as Reply).notified, true);
    assert.equal(JSON.stringify(await Promise.all(NAMES.map((n) => w.notices(n)))), before, 'resolving notifies nobody');

    const rows = JSON.stringify(await Promise.all(NAMES.map((n) => w.notices(n))));
    assert.ok(!rows.includes(SECRET) && !rows.includes('Looks good'), 'no comment text in any row');
    assert.ok(!/"(ana|ben|cat|dan)"/.test(rows) && !rows.includes('@test'), 'no names or addresses in any row');
    // Live peers hear about every saved write, with ids and a revision only.
    assert.deepEqual(w.events.map((e) => [e.threadId, e.revision]), [['thread', 1], ['thread', 2], ['thread', 3], ['thread', 4]]);
  } finally { await w.close(); }
});

test('S-5: one row per person and thread, a retry counts nothing, and the 1001st update does not fail', async () => {
  const c = await crowd(1);
  const write = { userId: c.people[0]!.id, threadId: 't', sessionId: 's', projectId: 'p', kind: 'reply' as const, actorId: c.actor.id, mentioned: false };
  assert.equal(await c.store.upsertCommentNotice({ ...write, messageId: 'm0', at: new Date().toISOString() }), 'created');
  assert.equal(await c.store.upsertCommentNotice({ ...write, messageId: 'm0', at: new Date().toISOString() }), 'updated');
  assert.equal((await c.store.listCommentNotices(c.people[0]!.id))[0]!.count, 1, 'the same message again is a retry');
  for (let i = 1; i <= 1000; i++) assert.equal(await c.store.upsertCommentNotice({ ...write, messageId: `m${i}`, at: new Date().toISOString() }), 'updated');
  const rows = await c.store.listCommentNotices(c.people[0]!.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.count, 1000);
});

/** A project with `n` extra editors, for the fan-out and cap cases. */
async function crowd(n: number) {
  const store = createMemoryStore(), now = new Date().toISOString();
  const make = (sub: string) => store.upsertUserBySub({ sub, email: `${sub}@test`, firstname: sub, groups: [], role: 'member' });
  const actor = await make('actor');
  const people: UserRecord[] = [];
  await store.putProject({ id: 'p', ownerId: actor.id, name: 'Crowd', visibility: 'private', createdAt: now, updatedAt: now });
  for (let i = 0; i < n; i++) {
    const user = await make(`person${String(i).padStart(2, '0')}`);
    await store.putProjectMember({ projectId: 'p', userId: user.id, role: 'editor', addedBy: actor.id, addedAt: now });
    people.push(user);
  }
  await store.putSession({ id: 's', projectId: 'p', toolId: 'design', toolVersion: '1', inputs: {}, meta: {}, createdBy: actor.id, updatedBy: actor.id, rev: 1, updatedAt: now });
  const audits: Array<{ action: string; detail: Record<string, unknown> }> = [];
  const config = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', comments: { enabled: true } } }));
  const deps = (cap = createActorCap()): NoticeDeps => ({ store, config, cap, audit: async (_a, action, _r, detail) => { audits.push({ action, detail }); } });
  const message = (id: string, author: UserRecord): CommentMessage => ({ id, authorId: author.id, authorName: 'x', body: SECRET, createdAt: now });
  const thread = (messages: CommentMessage[]): CommentThread => ({ id: 't', sessionId: 's', anchor: { kind: 'canvas', surface: 'page', x: 0, y: 0 },
    authorId: actor.id, authorName: 'actor', revision: messages.length, createdAt: now, updatedAt: now, messages });
  // The notice and mention-send rows reference a stored thread.
  assert.equal(await store.createCommentThread(thread([message('stored', actor)])), 'created');
  const session = (await store.getSession('s'))!, project = (await store.getProject('p'))!;
  return { store, actor, people, audits, deps, message, thread, session, project };
}

test('S-6: at most 50 people are notified per message, mentions first, and the writer is told', async () => {
  const c = await crowd(58);
  const replies = c.people.slice(0, 48).map((p, i) => c.message(`r${i}`, p));
  const written = c.message('last', c.actor);
  const mentioned = c.people.slice(48).map((p) => p.id);
  const result = await recordCommentNotices(c.deps(), { session: c.session, project: c.project, thread: c.thread([c.message('first', c.actor), ...replies, written]),
    message: written, actor: c.actor, mentioned, kind: 'reply' });
  assert.equal(result.notified, false);
  let rows = 0, mentions = 0;
  for (const person of c.people) for (const n of await c.store.listCommentNotices(person.id)) { rows++; if (n.kind === 'mention') mentions++; }
  assert.equal(rows, NOTICE_FANOUT_LIMIT);
  assert.equal(mentions, 10, 'every mentioned person is inside the cap');
});

test('S-6: a writer over the actor cap records nothing, is audited, and the cap survives a restart', async () => {
  const cap = createActorCap({ limit: 120 });
  const recent = async () => 0;
  assert.equal(await cap.take('a', 100, recent), true);
  assert.equal(await cap.take('a', 21, recent), false);
  assert.equal(await cap.take('a', 20, recent), true);
  assert.equal(await cap.take('b', 50, recent), true, 'per writer');
  let t = 0;
  const timed = createActorCap({ limit: 5, windowMs: 1000, now: () => t });
  assert.equal(await timed.take('a', 5, recent), true);
  assert.equal(await timed.take('a', 1, recent), false);
  t = 1000;
  assert.equal(await timed.take('a', 5, recent), true, 'a new window');

  const c = await crowd(4);
  const written = c.message('m', c.actor);
  const event = { session: c.session, project: c.project, thread: c.thread([written]), message: written, actor: c.actor, mentioned: c.people.slice(0, 3).map((p) => p.id), kind: 'create' as const };
  assert.equal((await recordCommentNotices(c.deps(createActorCap({ limit: 2 })), event)).notified, false);
  for (const p of c.people) assert.deepEqual(await c.store.listCommentNotices(p.id), [], 'nothing is written over the cap');
  assert.deepEqual(c.audits.map((a) => a.action), ['comment.notice.capped']);
  assert.deepEqual(Object.keys(c.audits[0]!.detail).sort(), ['messageId', 'recipients', 'threadId']);
  // Within the cap the same message notifies; a new process (a fresh in-memory
  // cap) is seeded from the database and still refuses more than the limit.
  const second = c.message('m2', c.actor);
  assert.equal((await recordCommentNotices(c.deps(createActorCap({ limit: 4 })), { ...event, message: second })).notified, true);
  const third = c.message('m3', c.actor);
  assert.equal((await recordCommentNotices(c.deps(createActorCap({ limit: 4 })), { ...event, message: third, mentioned: [c.people[3]!.id, c.people[0]!.id] })).notified, false,
    'three notices from before the restart plus two more pass a limit of four');
});

test('S-22: the 31st comment write in a minute is refused with retry-after, per person', async () => {
  const w = await world();
  try {
    for (let i = 0; i < 30; i++) {
      const response = await w.call('ana', 'POST', COMMENTS, { id: `burst${i}`, messageId: `b${i}`, anchor, body: `note ${i}` });
      assert.equal(response.status, 201, `write ${i + 1}`);
    }
    const refused = await w.call('ana', 'POST', COMMENTS, { id: 'burst30', messageId: 'b30', anchor, body: 'one more' });
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '60');
    assert.equal((await refused.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
    assert.equal(await w.store.getCommentThread('burst30'), null);
    const command = await w.call('ana', 'POST', `${COMMENTS}/burst0`, { revision: 1, action: 'resolve' });
    assert.equal(command.status, 429, 'commands count against the same limit');
    assert.equal((await w.call('ben', 'POST', COMMENTS, { id: 'other', messageId: 'o1', anchor, body: 'mine' })).status, 201, 'another person is not limited');
  } finally { await w.close(); }
});

test('S-22: removing and adding a mention again in edits notifies once per message', async () => {
  const w = await world();
  try {
    let thread = (await (await w.call('ana', 'POST', COMMENTS, { id: 'thread', messageId: 'm1', anchor, body: 'hi @ben', mentions: [w.id('ben')] })).json() as Reply).thread;
    const edit = async (body: string, mentions: string[]) => {
      const response = await w.call('ana', 'POST', `${COMMENTS}/thread`, { revision: thread.revision, action: 'edit', messageId: 'm1', body, mentions });
      assert.equal(response.status, 200);
      thread = (await response.json() as Reply).thread;
    };
    await edit('hi', []);
    await edit('hi @ben', [w.id('ben')]);
    await edit('hi', []);
    await edit('hi @ben', [w.id('ben')]);
    assert.deepEqual((await w.notices('ben')).map((n) => [n.kind, n.count]), [['mention', 1]], 'told once for m1');
    await edit('hi @ben and @cat', [w.id('ben'), w.id('cat')]);
    assert.deepEqual((await w.notices('cat')).map((n) => [n.kind, n.count]), [['mention', 1]], 'an edit that adds someone new tells them');
    const audit = (await w.store.listAudit()).filter((e) => e.action === 'comment.edit').at(-1);
    assert.deepEqual(audit?.payload?.['mentioned'], [w.id('ben'), w.id('cat')]);
    const reply = await w.call('ben', 'POST', `${COMMENTS}/thread`, { revision: thread.revision, action: 'reply', messageId: 'm2', body: '@cat see above', mentions: [w.id('cat')] });
    assert.equal(reply.status, 200);
    assert.deepEqual((await w.notices('cat')).map((n) => [n.kind, n.count]), [['mention', 2]], 'a new message is a new mention');
  } finally { await w.close(); }
});

test('S-22: a failing notice write keeps the reply and audits comment.notice.failed', async () => {
  let failing = false;
  const w = await world({ wrap: (store) => new Proxy(store, {
    get(target, key, receiver) {
      if (key === 'upsertCommentNotice' && failing) return async () => { throw new Error('notice table unavailable'); };
      return Reflect.get(target, key, receiver);
    },
  }) });
  try {
    const thread = (await (await w.call('ana', 'POST', COMMENTS, { id: 'thread', messageId: 'm1', anchor, body: 'first' })).json() as Reply).thread;
    failing = true;
    const response = await w.call('ben', 'POST', `${COMMENTS}/thread`, { revision: thread.revision, action: 'reply', messageId: 'm2', body: 'second' });
    assert.equal(response.status, 200);
    const saved = await response.json() as Reply;
    assert.equal(saved.notified, false);
    assert.equal((await w.store.getCommentThread('thread'))!.messages.length, 2, 'the reply is saved');
    const failed = (await w.store.listAudit()).filter((e) => e.action === 'comment.notice.failed');
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0]!.payload, { threadId: 'thread', messageId: 'm2' });
  } finally { await w.close(); }
});

test('S-3 (write side): one predicate decides, and a person who lost access is not notified', async () => {
  const w = await world();
  try {
    const session = (await w.store.getSession('session'))!, project = (await w.store.getProject('project'))!;
    const decide = async (name: Name, o: { session?: typeof session; config?: typeof w.config } = {}) => {
      const user = (await w.store.getUser(w.id(name)))!;
      const input = { user, session: o.session ?? session, project, membership: await w.store.getProjectMember('project', user.id),
        grants: await w.store.listGrants(), config: o.config ?? w.config };
      const read = mayReadComments(input), receive = mayReceiveNotices(input);
      return [read.ok ? 'ok' : read.reason, receive.ok ? 'ok' : receive.reason];
    };
    assert.deepEqual(await decide('cat'), ['ok', 'ok']);
    assert.deepEqual(await decide('out'), ['forbidden', 'forbidden'], 'no project access');
    assert.deepEqual(await decide('cat', { session: { ...session, deletedAt: new Date().toISOString() } }), ['gone', 'gone']);
    assert.deepEqual(await decide('cat', { config: parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', comments: { enabled: false } } })) }), ['off', 'off']);
    assert.deepEqual(await decide('cat', { config: parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', comments: { enabled: true, notices: false } } })) }), ['ok', 'off']);
    await w.store.putGrant({ principal: `user:${w.id('dan')}`, action: 'comment.view', resource: 'session:session', effect: 'deny' });
    assert.deepEqual(await decide('dan'), ['forbidden', 'forbidden'], 'a later deny on comment.view');

    let thread = (await (await w.call('cat', 'POST', COMMENTS, { id: 'thread', messageId: 'm1', anchor, body: 'first' })).json() as Reply).thread;
    await w.store.deleteProjectMember('project', w.id('cat'));
    assert.equal(await decide('cat').then((d) => d[1]), 'forbidden');
    const reply = await w.call('ben', 'POST', `${COMMENTS}/thread`, { revision: thread.revision, action: 'reply', messageId: 'm2', body: 'second' });
    thread = (await reply.json() as Reply).thread;
    assert.deepEqual(await w.notices('cat'), [], 'removed from the project before the reply, so not told');
  } finally { await w.close(); }
});

test('notices can be switched off: nothing is written and a mention reports not notified', async () => {
  const w = await world({ comments: { notices: false } });
  try {
    const created = await w.call('ana', 'POST', COMMENTS, { id: 'thread', messageId: 'm1', anchor, body: '@ben', mentions: [w.id('ben')] });
    assert.equal(created.status, 201);
    const body = await created.json() as Reply;
    assert.equal(body.notified, false);
    assert.deepEqual(body.thread.messages[0]!.mentions?.map((m) => m.id), [w.id('ben')], 'the mention is still shown');
    assert.deepEqual(await w.notices('ben'), []);
    const reply = await w.call('ben', 'POST', `${COMMENTS}/thread`, { revision: 1, action: 'reply', messageId: 'm2', body: 'ok' });
    assert.equal((await reply.json() as Reply).notified, true, 'a plain reply had nobody it failed to tell');
    assert.deepEqual(await w.notices('ana'), []);
    assert.throws(() => parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', comments: { enabled: true, notices: 1 } } })), /policy\.comments\.notices/);
  } finally { await w.close(); }
});
