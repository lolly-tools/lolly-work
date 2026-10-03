// SPDX-License-Identifier: MPL-2.0
/**
 * The console's People view in jsdom. Email and password sign-in (plans/74):
 * "Copy sign-in link" on each pending invitation and the person detail's
 * Password row with "Copy password link", both shown only while the instance
 * offers a password sign-in; the link is copied and shown read-only with its
 * expiry, focused and in view. A locked password shows Unlock, removing the
 * password sign-in says it removes the password. Also pinned: the sign-in gate says plain
 * "Sign in" when several sign-ins exist (and offers the password form beside
 * the dev sign-in), and creating a local group from a person no longer
 * throws: the group filter's search learns the new name as an exact match.
 * Invite links (plans/74 invite spec 4.1, 4.2): the password tick and its
 * passwordDomains default, one result row per address with Copy message and
 * Copy link, the invite message itself (and the read-only box when the
 * clipboard refuses), the invitations table's columns, text statuses and
 * per-status actions, New link and Invite again, and the Requests card at
 * the top of People.
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

type Reply = { status: number; data: unknown };
function page(opts: {
  providers?: typeof PROVIDERS; password?: { set: boolean; email: string; lockedUntil?: string } | null;
  identities?: unknown[]; groups?: string[];
  /** Answers a call first; undefined falls through to the defaults. */
  route?: (path: string, method: string, body: any) => Reply | undefined;
  invitations?: unknown[]; context?: Record<string, unknown>; clipboard?: boolean;
} = {}) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/users', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const copied: string[] = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t: string) => {
    if (opts.clipboard === false) throw new Error('denied');
    copied.push(t);
  } }, configurable: true });
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  const invitations = opts.invitations ?? [
    { id: 'inv_p', email: 'bo@partner.example', groups: [], status: 'pending', createdAt: '2026-10-01T10:00:00.000Z', expiresAt: null, acceptedAt: null },
    { id: 'inv_a', email: 'cy@partner.example', groups: [], status: 'accepted', createdAt: '2026-10-01T09:00:00.000Z', expiresAt: null, acceptedAt: '2026-10-01T09:30:00.000Z' },
  ];
  w.fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    const own = opts.route?.(path, method, body);
    if (own) return json(own.status, own.data);
    if (path === '/api/v1/invitations' && method === 'POST') {
      return json(201, { invitations: body.emails.map((email: string) => ({ email, created: true, status: 'pending' })) });
    }
    if (path === '/api/v1/invitations') return json(200, { invitations, signInUrl: 'https://team.example', admission: { policy: true, invitations: true }, ...opts.context });
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

// ── invite links, messages and the invitations table (plans/74 invite spec 4.1, 4.2) ──

const CONTEXT = {
  providers: ['Google', 'GitHub'], passwordSignIn: true, passwordDomains: ['suse.com'],
  inviteNote: 'If your organisation blocks Google sign-in (for example @suse.com), use GitHub or email and password.',
};
const ORG_CONFIG = { invites: { domains: ['suse.com', 'partner.example'], maxTtlHours: 720, projectRoles: ['viewer', 'editor'] } };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const textOf = (node: any) => node.textContent.replace(/\s+/g, ' ').trim();
const LOLLY_ING = { provider: 'oidc', providerName: 'Google', providers: PROVIDERS, instanceName: 'lolly.ing' };
const submit = async (p: ReturnType<typeof page>, section: any, emails: string) => {
  (section.querySelector('textarea') as any).value = emails;
  (section.querySelector('form') as any).dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await pause(20);
};
const type = (p: ReturnType<typeof page>, section: any, emails: string) => {
  const area = section.querySelector('textarea') as any;
  area.value = emails;
  area.dispatchEvent(new p.w.Event('input'));
};

test('the password tick follows the typed addresses until changed, and the invite posts passwordSetup', async () => {
  const p = page({ context: CONTEXT });
  const section = await p.helpers.invitationsSection([]);
  p.main.append(section);
  const label = [...section.querySelectorAll('label.chk')].find((l: any) => l.textContent.includes('Let them set a password from the invite link')) as any;
  assert.ok(label, 'the tick is offered while password sign-in is on');
  const tick = label.querySelector('input') as any;
  assert.ok(section.textContent.includes('Anyone with the link can then set the password for that address, once. Send the link privately.'));
  assert.ok(section.textContent.includes('Use this for people who cannot use Google or GitHub.'), 'names the other sign-ins, not the password one');
  assert.equal(tick.checked, false);
  type(p, section, 'sam@suse.com');
  assert.equal(tick.checked, true, 'every address is in passwordDomains');
  type(p, section, 'sam@suse.com, bo@gmail.com');
  assert.equal(tick.checked, false, 'one address outside them');
  type(p, section, 'sam@SUSE.com');
  assert.equal(tick.checked, true);
  tick.checked = false;
  tick.dispatchEvent(new p.w.Event('change'));
  type(p, section, 'sam@suse.com ana@suse.com');
  assert.equal(tick.checked, false, 'a changed tick stays as the admin left it');
  tick.checked = true;
  await submit(p, section, 'sam@suse.com');
  assert.equal(p.calls.find((c) => c.path === '/api/v1/invitations' && c.method === 'POST')?.body.passwordSetup, true);

  // No password sign-in: no tick and no passwordSetup in the body.
  const q = page({ providers: PROVIDERS.slice(0, 1), context: CONTEXT });
  const plain = await q.helpers.invitationsSection([]);
  assert.ok(!plain.textContent.includes('Let them set a password'));
  await submit(q, plain, 'sam@suse.com');
  assert.equal('passwordSetup' in q.calls.find((c) => c.path === '/api/v1/invitations' && c.method === 'POST')!.body, false);
});

