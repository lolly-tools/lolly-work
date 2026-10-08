// SPDX-License-Identifier: MPL-2.0
/** Render tickets grant catalog reads and, for the files a render names, file
 *  reads bound to the submitter's current access; never a human session or
 *  any other project route (plan 76 M4j, security rule S-13). */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  createRenderFileReader, mintRenderRead, projectFileRefs, renderFileScope, renderFileTicket, renderReader, RENDER_READ_FILE_LIMIT,
  type RenderFileScope,
} from '../server/src/render/read-ticket.ts';
import { mintToken, verifyToken } from '../server/src/iam/tokens.ts';
import { loadEngine } from '../server/src/render/contract.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { fileChecksum, type ProjectFileRecord } from '../server/src/projects/files.ts';
import type { ProjectAccess } from '../server/src/rbac/project-access.ts';
import type { ProjectRecord, Store, UserRecord } from '../server/src/store/types.ts';
import { boot, LINK_SECRET } from './invite-harness.ts';

test('render credential is limited by path, method, domain, revision and expiry', () => {
  const token = mintRenderRead(['design'], 'rev', 'secret');
  const read = (url: string, method = 'GET', key = token, revision = 'rev') => renderReader({ url, method, headers: { 'x-lw-render-read': key } } as unknown as IncomingMessage, revision, 'secret');
  assert.deepEqual(read('/catalog/assets/index.json')?.groups, ['design']);
  assert.ok(read('/tools/design/tool.json'));
  assert.ok(read('/catalog/fonts/a.woff2', 'HEAD'));
  for (const path of ['/api/auth/session', '/api/v1/projects', '/api/v1/org-config', '/api/v1/catalog/search', '/api/v1/users']) assert.equal(read(path), null);
  assert.equal(read('/catalog/assets/index.json', 'PUT'), null);
  assert.equal(read('/catalog/assets/index.json', 'GET', token, 'new'), null);
  assert.equal(read('/catalog/assets/index.json', 'GET', token+'bad'), null);
  assert.equal(verifyToken('lw/session', token, 'secret'), null);
  assert.equal(read('/catalog/assets/index.json', 'GET', mintToken('lw/render-read', { groups: [], revision: 'rev' }, 'secret', 1, Date.now()-5000)), null);
});

test('a gated instance admits a render catalog reader without opening sign-in or project routes', async () => {
  const env = await boot({ policy: { defaultAccessMode: 'gated' } });
  const config = await fetch(env.base+'/api/auth/config');
  const revision = config.headers.get('x-lolly-brand-revision')!;
  assert.equal((await config.json() as { mode: string }).mode, 'gated');
  const token = mintRenderRead([], revision, LINK_SECRET), headers = { 'x-lw-render-read': token };
  assert.equal((await fetch(env.base+'/catalog/assets/index.json')).status, 401);
  assert.equal((await fetch(env.base+'/catalog/assets/index.json', { headers })).status, 200);
  assert.equal((await (await fetch(env.base+'/api/auth/config', { headers })).json() as { mode: string }).mode, 'open');
  for (const path of ['/api/auth/session', '/api/v1/projects', '/api/v1/users']) assert.equal((await fetch(env.base+path, { headers })).status, 401);
  assert.equal((await fetch(env.base+'/api/v1/projects', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'forbidden' }) })).status, 401);
});

const servers: Server[] = [];
after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });

const SCOPE: RenderFileScope = { projectId: 'prj_a', ids: ['fil_a', 'fil_b'], userId: 'usr_viewer' };
const ask = (url: string, key: string | undefined, method = 'GET') =>
  ({ url, method, headers: key === undefined ? {} : { 'x-lw-render-read': key } }) as unknown as IncomingMessage;
const scopeOf = (token: string) => verifyToken<{ files?: RenderFileScope }>('lw/render-read', token, 'secret')?.files;

