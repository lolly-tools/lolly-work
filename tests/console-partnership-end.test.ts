// SPDX-License-Identifier: MPL-2.0
/**
 * The console's End card and an end's states (plans/82 M5, W-M5-4), in jsdom:
 *
 *  - the dry run shows one table per kind, people with their "stays" and "cannot be
 *    ended" rows, and names the kinds with nothing in them in one line;
 *  - a date makes the button schedule the end and says who is told; a domain ends now;
 *  - a scheduled end shows its date with Change and Cancel;
 *  - an ended company reads "Ended on <day> by <name>" with Reopen while offered and
 *    the receipt below, and says when Reopen is no longer offered.
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

const DRY = {
  dryRun: true, projects: 'team-readonly', transferTo: { id: 'u-bruno', email: 'bruno@suse.example' },
  accounts: [{ id: 'u-rita', name: 'Rita Ortiz', email: 'rita@northwind.example', disabled: false, projects: [{ id: 'p1', name: 'Northwind data sheets' }], links: 2 }],
  stays: [{ id: 'u-pat', name: 'Pat Lee', email: 'pat@northwind.example', disabled: false, stays: ['ISV partners'] }],
  cannotEnd: [{ id: 'u-big', name: 'big@northwind.example', email: 'big@northwind.example', disabled: false, links: 0, reason: 'too many rows to end in one step' }],
  skipped: [], pendingInvitations: [], domainRules: [{ domain: 'northwind.example', programme: { id: 'resellers', name: 'Resellers, EMEA' }, company: { id: 'northwind', name: 'Northwind IT' } }],
  tokens: [{ id: 'tok_1', label: "Rita's agent" }], templates: [{ id: 'inst/a', name: 'Northwind data sheet', action: 'retire' }, { id: 'inst/b', name: 'Shared price list', action: 'narrow', keeps: ['company-globex'] }],
  folders: [{ provider: 'dam', path: 'Partners/Northwind', company: 'northwind' }], rightsChoices: [], rowBound: 1000,
  limits: { rowBound: 1000, reopenDays: 30, noticeDaysBefore: [14, 1], email: false, sweepSeconds: 60 },
};

function page(routes: Record<string, (body: any) => unknown>) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/programmes', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const calls: Array<{ path: string; method: string; body?: any }> = [];
  w.fetch = async (path: string, init: { method?: string; body?: string } = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method ?? 'GET', ...(body ? { body } : {}) });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    const value = key ? routes[key]!(body) : {};
    return { ok: true, status: 200, headers: new w.Headers({ 'content-type': 'application/json' }), json: async () => value, text: async () => JSON.stringify(value) };
  };
  w.eval(`${source}; window.t = { endPartnershipCard, exitDryRunTables, partnershipState };`);
  return { w, calls, t: w.t as { endPartnershipCard: Function; exitDryRunTables: Function; partnershipState: Function }, close: () => dom.window.close() };
}
const P = { id: 'resellers', name: 'Resellers, EMEA', team: 'marketing' };
const text = (node: any) => node.textContent!.replace(/\s+/g, ' ');
/** Each part, in order, in the node's text. textContent runs elements together, so the parts are matched without spaces between them. */
const reads = (node: any, ...parts: string[]) => {
  const all = text(node);
  let at = 0;
  for (const part of parts) { const i = all.indexOf(part, at); assert.ok(i >= 0, `"${part}" after ${at} in: ${all}`); at = i + part.length; }
};
// The day as this runtime's locale writes it, as the console does.
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

test('the dry run is one table per kind, and empty kinds are named in one line', () => {
  const pg = page({});
  const box = pg.w.document.createElement('div');
  box.append(...pg.t.exitDryRunTables(DRY, P, [{ id: 'northwind', name: 'Northwind IT' }]));
  const titles = [...box.querySelectorAll('h4')].map((h) => h.textContent);
  assert.deepEqual(titles, ['People (3)', 'Projects (1)', 'Share links (1)', 'Agent tokens (1)', 'Templates to retire (2)', 'Folders (1)', 'Domain rules (1)']);
  reads(box, 'Rita Ortiz', 'rita@northwind.example', 'Access ends');
  reads(box, 'Pat Lee', 'pat@northwind.example', 'Stays', 'Still in ISV partners');
  reads(box, 'Cannot be ended', 'too many rows to end in one step');
  assert.match(text(box), /Stays published to company-globex only/);
  assert.match(text(box), /Everyone at Northwind IT/, 'a folder names its company');
  assert.match(text(box), /Nothing to end among licence choices to withdraw, open invitations\./);
  assert.doesNotMatch(text(box), /null|undefined/);
  pg.close();
});

