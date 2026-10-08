// SPDX-License-Identifier: MPL-2.0
/** Exercise the shipped console and authenticated API before publishing an image. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { checkConsoleAssets, consoleAssetPlan, CONSOLE_DIR } from './console-assets.ts';
import { loadConsoleModuleGraph } from './console-module-check.ts';

// Native module linking is opt-in in Node 24. Keep the existing image/operator
// command usable, without enabling experimental VM APIs in the running server.
if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', ...process.argv.slice(1)], { stdio: 'inherit', timeout: 60_000 });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}
checkConsoleAssets();

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
  const htmlResponse = await fetch(base + '/admin/');
  assert.equal(htmlResponse.status, 200);
  assert.equal(htmlResponse.headers.get('cache-control'), 'no-cache');
  const html = await htmlResponse.text();
  assert.equal(html, consoleAssetPlan().html, 'served HTML must match the generated console entry');
  const stylesheet = /<link\b[^>]*\bhref="(\/admin\/styles\.css\?v=[a-f0-9]{64})"/.exec(html);
  assert.ok(stylesheet, 'shipped HTML must select the current stylesheet');
  const css = await fetch(base + stylesheet[1]);
  assert.equal(css.status, 200);
  assert.equal(css.headers.get('cache-control'), 'no-cache');
  assert.equal(await css.text(), await readFile(join(CONSOLE_DIR, 'styles.css'), 'utf8'));
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
  // Plan 76 milestone 4 (R1): the comment routes the shell feature-detects. An
  // unknown route answers 404, so a 401 shows the route is in this build.
  assert.equal((await fetch(base + '/api/v1/sessions/release-check/comment-missing')).status, 404, 'an unknown session route must answer 404');
  for (const [method, path] of [
    ['GET', '/api/v1/sessions/release-check/comments/thread'],
    ['POST', '/api/v1/sessions/release-check/comment-reads'],
    ['GET', '/api/v1/sessions/release-check/comment-people'],
  ] as const) assert.equal((await fetch(base + path, { method })).status, 401, `${method} ${path} must exist and refuse anonymous access`);
  // Plan 76 milestone 4 (W5, plans/75 G18): sign out on all devices. An
  // unknown route under /api/v1/me answers 404, so a 401 shows it is in this build.
  assert.equal((await fetch(base + '/api/v1/me/revoke-sessions-missing', { method: 'POST' })).status, 404, 'an unknown /api/v1/me route must answer 404');
  assert.equal((await fetch(base + '/api/v1/me/revoke-sessions', { method: 'POST' })).status, 401, 'POST /api/v1/me/revoke-sessions must exist and refuse anonymous access');
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
    const dom = new JSDOM(html, { url: base + '/admin/#/agents', runScripts: 'outside-only' });
    try {
      dom.window.matchMedia = () => ({ matches: false });
      dom.window.fetch = (path: string, options: Parameters<typeof fetch>[1] = {}) => fetch(new URL(path, base), {
        ...options, headers: { ...options.headers, cookie },
      });
      const entry = await loadConsoleModuleGraph({ html, base, context: dom.getInternalVMContext(), read: async url => {
        const response = await fetch(url);
        assert.equal(response.status, 200, `HTML-selected module must be shipped: ${new URL(url).pathname}`);
        assert.equal(response.headers.get('cache-control'), 'no-cache', 'imported modules must revalidate after an update');
        const source = await response.text();
        assert.equal(source, await readFile(join(CONSOLE_DIR, decodeURIComponent(new URL(url).pathname.slice('/admin/'.length))), 'utf8'), 'served module bytes must match the console source');
        return source;
      } });
      const browser = entry.namespace as unknown as {
        setReleaseSession: (session: unknown) => void;
        consoleNavigation: (view: string) => { querySelector: (selector: string) => unknown };
        renderProjectDetail: (main: unknown, id: string, name: string) => Promise<void>;
        actSessionObj: (id: string) => { getAttribute: (name: string) => string };
      };
      browser.setReleaseSession(session);
      const nav = browser.consoleNavigation('agents');
      assert.equal(!!nav.querySelector('a[href="#/agents"]'), permitted, `${role} must see the correct desktop navigation`);
      assert.equal(!!nav.querySelector('option[value="agents"]'), permitted, `${role} must see the correct mobile navigation`);
      assert.equal(browser.actSessionObj('ses_release').getAttribute('href'), '/#/team/ses_release', 'saved-session links must open shared documents');
      if (role === 'owner') {
        const main = dom.window.document.createElement('main'); dom.window.document.body.append(main);
        await browser.renderProjectDetail(main, 'release-check', 'Release check');
        assert.ok(main.textContent.includes('Prepare to move this project'), 'HTML-selected project view must include transfer preparation');
        const preview = [...main.querySelectorAll('button')].find((button: any) => button.textContent === 'Preview transfer');
        assert.ok(preview, 'HTML-selected project view must offer Preview transfer');
        preview.click();
        const deadline = Date.now() + 5000;
        while (!main.textContent.includes('Transfer preview ready.') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(main.textContent.includes('Transfer preview ready.'), 'shipped module must render the authenticated metadata preview');
        assert.ok(main.textContent.includes('this JSON cannot restore a project'), 'preview must preserve its incomplete-inventory explanation');
      }
    } finally { dom.window.close(); }
  }
  console.log('PASS release capabilities: HTML-selected module graph and project transfer preview; saved-session links; owner/admin agent API and navigation; member/anonymous access refused; comment and sign-out routes present');
} finally {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
  await rm(pack, { recursive: true, force: true });
}