test('a file ticket opens a listed file in its own project, by GET or HEAD, until it expires', () => {
  const token = mintRenderRead(['design'], 'rev', 'secret', SCOPE);
  assert.deepEqual(scopeOf(token), SCOPE);
  const read = (url: string, method = 'GET', key: string | undefined = token) => renderFileTicket(ask(url, key, method), 'secret');
  assert.deepEqual(read('/api/v1/projects/prj_a/files/fil_a'), { projectId: 'prj_a', fileId: 'fil_a', userId: 'usr_viewer' });
  assert.deepEqual(read('/api/v1/projects/prj_a/files/fil_b?download=1', 'HEAD'), { projectId: 'prj_a', fileId: 'fil_b', userId: 'usr_viewer' });
  // A ticket for project A is refused on project B, for an unlisted file, and on every other route.
  assert.equal(read('/api/v1/projects/prj_b/files/fil_a'), null);
  assert.equal(read('/api/v1/projects/prj_a/files/fil_c'), null);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(read('/api/v1/projects/prj_a/files/fil_a', method), null, method);
  for (const path of ['/api/v1/projects/prj_a/files', '/api/v1/projects/prj_a/files/fil_a/parts/0', '/api/v1/projects/prj_a/files/fil_a/finalize',
    '/api/v1/projects/prj_a', '/api/v1/sessions/ses_a', '/catalog/assets/index.json']) assert.equal(read(path), null, path);
  // Expired, tampered, wrong domain, over-long, missing, or catalog-only: refused.
  assert.equal(read('/api/v1/projects/prj_a/files/fil_a', 'GET', mintToken('lw/render-read', { groups: [], revision: 'rev', files: SCOPE }, 'secret', 1, Date.now() - 5000)), null);
  assert.equal(read('/api/v1/projects/prj_a/files/fil_a', 'GET', token + 'x'), null);
  assert.equal(renderFileTicket(ask('/api/v1/projects/prj_a/files/fil_a', token), 'another secret'), null);
  assert.equal(read('/api/v1/projects/prj_a/files/fil_a', 'GET', mintToken('lw/session', { groups: [], revision: 'rev', files: SCOPE }, 'secret', 300)), null);
  assert.equal(read('/api/v1/projects/prj_a/files/fil_a', 'GET', 'x'.repeat(8193)), null);
  assert.equal(renderFileTicket(ask('/api/v1/projects/prj_a/files/fil_a', undefined), 'secret'), null);
  assert.equal(read('/api/v1/projects/prj_a/files/fil_a', 'GET', mintRenderRead(['design'], 'rev', 'secret')), null);
  // Rotation: the previous key still verifies.
  assert.ok(renderFileTicket(ask('/api/v1/projects/prj_a/files/fil_a', token), ['new secret', 'secret']));
});

test('the catalog reader never opens a project file, and a file ticket still opens the catalog', () => {
  const token = mintRenderRead(['design'], 'rev', 'secret', SCOPE);
  assert.equal(renderReader(ask('/api/v1/projects/prj_a/files/fil_a', token), 'rev', 'secret'), null);
  assert.deepEqual(renderReader(ask('/catalog/assets/index.json', token), 'rev', 'secret')?.groups, ['design']);
});

test('a malformed or oversized file scope is never minted or honoured', () => {
  const forged = (files: unknown) => mintToken('lw/render-read', { groups: [], revision: 'rev', files }, 'secret', 300);
  const ids = Array.from({ length: RENDER_READ_FILE_LIMIT + 1 }, (_, i) => `fil_${i}`);
  for (const files of [{ ...SCOPE, ids }, { ...SCOPE, ids: [] }, { ...SCOPE, ids: [7] }, { ...SCOPE, ids: ['fil a'] }, { ...SCOPE, userId: '' },
    { ...SCOPE, projectId: '../x' }, { projectId: 'prj_a', ids: ['fil_a'] }, ['prj_a'], 'prj_a']) {
    assert.equal(renderFileTicket(ask('/api/v1/projects/prj_a/files/fil_a', forged(files)), 'secret'), null, JSON.stringify(files));
    assert.equal(scopeOf(mintRenderRead([], 'rev', 'secret', files as RenderFileScope)), undefined, JSON.stringify(files));
  }
  // A ticket the worker would refuse as too long keeps the catalog and drops the files.
  const groups = Array.from({ length: 150 }, (_, i) => `group-with-a-long-name-${i}`);
  const many = { ...SCOPE, ids: Array.from({ length: RENDER_READ_FILE_LIMIT }, (_, i) => `fil_${'x'.repeat(40)}${i}`) };
  const long = mintRenderRead(groups, 'rev', 'secret', many);
  assert.ok(long.length <= 8192);
  assert.equal(scopeOf(long), undefined);
  assert.deepEqual(verifyToken<{ groups: string[] }>('lw/render-read', long, 'secret')?.groups, groups);
  assert.deepEqual(scopeOf(mintRenderRead(groups.slice(0, 10), 'rev', 'secret', many)), many);
});

