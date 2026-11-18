// SPDX-License-Identifier: MPL-2.0
/**
 * The console for a team manager, in jsdom: the rail counts requests waiting on
 * the signed-in person and updates the count in place, a person who cannot see
 * Overview opens on Approvals when something waits, Reject asks for a reason in
 * place, and approval cards and the rail read in people's words.
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

const approval = (over: Record<string, unknown> = {}) => ({
  id: 'apr_1', subjectType: 'asset', subjectRef: 'certificate/summit-keynote', title: 'Summit keynote certificate', chainId: 'brand', chainName: 'Brand review',
  state: 'in_review', stepIndex: 0, stepCount: 2, stepName: 'Brand sign-off', stepRule: 'any',
  steps: [{ name: 'Brand sign-off', rule: 'any', groups: ['brand-team', 'approver'] }, { name: 'Legal sign-off', rule: 'all', groups: ['admin'] }],
  nominees: [], nomineeNames: [], actions: [], createdBy: 'u1', createdByName: 'Mia Fields', createdAt: new Date().toISOString(),
  mine: false, relation: 'inbox', ...over,
});

type Reply = { status: number; data: unknown };
function page(url = 'https://work.test/admin#/projects', reply: (path: string, method: string, body: any) => Reply | undefined = () => undefined) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url, runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  w.fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    const own = reply(path, method, body) ?? { status: 404, data: { error: { message: 'nope' } } };
    return { ok: own.status < 400, status: own.status, json: async () => own.data };
  };
  w.eval(`${source}\nwindow.t = { consoleNavigation, refreshWaitingCount, route, renderApprovalCard, ruleLabel, roleLabel, setSession: s => { session = s; } };`);
  return { dom, w, t: w.t, calls };
}

const memberSession = (views: Record<string, boolean>, role = 'member') => ({ kind: 'member', user: { email: 'brand@lolly.example', role, groups: [] }, console: { views, actions: ['approval.act'] } });

test('the rail counts requests waiting on you and updates the count in place; a failed fetch shows none', async () => {
  let answer: Reply = { status: 200, data: { approvals: [approval(), approval({ id: 'apr_2' }), approval({ id: 'apr_3', relation: 'mine' })] } };
  const p = page(undefined, (path) => (path === '/api/v1/approvals' ? answer : undefined));
  try {
    p.t.setSession(memberSession({ projects: true, approvals: true }));
    const nav = p.t.consoleNavigation('projects'); p.w.document.body.append(nav);
    const badge = () => nav.querySelector('a[href="#/approvals"] .nav-count');
    assert.equal(badge().hidden, true, 'no count before the first answer');
    await p.t.refreshWaitingCount();
    assert.equal(badge().hidden, false);
    assert.equal(badge().textContent, '2');
    assert.equal(badge().getAttribute('aria-label'), '2 waiting on you');
    assert.equal(nav.querySelector('a[href="#/projects"] .nav-count'), null, 'only Approvals carries a count');
    const again = p.t.consoleNavigation('approvals');
    assert.equal(again.querySelector('.nav-count').textContent, '2', 'a fresh rail draws from the cached count at once');
    answer = { status: 200, data: { approvals: [] } };
    await p.t.refreshWaitingCount();
    assert.equal(badge().hidden, true, 'nothing waiting hides the count');
    answer = { status: 500, data: { error: { message: 'down' } } };
    await p.t.refreshWaitingCount();
    assert.equal(badge().hidden, true);
    assert.equal(badge().textContent, '');
  } finally { p.dom.window.close(); }
});

test('a person who cannot see Overview opens on Approvals when something waits, otherwise where they did before', async () => {
  for (const [waiting, role, expected] of [[1, 'member', '#/approvals'], [0, 'member', '#/projects'], [2, 'author', '#/approvals']] as const) {
    const views = { overview: false, projects: true, approvals: true, docs: true };
    const p = page('https://work.test/admin', (path) => {
      if (path === '/api/auth/session') return { status: 200, data: memberSession(views, role) };
      if (path === '/api/v1/approvals') return { status: 200, data: { approvals: Array.from({ length: waiting }, (_, i) => approval({ id: `apr_${i}` })) } };
      return undefined;
    });
    try {
      p.t.setSession(memberSession(views, role));
      await p.t.route();
      await pause(20);
      assert.equal(p.w.location.hash, expected, `${role} with ${waiting} waiting`);
    } finally { p.dom.window.close(); }
  }
});

test('someone who can see Overview still opens Overview, and an explicit route wins', async () => {
  const views = { overview: true, projects: true, approvals: true };
  const reply = (path: string) => (path === '/api/v1/approvals' ? { status: 200, data: { approvals: [approval()] } }
    : path === '/api/auth/session' ? { status: 200, data: memberSession(views, 'admin') } : undefined);
  const admin = page('https://work.test/admin', reply);
  try {
    admin.t.setSession(memberSession(views, 'admin'));
    await admin.t.route();
    assert.equal(admin.w.location.hash, '', 'no redirect away from Overview');
  } finally { admin.dom.window.close(); }
  const explicit = page('https://work.test/admin#/projects', reply);
  try {
    explicit.t.setSession(memberSession({ overview: false, projects: true, approvals: true }));
    await explicit.t.route();
    assert.equal(explicit.w.location.hash, '#/projects');
  } finally { explicit.dom.window.close(); }
});

test('Reject asks for a reason in place; Escape and Cancel put the row back; Enter sends the reason', async () => {
  const p = page('https://work.test/admin#/approvals', (path, method) => (path.endsWith('/act') && method === 'POST' ? { status: 200, data: {} } : undefined));
  try {
    const card = p.t.renderApprovalCard(approval(), { actionable: true });
    p.w.document.body.append(card);
    const row = () => card.querySelector('.appr-act');
    const labels = () => [...row().querySelectorAll('button')].map((b: any) => b.textContent);
    assert.deepEqual(labels(), ['Approve', 'Reject']);
    assert.equal(row().querySelector('input'), null, 'no reason field at rest');
    const reject = row().querySelectorAll('button')[1];
    reject.click();
    const input = row().querySelector('input');
    assert.deepEqual(labels(), ['Reject request', 'Cancel']);
    assert.equal(input.getAttribute('placeholder'), 'Reason for rejecting');
    assert.equal(input.getAttribute('aria-label'), 'Reason for rejecting');
    assert.equal(p.w.document.activeElement, input);
    assert.ok(row().querySelectorAll('button')[0].classList.contains('danger'));

    row().querySelectorAll('button')[0].click();
    await pause();
    assert.match(card.textContent, /Add a reason before rejecting\./);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(p.calls.filter(c => c.path.endsWith('/act')).length, 0, 'an empty reason sends nothing');

    input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.deepEqual(labels(), ['Approve', 'Reject']);
    assert.equal(p.w.document.activeElement, reject, 'focus returns to Reject');
    assert.doesNotMatch(card.textContent, /Add a reason/);

    reject.click();
    row().querySelectorAll('button')[1].click();
    assert.deepEqual(labels(), ['Approve', 'Reject'], 'Cancel puts the row back');
    assert.equal(p.w.document.activeElement, reject);

    reject.click();
    input.value = 'Wrong logo lockup';
    input.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await pause(10);
    const act = p.calls.find(c => c.path.endsWith('/act'))!;
    assert.deepEqual(act.body, { action: 'reject', comment: 'Wrong logo lockup' });
  } finally { p.dom.window.close(); }
});

test('approval cards and the rail foot read in people\'s words', () => {
  const p = page();
  try {
    const card = p.t.renderApprovalCard(approval(), { actionable: true });
    const meta = card.querySelector('.appr-meta');
    assert.match(meta.textContent, /^Asset · Brand review · raised by Mia Fields · just now$/);
    assert.equal(card.querySelector('.appr-meta .chip'), null, 'no kind chip');
    assert.doesNotMatch(card.querySelector('.appr-head').textContent, /certificate\/summit-keynote/);
    assert.equal(card.querySelector('.appr-title').getAttribute('title'), 'certificate/summit-keynote', 'the path stays reachable on hover');
    assert.deepEqual([...card.querySelectorAll('.rule-badge')].map((b: any) => b.textContent), ['Any one approves', 'All approve']);
    assert.equal(card.querySelector('.step-sub .muted').getAttribute('title'), 'brand-team, approver');
    assert.equal(p.t.ruleLabel({ quorum: 2 }), 'Any 2 approve');
    assert.equal(p.t.roleLabel('approver'), 'Approver');
    assert.equal(p.t.roleLabel('brand-manager'), 'Brand manager');
    assert.equal(p.t.roleLabel(undefined), '');
  } finally { p.dom.window.close(); }
});
