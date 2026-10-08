// SPDX-License-Identifier: MPL-2.0
/**
 * Route resolution for the review comment paths (plan 76 milestone 4, S-18).
 *
 * The router takes the first registered pattern that matches, and a pattern
 * matches only paths with the same number of segments. So `/comments/read`
 * would be read as a thread called "read" if a read route lived under
 * `/comments/`. The read and people routes are siblings (`/comment-reads`,
 * `/comment-people`) instead, and threads called `read` and `people` behave
 * like any other thread. The matched pattern is what the request metric
 * records, so this test reads it from there, through the whole app.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { CommentThread } from '@lolly-tools/core/canvas-review-v1';
import { buildApp } from '../server/src/api/app.ts';
import { createRouter } from '../server/src/api/router.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMetrics, type Metrics } from '../server/src/observability/metrics.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';

test('a router pattern matches only paths with its own number of segments, first match wins', async () => {
  const router = createRouter(), hits: string[] = [];
  router.add('POST', '/s/:id/comments/:threadId', () => { hits.push('thread'); });
  router.add('POST', '/s/:id/comments/read', () => { hits.push('read'); });
  router.add('POST', '/s/:id/comment-reads', () => { hits.push('reads'); });
  const dispatch = (url: string) => router.dispatch({ method: 'POST', url } as never, {} as never);
  assert.equal(await dispatch('/s/1/comments/read'), '/s/:id/comments/:threadId', 'the earlier pattern takes the literal');
  assert.equal(await dispatch('/s/1/comment-reads'), '/s/:id/comment-reads');
  assert.equal(await dispatch('/s/1/comments'), null);
  assert.deepEqual(hits, ['thread', 'reads']);
});

test('S-18: every comment path resolves to its own handler, and threads named read and people are ordinary threads', async () => {
  const routes: string[] = [];
  const base = createMetrics();
  const metrics: Metrics = { ...base, httpRequest: (route, status) => { routes.push(route); base.httpRequest(route, status); } };
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false }, policy: { comments: { enabled: true } }, dev: { enabled: true,
    users: [{ email: 'ana@test', name: 'ana', groups: [] }, { email: 'cat@test', name: 'cat', groups: [] }] } }));
  const store = createMemoryStore(), frames: string[] = [];
  const server = createServer(buildApp({ config, store, metrics, secrets: { session: 'router-session', link: 'router-link' },
    roomEvents: (_id, frame) => frames.push(frame.threadId) }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const cookies = new Map<string, string>();
    for (const name of ['ana', 'cat']) {
      const response = await fetch(`${origin}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
      cookies.set(name, response.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    }
    const ana = (await store.findUsersByEmail('ana@test'))[0]!, cat = (await store.findUsersByEmail('cat@test'))[0]!;
    const now = new Date().toISOString();
    await store.putProject({ id: 'project', ownerId: ana.id, name: 'Routes', visibility: 'private', createdAt: now, updatedAt: now });
    await store.putProjectMember({ projectId: 'project', userId: cat.id, role: 'editor', addedBy: ana.id, addedAt: now });
    await store.putSession({ id: 'session', projectId: 'project', toolId: 'design', toolVersion: '1', inputs: {}, meta: {}, createdBy: ana.id, updatedBy: ana.id, rev: 1, updatedAt: now });

    /** Send one request and return its status, body and the pattern the app matched. */
    const hit = async (method: string, path: string, body?: object) => {
      const before = routes.length;
      const response = await fetch(origin + path, { method, headers: { cookie: cookies.get('ana')!, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await response.text();
      // The metric is recorded when the response finishes, which can trail the client by a tick.
      for (let i = 0; routes.length === before && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: response.status, json: text ? JSON.parse(text) as Record<string, unknown> : {}, route: routes.at(-1) };
    };
    const S = '/api/v1/sessions/session';
    const anchor = { kind: 'canvas', surface: 'page', x: 1, y: 2 };
    for (const id of ['read', 'people']) {
      const created = await hit('POST', `${S}/comments`, { id, messageId: `${id}-1`, anchor, body: `a thread called ${id}` });
      assert.deepEqual([created.status, created.route], [201, '/api/v1/sessions/:id/comments']);
      const fetched = await hit('GET', `${S}/comments/${id}`);
      assert.deepEqual([fetched.status, fetched.route], [200, '/api/v1/sessions/:id/comments/:threadId']);
      assert.equal((fetched.json['thread'] as CommentThread).id, id);
      const replied = await hit('POST', `${S}/comments/${id}`, { revision: 1, action: 'reply', messageId: `${id}-2`, body: 'a reply' });
      assert.deepEqual([replied.status, replied.route], [200, '/api/v1/sessions/:id/comments/:threadId']);
      assert.equal((replied.json['thread'] as CommentThread).messages.length, 2);
    }
    const list = await hit('GET', `${S}/comments`);
    assert.deepEqual([list.status, list.route], [200, '/api/v1/sessions/:id/comments']);
    assert.deepEqual((list.json['threads'] as CommentThread[]).map((t) => t.id).sort(), ['people', 'read']);
    assert.equal((list.json['features'] as { events: boolean }).events, true, 'a host with live rooms says events work');
    const reads = await hit('POST', `${S}/comment-reads`, { threadIds: ['read', 'people'] });
    assert.deepEqual([reads.status, reads.route, reads.json['count']], [200, '/api/v1/sessions/:id/comment-reads', 2]);
    const people = await hit('GET', `${S}/comment-people?q=c`);
    assert.deepEqual([people.status, people.route], [200, '/api/v1/sessions/:id/comment-people']);
    assert.deepEqual((people.json['people'] as Array<{ name: string }>).map((p) => p.name), ['cat']);
    const missing = await hit('GET', `${S}/comments/nothing-here`);
    assert.deepEqual([missing.status, missing.route], [404, '/api/v1/sessions/:id/comments/:threadId']);
    const wrongMethod = await hit('GET', `${S}/comment-reads`);
    assert.deepEqual([wrongMethod.status, wrongMethod.route], [404, 'unmatched']);
    assert.deepEqual(frames, ['read', 'read', 'people', 'people'], 'one live event per saved write, none for reads');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