test('project file references come from asset ids and this instance’s file addresses, in order', async () => {
  const canvas = JSON.stringify([{ id: 'img', image: `lolly-asset-v1:${JSON.stringify({ id: 'user/team/fil_canvas', source: 'user', type: 'raster', format: 'png', pin: { version: 'v' } })}` }]);
  const query = new URLSearchParams({
    image: 'https://work.example/api/v1/projects/prj_a/files/fil_url', logo: 'user/team/fil_logo#lolly-version=%5B%22v%22%2Cnull%5D', boxes: canvas,
    again: 'user/team/fil_logo', part: '/api/v1/projects/prj_a/files/fil_part/parts/0', list: '/api/v1/projects/prj_a/files', other: 'user/fil_device',
  }).toString();
  assert.deepEqual(projectFileRefs(query), [
    { fileId: 'fil_url', projectId: 'prj_a' }, { fileId: 'fil_logo' }, { fileId: 'fil_canvas' },
  ]);
  assert.equal(projectFileRefs(new URLSearchParams({ a: Array.from({ length: 80 }, (_, i) => `user/team/fil_${i}`).join(' ') }).toString()).length, RENDER_READ_FILE_LIMIT);
  // A packed query is expanded before it is read (renderFileScope).
  const packed = await (await loadEngine()).packQuery(new URLSearchParams({ image: 'user/team/fil_logo', pad: 'x'.repeat(5000) }).toString());
  assert.ok(packed);
  const fake = fakeFiles({ fil_logo: 'prj_a' });
  assert.deepEqual(await renderFileScope(fake.deps, `z=${packed}`, fake.viewer), { projectId: 'prj_a', ids: ['fil_logo'], userId: fake.viewer.id });
});

/** In-memory files and access for the scope and reader rules. `access` is per user and project. */
function fakeFiles(files: Record<string, string>, notReady: string[] = []) {
  const person = (id: string, extra: Partial<UserRecord> = {}): UserRecord => ({ id, sub: id, email: `${id}@test`, groups: [], idpGroups: [], localGroups: [],
    role: 'member', sessionEpoch: 0, createdAt: '', lastSeenAt: '', ...extra });
  const viewer = person('usr_viewer'), outsider = person('usr_outsider'), disabled = person('usr_disabled', { disabledAt: '2026-10-07T00:00:00Z' }), service = person('svc_robot');
  const users = new Map([viewer, outsider, disabled, service].map((u) => [u.id, u]));
  const access = new Map<string, ProjectAccess>([['usr_viewer/prj_a', 'viewer'], ['usr_viewer/prj_b', 'editor'], ['usr_disabled/prj_a', 'viewer'], ['svc_robot/prj_a', 'viewer']]);
  const project = (id: string): ProjectRecord => ({ id, name: id, visibility: 'private', ownerId: 'usr_owner', createdAt: '' });
  const reads: string[] = [];
  const deps = {
    store: {
      async getProjectFile(id: string) {
        reads.push(id);
        return files[id] ? { id, projectId: files[id]!, ready: !notReady.includes(id) } as ProjectFileRecord : null;
      },
      async getProject(id: string) { return ['prj_a', 'prj_b'].includes(id) ? project(id) : null; },
      async getUser(id: string) { return users.get(id) ?? null; },
    },
    async projectAccessOf(user: UserRecord, p: ProjectRecord) { return access.get(`${user.id}/${p.id}`) ?? 'none'; },
  };
  return { deps, viewer, outsider, disabled, service, access, reads };
}