test('a date schedules the end and says who is told; a domain ends now', async () => {
  const pg = page({ '/api/v1/programmes/exit': (body) => ({ ...DRY, ...(body.at ? { endsAt: `${body.at}T23:59:59.999Z`, notice: body.notice } : {}) }) });
  const card = pg.t.endPartnershipCard(P, { companies: [{ id: 'northwind', name: 'Northwind IT' }], domains: [{ domain: 'northwind.example' }], reload: () => {} });
  pg.w.document.body.append(card);
  const who = card.querySelector('select[aria-label="Whose access ends"]');
  who.value = 'company:northwind'; who.dispatchEvent(new pg.w.Event('change'));
  const dateRadio = card.querySelector('input[type=radio][value=date]');
  dateRadio.checked = true; dateRadio.dispatchEvent(new pg.w.Event('change'));
  const date = card.querySelector('input[aria-label="End date"]');
  assert.equal(date.disabled, false);
  date.value = '2026-11-30';
  [...card.querySelectorAll('button')].find((b: any) => b.textContent === 'See what ending it does').click();
  await until(() => card.querySelector('.exit-kind'));
  assert.deepEqual(pg.calls.at(-1)!.body, { company: 'northwind', projects: 'team-readonly', at: '2026-11-30', notice: true });
  reads(card, `Schedule the end for ${day('2026-11-30T23:59:59.999Z')}`);
  assert.match(text(card), /They are told 14 days and 1 day before the end, in their inbox\./);
  // A domain is ended now: the date option goes, and so does the date from the request.
  who.value = 'domain:northwind.example'; who.dispatchEvent(new pg.w.Event('change'));
  assert.equal(dateRadio.disabled, true);
  assert.equal(card.querySelector('input[type=radio][value=now]').checked, true);
  pg.close();
});

const exits = (extra: Record<string, unknown>) => ({
  programme: 'resellers', reopenDays: 30, exits: [
    { id: 'pex_s', state: 'scheduled', selection: { company: 'northwind' }, company: 'northwind', createdAt: 'x', createdBy: { id: 'u', name: 'Bruno Marsh' }, endsAt: '2026-11-30T23:59:59.999Z', notice: true, projects: 'team-readonly', reopen: { offered: false, days: 30 } },
    { id: 'pex_d', state: 'done', selection: { company: 'globex' }, company: 'globex', createdAt: 'x', createdBy: { id: 'u', name: 'Bruno Marsh' }, doneAt: '2026-11-08T10:00:00.000Z',
      counts: { ended: 1, stays: 0, notEnded: 0, invitations: 0, tokens: 1, templates: 1, folders: 0, domainRules: 0, rightsChoices: 0, projects: 1 }, reopen: { offered: true, until: '2026-12-08T10:00:00.000Z', days: 30 }, ...extra },
  ],
});

test('a scheduled end shows its date with Change and Cancel', async () => {
  const pg = page({ '/api/v1/programmes/resellers/exits': () => exits({}) });
  const host = pg.w.document.createElement('div');
  await pg.t.partnershipState(P, host, { company: { id: 'northwind', name: 'Northwind IT' }, reload: () => {} });
  const block = host.querySelector('[data-exit-state="scheduled"]');
  assert.ok(block);
  reads(block, 'Scheduled', `Northwind IT ends on ${day('2026-11-30T23:59:59.999Z')}`);
  assert.match(text(block), /Set by Bruno Marsh/);
  const buttons = [...block.querySelectorAll('button')].map((b: any) => b.textContent);
  assert.ok(buttons.includes('Change') && buttons.includes('Cancel the end'), String(buttons));
  assert.equal(host.querySelector('[data-exit-state="ended"]'), null, 'nothing has ended for Northwind');
  pg.close();
});

test('an ended company reads when and who, offers Reopen while it may, and keeps the receipt', async () => {
  const pg = page({ '/api/v1/programmes/resellers/exits': () => exits({}) });
  const host = pg.w.document.createElement('div');
  await pg.t.partnershipState(P, host, { company: { id: 'globex', name: 'Globex', endedAt: '2026-11-08T10:00:00.000Z', endedExit: 'pex_d' }, reload: () => {} });
  const block = host.querySelector('[data-exit-state="ended"]');
  reads(block, 'Ended', ` on ${day('2026-11-08T10:00:00.000Z')} by Bruno Marsh`);
  reads(block, `Reopen puts back what this end took, until ${day('2026-12-08T10:00:00.000Z')}.`);
  assert.ok([...block.querySelectorAll('button')].some((b: any) => b.textContent === 'Reopen'));
  reads(block, 'Receipt', 'Access ended', '1', 'Projects moved', '1', 'Agent tokens revoked', '1', 'Templates retired', '1');
  // Past the window, Reopen is not offered and the page says what to do instead.
  const late = page({ '/api/v1/programmes/resellers/exits': () => exits({ reopen: { offered: false, days: 30 } }) });
  const host2 = late.w.document.createElement('div');
  await late.t.partnershipState(P, host2, { company: { id: 'globex', name: 'Globex', endedAt: '2026-11-08T10:00:00.000Z', endedExit: 'pex_d' }, reload: () => {} });
  assert.ok(![...host2.querySelectorAll('button')].some((b: any) => b.textContent === 'Reopen'));
  assert.match(text(host2), /Reopen was offered for 30 days after the end\. Add the people again by list\./);
  pg.close(); late.close();
});
