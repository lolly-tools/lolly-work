// SPDX-License-Identifier: MPL-2.0
/**
 * The console's agent cards (plans/82 M7, W-M7-8), in jsdom:
 *
 *  - the Tokens card shows each limit with where it comes from, today's use against it
 *    and what a limit turned away this week; Change limits sends only what was set;
 *  - Mint sends the label, company, scopes, lifetime and limits, and shows the secret
 *    once, with Copy;
 *  - the Usage card totals per token, company and programme, with a CSV of the same cells;
 *  - an agent's approval card says the file is its own render, and prints no "null".
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
const until = async (ready: () => unknown) => { for (let i = 0; i < 400 && !ready(); i++) await pause(5); assert.ok(ready(), 'it settled'); };
const reads = (node: any, ...parts: string[]) => {
  const all = node.textContent.replace(/\s+/g, ' ');
  let at = 0;
  for (const part of parts) { const i = all.indexOf(part, at); assert.ok(i >= 0, `"${part}" after ${at} in: ${all}`); at = i + part.length; }
};

const usage = (over: Record<string, unknown> = {}) => ({
  today: { day: '2026-11-08', calls: 13, renders: 2, busiestMinute: 9 }, month: { from: '2026-11-01', renders: 40 },
  week: { from: '2026-11-02', rateLimited: 3, budgetRefused: 1 }, lastRefusal: { at: '2026-11-07T10:00:00.000Z', code: 'RATE_LIMITED' },
  resetsAt: 'x', monthResetsAt: 'x', ...over,
});
const TOKENS = {
  programme: 'resellers', expiringWithinDays: 14,
  caps: { scopes: [{ id: 'render', label: 'Render files', description: 'Make files.' }, { id: 'catalog.read', label: 'Read the catalog', description: 'Read.' }, { id: 'approvals.request', label: 'Ask for approval', description: 'Ask.' }],
    defaultScopes: ['render', 'catalog.read'], ttlDays: { default: 90, min: 1, max: 365 }, maxTools: 64 },
  tokens: [{ id: 'tok_r', label: "Rita's agent", company: 'northwind', scopes: ['render', 'catalog.read'], live: true, expiring: false, expired: false,
    createdAt: 'x', expiresAt: '2027-02-06T00:00:00.000Z', lastUsedAt: '2026-11-08T09:00:00.000Z', revokedAt: null,
    limits: { callsPerMinute: 60, rendersPerDay: 500, rendersPerMonth: null }, limitSources: { callsPerMinute: 'token', rendersPerDay: 'programme', rendersPerMonth: 'instance' },
    limitOverrides: { callsPerMinute: 60 }, usage: usage() }],
};
const P = { id: 'resellers', name: 'Resellers, EMEA', tools: [], tokenLimitDefaults: { limits: { callsPerMinute: 120, rendersPerDay: 500, rendersPerMonth: null }, sources: { callsPerMinute: 'instance', rendersPerDay: 'programme', rendersPerMonth: 'instance' } } };

function page(routes: Record<string, (body: any, method: string) => unknown>) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/programmes', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.URL.createObjectURL = () => 'blob:artifact';
  w.URL.revokeObjectURL = () => {};
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  w.fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    const method = init.method ?? 'GET';
    calls.push({ path, method, ...(body ? { body } : {}) });
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => `${method} ${path}`.startsWith(k));
    const value = key ? routes[key]!(body, method) : {};
    return { ok: true, status: 200, headers: new w.Headers({ 'content-type': 'application/json' }), json: async () => value, text: async () => JSON.stringify(value), blob: async () => new w.Blob(['x']) };
  };
  w.eval(`${source}; window.t = { programmeTokens, programmeUsage, renderApprovalCard };`);
  return { w, calls, t: w.t as Record<string, Function>, close: () => dom.window.close() };
}

test('the Tokens card shows each limit, where it comes from, today\'s use and what was turned away', async () => {
  const pg = page({ 'GET /api/v1/programmes/resellers/tokens': () => TOKENS });
  const host = pg.w.document.createElement('div');
  await pg.t.programmeTokens!(P, host, { companies: [{ id: 'northwind', name: 'Northwind IT' }] });
  reads(host, 'Every token here starts with 120 calls a minute (the instance default), 500 renders a day (set for this programme), no cap on renders a month (the instance default).');
  reads(host, "Rita's agent", 'Northwind IT · Render files · Read the catalog', 'Live');
  reads(host, '60 calls a minute', 'set on this token', '500 renders a day', 'the programme’s', 'No cap on renders a month', 'the instance default');
  reads(host, '13 calls, busiest minute 9', '2 of 500 renders', '40 renders this month');
  reads(host, '4 this week', '3 over the call limit, 1 over a render budget', 'RATE_LIMITED');
  assert.doesNotMatch(host.textContent, /null|undefined/);
  pg.close();
});

test('Change limits sends only what was set, and No cap sends null', async () => {
  const pg = page({ 'GET /api/v1/programmes/resellers/tokens': () => TOKENS, 'PUT /api/v1/programmes/resellers/tokens/tok_r': () => TOKENS.tokens[0] });
  const host = pg.w.document.createElement('div');
  pg.w.document.body.append(host);
  await pg.t.programmeTokens!(P, host, { companies: [] });
  [...host.querySelectorAll('button')].find((b: any) => b.textContent === 'Change limits').click();
  const editor = host.querySelector('.token-limits-editor');
  const day = editor.querySelector('input[aria-label="Limit: renders a day"]');
  day.value = '250';
  const month = [...editor.querySelectorAll('.limit-field')][2].querySelector('input[type=checkbox]');
  month.checked = true; month.dispatchEvent(new pg.w.Event('change'));
  [...editor.querySelectorAll('button')].find((b: any) => b.textContent === 'Save').click();
  await until(() => pg.calls.some((c) => c.method === 'PUT'));
  assert.deepEqual(pg.calls.find((c) => c.method === 'PUT')!.body, { limits: { callsPerMinute: 60, rendersPerDay: 250, rendersPerMonth: null } });
  pg.close();
});

test('Mint sends what was chosen and shows the secret once, with Copy', async () => {
  const pg = page({
    'GET /api/v1/programmes/resellers/tokens': () => TOKENS,
    'POST /api/v1/programmes/resellers/tokens': (body) => ({ ...TOKENS.tokens[0], id: 'tok_new', label: body.label, token: 'lwt_secret_once', limits: { callsPerMinute: 120, rendersPerDay: 500, rendersPerMonth: null } }),
  });
  const host = pg.w.document.createElement('div');
  pg.w.document.body.append(host);
  await pg.t.programmeTokens!(P, host, { companies: [{ id: 'northwind', name: 'Northwind IT' }] });
  host.querySelector('input[aria-label="Label"]').value = 'Northwind ordering bot';
  const company = host.querySelector('select[aria-label="Company"]');
  company.value = 'northwind';
  host.querySelector('input[aria-label="Days until it expires"]').value = '30';
  [...host.querySelectorAll('button')].find((b: any) => b.textContent === 'Mint token').click();
  await until(() => host.querySelector('.token-secret-sheet'));
  assert.deepEqual(pg.calls.find((c) => c.method === 'POST')!.body, { label: 'Northwind ordering bot', company: 'northwind', scopes: ['render', 'catalog.read'], ttlDays: 30 });
  const sheet = host.querySelector('.token-secret-sheet');
  reads(sheet, 'Northwind ordering bot: copy the secret now', 'This is the only time it is shown.', 'lwt_secret_once', 'Copy');
  pg.close();
});

test('the Usage card totals per token, company and programme, with a CSV of the same cells', async () => {
  const cells = (calls: number, renders: number) => ({ calls, renders, rendersByTool: [{ toolId: 'webinar-banner', format: 'svg', succeeded: renders, failed: 0, cancelled: 0 }], batches: { count: 0, rows: 0 }, deliveries: [],
    approvals: { open: 1, approved: 0, rejected: 0, withdrawn: 0 }, refusals: { RATE_LIMITED: 2, BUDGET_EXHAUSTED: 0, INPUT_LOCKED: 0, TOKEN_SCOPE: 0, FORBIDDEN: 0, other: 0 } });
  const pg = page({ 'GET /api/v1/programmes/resellers/usage': () => ({ programme: 'resellers', from: '2026-10-12', to: '2026-11-08', by: 'week',
    tokens: [{ id: 'tok_r', label: "Rita's agent", company: 'northwind', periods: [], totals: cells(13, 2) }],
    companies: [{ id: 'northwind', name: 'Northwind IT', totals: cells(13, 2) }], totals: cells(13, 2) }) });
  const host = pg.w.document.createElement('div');
  await pg.t.programmeUsage!(P, host);
  reads(host, "Rita's agent", 'Northwind IT', '13', '2', '1 open, 0 approved, 0 rejected', '2');
  reads(host, 'All of Northwind IT', 'All of Resellers, EMEA');
  reads(host, 'Renders by tool', 'webinar-banner', 'SVG', '2');
  reads(host, 'Turned away, by reason: RATE_LIMITED 2.');
  const csv = [...host.querySelectorAll('a')].find((a: any) => a.textContent === 'Download CSV');
  assert.match(csv.getAttribute('href'), /\/api\/v1\/programmes\/resellers\/usage\?from=.*&by=week&format=csv$/);
  assert.doesNotMatch(host.textContent, /null|undefined/);
  pg.close();
});

test('an agent\'s approval card says the file is its own render, and the actions print no "null"', async () => {
  const pg = page({ 'GET /api/v1/approvals/apr_1/artifact': () => ({}) });
  const card = pg.t.renderApprovalCard!({
    id: 'apr_1', subjectType: 'export-review', subjectRef: 'export-review:fp', title: 'Webinar banner, Northwind IT', chainId: 'brand', chainName: 'Partner review', state: 'in_review', stepIndex: 0,
    stepCount: 1, stepName: 'Brand team', stepRule: 'any', steps: [{ name: 'Brand team', rule: 'any', groups: ['brand'] }], nominees: [], nomineeNames: [], actions: [],
    createdBy: 'svc_tok_r', createdByName: "Northwind IT's agent (Rita's agent)", createdAt: 'x', mine: false, relation: 'inbox',
    exportReview: { apiVersion: 'work/export-review-v1', sha256: 'a'.repeat(64), size: 4, name: 'r.svg', format: 'svg', mediaType: 'image/svg+xml', preview: 'image', toolId: 'webinar-banner', toolVersion: '1.0.0',
      inputsDigest: 'd'.repeat(64), fingerprint: 'fp', origin: 'service-token', frozenAt: 'x', artifactUrl: '/api/v1/approvals/apr_1/artifact' },
  }, { actionable: true });
  pg.w.document.body.append(card);
  reads(card, 'An agent asked. This file is its own render, kept exactly as Lolly Work made it.');
  await until(() => card.querySelector('.appr-file-actions').textContent);
  reads(card.querySelector('.appr-file-actions'), 'Download');
  assert.doesNotMatch(card.querySelector('.appr-file-actions').textContent, /null/, 'no reviewed-file link, and no "null" in its place');
  pg.close();
});