test('the file scope holds one project the submitter can see, and only its ready files', async () => {
  const fake = fakeFiles({ fil_a: 'prj_a', fil_a2: 'prj_a', fil_b: 'prj_b', fil_pending: 'prj_a' }, ['fil_pending']);
  const q = (values: Record<string, string>) => new URLSearchParams(values).toString();
  const query = q({ one: 'user/team/fil_a', two: 'user/team/fil_b', three: 'user/team/fil_pending', four: 'user/team/fil_missing',
    five: '/api/v1/projects/prj_b/files/fil_a2', six: '/api/v1/projects/prj_a/files/fil_a2' });
  // fil_b is in another project; fil_pending is not ready; fil_a2 named under the wrong project is skipped there.
  assert.deepEqual(await renderFileScope(fake.deps, query, fake.viewer), { projectId: 'prj_a', ids: ['fil_a', 'fil_a2'], userId: 'usr_viewer' });
  assert.deepEqual(await renderFileScope(fake.deps, q({ x: 'user/team/fil_b', y: 'user/team/fil_a' }), fake.viewer), { projectId: 'prj_b', ids: ['fil_b'], userId: 'usr_viewer' });
  for (const who of [fake.outsider, fake.disabled, fake.service]) assert.equal(await renderFileScope(fake.deps, query, who), undefined, who.id);
  fake.reads.length = 0;
  assert.equal(await renderFileScope(fake.deps, q({ title: 'No files here', image: 'library/logo' }), fake.viewer), undefined);
  assert.deepEqual(fake.reads, [], 'a render that names no files reads no file rows');
});

test('the file reader answers the submitter only while they can still see the project', async () => {
  const fake = fakeFiles({});
  const reader = createRenderFileReader({ secret: 'secret', ...fake.deps });
  const token = mintRenderRead([], 'rev', 'secret', SCOPE);
  const path = '/api/v1/projects/prj_a/files/fil_a';
  assert.equal((await reader(ask(path, token), 'prj_a'))?.id, 'usr_viewer');
  assert.equal(await reader(ask(path, token), 'prj_b'), null, 'the route’s own project must match the ticket');
  assert.equal(await reader(ask('/api/v1/projects/prj_a/files', token), 'prj_a'), null, 'never the list route');
  assert.equal(await reader(ask(path, token, 'DELETE'), 'prj_a'), null);
  fake.access.delete('usr_viewer/prj_a');
  assert.equal(await reader(ask(path, token), 'prj_a'), null, 'access removed after minting');
  for (const userId of ['usr_disabled', 'svc_robot', 'usr_gone']) {
    assert.equal(await reader(ask(path, mintRenderRead([], 'rev', 'secret', { ...SCOPE, userId })), 'prj_a'), null, userId);
  }
});

/** One app on HTTP with shared files on, a stub render worker that records the
 *  ticket each render carries, and a project with a viewer and an outsider. */
