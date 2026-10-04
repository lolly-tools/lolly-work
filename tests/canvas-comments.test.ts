// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { Store } from '../server/src/store/types.ts';
import type { CommentThread } from '@lolly-tools/core/canvas-review-v1';
import { withFreshPostgres } from './pg-test-schema.ts';

async function journey(store: Store) {
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false }, policy: { comments: { enabled: true } }, dev: { enabled: true,
    users: ['alice', 'editor', 'reviewer', 'outside'].map(name => ({ email: `${name}@test`, name, groups: name === 'reviewer' ? ['viewer'] : [] })) } }));
  const app = () => buildApp({ config, store, secrets: { session: 'comments-session', link: 'comments-link' } });
  const server = createServer(app()); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, cookies = new Map<string, string>();
  try {
    for (const name of ['alice', 'editor', 'reviewer', 'outside']) {
      const response = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
      cookies.set(name, response.headers.getSetCookie().find(cookie => cookie.startsWith('lw_session='))!.split(';')[0]!);
    }
    const call = (name: string, method: string, path: string, body?: object) => fetch(base + path, { method,
      headers: { cookie: cookies.get(name)!, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const owner = (await store.findUsersByEmail('alice@test'))[0]!, reviewer = (await store.findUsersByEmail('reviewer@test'))[0]!, editor = (await store.findUsersByEmail('editor@test'))[0]!;
    const now = new Date().toISOString();
    await store.putProject({ id: 'project', ownerId: owner.id, name: 'Review', visibility: 'private', createdAt: now, updatedAt: now });
    for (const [user, role] of [[reviewer, 'viewer'], [editor, 'editor']] as const)
      await store.putProjectMember({ projectId: 'project', userId: user.id, role, addedBy: owner.id, addedAt: now });
    await store.putSession({ id: 'session', projectId: 'project', toolId: 'design', toolVersion: '1', inputs: { boxes: [{ id: 'image', x: 10, y: 20, w: 200, h: 100 }] }, meta: {}, createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: now });
    const path = '/api/v1/sessions/session/comments', anchor = { kind: 'object', collection: 'boxes', objectId: 'image', surface: 'page', x: .25, y: .8 };
    const create = { id: 'thread', messageId: 'message', anchor, body: 'Please align the image.' };
    assert.equal((await call('outside', 'GET', path)).status, 403);
    const response = await call('reviewer', 'POST', path, create); assert.equal(response.status, 201, await response.clone().text());
    let thread = (await response.json() as { thread: CommentThread }).thread;
    assert.equal(thread.authorId, reviewer.id); assert.equal(thread.messages[0]!.authorId, reviewer.id);
    assert.equal((await call('reviewer', 'POST', path, create)).status, 200, 'retry is idempotent');
    assert.equal((await store.getSession('session'))!.rev, 1, 'review does not modify artwork');
    const snapshot = await store.getSession('session');
    assert.equal((await call('reviewer', 'PUT', '/api/v1/sessions/session', { rev: 1, inputs: { boxes: [] } })).status, 403);
    assert.deepEqual((await store.getSession('session'))!.inputs, snapshot!.inputs);
    const reply = await call('editor', 'POST', `${path}/thread`, { revision: thread.revision, action: 'reply', messageId: 'reply', body: 'Aligned now.' });
    assert.equal(reply.status, 200, await reply.clone().text()); thread = (await reply.json() as { thread: CommentThread }).thread;
    assert.equal((await call('reviewer', 'POST', `${path}/thread`, { revision: 1, action: 'reply', messageId: 'late', body: 'Stale reply' })).status, 409);
    assert.equal((await call('reviewer', 'POST', `${path}/thread`, { revision: thread.revision, action: 'edit', messageId: 'reply', body: 'Replaced' })).status, 403);
    const resolve = await call('editor', 'POST', `${path}/thread`, { revision: thread.revision, action: 'resolve' });
    assert.equal(resolve.status, 200); thread = (await resolve.json() as { thread: CommentThread }).thread; assert.ok(thread.resolvedAt);
    const reopen = await call('reviewer', 'POST', `${path}/thread`, { revision: thread.revision, action: 'reopen' });
    assert.equal(reopen.status, 200); thread = (await reopen.json() as { thread: CommentThread }).thread; assert.equal(thread.resolvedAt, undefined);
    const current = (await store.getSession('session'))!; await store.putSession({ ...current, inputs: { boxes: [] }, rev: 2 });
    assert.deepEqual((await store.getCommentThread('thread'))!.anchor, anchor, 'object deletion leaves the review findable');
    assert.equal((await call('reviewer', 'POST', path, create)).status, 200, 'an accepted comment can be replayed after its anchor is removed');
    assert.equal((await call('alice', 'POST', path, create)).status, 409, 'a different author cannot replay another comment');
    assert.equal((await call('editor', 'POST', path, { ...create, id: 'missing' })).status, 409);
    await store.putGrant({ principal: `user:${reviewer.id}`, action: 'comment.create', resource: '*', effect: 'deny' });
    assert.equal((await call('reviewer', 'POST', `${path}/thread`, { revision: thread.revision, action: 'reply', messageId: 'denied', body: 'Denied comment' })).status, 403);
    assert.equal((await call('reviewer', 'GET', path)).status, 200, 'read access remains separate from the right to comment');
    const copies = await store.listCommentThreads('session'); assert.equal(copies.length, 1); assert.equal(copies[0]!.messages.length, 2);
    const competing = await Promise.all([store.casCommentThread({ ...thread, revision: thread.revision + 1 }, thread.revision), store.casCommentThread({ ...thread, revision: thread.revision + 1 }, thread.revision)]);
    assert.equal(competing.filter(Boolean).length, 1, 'concurrent commands cannot silently replace one another');
    await store.deleteProjectMember('project', reviewer.id);
    assert.equal((await call('reviewer', 'GET', path)).status, 403);
    assert.equal((await call('reviewer', 'POST', `${path}/thread`, { revision: thread.revision, action: 'reply', messageId: 'removed', body: 'No longer allowed' })).status, 403);
    config.policy.comments = { enabled: false };
    assert.deepEqual((await (await call('alice', 'GET', path)).json() as { threads: unknown[] }).threads, []);
    assert.equal((await call('alice', 'POST', path, { ...create, id: 'disabled' })).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test('reviewer, editor, durable review lifecycle and removal use independently evaluated permissions', () => journey(createMemoryStore()));
test('Postgres review survives outside a live room and uses an atomic revision guard', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, journey);
});
