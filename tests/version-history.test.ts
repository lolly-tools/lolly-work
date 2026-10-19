// SPDX-License-Identifier: MPL-2.0
/**
 * History across documents (plan 221): GET /api/v1/history. One page lists the
 * versions of every document the caller may read, newest first, paged by an
 * opaque keyset position. The tests keep to what must never show (documents in
 * projects the caller cannot see, deleted documents, documents a grant denies,
 * hidden, archived and expired projects, and projects the caller pinned or
 * opened and then lost access to), the default "own projects" scope,
 * the filters, paging over equal times, and the input checks. The store's half
 * of the query is the store conformance suite's subject.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createRouter } from '../server/src/api/router.ts';
import { hashServiceSecret } from '../server/src/iam/service-tokens.ts';
import { evaluate, type Grant, type PrincipalCtx, type Role } from '../server/src/rbac/evaluate.ts';
import type { ProjectAccess } from '../server/src/rbac/project-access.ts';
import { historyCursor, historyPosition, historyScope, registerHistoryRoutes } from '../server/src/versions/history.ts';
import type { ProjectRecord, SessionVersionWrite, UserRecord } from '../server/src/store/types.ts';

const SECRETS = { session: 'history-route-session', link: 'history-route-link' };
const PEOPLE = ['alice', 'bob', 'carol', 'dana'] as const;
type Person = typeof PEOPLE[number];

interface Entry {
  id: string; sessionId: string; projectId: string; projectName: string | null; projectArchived?: true; toolId: string; sessionLabel: string | null;
  kind: string; label?: string; pinned: boolean; at: string; createdBy?: string; createdByName?: string;
  contributors: Array<{ id: string; kind: string; edits: number; name: string }>;
}
interface Page { entries: Entry[]; before?: string }

let store: ReturnType<typeof createMemoryStore>;
let server: Server;
let base: string;
const cookies = new Map<Person, string>();
const users = new Map<Person, UserRecord>();
/** Version ids by document, oldest first. */
const written = new Map<string, string[]>();
const START = Date.parse('2026-09-01T09:00:00.000Z');
let minute = 0;

const call = (who: Person | { bearer: string } | null, path: string) => fetch(`${base}${path}`, {
  headers: who === null ? {} : typeof who === 'string' ? { cookie: cookies.get(who)! } : { authorization: `Bearer ${who.bearer}` },
});
async function page(who: Person, query = ''): Promise<Page> {
  const res = await call(who, `/api/v1/history${query}`);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as Page;
}
const docs = (p: Page): string[] => [...new Set(p.entries.map((e) => e.sessionId))].sort();