test('after Invite, one row per address says what happened, and Copy message copies the invite message', async () => {
  const created = {
    id: 'inv_n', email: 'sam@suse.com', groups: [], status: 'pending', created: true, createdAt: ago(0), expiresAt: '2026-11-02T12:00:00.000Z',
    acceptedAt: null, projects: [], inviter: { name: 'Andy' }, link: 'https://lolly.ing/l/invite/tok-sam', passwordSetup: true, password: 'none',
  };
  const rows = [
    created,
    { ...created, id: 'inv_o', email: 'old@partner.example', created: false, link: 'https://lolly.ing/l/invite/tok-old', passwordSetup: false },
    { email: 'here@suse.com', status: 'already', created: false },
    { email: 'grouped@suse.com', status: 'applied', created: false },
    ...['invites-not-allowed', 'domain-not-allowed', 'self', 'account-disabled', 'owner-only', 'invitation-changed']
      .map((reason, i) => ({ email: `r${i}@x.example`, status: 'refused', reason, created: false })),
  ];
  const p = page({
    context: CONTEXT,
    route: (path, method) => (path === '/api/v1/invitations' && method === 'POST' ? { status: 201, data: { invitations: rows } }
      : path === '/api/v1/org-config' ? { status: 200, data: ORG_CONFIG } : undefined),
  });
  p.helpers.setAuthConfig(LOLLY_ING);
  const section = await p.helpers.invitationsSection([]);
  p.main.append(section);
  assert.ok(section.textContent.includes('lolly.ing does not send email. Copy each invite message and send the message yourself.'));
  await submit(p, section, rows.map((r) => r.email).join(' '));
  const text = textOf(section);
  for (const line of [
    'sam@suse.com · Invitation ready · ends 2 Nov',
    'Anyone with this link can set the password for sam@suse.com until it is used. Send the link privately.',
    'old@partner.example · Already invited · ends 2 Nov',
    'The link works only for someone who signs in as old@partner.example.',
    'here@suse.com · Already on lolly.ing',
    'grouped@suse.com · Already on lolly.ing · joined the groups now',
    'r0@x.example · Not invited. Your role cannot invite new people.',
    'r1@x.example · Not invited. lolly.ing only invites addresses at suse.com or partner.example.',
    'r2@x.example · Not invited. That is your own account.',
    'r3@x.example · Not invited. That account is turned off. Turn the account on first.',
    'r4@x.example · Not invited. Only an owner can change an owner’s groups.',
    'r5@x.example · Not invited.',
  ]) assert.ok(text.includes(line), `shows: ${line}`);
  assert.ok(!text.includes('Sign-in address to share'), 'the per-row links replace the one shared address');
  const result = section.querySelector('form .mint-out') as any;
  const messages = [...result.querySelectorAll('button')].filter((b: any) => b.textContent === 'Copy message');
  const links = [...result.querySelectorAll('button')].filter((b: any) => b.textContent === 'Copy link');
  assert.equal(messages.length, 2, 'created and existing rows');
  assert.equal(links.length, 1, 'only the created row offers Copy link');
  (messages[0] as any).click();
  await pause();
  assert.equal(p.copied.at(-1), [
    'Andy invited you to lolly.ing.',
    'https://lolly.ing/l/invite/tok-sam',
    'Sign in as sam@suse.com with Google or GitHub.',
    'Open the link to set your password.',
    'This invitation ends on Mon 2 Nov 2026.',
    CONTEXT.inviteNote,
  ].join('\n'));
  assert.equal((messages[0] as any).textContent, 'Copied');
  (links[0] as any).click();
  await pause();
  assert.equal(p.copied.at(-1), 'https://lolly.ing/l/invite/tok-sam');
});

