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

// ── Plan 76 milestone 4: read state, one-thread fetch, ETag (S-8) ───────────
// Read routes change only the caller's own rows, never anyone else's, and a
// thread from another session is a 404 on every route that names one.

/** `enforceBudget`: the plan 76 budget (p95 50 ms server time at 100 threads)
 *  is asserted on local Postgres, where it is defined; the in-memory run on a
 *  shared CI machine reports the figure without failing on scheduler noise. */
async function readState(store: Store, report: (message: string) => void, enforceBudget: boolean) {
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false }, policy: { comments: { enabled: true } }, dev: { enabled: true,
    users: ['ana', 'ben', 'cat', 'out'].map(name => ({ email: `${name}@test`, name, groups: [] })) } }));
  const app = buildApp({ config, store, secrets: { session: 'reads-session', link: 'reads-link' } }), serverTimes: number[] = [];
  const server = createServer((req, res) => {
    const started = performance.now();
    res.on('finish', () => serverTimes.push(performance.now() - started));
    return app(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, cookies = new Map<string, string>();
  try {
    for (const name of ['ana', 'ben', 'cat', 'out']) {
      const response = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
      cookies.set(name, response.headers.getSetCookie().find(cookie => cookie.startsWith('lw_session='))!.split(';')[0]!);
    }
    const call = (name: string, method: string, path: string, body?: object, headers: Record<string, string> = {}) => fetch(base + path, { method,
      headers: { cookie: cookies.get(name)!, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const user = async (name: string) => (await store.findUsersByEmail(`${name}@test`))[0]!;
    const ana = await user('ana'), ben = await user('ben'), cat = await user('cat');
    const now = new Date().toISOString();
    for (const id of ['one', 'two']) {
      await store.putProject({ id: `project-${id}`, ownerId: ana.id, name: id, visibility: 'private', createdAt: now, updatedAt: now });
      for (const [member, role] of [[ben, 'editor'], [cat, 'viewer']] as const)
        await store.putProjectMember({ projectId: `project-${id}`, userId: member.id, role, addedBy: ana.id, addedAt: now });
      await store.putSession({ id: `session-${id}`, projectId: `project-${id}`, toolId: 'design', toolVersion: '1', inputs: {}, meta: {}, createdBy: ana.id, updatedBy: ana.id, rev: 1, updatedAt: now });
    }
    const one = '/api/v1/sessions/session-one', anchor = { kind: 'canvas', surface: 'page', x: 1, y: 2 };
    const create = async (session: string, id: string, extra: object = {}) =>
      assert.equal((await call('ben', 'POST', `${session}/comments`, { id, messageId: `${id}-m`, anchor, body: `About ${id}`, ...extra })).status, 201);
    await create(one, 'alpha', { mentions: [cat.id] });
    await create(one, 'beta');
    await create('/api/v1/sessions/session-two', 'elsewhere');
    type Listing = { enabled: boolean; threads: CommentThread[]; reads: Record<string, string>; readFloor: string; notices: string[]; features: Record<string, boolean> };
    const list = async (name: string) => {
      const response = await call(name, 'GET', `${one}/comments`);
      assert.equal(response.status, 200);
      return { etag: response.headers.get('etag')!, body: await response.json() as Listing };
    };

    const first = await list('cat');
    assert.deepEqual(first.body.reads, {});
    assert.ok(Number.isFinite(Date.parse(first.body.readFloor)), 'the first listing sets the read floor');
    assert.deepEqual(first.body.notices, ['alpha'], 'the mention shows as a notice on its thread');
    assert.deepEqual(first.body.features, { mentions: true, reads: true, events: false, thread: true }, 'no live room on this host');
    assert.match(first.etag, /^"cm-[0-9a-f]{24}"$/);
    const again = await call('cat', 'GET', `${one}/comments`, undefined, { 'if-none-match': first.etag });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    assert.equal((await list('cat')).body.readFloor, first.body.readFloor, 'the floor is set once');

    const thread = await call('cat', 'GET', `${one}/comments/alpha`);
    assert.equal(thread.status, 200);
    assert.deepEqual(Object.keys(await thread.json() as object), ['thread'], 'no readAt before it is read');
    assert.equal((await call('cat', 'GET', `${one}/comments/elsewhere`)).status, 404, 'a thread from another session');
    assert.equal((await call('out', 'GET', `${one}/comments/alpha`)).status, 403);

    const marked = await call('cat', 'POST', `${one}/comment-reads`, { threadIds: ['alpha'], at: '2999-01-01T00:00:00.000Z' });
    assert.equal(marked.status, 200);
    const { readAt, count } = await marked.json() as { readAt: string; count: number };
    assert.equal(count, 1);
    assert.ok(Date.parse(readAt) <= Date.now(), 'a read time is never later than now');
    const after = await list('cat');
    assert.notEqual(after.etag, first.etag, 'reading changes what the caller is shown');
    assert.deepEqual(after.body.reads, { alpha: readAt });
    assert.deepEqual(after.body.notices, [], 'reading a thread clears its notice');
    assert.deepEqual(await store.listCommentNotices(cat.id), []);
    assert.deepEqual((await (await call('cat', 'GET', `${one}/comments/alpha`)).json() as { readAt?: string }).readAt, readAt);
    assert.deepEqual((await list('ana')).body.reads, {}, 'another person is unaffected');

    for (const [body, status] of [
      [{ threadIds: ['elsewhere'] }, 404], [{ threadIds: 'alpha' }, 400], [{ threadIds: Array.from({ length: 101 }, (_, i) => `t${i}`) }, 400],
      [{ at: 'yesterday' }, 400], [[], 400],
    ] as const) assert.equal((await call('cat', 'POST', `${one}/comment-reads`, body as object)).status, status, JSON.stringify(body));
    assert.equal((await call('out', 'POST', `${one}/comment-reads`, {})).status, 403);
    const all = await call('ana', 'POST', `${one}/comment-reads`);
    assert.deepEqual((await all.json() as { count: number }).count, 2, 'no list marks every thread in the session');
    assert.deepEqual(Object.keys((await list('ana')).body.reads).sort(), ['alpha', 'beta']);

    // A reply changes the listing a peer sees.
    const reply = await call('ana', 'POST', `${one}/comments/beta`, { revision: 1, action: 'reply', messageId: 'beta-2', body: 'ok' });
    assert.equal(reply.status, 200);
    assert.notEqual((await list('cat')).etag, after.etag);

    // GET comments at 100 threads stays inside the plan 76 budget (p95 50 ms).
    for (let i = 0; i < 98; i++) {
      const at = new Date().toISOString();
      assert.equal(await store.createCommentThread({ id: `load${i}`, sessionId: 'session-one', anchor: { kind: 'canvas', surface: 'page', x: i, y: i },
        authorId: ben.id, authorName: 'ben', revision: 1, createdAt: at, updatedAt: at,
        messages: [{ id: `load${i}-m`, authorId: ben.id, authorName: 'ben', body: `Load note ${i} `.repeat(8), createdAt: at }] }), 'created');
    }
    assert.equal((await list('cat')).body.threads.length, 100);
    for (let i = 0; i < 10; i++) await (await call('cat', 'GET', `${one}/comments`)).arrayBuffer();
    // A round is 40 reads; up to three rounds are measured and the best one
    // counts, so a slower build fails every round while a burst of load on a
    // shared machine does not fail the suite (as the inbox budget does).
    let best = Infinity;
    for (let round = 1; round <= 3 && best > 50; round++) {
      serverTimes.length = 0;
      for (let i = 0; i < 40; i++) assert.equal((await call('cat', 'GET', `${one}/comments`)).status, 200);
      const times = serverTimes.slice(0, 40).sort((a, b) => a - b);
      const p50 = times[Math.floor(times.length * 0.5)]!, p95 = times[Math.ceil(times.length * 0.95) - 1]!;
      report(`GET comments at 100 threads (${store.storageKind}), round ${round}: server time p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
      best = Math.min(best, p95);
      if (!enforceBudget) break;
    }
    if (enforceBudget) assert.ok(best <= 50, `GET comments at 100 threads: p95 ${best.toFixed(1)} ms in the best round is over the 50 ms budget`);

    config.policy.comments = { enabled: false };
    assert.equal((await call('cat', 'GET', `${one}/comments/alpha`)).status, 403);
    assert.equal((await call('cat', 'POST', `${one}/comment-reads`, {})).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
test('read state, one-thread fetch and ETag change only the caller and stay in the session', (t) => readState(createMemoryStore(), (m) => t.diagnostic(m), false));
test('Postgres read state and the 100-thread listing budget', { skip: !process.env.LW_TEST_DATABASE_URL }, async (t) => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, (store) => readState(store, (m) => t.diagnostic(m), true));
});