async function project(id: string, owner: Person, extra: Partial<ProjectRecord> = {}): Promise<void> {
  await store.putProject({ id, name: `Project ${id}`, visibility: 'private', ownerId: users.get(owner)!.id, createdAt: new Date(START).toISOString(), ...extra });
}
async function member(projectId: string, who: Person, role: 'viewer' | 'editor' = 'viewer', expiresAt?: string): Promise<void> {
  await store.putProjectMember({ projectId, userId: users.get(who)!.id, role, addedBy: 'test', addedAt: new Date(START).toISOString(), ...(expiresAt ? { expiresAt } : {}) });
}
/** A document with `count` versions, one minute apart, written by alice. */
async function documentWith(id: string, projectId: string, toolId: string, count: number): Promise<void> {
  const alice = users.get('alice')!;
  await store.putSession({ id, projectId, toolId, toolVersion: '1', inputs: { secret: `content of ${id}` }, meta: { label: `Doc ${id}` },
    createdBy: alice.id, updatedBy: alice.id, rev: 1, updatedAt: new Date(START).toISOString() });
  for (let i = 0; i < count; i++) await version({ sessionId: id, rev: 1, kind: 'save', inputs: { secret: `content of ${id}`, step: i }, meta: {},
    contributors: [{ id: alice.id, kind: 'user', edits: 1 }], createdBy: alice.id });
}
async function version(w: SessionVersionWrite, at = new Date(START + ++minute * 60_000).toISOString()): Promise<string> {
  const put = await store.putSessionVersion({ ...w, at });
  assert.ok(typeof put === 'object' && put.created);
  written.set(w.sessionId, [...(written.get(w.sessionId) ?? []), put.version.id]);
  return put.version.id;
}

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-history-routes-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'History routes', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'alice@test', name: 'Alice Owner', groups: ['team'] },
      { email: 'bob@test', name: 'Bob Reader', groups: ['team'] },
      { email: 'carol@test', name: 'Carol Outside', groups: ['other'] },
      { email: 'dana@test', name: 'Dana Admin', groups: ['admin'] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: SECRETS });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const name of PEOPLE) {
    const res = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    cookies.set(name, res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
    users.set(name, (await store.findUsersByEmail(`${name}@test`))[0]!);
  }
  // Bob's own projects: a member of prj_a, in the team group of prj_b.
  await project('prj_a', 'alice'); await member('prj_a', 'bob');
  await project('prj_b', 'alice', { visibility: { groups: ['team'] } });
  // What bob must not see by default, each for its own reason.
  await project('prj_secret', 'carol');
  await project('prj_everyone', 'carol', { sharing: { general: { audience: 'instance', role: 'viewer' } } });
  await project('prj_hidden', 'carol'); await member('prj_hidden', 'bob');
  await store.putProjectUserState(users.get('bob')!.id, 'prj_hidden', { listed: 'hidden' });
  await project('prj_archived', 'alice', { archivedAt: new Date(START).toISOString() }); await member('prj_archived', 'bob');
  await project('prj_expired', 'carol'); await member('prj_expired', 'bob', 'viewer', new Date(START).toISOString());

  await documentWith('ses_a1', 'prj_a', 'design', 3);
  await documentWith('ses_a2', 'prj_a', 'chart', 2);
  await documentWith('ses_b1', 'prj_b', 'design', 2);
  await documentWith('ses_gone', 'prj_a', 'design', 2);
  await documentWith('ses_s1', 'prj_secret', 'design', 2);
  await documentWith('ses_e1', 'prj_everyone', 'design', 1);
  await documentWith('ses_h1', 'prj_hidden', 'design', 1);
  await documentWith('ses_r1', 'prj_archived', 'design', 1);
  await documentWith('ses_x1', 'prj_expired', 'design', 1);
  // Deleted with its version rows left behind, as a stopped DELETE leaves them.
  const gone = (await store.getSession('ses_gone'))!;
  await store.putSession({ ...gone, deletedAt: new Date().toISOString() });
  // A named version and a pinned one, for the kind and kept filters.
  await version({ sessionId: 'ses_a1', rev: 1, kind: 'named', label: 'Final', inputs: { secret: 'final' }, meta: {}, contributors: [], createdBy: users.get('alice')!.id });
  const pinned = await version({ sessionId: 'ses_b1', rev: 1, kind: 'auto', inputs: { secret: 'auto' }, meta: {},
    contributors: [{ id: 'guest', kind: 'guest', edits: 2 }] });
  const out = await store.annotateSessionVersion('ses_b1', pinned, { pinned: true, annotationRev: 0, by: users.get('alice')!.id });
  assert.ok(typeof out === 'object' && out.changed);
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('the default page holds the versions of the person\'s own documents, newest first, and nothing else', async () => {
  const p = await page('bob');
  assert.deepEqual(docs(p), ['ses_a1', 'ses_a2', 'ses_b1'],
    'no deleted document, no project they cannot see, no project shared only with everyone, and no hidden, archived or expired project');
  assert.equal(p.entries.length, 3 + 1 + 2 + 2 + 1);
  assert.equal(p.before, undefined, 'a page shorter than the limit is the last');
  const order = p.entries.map((e) => e.at);
  assert.deepEqual(order, [...order].sort().reverse(), 'newest first');
  const final = p.entries.find((e) => e.label === 'Final')!;
  assert.equal(final.kind, 'named');
  assert.equal(final.projectId, 'prj_a');
  assert.equal(final.projectName, 'Project prj_a');
  assert.equal(final.toolId, 'design');
  assert.equal(final.sessionLabel, 'Doc ses_a1');
  assert.equal(final.createdByName, 'Alice Owner');
  const guest = p.entries.find((e) => e.pinned)!;
  assert.deepEqual(guest.contributors, [{ id: 'guest', kind: 'guest', edits: 2, name: 'Guest' }]);
  const text = JSON.stringify(p);
  assert.doesNotMatch(text, /content of|"inputs"|"meta"/, 'no document content');
  assert.doesNotMatch(text, /@test/, 'no email address');
});

test('a project the caller cannot see is refused by name, and never read', async () => {
  for (const id of ['prj_secret', 'prj_expired']) {
    const res = await call('bob', `/api/v1/history?project=${id}`);
    assert.equal(res.status, 403, id);
    assert.doesNotMatch(await res.text(), /ses_/);
  }
  assert.equal((await call('bob', '/api/v1/history?project=prj_nope')).status, 404);
  // An allow grant on one document never opens a project the person cannot see.
  const grant: Grant = { principal: `user:${users.get('bob')!.id}`, action: 'session.view', resource: 'session:ses_s1', effect: 'allow' };
  await store.putGrant(grant);
  try {
    assert.equal(docs(await page('bob')).includes('ses_s1'), false);
    assert.equal((await call('bob', '/api/v1/history?project=prj_secret')).status, 403);
  } finally { await store.deleteGrant(grant); }
});

test('a deleted document never appears, even when its versions are still stored', async () => {
  assert.equal((await store.listSessionVersions('ses_gone', { limit: 10 })).length, 2, 'the fixture keeps the rows');
  assert.equal(docs(await page('bob', '?project=prj_a')).includes('ses_gone'), false);
  assert.equal(docs(await page('alice')).includes('ses_gone'), false);
});

test('a session.view deny takes out the document, the project or everything', async () => {
  const bob = `user:${users.get('bob')!.id}`;
  const cases: Array<[Grant, string[]]> = [
    [{ principal: bob, action: 'session.view', resource: 'session:ses_a2', effect: 'deny' }, ['ses_a1', 'ses_b1']],
    [{ principal: 'group:team', action: 'session.view', resource: 'project:prj_b', effect: 'deny' }, ['ses_a1', 'ses_a2']],
    [{ principal: '*', action: 'session.view', resource: '*', effect: 'deny' }, []],
  ];
  for (const [grant, expected] of cases) {
    await store.putGrant(grant);
    try {
      assert.deepEqual(docs(await page('bob')), expected, grant.resource);
      assert.deepEqual(docs(await page('bob', '?project=prj_a')), expected.filter((id) => id.startsWith('ses_a')), `${grant.resource}, one project`);
    } finally { await store.deleteGrant(grant); }
  }
  // A deny for someone else changes nothing for bob.
  const other: Grant = { principal: `user:${users.get('carol')!.id}`, action: 'session.view', resource: 'session:ses_a2', effect: 'deny' };
  await store.putGrant(other);
  try { assert.deepEqual(docs(await page('bob')), ['ses_a1', 'ses_a2', 'ses_b1']); } finally { await store.deleteGrant(other); }
});

test('hidden, archived and shared-with-everyone projects follow the Projects list rule', async () => {
  const bob = users.get('bob')!.id;
  assert.deepEqual(docs(await page('bob', '?project=prj_hidden')), ['ses_h1'], 'a hidden project named on purpose');
  assert.deepEqual(docs(await page('bob', '?project=prj_everyone')), ['ses_e1'], 'a project shared with everyone, named on purpose');
  assert.deepEqual(docs(await page('bob', '?archived=1')), ['ses_a1', 'ses_a2', 'ses_b1', 'ses_r1']);
  assert.equal((await page('bob', '?archived=1')).entries.find((e) => e.sessionId === 'ses_r1')?.projectArchived, true);
  await store.putProjectUserState(bob, 'prj_everyone', { lastOpenedAt: new Date().toISOString() });
  try {
    assert.deepEqual(docs(await page('bob')), ['ses_a1', 'ses_a2', 'ses_b1', 'ses_e1'], 'opened lately');
    await store.putProjectUserState(bob, 'prj_everyone', { listed: 'hidden' });
    assert.deepEqual(docs(await page('bob')), ['ses_a1', 'ses_a2', 'ses_b1'], 'hidden wins over opened');
    await store.putProjectUserState(bob, 'prj_everyone', { listed: 'pinned', lastOpenedAt: new Date(START).toISOString() });
    assert.deepEqual(docs(await page('bob')), ['ses_a1', 'ses_a2', 'ses_b1', 'ses_e1'], 'pinned');
  } finally { await store.putProjectUserState(bob, 'prj_everyone', { listed: null, lastOpenedAt: new Date(START).toISOString() }); }
  assert.deepEqual(docs(await page('bob')), ['ses_a1', 'ses_a2', 'ses_b1'], 'opened long ago');
});

test('a project the person pinned or opened, then lost access to, never shows', async () => {
  // A pin or a recent open keeps a project in the person's own list whatever
  // their access, so only the access check keeps these out: a membership that
  // expired, a membership removed, a group taken away and sharing with everyone
  // turned off.
  const bob = users.get('bob')!.id;
  await project('prj_removed', 'alice'); await member('prj_removed', 'bob');
  await project('prj_regrouped', 'alice', { visibility: { groups: ['team'] } });
  await project('prj_unshared', 'alice', { sharing: { general: { audience: 'instance', role: 'viewer' } } });
  await documentWith('ses_m1', 'prj_removed', 'design', 1);
  await documentWith('ses_g1', 'prj_regrouped', 'design', 1);
  await documentWith('ses_u1', 'prj_unshared', 'design', 1);
  const lost = { prj_expired: 'ses_x1', prj_removed: 'ses_m1', prj_regrouped: 'ses_g1', prj_unshared: 'ses_u1' };
  const states: Array<[string, { listed?: 'pinned' | null; lastOpenedAt?: string }]> = [
    ['pinned', { listed: 'pinned' }],
    ['opened just now', { listed: null, lastOpenedAt: new Date().toISOString() }],
  ];
  try {
    for (const [why, state] of states) {
      for (const id of Object.keys(lost)) await store.putProjectUserState(bob, id, state);
      assert.deepEqual(docs(await page('bob')), ['ses_a1', 'ses_a2', 'ses_b1', 'ses_g1', 'ses_m1', 'ses_u1'], `${why}: what bob can still see shows, and the expired membership does not`);
    }
    await store.deleteProjectMember('prj_removed', bob);
    await project('prj_regrouped', 'alice');
    await project('prj_unshared', 'alice');
    for (const [why, state] of states) {
      for (const id of Object.keys(lost)) await store.putProjectUserState(bob, id, state);
      for (const query of ['', '?archived=1', '?limit=100', '?tool=design']) {
        const shown = docs(await page('bob', query));
        assert.deepEqual(shown.filter((id) => Object.values(lost).includes(id)), [], `${why}, ${query || 'the default page'}`);
      }
    }
    for (const id of Object.keys(lost)) assert.equal((await call('bob', `/api/v1/history?project=${id}`)).status, 403, id);
  } finally {
    for (const id of Object.keys(lost)) await store.putProjectUserState(bob, id, { listed: null, lastOpenedAt: new Date(START).toISOString() });
  }
});

test('an admin sees every project by name, but only their own by default', async () => {
  assert.deepEqual(docs(await page('dana')), []);
  assert.deepEqual(docs(await page('dana', '?project=prj_secret')), ['ses_s1']);
  assert.deepEqual(docs(await page('carol')), ['ses_e1', 'ses_h1', 'ses_s1', 'ses_x1']);
});

test('pages follow each other without a gap or a repeat, across versions saved at the same time', async () => {
  // Three versions in one millisecond: their ids break the tie.
  const at = new Date(START + 500 * 60_000).toISOString();
  for (let i = 0; i < 3; i++) await version({ sessionId: 'ses_a2', rev: 1, kind: 'save', inputs: { tie: i }, meta: {}, contributors: [] }, at);
  const all = (await page('bob', '?limit=100')).entries.map((e) => e.id);
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const p = await page('bob', `?limit=2${cursor ? `&before=${cursor}` : ''}`);
    seen.push(...p.entries.map((e) => e.id));
    if (!p.before) break;
    assert.equal(p.entries.length, 2);
    cursor = p.before;
  }
  assert.deepEqual(seen, all);
  assert.equal(new Set(seen).size, seen.length);
  // The cursor names only the last entry shown.
  const first = await page('bob', '?limit=2');
  assert.deepEqual(historyPosition(first.before!), { at: first.entries[1]!.at, id: first.entries[1]!.id });
});

