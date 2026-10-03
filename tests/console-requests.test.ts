// SPDX-License-Identifier: MPL-2.0
/**
 * The console's access requests in jsdom (plans/74 invite spec 4.3 and 4.4):
 * the Requests card on People lists open requests oldest first and says what
 * each asks for, keeps a note as text, approves with a role from the invite
 * policy (a join optionally into a project the approver manages), hands the
 * approver the message to send after a join, shows who answered first on a
 * 409, and folds the last week's answers away. The Overview counts waiting
 * requests, and the Activity feed has a sentence for each invite and access
 * event.
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
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const textOf = (node: any) => node.textContent.replace(/\s+/g, ' ').trim();
const buttonsByText = (root: any, text: string) => [...root.querySelectorAll('button')].filter((b: any) => b.textContent === text) as any[];

type Req = Record<string, unknown>;
const request = (over: Req): Req => ({
  status: 'open', name: null, provider: null, note: null, role: null, currentRole: null, project: null, session: null,
  invitation: null, expiresAt: ago(-1e9), answeredAt: null, answeredBy: null, answerRole: null, ...over,
});
const BRAND = { id: 'prj_1', name: 'Brand refresh' };
const OPEN = [
  request({ id: 'req_join', kind: 'join', email: 'sam.k@gmail.example', name: 'Sam K', provider: 'GitHub', note: '<script>window.pwned = 1</script>', createdAt: ago(60_000) }),
  request({ id: 'req_proj', kind: 'project', email: 'ana@suse.com', name: 'Ana', provider: 'Google', role: 'editor', currentRole: 'viewer', project: BRAND, session: { id: 'ses_1', name: 'Spring poster' }, createdAt: ago(3 * 3_600_000) }),
  request({ id: 'req_sw', kind: 'switch', email: 'sam.k@gmail.example', provider: 'GitHub', project: BRAND, invitation: { id: 'inv_1', maskedEmail: 'an•••@suse.com', inviter: 'Andy' }, createdAt: ago(3_600_000) }),
];
type Reply = { status: number; data: unknown };

function page(opts: { open?: Req[]; answered?: Req[]; route?: (path: string, method: string, body: any) => Reply | undefined; actions?: string[] } = {}) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/users', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const copied: string[] = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t: string) => { copied.push(t); } }, configurable: true });
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  w.fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    const own = opts.route?.(path, method, body);
    if (own) return json(own.status, own.data);
    if (path === '/api/v1/access-requests?status=open') return json(200, { requests: opts.open ?? OPEN });
    if (path.startsWith('/api/v1/access-requests?status=answered&since=')) return json(200, { requests: opts.answered ?? [] });
    if (path === '/api/v1/org-config') return json(200, { invites: { domains: [], maxTtlHours: 720, projectRoles: ['viewer', 'editor'] } });
    if (path === '/api/v1/projects') return json(200, { projects: [{ ...BRAND, myRole: 'manager' }, { id: 'prj_2', name: 'Not mine', myRole: 'editor' }] });
    return json(404, { error: { message: 'nope' } });
  };
  w.eval(`${source}
window.helpers = {
  requestsSection, viewOverview, activityLine,
  setAuthConfig: (c) => { authConfig = c; },
  setSession: (s) => { session = s; },
};`);
  w.helpers.setAuthConfig({ provider: 'oidc', providerName: 'Google', instanceName: 'lolly.ing',
    providers: [{ id: 'primary', kind: 'oidc', name: 'Google' }, { id: 'github', kind: 'github', name: 'GitHub' }] });
  w.helpers.setSession({ kind: 'member', user: { role: 'admin' }, console: { actions: opts.actions ?? ['user.invite'], views: {} } });
  return { w, calls, copied, main: w.document.getElementById('app'), helpers: w.helpers };
}
async function card(p: ReturnType<typeof page>, canInvite = true) {
  const node = await p.helpers.requestsSection(canInvite);
  if (node) p.main.append(node);
  return node;
}
const rowFor = (root: any, email: string, asks: string) =>
  [...root.querySelectorAll('tbody tr')].find((r: any) => r.textContent.includes(email) && r.textContent.includes(asks)) as any;
const approveCall = (p: ReturnType<typeof page>, id: string) => p.calls.find((c) => c.path === `/api/v1/access-requests/${id}/approve`);

test('the Requests card lists open requests oldest first, says what each asks for, and keeps a note as text', async () => {
  const p = page();
  const node = await card(p);
  assert.equal(node.querySelector('h2').textContent, 'Requests (3 waiting)');
  assert.deepEqual([...node.querySelectorAll('thead th')].map((t: any) => textOf(t)), ['Who', 'Asks for', 'Note', 'Asked', 'Actions']);
  const rows = [...node.querySelectorAll('tbody tr')] as any[];
  assert.deepEqual(rows.map((r) => textOf(r.children[1]).split(' Someone')[0]), [
    'Edit Brand refresh (from the Spring poster link)',
    'Use this account for an•••@suse.com’s invitation (Brand refresh)',
    'Join lolly.ing',
  ], 'oldest first');
  assert.equal(textOf(rows[0].children[0]), 'Ana ana@suse.com Google', 'name, email and the provider tag');
  assert.equal(textOf(rows[1].children[0]), 'sam.k@gmail.example GitHub', 'no name: the email once');
  assert.ok(textOf(rows[1]).includes('Someone with the invitation for an•••@suse.com signed in as sam.k@gmail.example. Approve only if you know the address belongs to the same person.'));
  assert.equal(rows[2].children[2].textContent, '<script>window.pwned = 1</script>', 'the note is text');
  assert.equal(node.querySelector('script'), null);
  assert.equal(p.w.pwned, undefined);
  const roleSel = rows[0].querySelector('select') as any;
  assert.deepEqual([...roleSel.options].map((o: any) => o.value), ['viewer', 'editor'], 'limited to policy.invites.projectRoles');
  assert.equal(roleSel.value, 'editor', 'defaults to the role asked for');
  assert.equal(rows[1].querySelector('select'), null, 'a switch has no role to choose');
  assert.deepEqual(rows.map((r) => buttonsByText(r, 'Approve').length + buttonsByText(r, 'Decline').length), [2, 2, 2]);
});

test('Approve on a project request sends the chosen role, and the row then says who approved it', async () => {
  const p = page({
    route: (path, method, body) => (path === '/api/v1/access-requests/req_proj/approve' && method === 'POST'
      ? { status: 200, data: { outcome: 'added', request: { ...OPEN[1], status: 'approved', answeredAt: ago(1000), answeredBy: { name: 'Andy' }, answerRole: body.role } } }
      : undefined),
  });
  const node = await card(p);
  const row = rowFor(node, 'ana@suse.com', 'Edit Brand refresh');
  const roleSel = row.querySelector('select') as any;
  roleSel.value = 'viewer';
  buttonsByText(row, 'Approve')[0].click();
  await pause(20);
  assert.deepEqual(approveCall(p, 'req_proj')?.body, { role: 'viewer' });
  assert.equal(textOf(row.lastElementChild), 'Andy approved this just now as Viewer');
  assert.equal(node.querySelector('h2').textContent, 'Requests (2 waiting)');
  assert.ok(!node.textContent.includes('Approved. Tell'), 'a member is told by the inbox, not by the approver');
});

test('approving a join hands the approver the message to send, with Copy message', async () => {
  const text = 'You can now sign in to lolly.ing. Open https://lolly.ing and sign in as sam.k@gmail.example with GitHub.';
  const p = page({
    route: (path) => (path === '/api/v1/access-requests/req_join/approve'
      ? { status: 200, data: { outcome: 'invited', request: { ...OPEN[0], status: 'approved', answeredAt: ago(0), answeredBy: { name: 'Andy' } }, message: { text } } }
      : undefined),
  });
  const node = await card(p);
  const row = rowFor(node, 'sam.k@gmail.example', 'Join lolly.ing');
  buttonsByText(row, 'Approve')[0].click();
  await pause(20);
  assert.deepEqual(approveCall(p, 'req_join')?.body, {}, 'no project chosen');
  const panel = node.querySelector('.mint-out') as any;
  assert.ok(panel, 'the result panel opens');
  assert.ok(panel.textContent.includes('Approved. Tell sam.k@gmail.example:'));
  assert.ok(panel.textContent.includes(text));
  buttonsByText(panel, 'Copy message')[0].click();
  await pause();
  assert.deepEqual(p.copied, [text]);
});

test('a join can be approved into a project the approver manages, with a role', async () => {
  const p = page();
  const node = await card(p);
  const row = rowFor(node, 'sam.k@gmail.example', 'Join lolly.ing');
  const [projectSel, roleSel] = [...row.querySelectorAll('select')] as any[];
  assert.deepEqual([...projectSel.options].map((o: any) => o.textContent), ['No project', 'Brand refresh'], 'only projects the approver manages');
  assert.equal(roleSel.disabled, true, 'the role waits for a project');
  projectSel.value = 'prj_1';
  projectSel.dispatchEvent(new p.w.Event('change'));
  assert.equal(roleSel.disabled, false);
  assert.equal(roleSel.value, 'editor');
  roleSel.value = 'viewer';
  buttonsByText(row, 'Approve')[0].click();
  await pause(20);
  assert.deepEqual(approveCall(p, 'req_join')?.body, { projectId: 'prj_1', role: 'viewer' });
  assert.ok(!p.calls.some((c) => c.path === '/api/v1/projects' && c.method !== 'GET'));

  // No join waiting: the project list is not loaded at all.
  const q = page({ open: [OPEN[1]!] });
  await card(q);
  assert.ok(!q.calls.some((c) => c.path === '/api/v1/projects'));
});

test('a request someone else answered first shows who did (409); Decline posts an empty body; an ended request says why', async () => {
  const p = page({
    route: (path) => {
      if (path === '/api/v1/access-requests/req_sw/approve') {
        return { status: 409, data: { error: { code: 'ALREADY_ANSWERED', message: 'already answered', request: { ...OPEN[2], status: 'declined', answeredAt: ago(3_600_000), answeredBy: { name: 'Priya' } } } } };
      }
      if (path === '/api/v1/access-requests/req_join/decline') {
        return { status: 200, data: { request: { ...OPEN[0], status: 'declined', answeredAt: ago(0), answeredBy: { name: 'Andy' } } } };
      }
      if (path === '/api/v1/access-requests/req_proj/approve') {
        return { status: 409, data: { error: { code: 'PROJECT_ARCHIVED', message: 'archived' } } };
      }
      return undefined;
    },
  });
  const node = await card(p);
  const sw = rowFor(node, 'sam.k@gmail.example', 'Use this account');
  buttonsByText(sw, 'Approve')[0].click();
  await pause(20);
  assert.equal(textOf(sw.lastElementChild), 'Priya declined this 1h ago');
  const join = rowFor(node, 'sam.k@gmail.example', 'Join lolly.ing');
  buttonsByText(join, 'Decline')[0].click();
  await pause(20);
  assert.deepEqual(p.calls.find((c) => c.path === '/api/v1/access-requests/req_join/decline')?.body, {});
  assert.equal(textOf(join.lastElementChild), 'Andy declined this just now');
  const proj = rowFor(node, 'ana@suse.com', 'Edit Brand refresh');
  buttonsByText(proj, 'Approve')[0].click();
  await pause(20);
  assert.equal(textOf(proj.lastElementChild), 'Not approved. The project is archived, so the request is closed.');
  assert.equal(node.querySelector('h2').textContent, 'Requests');
});

test('answers from the last seven days fold under Answered (n), newest first', async () => {
  const answered = [
    request({ id: 'a1', kind: 'join', email: 'old@x.example', status: 'approved', createdAt: ago(5 * 86_400_000), answeredAt: ago(4 * 86_400_000), answeredBy: { name: 'Andy' } }),
    request({ id: 'a2', kind: 'project', email: 'new@x.example', role: 'viewer', project: BRAND, status: 'approved', createdAt: ago(86_400_000), answeredAt: ago(3_600_000), answeredBy: { name: 'Priya' }, answerRole: 'viewer' }),
    request({ id: 'a3', kind: 'join', email: 'gone@x.example', status: 'withdrawn', createdAt: ago(2 * 86_400_000), answeredAt: ago(86_400_000) }),
  ];
  const p = page({ open: [], answered });
  const node = await card(p);
  assert.ok(node.textContent.includes('No requests waiting.'));
  assert.equal(node.querySelector('h2').textContent, 'Requests');
  const details = node.querySelector('details') as any;
  assert.equal(details.open, false, 'collapsed');
  assert.equal(textOf(details.querySelector('summary')), 'Answered (3)');
  assert.deepEqual([...details.querySelectorAll('tbody tr')].map((r: any) => textOf(r.lastElementChild)),
    ['Priya approved this 1h ago as Viewer', 'They withdrew this 1d ago', 'Andy approved this 4d ago']);
  const since = p.calls.find((c) => c.path.includes('status=answered'))!.path.split('since=')[1]!;
  const days = (Date.now() - Date.parse(decodeURIComponent(since))) / 86_400_000;
  assert.ok(days > 6.9 && days < 7.1, 'asks the server for seven days');
});

test('the card is only for people who can answer or invite', async () => {
  const empty = page({ open: [], answered: [] });
  assert.equal(await card(empty, false), null, 'nothing to answer, no user.invite: no card');
  const inviter = await card(page({ open: [], answered: [] }), true);
  assert.ok(inviter?.textContent.includes('No requests waiting.'));
  const old = page({ route: (path) => (path.startsWith('/api/v1/access-requests') ? { status: 404, data: { error: { message: 'no route' } } } : undefined) });
  assert.equal(await card(old, true), null, 'a server without the request routes shows no card');
  const broken = page({ route: (path) => (path === '/api/v1/access-requests?status=open' ? { status: 500, data: { error: { message: 'store down' } } } : undefined) });
  assert.ok((await card(broken, true))?.textContent.includes('store down'));
});

test('the Overview counts the requests waiting and links to People', async () => {
  const p = page({
    route: (path) => (path === '/api/v1/telemetry/summary'
      ? { status: 200, data: { days: [{ date: '2026-10-03', events: 1, exports: 0, users: 1 }], totals: { activeUsers: 1 }, topTools: [], formats: [] } }
      : undefined),
  });
  await p.helpers.viewOverview(p.main);
  const link = [...p.main.querySelectorAll('a.needs-link')].find((a: any) => a.textContent.includes('requests waiting')) as any;
  assert.equal(link?.textContent, '3 requests waiting');
  assert.equal(link.getAttribute('href'), '#/users');

  const q = page({ open: [], route: (path) => (path === '/api/v1/telemetry/summary'
    ? { status: 200, data: { days: [{ date: '2026-10-03', events: 0, exports: 0, users: 0 }], totals: { activeUsers: 0 }, topTools: [], formats: [] } }
    : undefined) });
  await q.helpers.viewOverview(q.main);
  assert.ok(!q.main.textContent.includes('requests waiting'));
  assert.ok(q.main.textContent.includes('Invite people from People. Invited people appear in the directory after they first sign in.'), 'the first-run steps');
});

test('Activity has a sentence for each invite and access event', () => {
  const p = page();
  const user = { kind: 'user', id: 'usr_1', name: 'Andy' };
  const nobody = { kind: 'system', id: null, name: 'the system' };
  const line = (action: string, payload: Record<string, unknown>, actor: unknown = user, subject = 'invitation:inv_1') => {
    const host = p.w.document.createElement('div');
    host.append(...p.helpers.activityLine({ action, payload, actor, subject }, {}).flat(Infinity).filter((x: unknown) => x !== '' && x != null));
    return textOf(host);
  };
  assert.equal(line('invite.create', { email: 'sam@suse.com' }), 'Andy invited sam@suse.com');
  assert.match(line('invite.create', { email: 'sam@suse.com', projects: [{ projectId: 'prj_1', role: 'editor' }] }), /^Andy invited sam@suse\.com to prj_1$/);
  assert.equal(line('invite.extend', { email: 'sam@suse.com', project: { projectId: 'prj_1' } }), 'Andy added prj_1 to the invitation for sam@suse.com');
  assert.equal(line('invite.accept', { email: 'sam@suse.com' }), 'Andy accepted the invitation for sam@suse.com');
  assert.equal(line('invite.revoke', { email: 'sam@suse.com' }), 'Andy revoked the invitation for sam@suse.com');
  assert.equal(line('invite.link', { email: 'sam@suse.com', version: 2 }), 'Andy made a new invite link for sam@suse.com');
  assert.equal(line('invite.open', { email: 'sam@suse.com', provider: 'oidc' }, nobody), 'Someone opened the invitation for sam@suse.com');
  assert.equal(line('invite.open', { provider: 'oidc' }, nobody), 'Someone opened an invitation');
  assert.equal(line('invite.wrong-account', { email: 'sam.k@gmail.example', admitted: false }, nobody), 'sam.k@gmail.example opened an invitation with another account');
  assert.equal(line('auth.denied', { email: 'eve@x.example', reason: 'not-invited' }, nobody, 'session'), 'eve@x.example could not sign in (not invited)');
  assert.equal(line('auth.denied', { email: 'eve@x.example', reason: 'email-unverified' }, nobody, 'session'), 'eve@x.example could not sign in (email address not verified)');
  assert.equal(line('access.request', { kind: 'join', email: 'sam.k@gmail.example' }, nobody, 'request:r1'), 'sam.k@gmail.example asked to join lolly.ing');
  assert.equal(line('access.request', { kind: 'project', email: 'ana@suse.com', role: 'editor', projectId: 'prj_1' }, { kind: 'user', id: 'usr_2', name: 'Ana' }, 'request:r2'), 'Ana asked to edit prj_1');
  assert.equal(line('access.request', { kind: 'switch', email: 'sam.k@gmail.example' }, nobody, 'request:r3'), 'sam.k@gmail.example asked to use their own account for an invitation');
  assert.equal(line('access.approve', { kind: 'join', email: 'sam.k@gmail.example' }, user, 'request:r1'), 'Andy approved a request from sam.k@gmail.example');
  assert.equal(line('access.decline', { kind: 'join', email: 'sam.k@gmail.example' }, user, 'request:r1'), 'Andy declined a request from sam.k@gmail.example');
  assert.equal(line('access.withdraw', { kind: 'join' }, nobody, 'request:r1'), 'Someone withdrew a request');
  assert.equal(line('access.withdraw', { kind: 'project' }, { kind: 'user', id: 'usr_2', name: 'Ana' }, 'request:r2'), 'Ana withdrew a request');
});