async function bootRender() {
  const tickets: (string | undefined)[] = [];
  const worker = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const job = JSON.parse(raw) as { readToken?: string; brandRevision?: string };
      tickets.push(job.readToken);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', ...(job.brandRevision ? { brandRevision: job.brandRevision } : {}) }));
    });
  });
  servers.push(worker);
  await new Promise<void>((r) => worker.listen(0, '127.0.0.1', () => r()));
  const store: Store = Object.assign(createMemoryStore(), { storageKind: 'postgres' as const });
  const people = ['alice', 'viewer', 'outsider'];
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false }, render: { worker: { url: `http://127.0.0.1:${(worker.address() as { port: number }).port}` } },
    dev: { enabled: true, users: people.map((name) => ({ email: `${name}@test`, name, groups: [] })) } }));
  const app = createServer(buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'render-session', link: 'render-link', renderWorker: 'render-worker' } }));
  servers.push(app);
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const cookies = new Map<string, string>();
  for (const name of people) {
    const r = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    cookies.set(name, r.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!);
  }
  const call = (who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { ...(who ? { cookie: cookies.get(who)! } : {}), ...headers, ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const userId = async (name: string) => (await store.findUsersByEmail(`${name}@test`))[0]!.id;
  for (const name of people) await store.putGrant({ principal: `user:${await userId(name)}`, action: 'export.server', resource: '*', effect: 'allow' });
  const project = async (name: string) => (await (await call('alice', 'POST', '/api/v1/projects', { name, visibility: 'private' })).json() as { id: string }).id;
  const upload = async (projectId: string, bytes: Uint8Array, finalize = true) => {
    const checksum = fileChecksum(bytes);
    const begun = await call('alice', 'POST', `/api/v1/projects/${projectId}/files`, { name: 'cover.png', contentType: 'image/png', size: bytes.length, checksum,
      parts: [{ size: bytes.length, checksum }], asset: { type: 'raster', format: 'png' } });
    assert.equal(begun.status, 201, await begun.clone().text());
    const { file } = await begun.json() as { file: ProjectFileRecord };
    assert.equal((await call('alice', 'PUT', `/api/v1/projects/${projectId}/files/${file.id}/parts/0`, bytes)).status, 204);
    if (finalize) assert.equal((await call('alice', 'POST', `/api/v1/projects/${projectId}/files/${file.id}/finalize`, {})).status, 200);
    return file.id;
  };
  return { base, store, call, userId, project, upload, tickets };
}

test('a render carries a ticket for the files its inputs name that the submitter can read, and the ticket reads only those', async () => {
  const env = await bootRender();
  const projectA = await env.project('Spring poster'), projectB = await env.project('Other');
  const viewerId = await env.userId('viewer');
  await env.store.putProjectMember({ projectId: projectA, userId: viewerId, role: 'viewer', addedBy: 'alice', addedAt: new Date().toISOString() });
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const fileA = await env.upload(projectA, bytes), unlisted = await env.upload(projectA, new Uint8Array([9, 9, 9])), pending = await env.upload(projectA, new Uint8Array([7]), false);
  const fileB = await env.upload(projectB, new Uint8Array([5, 5]));
  const render = async (who: string, url: string) => {
    const r = await env.call(who, 'POST', '/api/v1/render', { toolId: 'qr-code', format: 'svg', inputs: { url } });
    assert.equal(r.status, 200, await r.clone().text());
    return env.tickets.at(-1)!;
  };
  const scope = (token: string) => verifyToken<{ files?: RenderFileScope }>('lw/render-read', token, 'render-link')?.files;
  // Both forms of reference; a file in another project, and an unfinished one, are left out.
  const token = await render('viewer', `${env.base}/api/v1/projects/${projectA}/files/${fileA} user/team/${pending} user/team/${fileB}`);
  assert.deepEqual(scope(token), { projectId: projectA, ids: [fileA], userId: viewerId });
  assert.deepEqual(scope(await render('viewer', `user/team/${fileA}`)), { projectId: projectA, ids: [fileA], userId: viewerId });
  // A submitter who cannot see the project gets no file scope; nor does a render naming no files.
  assert.equal(scope(await render('outsider', `user/team/${fileA}`)), undefined);
  assert.equal(scope(await render('viewer', 'https://example.com/')), undefined);

  // The worker's reads: the listed file only, without a cookie, and only while the viewer can see it.
  const read = (path: string, method = 'GET', key = token) => env.call('', method, path, undefined, { 'x-lw-render-read': key });
  const got = await read(`/api/v1/projects/${projectA}/files/${fileA}`);
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
  assert.equal((await read(`/api/v1/projects/${projectB}/files/${fileB}`)).status, 401, 'a ticket for project A is refused on project B');
  assert.equal((await read(`/api/v1/projects/${projectA}/files/${unlisted}`)).status, 401, 'an unlisted file is refused');
  assert.equal((await read(`/api/v1/projects/${projectA}/files`)).status, 401, 'the list route takes people only');
  assert.equal((await read(`/api/v1/projects/${projectA}/files/${fileA}`, 'DELETE')).status, 401);
  assert.equal((await read(`/api/v1/projects/${projectA}/files/${fileA}/finalize`, 'POST')).status, 401);
  assert.equal((await read(`/api/v1/projects/${projectA}/files/${fileA}`, 'GET', mintToken('lw/render-read', { groups: [], revision: 'x', files: scope(token) }, 'render-link', 1, Date.now() - 5000))).status, 401, 'expired');
  await env.store.deleteProjectMember(projectA, viewerId);
  assert.equal((await read(`/api/v1/projects/${projectA}/files/${fileA}`)).status, 401, 'access removed after minting');
});