test('filters narrow the page on the server', async () => {
  assert.deepEqual(docs(await page('bob', '?tool=chart')), ['ses_a2']);
  assert.deepEqual((await page('bob', '?kind=named')).entries.map((e) => e.label), ['Final']);
  assert.deepEqual((await page('bob', '?kind=named,auto')).entries.map((e) => e.kind).sort(), ['auto', 'named']);
  assert.deepEqual((await page('bob', '?kept=1')).entries.map((e) => e.kind).sort(), ['auto', 'named'], 'named, and pinned later');
  const ids = written.get('ses_a1')!;
  const window = (await page('bob', '?project=prj_a&tool=design')).entries.filter((e) => ids.slice(0, 2).includes(e.id));
  const from = window.at(-1)!.at, to = window[0]!.at;
  assert.deepEqual((await page('bob', `?tool=design&project=prj_a&from=${from}&to=${to}`)).entries.map((e) => e.id).sort(), ids.slice(0, 2).sort(), 'both ends included');
  assert.deepEqual((await page('bob', `?from=${to}&to=${from}`)).entries, [], 'an empty window');
});

test('malformed queries are refused, and a person is required', async () => {
  for (const query of ['limit=0', 'limit=101', 'limit=2.5', 'kind=bogus', 'kind=named,', 'from=yesterday', 'to=', 'before=nope',
    `before=${Buffer.from('["2026-09-01T09:00:00Z","ver_x"]').toString('base64url')}`, `before=${historyCursor({ at: 'x', id: 'ver_x' })}`]) {
    const res = await call('bob', `/api/v1/history?${query}`);
    assert.equal(res.status, 400, query);
  }
  const raw = 'lwt_history_robot';
  await store.putApiToken({ id: 'tok_history', label: 'robot', role: 'owner', tokenHash: hashServiceSecret(raw), createdBy: 'user:x', createdAt: new Date().toISOString() });
  for (const who of [{ bearer: raw }, null] as const) assert.equal((await call(who, '/api/v1/history')).status, 401);
});

