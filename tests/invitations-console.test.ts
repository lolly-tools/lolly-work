// SPDX-License-Identifier: MPL-2.0
/**
 * The console's "Invite people" card (plans/74 W-ID-2) in jsdom: it posts the
 * parsed addresses with the ticked local groups, hands over the sign-in
 * address, lists invitations by status and revokes with the two-click confirm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

type Inv = { id: string; email: string; groups: string[]; status: string; createdAt: string; expiresAt: string | null; acceptedAt: string | null; created?: boolean };

function page(invitations: Inv[], admission = { policy: true, invitations: true }) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/users', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let rows = invitations;
  w.fetch = async (path: string, opts: { method?: string; body?: string } = {}) => {
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, method, body });
    const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    if (path === '/api/v1/invitations' && method === 'GET') return json(200, { invitations: rows, signInUrl: 'https://team.example', admission });
    if (path === '/api/v1/invitations' && method === 'POST') {
      const made = body.emails.map((email: string, i: number) => ({ id: `inv_${i}`, email, groups: body.groups, status: 'pending', createdAt: '2026-10-02T10:00:00.000Z', expiresAt: body.expiresAt ?? null, acceptedAt: null, created: true }));
      rows = [...made, ...rows];
      return json(201, { invitations: made, signInUrl: 'https://team.example', admission });
    }
    const del = /^\/api\/v1\/invitations\/(.+)$/.exec(path);
    if (del && method === 'DELETE') {
      rows = rows.map((r) => (r.id === del[1] ? { ...r, status: 'revoked' } : r));
      return json(200, rows.find((r) => r.id === del[1]));
    }
    return json(404, { error: { message: 'nope' } });
  };
  w.eval(`${source}\nwindow.helpers = { invitationsSection, parseInviteEmails };`);
  return { w, calls, main: w.document.getElementById('app'), helpers: w.helpers };
}
const buttonByText = (root: any, text: string) => [...root.querySelectorAll('button')].find((b: any) => b.textContent === text);

test('address parsing splits on commas, semicolons and whitespace and drops brackets', () => {
  const { helpers } = page([]);
  assert.deepEqual([...helpers.parseInviteEmails('Ana@Example.com, <bo@x.example>;\n"cy@x.example"  ana@example.com')],
    ['ana@example.com', 'bo@x.example', 'cy@x.example']);
});

test('invite form posts addresses, ticked groups and expiry, then shows the sign-in address', async () => {
  const p = page([]);
  const section = await p.helpers.invitationsSection(['brand', 'team']);
  p.main.append(section);
  assert.ok(section.textContent.includes('No open invitations'));
  section.querySelector('textarea').value = 'ana@example.com\nbo@example.com';
  const team = [...section.querySelectorAll('input[type=checkbox]')].find((c: any) => c.value === 'team') as any;
  team.checked = true;
  const select = section.querySelector('select');
  assert.equal(select.value, '30', 'thirty days is the default expiry');
  section.querySelector('form').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await pause();
  const post = p.calls.find((c) => c.method === 'POST');
  assert.deepEqual(post?.body.emails, ['ana@example.com', 'bo@example.com']);
  assert.deepEqual(post?.body.groups, ['team']);
  const days = (Date.parse(post?.body.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days < 30.1, 'expiry is thirty days out');
  assert.ok(section.textContent.includes('2 invitations created.'));
  assert.ok(section.textContent.includes('https://team.example'), 'the sign-in address to share');
  assert.ok(buttonByText(section, 'Copy link'), 'with a copy button');
  await pause();
  assert.equal(section.querySelectorAll('tbody tr').length, 2, 'the list refreshed');
  assert.ok(section.querySelector('.status.review'), 'pending reads with the in-progress status');

  // An empty form says what is missing and posts nothing.
  const before = p.calls.length;
  section.querySelector('form').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await pause();
  assert.equal(p.calls.length, before);
  assert.ok(section.textContent.includes('Enter at least one email address.'));
});

test('the list separates revoked rows and revoke needs a second click', async () => {
  const p = page([
    { id: 'inv_a', email: 'ana@example.com', groups: ['team'], status: 'accepted', createdAt: '2026-10-01T10:00:00.000Z', expiresAt: null, acceptedAt: '2026-10-01T11:00:00.000Z' },
    { id: 'inv_b', email: 'bo@example.com', groups: [], status: 'revoked', createdAt: '2026-10-01T09:00:00.000Z', expiresAt: null, acceptedAt: null },
  ]);
  const section = await p.helpers.invitationsSection([]);
  p.main.append(section);
  assert.ok(section.textContent.includes('No local groups yet.'));
  assert.ok(section.textContent.includes('Revoked (1)'));
  const revoke = buttonByText(section, 'Revoke') as any;
  revoke.click();
  assert.equal(p.calls.filter((c) => c.method === 'DELETE').length, 0, 'the first click only arms');
  revoke.click();
  await pause();
  assert.equal(p.calls.find((c) => c.method === 'DELETE')?.path, '/api/v1/invitations/inv_a');
  await pause();
  assert.ok(section.textContent.includes('Revoked (2)'));
});

test('an owner is offered IdP groups (the way to add a second owner); without grant.edit no groups are offered', async () => {
  const p = page([]);
  const section = await p.helpers.invitationsSection([{ name: 'team', source: 'local' }, { name: 'lolly-owners', source: 'idp' }]);
  p.main.append(section);
  const owners = [...section.querySelectorAll('input[type=checkbox]')].find((c: any) => c.value === 'lolly-owners') as any;
  assert.ok(owners, 'the IdP owner group is offered');
  assert.ok(owners.closest('label').textContent.includes('from sign-in provider'), 'and marked as coming from the provider');
  owners.checked = true;
  section.querySelector('textarea').value = 'co-owner@example.com';
  section.querySelector('form').dispatchEvent(new p.w.Event('submit', { cancelable: true }));
  await pause();
  assert.deepEqual(p.calls.find((c) => c.method === 'POST')?.body.groups, ['lolly-owners']);

  const q = page([]);
  const plain = await q.helpers.invitationsSection(null);
  q.main.append(plain);
  assert.equal(plain.querySelectorAll('input[type=checkbox]').length, 0);
  assert.ok(plain.textContent.includes('needs permission to edit groups'));
  plain.querySelector('textarea').value = 'ana@example.com';
  plain.querySelector('form').dispatchEvent(new q.w.Event('submit', { cancelable: true }));
  await pause();
  assert.deepEqual(q.calls.find((c) => c.method === 'POST')?.body.groups, []);

  // The People view hands owners the IdP groups and gates groups on grant.edit.
  assert.match(source, /canAction\('grant\.edit'\) \? null/);
  assert.match(source, /g\.source === 'local' \|\| session\?\.user\?\.role === 'owner'/);
});

test('a deployment with invitations switched off says so on the card', async () => {
  const p = page([], { policy: true, invitations: false });
  const section = await p.helpers.invitationsSection([]);
  assert.ok(section.textContent.includes('Invitations are switched off'));
});
