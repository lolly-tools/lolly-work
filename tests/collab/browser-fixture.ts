// SPDX-License-Identifier: MPL-2.0
// Real Work HTTP/auth/WebSocket services with a development or built shell.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Duplex } from 'node:stream';
import { parseConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import type { Store } from '../../server/src/store/types.ts';
import type { RenderRunner } from '../../server/src/renders/runner.ts';
import { buildApp } from '../../server/src/api/app.ts';
import { createCollabGateway } from '../../server/src/collab/gateway.ts';
import { buildPackView, type ContentRootsModule } from '../../scripts/demo.ts';

export async function createWorkBrowserFixture(ossDir: string, viteOrigin: string, options: { renderWorker?: { url: string; secret: string }; shapeCount?: number; store?: Store; productionPack?: string; invites?: boolean; httpRateLimit?: boolean } = {}) {
  const pack = options.productionPack ?? await mkdtemp(join(tmpdir(), 'lw-design-browser-'));
  if (!options.productionPack) {
    const roots = await import(pathToFileURL(join(ossDir, 'packages/node-shell/src/content-roots.ts')).href) as ContentRootsModule;
    buildPackView(pack, roots, roots.contentRoots({ root: ossDir, profile: 'lolly-start' }));
  }
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Browser collaboration test', baseUrl: 'http://localhost', pack },
    policy: { guestLinks: { enabled: true }, defaultAccessMode: 'gated' },
    ...(options.renderWorker ? { render: { worker: { url: options.renderWorker.url } }, rateLimit: { enabled: options.httpRateLimit ?? false } } : {}),
    dev: { enabled: true, users: [
      { email: 'admin@test', name: 'Admin', groups: ['admin'] },
      { email: 'alice@test', name: 'Alice', groups: ['team'] },
      { email: 'bob@test', name: 'Bob', groups: ['team'] },
      { email: 'viewer@test', name: 'Viewer', groups: ['team'] },
    ] },
  }));
  const store = options.store ?? createMemoryStore(), secrets = { session: 'browser-session-test', link: 'browser-link-test', ...(options.renderWorker ? { renderWorker: options.renderWorker.secret } : {}) };
  const renderClaims: { id: string; queueMs: number; attempt: number }[] = [];
  const claim = store.claimRender;
  if (options.renderWorker) {
    store.claimRender = async leaseMs => {
      const record = await claim.call(store, leaseMs);
      if (record) renderClaims.push({ id: record.id, queueMs: Date.now() - Date.parse(record.createdAt), attempt: record.attempt });
      return record;
    };
  }
  const commits: { start: number; end: number; operations: number; revision: number }[] = [];
  const commit = store.commitCollab.bind(store);
  store.commitCollab = async batch => {
    const start = performance.timeOrigin + performance.now();
    const revision = await commit(batch);
    commits.push({ start, end: performance.timeOrigin + performance.now(), operations: batch.ops.length, revision });
    return revision;
  };
  let renders: RenderRunner | undefined;
  const gateway = createCollabGateway({ config, store, secrets, pingIntervalMs: 1000 });
  const app = buildApp({ config, store, secrets, listCollabRooms: () => gateway.snapshot(),
    ...(options.renderWorker ? { onRenderRunner: (runner: RenderRunner) => { renders = runner; runner.start(); } } : {}),
  });
  const sockets = new Set<Duplex>();
  let suspended = false;
  const server = createServer((req, res) => {
    if (/^\/(api\/|tools\/|catalog\/|l\/)/.test(req.url ?? '')) { void app(req, res); return; }
    const upstream = request(new URL(req.url ?? '/', viteOrigin), { method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (suspended) { socket.destroy(); return; }
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    if (!gateway.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  config.instance.baseUrl = base;
  const login = async (email: string) => {
    const response = await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    return response.headers.getSetCookie().find(cookie => cookie.startsWith('lw_session='))!.split(';')[0]!;
  };
  const cookies = new Map<string, string>();
  for (const email of ['admin@test', 'alice@test', 'bob@test', 'viewer@test']) cookies.set(email, await login(email));
  const user = async (email: string) => (await store.listUsers()).find(user => user.email === email)!;
  const api = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookies.get('admin@test')!, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 201, await response.clone().text());
    return await response.json() as { id: string; url?: string };
  };
  const project = await api('/api/v1/projects', { name: 'Design browser test', visibility: { groups: ['team'] } });
  const inputs = { boxes: [
    { id: 'board', kind: 'frame', name: 'Board', x: 0, y: 0, w: 600, h: 400, rot: 0, bg: '#ffffff', clipChildren: true },
    { id: 'shape', kind: 'box', frame: 'board', x: 60, y: 80, w: 140, h: 100, rot: 0, shape: 'rect', bg: '#ff3366' },
    { id: 'headline', kind: 'text', frame: 'board', x: 60, y: 230, w: 450, h: 60, text: 'Shared Design', fontSize: 32, fg: '#111111', font: 'sans' },
  ] };
  for (let i = 0; i < (options.shapeCount ?? 0); i++) inputs.boxes.push({
    id: `load-${i}`, kind: 'box', frame: 'board', x: (i % 20) * 28, y: Math.floor(i / 20) * 20,
    w: 20, h: 12, rot: 0, shape: 'rect', bg: '#225588',
  });
  const session = await api(`/api/v1/projects/${project.id}/sessions`, { toolId: 'design', toolVersion: '1', inputs, meta: { label: 'Browser session' } });
  await store.putGrant({ principal: `user:${(await user('viewer@test')).id}`, action: 'session.edit', resource: '*', effect: 'deny' });
  if (options.invites) {
    for (const email of ['alice@test', 'bob@test']) await api('/api/v1/collab/invites', { sessionId: session.id, userId: (await user(email)).id });
  }
  return {
    collabCommits() { return commits.map(row => ({ ...row })); },
    base, sessionId: session.id, inputs,
    async readSession() { return await store.getSession(session.id); },
    rooms() { return gateway.snapshot(); },
    renderStats() { return renders?.stats(); },
    renderClaims() { return renderClaims.map(row => ({ ...row })); },
    suspendConnections() { suspended = true; for (const socket of sockets) socket.destroy(); },
    resumeConnections() { suspended = false; },
    async denyEdit(email: string) { await store.putGrant({ principal: `user:${(await user(email)).id}`, action: 'session.edit', resource: '*', effect: 'deny' }); },
    async revokeJoin(email: string) { await store.putGrant({ principal: `user:${(await user(email)).id}`, action: 'collab.join', resource: '*', effect: 'deny' }); },
    async close() {
      await renders?.stop();
      gateway.close(); await gateway.drain();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.commitCollab = commit;
      store.claimRender = claim;
      if (!options.productionPack) await rm(pack, { recursive: true, force: true });
    },
  };
}