test('an agent acting for a person cannot read their history', async () => {
  const router = createRouter();
  registerHistoryRoutes(router, { store, memberOf: async () => users.get('bob')!, delegated: () => true });
  const local = createServer((req, res) => void router.dispatch(req, res));
  await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', () => resolve()));
  try {
    const res = await fetch(`http://127.0.0.1:${(local.address() as { port: number }).port}/api/v1/history`);
    assert.equal(res.status, 403);
  } finally {
    local.closeAllConnections();
    await new Promise<void>((resolve) => local.close(() => resolve()));
  }
});

test('historyScope never takes in a document session.view refuses, and leaves out only what a member role cannot read', () => {
  const sessions = [{ id: 'S1', project: 'P1' }, { id: 'S2', project: 'P1' }, { id: 'S3', project: 'P2' }, { id: 'S4', project: 'P3' }];
  const access: Record<string, ProjectAccess> = { P1: 'viewer', P2: 'editor', P3: 'none' };
  const resources = ['*', 'project:P1', 'project:P2', 'session:S1', 'session:S3', 'session:S4'];
  const principals = ['user:u1', 'group:g1', 'user:other'];
  let checked = 0;
  for (const role of ['member', 'viewer', 'guest'] as Role[]) {
    const ctx: PrincipalCtx = { userId: 'u1', groups: ['g1'], role };
    // Every choice of none, allow or deny for each resource, for one principal at a time.
    for (const who of principals) {
      for (let combo = 0; combo < 3 ** resources.length; combo++) {
        const grants: Grant[] = [];
        let n = combo;
        for (const resource of resources) {
          const choice = n % 3; n = Math.floor(n / 3);
          if (choice) grants.push({ principal: who, action: 'session.view', resource, effect: choice === 1 ? 'allow' : 'deny' });
        }
        const scope = historyScope(ctx, Object.entries(access).map(([id, a]) => ({ id, access: a })), grants);
        for (const s of sessions) {
          const inScope = scope.projectIds.includes(s.project) && !scope.exceptSessionIds.includes(s.id);
          const readable = access[s.project] !== 'none' && evaluate(ctx, 'session.view', ['*', `session:${s.id}`, `project:${s.project}`], grants);
          if (inScope) assert.ok(readable, `${role} ${who} ${JSON.stringify(grants)} ${s.id}: in scope but not readable`);
          if (role !== 'guest') assert.equal(inScope, readable, `${role} ${who} ${JSON.stringify(grants)} ${s.id}`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 10_000);
});
