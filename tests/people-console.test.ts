// SPDX-License-Identifier: MPL-2.0
/**
 * The console's People view in jsdom. Email and password sign-in (plans/74):
 * "Copy sign-in link" on each pending invitation and the person detail's
 * Password row with "Copy password link", both shown only while the instance
 * offers a password sign-in; the link is copied and shown read-only with its
 * expiry, focused and in view. A locked password shows Unlock, removing the
 * password sign-in says it removes the password, and the invite share card
 * points to the password link. Also pinned: the sign-in gate says plain
 * "Sign in" when several sign-ins exist (and offers the password form beside
 * the dev sign-in), and creating a local group from a person no longer
 * throws: the group filter's search learns the new name as an exact match.
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

function page(opts: {
  providers?: typeof PROVIDERS; password?: { set: boolean; email: string; lockedUntil?: string } | null;
  identities?: unknown[]; groups?: string[];
} = {}) {
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
    if (path === '/api/v1/invitations' && method === 'POST') {
      return json(201, { invitations: body.emails.map((email: string) => ({ email, created: true, status: 'pending' })) });
    }
    if (path === '/api/v1/invitations') return json(200, { invitations, signInUrl: 'https://team.example', admission: { policy: true, invitations: true } });
    if (path === `/api/v1/users/${PERSON.id}/password/unlock` && method === 'POST') return { ok: true, status: 204, json: async () => ({}) };
    if (path.startsWith(`/api/v1/users/${PERSON.id}/identities/`) && method === 'DELETE') return { ok: true, status: 204, json: async () => ({}) };
    if (path === '/api/v1/admin/password-links' && method === 'POST') return json(201, LINK);
    if (path === '/api/v1/groups' && method === 'GET') return json(200, { groups: (opts.groups ?? ['team']).map((name) => ({ name, source: 'local', memberCount: 0 })) });
    if (path === '/api/v1/groups' && method === 'POST') return json(201, { name: body.name, source: 'local', memberCount: 0, createdAt: '2026-10-03T00:00:00.000Z' });
    if (path.startsWith('/api/v1/users?')) return json(200, { users: [PERSON], total: 1, page: 1, pageSize: 50 });
    if (path === `/api/v1/users/${PERSON.id}/identities`) {
      return json(200, { identities: opts.identities ?? [], ...(opts.password ? { password: opts.password } : {}) });
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

test('a pending invitation offers "Copy sign-in link": it issues a setup link, copies it and shows it read-only', async () => {
  const p = page();
  const section = await p.helpers.invitationsSection([]);
  p.main.append(section);
  const buttons = [...section.querySelectorAll('button')].filter((b: any) => b.textContent === 'Copy sign-in link');
  assert.equal(buttons.length, 1, 'the pending row only, not the accepted one');
  assert.ok(section.textContent.includes('It works once, for seven days'));
  (buttons[0] as any).click();
  await pause();
  assert.deepEqual(p.calls.find((c) => c.path === '/api/v1/admin/password-links')?.body, { email: 'bo@partner.example', purpose: 'setup' });
  assert.deepEqual(p.copied, [LINK.url]);
  const field = section.querySelector('input[readonly]') as any;
  assert.equal(field?.value, LINK.url);
  assert.ok(section.textContent.includes('Works once, until'));
  assert.ok(section.textContent.includes('Sign-in link for bo@partner.example'));
});

test('without a password sign-in the invitation list has no sign-in link button', async () => {
  const p = page({ providers: PROVIDERS.slice(0, 1) });
  const section = await p.helpers.invitationsSection([]);
  assert.equal(buttonByText(section, 'Copy sign-in link'), undefined);
  assert.ok(!section.textContent.includes('Copy sign-in link'));
});

test('person detail: the Password row and "Copy password link" (reset when set, setup when not)', async () => {
  for (const [password, purpose, shown] of [
    [{ set: true, email: 'ana@partner.example' }, 'reset', 'Set'],
    [{ set: false, email: 'ana@partner.example' }, 'setup', 'Not set'],
  ] as const) {
    const p = page({ password });
    await p.helpers.viewUsers(p.main, new p.w.URLSearchParams(''));
    (p.main.querySelector('tbody tr.row-click') as any).click();
    await pause(20);
    const cells = [...p.main.querySelectorAll('.idy')].map((c: any) => [c.querySelector('.idy-l').textContent, c.querySelector('.idy-v').textContent]);
    assert.deepEqual(cells.find(([l]) => l === 'Password'), ['Password', shown]);
    (buttonByText(p.main, 'Copy password link') as any).click();
    await pause();
    assert.deepEqual(p.calls.find((c) => c.path === '/api/v1/admin/password-links')?.body, { email: 'ana@partner.example', purpose });
    assert.equal((p.main.querySelector('.detail-sheet input[readonly]') as any)?.value, LINK.url);
  }
  // No password sign-in: no row, no button.
  const q = page({ providers: PROVIDERS.slice(0, 1), password: null });
  await q.helpers.viewUsers(q.main, new q.w.URLSearchParams(''));
  (q.main.querySelector('tbody tr.row-click') as any).click();
  await pause(20);
  assert.equal(buttonByText(q.main, 'Copy password link'), undefined);
});

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
  const r = page({ providers: PROVIDERS.slice(1) });
  r.helpers.setAuthConfig({ provider: 'password', providerName: 'Email and password', providers: PROVIDERS.slice(1) });
  await r.helpers.signInGate();
  const go = r.main.querySelector('a.gate-go') as any;
  assert.equal(go?.textContent, 'Sign in', 'email and password alone');
  assert.equal(go?.getAttribute('href'), '/api/auth/login?returnTo=%2Fadmin');
});

// ── review fixes ──────────────────────────────────────────────────────────────

test('the issued link is brought into view and focused, so a phone or a long list shows it', async () => {
  const p = page();
  const section = await p.helpers.invitationsSection([]);
  p.main.append(section);
  let scrolled = 0;
  p.w.HTMLElement.prototype.scrollIntoView = () => { scrolled++; };
  (buttonByText(section, 'Copy sign-in link') as any).click();
  await pause();
  const field = section.querySelector('input[readonly]') as any;
  assert.equal(p.w.document.activeElement, field, 'focus lands on the link');
  assert.ok(scrolled > 0, 'scrolled into view');
});

test('after inviting, the share card points to the password link when password sign-in is on', async () => {
  for (const [providers, expect] of [[PROVIDERS, true], [PROVIDERS.slice(0, 1), false]] as const) {
    const p = page({ providers: [...providers] });
    const section = await p.helpers.invitationsSection([]);
    p.main.append(section);
    (section.querySelector('textarea') as any).value = 'dee@partner.example';
    (section.querySelector('form') as any).dispatchEvent(new p.w.Event('submit', { cancelable: true }));
    await pause(20);
    assert.ok(section.textContent.includes('Sign-in address to share'), 'the share card is shown');
    assert.equal(section.textContent.includes('send them a password link instead: press Copy sign-in link'), expect);
  }
});

test('person detail: a locked password says so and offers Unlock', async () => {
  const until = new Date(Date.now() + 10 * 60_000).toISOString();
  const p = page({ password: { set: true, email: 'ana@partner.example', lockedUntil: until } });
  await p.helpers.viewUsers(p.main, new p.w.URLSearchParams(''));
  (p.main.querySelector('tbody tr.row-click') as any).click();
  await pause(20);
  const cells = [...p.main.querySelectorAll('.idy')].map((c: any) => [c.querySelector('.idy-l').textContent, c.querySelector('.idy-v').textContent]);
  assert.deepEqual(cells.find(([l]) => l === 'Password'), ['Password', 'Set, locked']);
  assert.ok(p.main.textContent.includes('Locked after too many wrong passwords'));
  (buttonByText(p.main, 'Unlock') as any).click();
  await pause(20);
  assert.ok(p.calls.some((c) => c.path === `/api/v1/users/${PERSON.id}/password/unlock` && c.method === 'POST'));
  assert.equal(buttonByText(p.main, 'Unlock'), undefined);
  assert.ok(!p.main.textContent.includes('Locked after too many wrong passwords'));
});

test('person detail: removing the email and password sign-in says it removes the password', async () => {
  const identities = [
    { idp: 'primary', subjectHash: 'aaaa', displayName: 'Google', email: 'ana@partner.example', emailVerified: true, linkedAt: '2026-10-01T00:00:00.000Z', lastLoginAt: null, canUnlink: false, unlinkBlocked: 'account' },
    { idp: 'email', subjectHash: 'bbbb', displayName: 'Email and password', email: 'ana@partner.example', emailVerified: false, linkedAt: '2026-10-02T00:00:00.000Z', lastLoginAt: null, canUnlink: true },
  ];
  const p = page({ password: { set: true, email: 'ana@partner.example' }, identities });
  await p.helpers.viewUsers(p.main, new p.w.URLSearchParams(''));
  (p.main.querySelector('tbody tr.row-click') as any).click();
  await pause(20);
  const remove = buttonByText(p.main, 'Remove') as any;
  remove.click();
  assert.equal(remove.textContent, 'Really remove their password?');
  remove.click();
  await pause(20);
  assert.ok(p.calls.some((c) => c.path === `/api/v1/users/${PERSON.id}/identities/email/bbbb` && c.method === 'DELETE'));
  const cells = [...p.main.querySelectorAll('.idy')].map((c: any) => [c.querySelector('.idy-l').textContent, c.querySelector('.idy-v').textContent]);
  assert.deepEqual(cells.find(([l]) => l === 'Password'), ['Password', 'Not set']);
});

test('a new group whose name is inside an existing one is picked exactly, not snapped to the longer name', async () => {
  const p = page({ groups: ['design-team'] });
  await p.helpers.viewUsers(p.main, new p.w.URLSearchParams(''));
  (p.main.querySelector('tbody tr.row-click') as any).click();
  await pause(20);
  const name = p.main.querySelector('input[aria-label="New local group name"]') as any;
  name.value = 'design';
  (buttonByText(p.main, 'Create') as any).click();
  await pause(20);
  const filter = p.main.querySelector('.filters-more .search-select input') as any;
  filter.value = 'design';
  filter.dispatchEvent(new p.w.Event('change'));
  await pause(20);
  assert.equal(filter.value, 'design', 'not rewritten to design-team');
  const last = p.calls.filter((c) => c.path.startsWith('/api/v1/users?')).at(-1)!;
  assert.equal(new p.w.URLSearchParams(last.path.split('?')[1]).get('group'), 'design');
});

test('with the dev provider and a password entry, the gate offers both', async () => {
  const p = page({ providers: PROVIDERS.slice(1) });
  p.helpers.setAuthConfig({ provider: 'dev', providerName: null, providers: PROVIDERS.slice(1) });
  await p.helpers.signInGate();
  assert.ok(p.main.querySelector('form.gate-form'), 'the dev form');
  const link = [...p.main.querySelectorAll('a')].find((a: any) => a.textContent === 'Sign in with email and password') as any;
  assert.equal(link?.getAttribute('href'), '/api/auth/login?returnTo=%2Fadmin');
});
