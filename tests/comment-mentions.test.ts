// SPDX-License-Identifier: MPL-2.0
/**
 * Mentions in review comments (plan 76 milestone 4, S-1, S-2, S-17).
 *
 * A mention may only name someone who can already open the document and read
 * its comments, and it never grants anything. The people list a commenter
 * picks from obeys the same rule, prefix matched and capped, with no email
 * address anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { CommentThread } from '@lolly-tools/core/canvas-review-v1';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { eligibleMentionIds, mentionsStillInBody, readMentionRequest } from '../server/src/comments/mentions.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { UserRecord } from '../server/src/store/types.ts';

const NAMES = ['ana', 'ben', 'cat', 'out', 'ada', 'dis', 'den', 'joe'] as const;
type Name = typeof NAMES[number] | 'nia';

/** ana owns a private project; ben edits, cat reviews, nia (address only) reviews.
 *  out has no access, ada is an admin who is not a member, dis is a disabled
 *  editor, den may not read comments, joe may not join live rooms. */
async function world(comments: Record<string, unknown> = {}) {
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false }, policy: { comments: { enabled: true, ...comments } }, dev: { enabled: true,
    users: [...NAMES.map((name) => ({ email: `${name}@test`, name, groups: name === 'ada' ? ['admin'] : [] })), { email: 'nia@corp', groups: [] }] } }));
  const store = createMemoryStore();
  const server = createServer(buildApp({ config, store, secrets: { session: 'mentions-session', link: 'mentions-link' } }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cookies = new Map<Name, string>(), users = new Map<Name, UserRecord>();
  for (const name of [...NAMES, 'nia'] as Name[]) {
    const email = name === 'nia' ? 'nia@corp' : `${name}@test`;
    const response = await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' });
    cookies.set(name, response.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    users.set(name, (await store.findUsersByEmail(email))[0]!);
  }
  const id = (name: Name) => users.get(name)!.id;
  const now = new Date().toISOString();
  await store.putProject({ id: 'project', ownerId: id('ana'), name: 'Review', visibility: 'private', createdAt: now, updatedAt: now });
  for (const [name, role] of [['ben', 'editor'], ['cat', 'viewer'], ['nia', 'viewer'], ['dis', 'editor'], ['den', 'viewer'], ['joe', 'viewer']] as const)
    await store.putProjectMember({ projectId: 'project', userId: id(name), role, addedBy: id('ana'), addedAt: now });
  await store.putSession({ id: 'session', projectId: 'project', toolId: 'design', toolVersion: '1', inputs: {}, meta: { label: 'Spring poster' },
    createdBy: id('ana'), updatedBy: id('ana'), rev: 1, updatedAt: now });
  await store.putGrant({ principal: `user:${id('den')}`, action: 'comment.view', resource: 'project:project', effect: 'deny' });
  await store.putGrant({ principal: `user:${id('joe')}`, action: 'collab.join', resource: '*', effect: 'deny' });
  await store.setUserDisabled(id('dis'), now);
  const call = (name: Name, method: string, path: string, body?: object) => fetch(base + path, { method,
    headers: { cookie: cookies.get(name)!, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const close = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
  return { config, store, call, id, users, close };
}

const COMMENTS = '/api/v1/sessions/session/comments';
const PEOPLE = '/api/v1/sessions/session/comment-people';
const anchor = { kind: 'canvas', surface: 'page', x: 10, y: 20 };

test('the mention request is a list of at most ten ids', () => {
  assert.deepEqual(readMentionRequest(['a', 'b', 'a']), ['a', 'b']);
  assert.deepEqual(readMentionRequest([]), []);
  assert.equal(readMentionRequest('a'), null);
  assert.equal(readMentionRequest([1]), null);
  assert.equal(readMentionRequest(Array.from({ length: 11 }, (_, i) => `u${i}`)), null);
  assert.deepEqual(mentionsStillInBody([{ id: 'a', name: 'Ann Lee' }, { id: 'b', name: 'Bo' }], 'thanks @Ann Lee'), [{ id: 'a', name: 'Ann Lee' }]);
});

test('S-1: only eligible people are mentioned; nothing is granted, requested or sent to anyone else', async () => {
  const w = await world();
  try {
    const grantsBefore = (await w.store.listGrants()).length;
    const requested = [w.id('ben'), w.id('out'), w.id('ada'), w.id('dis'), 'svc_robot', w.id('ana'), 'usr_unknown', w.id('den'), w.id('joe'), w.id('cat')];
    const response = await w.call('ana', 'POST', COMMENTS, { id: 'thread', messageId: 'm1', anchor, body: 'Please check @ben and @cat', mentions: requested });
    assert.equal(response.status, 201, await response.clone().text());
    const { thread, notified } = await response.json() as { thread: CommentThread; notified: boolean };
    assert.deepEqual(thread.messages[0]!.mentions, [{ id: w.id('ben'), name: 'ben' }, { id: w.id('cat'), name: 'cat' }]);
    assert.equal(notified, true);
    assert.deepEqual((await w.store.getCommentThread('thread'))!.messages[0]!.mentions?.map((m) => m.id), [w.id('ben'), w.id('cat')]);
    for (const name of ['out', 'ada'] as const) assert.equal(await w.store.getProjectMember('project', w.id(name)), null, `${name} gained no membership`);
    assert.equal((await w.store.listGrants()).length, grantsBefore, 'no grant was written');
    for (const name of ['out', 'ada', 'dis', 'den', 'joe', 'ana'] as const)
      assert.deepEqual(await w.store.listCommentNotices(w.id(name)), [], `${name} was not notified`);
    assert.equal((await w.store.listCommentNotices(w.id('ben'))).length, 1);
    assert.equal((await w.store.listCommentNotices(w.id('cat'))).length, 1);
    const audit = (await w.store.listAudit()).find((e) => e.action === 'comment.create');
    assert.deepEqual(audit?.payload?.['mentioned'], [w.id('ben'), w.id('cat')], 'the audit names ids only');
    assert.ok(!JSON.stringify(audit).includes('@test'));
    // Malformed lists are refused rather than silently dropped.
    for (const mentions of ['ben', [42], Array.from({ length: 11 }, (_, i) => `usr_${i}`)]) {
      assert.equal((await w.call('ana', 'POST', COMMENTS, { id: 'bad', messageId: 'bad', anchor, body: 'x', mentions })).status, 400);
    }
    // A reply may mention too, with the same rule.
    const reply = await w.call('ben', 'POST', `${COMMENTS}/thread`, { revision: thread.revision, action: 'reply', messageId: 'm2', body: 'cc @out', mentions: [w.id('out'), w.id('nia')] });
    assert.equal(reply.status, 200);
    const replied = (await reply.json() as { thread: CommentThread }).thread;
    assert.deepEqual(replied.messages[1]!.mentions, [{ id: w.id('nia'), name: 'nia' }]);
    assert.deepEqual(await w.store.listCommentNotices(w.id('out')), []);
  } finally { await w.close(); }
});

test('eligibility helper agrees with the routes and counts what it dropped', async () => {
  const w = await world();
  try {
    const session = (await w.store.getSession('session'))!, project = (await w.store.getProject('project'))!;
    const { kept, skipped } = await eligibleMentionIds({ store: w.store, config: w.config },
      { session, project, requested: [w.id('ben'), w.id('ben'), w.id('ada'), w.id('ana')], actorId: w.id('ana') });
    assert.deepEqual(kept, [{ id: w.id('ben'), name: 'ben' }]);
    assert.equal(skipped, 2, 'duplicates count once');
    await w.store.putSession({ ...session, deletedAt: new Date().toISOString() });
    assert.deepEqual((await eligibleMentionIds({ store: w.store, config: w.config },
      { session: (await w.store.getSession('session'))!, project, requested: [w.id('ben')], actorId: w.id('ana') })).kept, [], 'nobody is mentionable in a deleted session');
  } finally { await w.close(); }
});

test('S-2 and S-17: comment-people lists eligible people only, by prefix, without the caller or any address', async () => {
  const w = await world();
  try {
    const list = async (name: Name, q = '') => {
      const response = await w.call(name, 'GET', `${PEOPLE}?q=${encodeURIComponent(q)}`);
      assert.equal(response.status, 200, await response.clone().text());
      const text = await response.text();
      assert.ok(!text.includes('@'), `no address in the body: ${text}`);
      return JSON.parse(text) as { people: Array<{ id: string; name: string }>; truncated: boolean };
    };
    const everyone = await list('ana');
    assert.deepEqual(everyone.people.map((p) => p.name), ['ben', 'cat', 'nia'], 'out, ada, dis, den, joe and the caller are not offered');
    assert.equal(everyone.truncated, false);
    assert.deepEqual([...new Set(everyone.people.flatMap((p) => Object.keys(p)))].sort(), ['id', 'name']);
    assert.deepEqual((await list('ana', 'B')).people.map((p) => p.name), ['ben']);
    assert.deepEqual((await list('ana', 'en')).people, [], 'a prefix, not a substring');
    assert.deepEqual((await list('ben')).people.map((p) => p.name), ['ana', 'cat', 'nia'], 'the owner is offered to members');
    // Viewers who may comment may mention.
    assert.deepEqual((await list('cat', 'n')).people.map((p) => p.name), ['nia']);
    // Outsiders, people who cannot comment, and instances with commenting off are refused.
    assert.equal((await w.call('out', 'GET', PEOPLE)).status, 403);
    assert.equal((await w.call('ada', 'GET', PEOPLE)).status, 200, 'an admin who can open the project may look, but is not offered to others');
    await w.store.putGrant({ principal: `user:${w.id('cat')}`, action: 'comment.create', resource: '*', effect: 'deny' });
    assert.equal((await w.call('cat', 'GET', PEOPLE)).status, 403, 'no right to comment, no people list');
    w.config.policy.comments = { enabled: false };
    assert.equal((await w.call('ana', 'GET', PEOPLE)).status, 403, 'commenting off');
  } finally { await w.close(); }
});

test('S-2: the cap applies after the comment check, so truncated stays honest', async () => {
  const w = await world();
  try {
    const now = new Date().toISOString();
    for (let i = 0; i < 21; i++) {
      const user = await w.store.upsertUserBySub({ sub: `pad:${i}`, email: `pad${i}@test`, firstname: 'Pad', lastname: String(i).padStart(2, '0'), groups: [], role: 'member' });
      await w.store.putProjectMember({ projectId: 'project', userId: user.id, role: 'viewer', addedBy: w.id('ana'), addedAt: now });
      // Two of them may not read comments: they must not take a place in the page.
      if (i < 2) await w.store.putGrant({ principal: `user:${user.id}`, action: 'comment.view', resource: '*', effect: 'deny' });
    }
    const pads = await (await w.call('ana', 'GET', `${PEOPLE}?q=pad`)).json() as { people: Array<{ name: string }>; truncated: boolean };
    assert.equal(pads.people.length, 19);
    assert.equal(pads.truncated, false, '21 joinable, 19 may read comments: one page, not truncated');
    const all = await (await w.call('ana', 'GET', PEOPLE)).json() as { people: Array<{ name: string }>; truncated: boolean };
    assert.equal(all.people.length, 20);
    assert.equal(all.truncated, true);
    assert.equal((await (await w.call('ana', 'GET', `${PEOPLE}?q=${'p'.repeat(200)}`)).json() as { people: unknown[] }).people.length, 0, 'long queries are cut, not refused');
  } finally { await w.close(); }
});

test('mentions can be switched off: no list, no stored mentions, and GET says so', async () => {
  const w = await world({ mentions: false });
  try {
    assert.equal((await w.call('ana', 'GET', PEOPLE)).status, 403);
    const created = await w.call('ana', 'POST', COMMENTS, { id: 'quiet', messageId: 'q1', anchor, body: 'hi @ben', mentions: [w.id('ben')] });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { thread: CommentThread }).thread.messages[0]!.mentions, undefined);
    assert.deepEqual(await w.store.listCommentNotices(w.id('ben')), []);
    const list = await (await w.call('ana', 'GET', COMMENTS)).json() as { features: { mentions: boolean } };
    assert.equal(list.features.mentions, false);
    assert.throws(() => parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', comments: { enabled: true, mentions: 'no' } } })), /policy\.comments\.mentions/);
  } finally { await w.close(); }
});

test('an edit keeps the mentions still written in the text, or takes a new list', async () => {
  const w = await world();
  try {
    let thread = (await (await w.call('ana', 'POST', COMMENTS, { id: 'edit', messageId: 'e1', anchor, body: 'Ask @ben', mentions: [w.id('ben')] })).json() as { thread: CommentThread }).thread;
    const edit = async (body: string, mentions?: string[]) => {
      const response = await w.call('ana', 'POST', `${COMMENTS}/edit`, { revision: thread.revision, action: 'edit', messageId: 'e1', body, ...(mentions ? { mentions } : {}) });
      assert.equal(response.status, 200, await response.clone().text());
      thread = (await response.json() as { thread: CommentThread }).thread;
      return thread.messages[0]!.mentions?.map((m) => m.name);
    };
    assert.deepEqual(await edit('Ask @ben again'), ['ben'], 'still in the text');
    assert.equal(await edit('Ask someone'), undefined, 'removed from the text');
    assert.deepEqual(await edit('Ask @cat and @out', [w.id('cat'), w.id('out')]), ['cat'], 'a new list goes through the same rule');
  } finally { await w.close(); }
});