test('a project invitation names the project and role; a refused clipboard shows the message selected', async () => {
  const invitations = [{
    id: 'inv_p', email: 'sam@work.example', groups: [], status: 'pending', createdAt: ago(3_600_000), expiresAt: null, acceptedAt: null,
    inviter: { name: 'Andy' }, createdVia: 'project', link: 'https://lolly.ing/l/invite/tok-p', passwordSetup: false, password: 'none',
    projects: [{ projectId: 'prj_1', name: 'Brand refresh', role: 'editor', invitedBy: { name: 'Priya' } }],
  }];
  const p = page({ invitations, context: { ...CONTEXT, inviteNote: '' }, clipboard: false });
  p.helpers.setAuthConfig(LOLLY_ING);
  const section = await p.helpers.invitationsSection([]);
  p.main.append(section);
  (buttonByText(section, 'Copy message') as any).click();
  await pause();
  const box = section.querySelector('textarea[readonly]') as any;
  assert.ok(box, 'the message is shown read-only');
  assert.equal(box.value, [
    'Priya invited you to Brand refresh on lolly.ing. Your role: Editor.',
    'https://lolly.ing/l/invite/tok-p',
    'Sign in as sam@work.example with Google or GitHub.',
  ].join('\n'), 'no password line, no end date, no note');
  assert.equal(p.w.document.activeElement, box, 'focused');
  assert.equal(box.selectionEnd - box.selectionStart, box.value.length, 'and selected');
  assert.ok(section.textContent.includes('Copy the message from this box.'));
});

test('the invitations table: columns, text statuses, password lines and the actions of each status', async () => {
  const base = { groups: [], expiresAt: null, acceptedAt: null, projects: [], inviter: { name: 'Andy' }, createdVia: 'console', passwordSetup: false, password: 'none' };
  const invitations = [
    { ...base, id: 'inv_acc', email: 'cy@partner.example', status: 'accepted', createdAt: ago(9e6), acceptedAt: ago(8e6), acceptedUserId: 'usr_cy', acceptedUser: { name: 'Cy', email: 'cy@gmail.example' }, password: 'set' },
    { ...base, id: 'inv_exp', email: 'ex@partner.example', status: 'expired', createdAt: ago(5e6), createdVia: 'request', inviter: null },
    { ...base, id: 'inv_rev', email: 'rv@partner.example', status: 'revoked', createdAt: ago(4e6) },
    { ...base, id: 'inv_wait', email: 'wa@partner.example', status: 'pending', createdAt: ago(2e6), link: 'https://lolly.ing/l/invite/w' },
    { ...base, id: 'inv_open', email: 'op@partner.example', status: 'pending', createdAt: ago(1e6), openedAt: ago(2 * 3_600_000), passwordSetup: true, link: 'https://lolly.ing/l/invite/o',
      createdVia: 'project', projects: [{ projectId: 'prj_1', name: 'Brand refresh', role: 'editor', invitedBy: { name: 'Priya' } }, { projectId: 'prj_2', name: 'Spring poster', role: 'viewer', invitedBy: null }] },
  ];
  const p = page({ invitations, context: CONTEXT });
  const section = await p.helpers.invitationsSection([]);
  p.main.append(section);
  const card = [...section.querySelectorAll('.card')].find((c: any) => c.querySelector('h2')?.textContent === 'Invitations') as any;
  const tables = card.querySelectorAll('table');
  assert.deepEqual([...tables[0].querySelectorAll('thead th')].map((t: any) => textOf(t)),
    ['Email', 'Projects', 'Made from', 'Invited by', 'Status', 'Ends or accepted', 'Actions']);
  const rows = [...tables[0].querySelectorAll('tbody tr')] as any[];
  assert.deepEqual(rows.map((r) => r.children[0].textContent), ['op@partner.example', 'wa@partner.example', 'ex@partner.example', 'cy@partner.example'],
    'pending first, then expired, then accepted');
  const cells = (r: any) => [...r.children].map((c: any) => textOf(c));
  const [open, wait, expired, accepted] = rows;
  assert.equal(cells(open)[1], 'Brand refresh (Editor), Spring poster (Viewer)');
  assert.equal(cells(open)[2], 'Brand refresh (Priya)');
  assert.equal(cells(open)[4], 'Opened 2h ago Can set a password');
  assert.equal(cells(wait)[1], 'none');
  assert.equal(cells(wait)[2], 'Console');
  assert.equal(cells(wait)[4], 'Waiting');
  assert.equal(cells(expired)[2], 'Request');
  assert.equal(cells(expired)[3], '—');
  assert.equal(cells(expired)[4], 'Expired');
  assert.equal(cells(accepted)[4], 'Accepted as cy@gmail.example Password set');
  const actions = (r: any) => [...r.lastElementChild.querySelectorAll('button, a')].map((b: any) => b.textContent);
  assert.deepEqual(actions(open), ['Copy message', 'Copy link', 'New link', 'Copy sign-in link', 'Revoke']);
  assert.deepEqual(actions(expired), ['Invite again']);
  assert.deepEqual(actions(accepted), ['Open person', 'Revoke']);
  assert.equal(accepted.querySelector('a').getAttribute('href'), '#/users?focus=usr_cy');
  assert.ok(card.textContent.includes('Revoked (1)'));
  assert.deepEqual(actions(tables[1].querySelector('tbody tr')), ['Invite again']);
  assert.ok(card.textContent.includes('Anyone with the link of an invitation that can set a password can set that password until it is used.'));
  assert.ok(section.textContent.includes('Invite again makes a new link and ends the old one.'));
  assert.ok(!section.textContent.includes('To change an invitation, revoke it and invite again'));
});

