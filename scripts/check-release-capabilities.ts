// SPDX-License-Identifier: MPL-2.0
/** Exercise the shipped console and authenticated API before publishing an image. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const pack = await mkdtemp(join(tmpdir(), 'lolly-release-check-'));
let server: ReturnType<typeof createServer> | undefined;
try {
  await mkdir(join(pack, 'catalog/tools'), { recursive: true });
  await writeFile(join(pack, 'catalog/tools/index.json'), '{"version":1,"tools":[]}');
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({ instance: { pack, baseUrl: 'http://localhost' }, rateLimit: { enabled: false }, idp: { additional: [{ id: 'email', kind: 'password' }] } }));
  const app = buildApp({ config, store, secrets: { session: 'isolated-release-check', link: 'isolated-release-check' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const source = (await readFile(new URL('../console/app.js', import.meta.url), 'utf8')).replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
  // Plan 76 milestone 4 (R2): the version routes the shell's History feature-detects.
  // An unknown session route answers 404, so a 401 shows the route is in this build.
  assert.equal((await fetch(base + '/api/v1/sessions/release-check/version-missing')).status, 404, 'an unknown session route must answer 404');
  for (const [method, path] of [
    ['GET', '/api/v1/sessions/release-check/versions'],
    ['POST', '/api/v1/sessions/release-check/versions'],
    ['GET', '/api/v1/sessions/release-check/versions/ver_release'],
    ['POST', '/api/v1/sessions/release-check/versions/ver_release/restore'],
    ['DELETE', '/api/v1/sessions/release-check/versions/ver_release'],
  ] as const) assert.equal((await fetch(base + path, { method })).status, 401, `${method} ${path} must exist and refuse anonymous access`);
  console.log('PASS release capabilities: version routes present and refuse anonymous access');
  assert.equal((await fetch(base + '/api/v1/agents/activity')).status, 401, 'agent dashboard route must exist and refuse anonymous access');
  for (const role of ['owner', 'admin', 'member'] as const) {
    const user = await store.upsertUserBySub({ sub: role, email: `${role}@release.invalid`, groups: [role], role });
    if (role === 'owner') await store.putProject({ id: 'release-check', name: 'Release check', ownerId: user.id, visibility: 'private', createdAt: new Date().toISOString() });
    const cookie = mintSessionCookie({ sub: user.sub, email: user.email, name: role, groups: user.groups, role, epoch: user.sessionEpoch }, 'isolated-release-check', false).split(';')[0]!;
    const sessionResponse = await fetch(base + '/api/auth/session', { headers: { cookie } });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json() as { console: { views: Record<string, boolean> } };
    const permitted = role !== 'member';
    assert.equal(session.console.views.agents, permitted, `${role} console must advertise correct agent access`);
    assert.equal((await fetch(base + '/api/v1/agents/activity', { headers: { cookie } })).status, permitted ? 200 : 403);
    assert.equal((await fetch(base + '/api/v1/projects/release-check/presence', { headers: { cookie } })).status, permitted ? 200 : 403, 'project presence route must exist and enforce membership');
    const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: base + '/admin#/agents', runScripts: 'outside-only' });
    try {
      dom.window.matchMedia = () => ({ matches: false });
      dom.window.eval(source + '\nwindow.checkNavigation = s => { session = s; return consoleNavigation("agents"); };');
      const nav = dom.window.checkNavigation(session);
      assert.equal(!!nav.querySelector('a[href="#/agents"]'), permitted, `${role} must see the correct desktop navigation`);
      assert.equal(!!nav.querySelector('option[value="agents"]'), permitted, `${role} must see the correct mobile navigation`);
    } finally { dom.window.close(); }
  }
  console.log('PASS release capabilities: owner/admin agent API and desktop/mobile navigation; member and anonymous access refused');
} finally {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await rm(pack, { recursive: true, force: true });
}
