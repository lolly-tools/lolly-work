// SPDX-License-Identifier: MPL-2.0
/**
 * The console's People view in jsdom. Pinned: the sign-in gate says plain
 * "Sign in" when several sign-ins exist, and creating a local group from a
 * person no longer throws (the group filter's search learns the new name
 * instead).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PROVIDERS = [
  { id: 'primary', kind: 'oidc', name: 'Google', loginPath: '/api/auth/login?idp=primary' },
  { id: 'email', kind: 'password', name: 'Email and password', loginPath: '/api/auth/login?idp=email' },
];
const LINK = { url: 'https://team.example/api/auth/password/set?token=abc', expiresAt: '2026-10-10T10:00:00.000Z' };
const PERSON = { id: 'usr_1', email: 'ana@partner.example', name: 'Ana', title: null, groups: [], idpGroups: [], localGroups: [], role: 'member', lastSeenAt: '2026-10-02T10:00:00.000Z', disabled: false };

function page(opts: { providers?: typeof PROVIDERS; password?: { set: boolean; email: string } | null } = {}) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/users', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const copied: string[] = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t: string) => { copied.push(t); } }, configurable: true });
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const invitations = [
    { id: 'inv_p', email: 'bo@partner.example', groups: [], status: 'pending', createdAt: '2026-10-01T10:00:00.000Z', expiresAt: null, acceptedAt: null },
    { id: 'inv_a', email: 'cy@partner.example', groups: [], status: 'accepted', createdAt: '2026-10-01T09:00:00.000Z', expiresAt: null, acceptedAt: '2026-10-01T09:30:00.000Z' },
  ];
  w.fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    if (path === '/api/v1/invitations') return json(200, { invitations, signInUrl: 'https://team.example', admission: { policy: true, invitations: true } });
    if (path === '/api/v1/admin/password-links' && method === 'POST') return json(201, LINK);
    if (path === '/api/v1/groups' && method === 'GET') return json(200, { groups: [{ name: 'team', source: 'local', memberCount: 0 }] });
    if (path === '/api/v1/groups' && method === 'POST') return json(201, { name: body.name, source: 'local', memberCount: 0, createdAt: '2026-10-03T00:00:00.000Z' });
    if (path.startsWith('/api/v1/users?')) return json(200, { users: [PERSON], total: 1, page: 1, pageSize: 50 });
    if (path === `/api/v1/users/${PERSON.id}/identities`) {
      return json(200, { identities: [], ...(opts.password ? { password: opts.password } : {}) });
    }
    if (path === '/api/v1/policy/tools') return json(200, { tools: [] });
    if (path === '/api/v1/grants') return json(200, { grants: [] });
    return json(404, { error: { message: 'nope' } });
  };
  w.eval(`${source}
window.helpers = {
  invitationsSection, viewUsers, signInGate,
  setAuthConfig: (c) => { authConfig = c; },
  setSession: (s) => { session = s; },
};`);
  w.helpers.setAuthConfig({ provider: 'oidc', providerName: 'Google', providers: opts.providers ?? PROVIDERS });
  w.helpers.setSession({ kind: 'member', user: { role: 'admin' }, console: { actions: ['user.invite', 'grant.edit'], views: {} } });
  return { w, calls, copied, main: w.document.getElementById('app'), helpers: w.helpers };
}
const buttonByText = (root: any, text: string) => [...root.querySelectorAll('button')].find((b: any) => b.textContent === text);

test('creating a local group from a person adds it to the group filter instead of throwing', async () => {
  const p = page();
  await p.helpers.viewUsers(p.main, new p.w.URLSearchParams(''));
  (p.main.querySelector('tbody tr.row-click') as any).click();
  await pause(20);
  const errors: unknown[] = [];
  p.w.addEventListener('error', (e: any) => errors.push(e.error));
  const name = p.main.querySelector('input[aria-label="New local group name"]') as any;
  name.value = 'brand';
  (buttonByText(p.main, 'Create') as any).click();
  await pause(20);
  assert.ok(p.calls.some((c) => c.path === '/api/v1/groups' && c.method === 'POST'));
  assert.deepEqual(errors, []);
  const options = [...p.main.querySelectorAll('.filters-more datalist option')].map((o: any) => o.value);
  assert.ok(options.includes('brand'), `the filter offers the new group (${options.join(', ')})`);
  assert.ok(!p.main.textContent.includes('groupSel'), 'no ReferenceError message on the page');
});

test('the sign-in gate says "Sign in" when there are several ways in, and names the only one otherwise', async () => {
  const p = page();
  await p.helpers.signInGate();
  assert.equal((p.main.querySelector('a.gate-go') as any)?.textContent, 'Sign in');
  const q = page({ providers: PROVIDERS.slice(0, 1) });
  await q.helpers.signInGate();
  assert.equal((q.main.querySelector('a.gate-go') as any)?.textContent, 'Sign in with Google');
});