test('New link asks first and posts to the link route; Invite again shows the new invitation, or the live one on a 409', async () => {
  const base = { groups: [], expiresAt: null, acceptedAt: null, projects: [], inviter: { name: 'Andy' }, passwordSetup: false, password: 'none' };
  const invitations = [
    { ...base, id: 'inv_p', email: 'wa@partner.example', status: 'pending', createdAt: ago(1e6), link: 'https://lolly.ing/l/invite/old' },
    { ...base, id: 'inv_e', email: 'ex@partner.example', status: 'expired', createdAt: ago(2e6) },
    { ...base, id: 'inv_r', email: 'rv@partner.example', status: 'revoked', createdAt: ago(3e6) },
  ];
  const fresh = { ...base, id: 'inv_new', email: 'ex@partner.example', status: 'pending', createdAt: ago(0), expiresAt: '2026-11-02T12:00:00.000Z', link: 'https://lolly.ing/l/invite/new' };
  const live = { ...base, id: 'inv_live', email: 'rv@partner.example', status: 'pending', createdAt: ago(0), link: 'https://lolly.ing/l/invite/live' };
  const p = page({
    invitations, context: CONTEXT,
    route: (path, method) => {
      if (path === '/api/v1/invitations/inv_p/link' && method === 'POST') return { status: 200, data: { invitation: { ...invitations[0], link: 'https://lolly.ing/l/invite/rotated' } } };
      if (path === '/api/v1/invitations/inv_e/reinvite' && method === 'POST') return { status: 201, data: { invitation: fresh } };
      if (path === '/api/v1/invitations/inv_r/reinvite' && method === 'POST') return { status: 409, data: { error: { code: 'ACTIVE_INVITATION', message: 'already invited', invitation: live } } };
      return undefined;
    },
  });
  const section = await p.helpers.invitationsSection([]);
  p.main.append(section);
  const newLink = buttonByText(section, 'New link') as any;
  newLink.click();
  assert.equal(newLink.textContent, 'Old links stop working?');
  assert.ok(!p.calls.some((c) => c.path.endsWith('/link')), 'the first click only asks');
  newLink.click();
  await pause(20);
  assert.deepEqual(p.calls.find((c) => c.path === '/api/v1/invitations/inv_p/link'), { path: '/api/v1/invitations/inv_p/link', method: 'POST', body: {} });

  const again = () => [...section.querySelectorAll('button')].filter((b: any) => b.textContent === 'Invite again') as any[];
  again()[0].click();
  await pause(20);
  assert.ok(p.calls.some((c) => c.path === '/api/v1/invitations/inv_e/reinvite' && c.method === 'POST'));
  assert.ok(textOf(section).includes('ex@partner.example · Invitation ready · ends 2 Nov'), 'the new invitation, with its copy buttons');
  again().at(-1).click();
  await pause(20);
  assert.ok(textOf(section).includes('rv@partner.example · Already invited'), 'the live invitation instead of an error');
  assert.ok(!section.querySelector('.form-err')?.textContent);
});

test('People opens with the Requests card above the invitations', async () => {
  const request = { id: 'req_1', kind: 'join', status: 'open', email: 'sam.k@gmail.example', name: 'Sam', provider: 'GitHub', note: null, role: null, currentRole: null, project: null, session: null, invitation: null, createdAt: ago(6e5), expiresAt: ago(-1e9), answeredAt: null, answeredBy: null, answerRole: null };
  const p = page({ route: (path) => (path.startsWith('/api/v1/access-requests?status=open') ? { status: 200, data: { requests: [request] } }
    : path.startsWith('/api/v1/access-requests?status=answered') ? { status: 200, data: { requests: [] } } : undefined) });
  await p.helpers.viewUsers(p.main, new p.w.URLSearchParams(''));
  const headings = [...p.main.querySelectorAll('h2')].map((h: any) => h.textContent);
  assert.ok(headings.indexOf('Requests (1 waiting)') >= 0, headings.join(' | '));
  assert.ok(headings.indexOf('Requests (1 waiting)') < headings.indexOf('Invite people'));
});
