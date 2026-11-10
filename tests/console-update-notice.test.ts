// SPDX-License-Identifier: MPL-2.0
/**
 * The console's release notice (console/update-notice.js), in jsdom: the Overview
 * banner for owners and admins with its flags, migration warning, highlights and
 * copyable steps; dismissal for one version; nothing for members, who are never
 * asked about; and This deployment's release card with Check now.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
// The module keeps its own scope, as it does in the browser; its exports become the
// names app.js imports.
const notice = `const { releaseCard, shouldShowBanner, updateNotice } = (() => {
${readFileSync(new URL('../console/update-notice.js', import.meta.url), 'utf8').replace(/^export /gm, '')}
return { releaseCard, shouldShowBanner, updateNotice };
})();`;
const app = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const textOf = (node: any) => node.textContent.replace(/\s+/g, ' ').trim();

const STEPS = [
  { id: 'backup', title: 'Take a verified backup', detail: 'This upgrade migrates the database.', doc: { page: 'operations', anchor: 'backup-and-restore' } },
  { id: 'verify', title: 'Check the chart’s signature', optional: true, detail: 'The chart is signed.', command: 'cosign verify-blob --bundle lolly-work-1.3.1.tgz.sigstore.json \\\n  lolly-work-1.3.1.tgz' },
  { id: 'upgrade', title: 'Upgrade to 1.3.1', detail: 'Prefer -f over --reuse-values.', command: 'helm upgrade lolly-work lolly-work/lolly-work -n lolly --version 1.3.1 -f <your-values.yaml>' },
];
const UPDATES = {
  check: true, channel: 'stable', feed: 'https://github.com',
  status: 'ok', checkedAt: new Date(Date.now() - 3_600_000).toISOString(), attemptedAt: null, error: null,
  current: { version: '1.2.0', chartVersion: '1.2.0' }, latest: '1.3.1', newer: 2, security: true, migrates: true, migrationCount: 2,
  releases: [
    { version: '1.3.1', created: '2026-12-02T10:15:00.000Z', prerelease: false, security: true, migrations: 2, migrationClasses: { additive: 2, maintenance: 0 },
      notesUrl: 'https://github.com/lolly-tools/lolly-work/releases/tag/v1.3.1',
      changes: [{ kind: 'security', description: 'Session cookies are refused on plain HTTP.' }, { kind: 'added', description: '<img src=x onerror="window.pwned=1"> is text.' }] },
    { version: '1.3.0', created: '2026-11-20T09:00:00.000Z', prerelease: false, security: false, migrations: 0, migrationClasses: { additive: 0, maintenance: 0 },
      notesUrl: null, changes: [{ kind: 'changed', description: 'Image tags follow 1.3.0.' }] },
  ],
  install: { route: 'helm', release: 'lolly-work', namespace: 'lolly', deployment: 'lolly-work', repository: 'https://github.com/lolly-tools/lolly-work/releases/download/helm-index' },
  steps: STEPS,
};
const CURRENT = { ...UPDATES, latest: null, newer: 0, security: false, migrates: false, migrationCount: 0, releases: [], steps: [] };

function page(opts: { actions?: string[]; updates?: unknown; afterCheck?: unknown } = {}) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/overview', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const copied: string[] = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async (t: string) => { copied.push(t); } }, configurable: true });
  const calls: Array<{ path: string; method: string }> = [];
  w.fetch = async (path: string, init: { method?: string } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ path, method });
    const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    if (path === '/api/v1/admin/updates') return json(200, opts.updates ?? UPDATES);
    if (path === '/api/v1/admin/updates/check' && method === 'POST') return json(200, opts.afterCheck ?? UPDATES);
    if (path === '/api/v1/telemetry/summary') return json(200, { days: [{ date: '2026-11-10', events: 1, exports: 0, users: 1 }], totals: { activeUsers: 1 }, topTools: [], formats: [] });
    return json(404, { error: { message: 'nope' } });
  };
  w.eval(`${notice}\n${app}
window.helpers = { viewOverview, releaseCard, updateDeps, setSession: (s) => { session = s; } };`);
  w.helpers.setSession({ kind: 'member', user: { role: 'owner' }, console: { actions: opts.actions ?? ['fleet.view', 'telemetry.view'], views: {} } });
  return { w, calls, copied, main: w.document.getElementById('app'), helpers: w.helpers };
}

test('the Overview shows owners and admins a newer release with its flags, migration warning, highlights and steps', async () => {
  const p = page();
  await p.helpers.viewOverview(p.main);
  const card = p.main.querySelector('.update-notice');
  assert.ok(card, 'the banner is on the Overview');
  assert.equal(textOf(card.querySelector('h2')), 'Lolly Work 1.3.1 is available. You run 1.2.0.');
  assert.ok(card.classList.contains('is-security'));
  const flags = [...card.querySelectorAll('.update-flags .chip')].map(textOf);
  assert.deepEqual(flags, ['Security', 'Migrates the database', '2 newer releases']);
  const warning = card.querySelector('.update-migrate');
  assert.match(textOf(warning), /This upgrade migrates the database \(2 migrations\)/);
  assert.equal(warning.querySelector('a').getAttribute('href'), '#/docs?doc=operations&anchor=backup-and-restore');
  assert.deepEqual([...card.querySelectorAll('.update-highlights h3')].map(textOf), ['Highlights', 'Also in 1.3.0']);
  assert.equal(p.w.pwned, undefined, 'a highlight is text, never markup');
  assert.equal(card.querySelector('img'), null);
  const notes = [...card.querySelectorAll('a')].find((a: any) => textOf(a) === 'Release notes') as any;
  assert.equal(notes.getAttribute('href'), 'https://github.com/lolly-tools/lolly-work/releases/tag/v1.3.1');
  assert.equal(notes.getAttribute('rel'), 'noopener noreferrer');
  const steps = card.querySelector('details.update-steps');
  assert.equal(textOf(steps.querySelector('summary')), 'Upgrade steps for Helm');
  assert.equal(steps.hasAttribute('open'), false, 'collapsed on the Overview');
  assert.deepEqual([...steps.querySelectorAll('li.update-step')].map((li: any) => li.dataset.step), ['backup', 'verify', 'upgrade']);
  assert.deepEqual([...steps.querySelectorAll('li[data-step="upgrade"] code')].map(textOf), ['-f', '--reuse-values'], 'flags in a sentence read as code');
  // Copy takes the command exactly as written.
  const copy = [...steps.querySelectorAll('li[data-step="upgrade"] button')].find((b: any) => textOf(b) === 'Copy') as any;
  copy.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(p.copied, ['helm upgrade lolly-work lolly-work/lolly-work -n lolly --version 1.3.1 -f <your-values.yaml>']);
  assert.match(textOf(card.querySelector('.update-checked')), /Checked 1h ago from github\.com\. The release feed is not signed, so this notice is information only\./);
});

test('dismissing hides that version; a newer one shows again', async () => {
  const p = page();
  await p.helpers.viewOverview(p.main);
  const dismiss = [...p.main.querySelectorAll('.update-notice button')].find((b: any) => textOf(b) === 'Dismiss for 1.3.1') as any;
  dismiss.click();
  assert.equal(p.main.querySelector('.update-notice'), null);
  assert.equal(p.w.localStorage.getItem('lw-update-dismissed'), '1.3.1');
  p.main.replaceChildren();
  await p.helpers.viewOverview(p.main);
  assert.equal(p.main.querySelector('.update-notice'), null, 'stays dismissed for 1.3.1');

  const newer = page({ updates: { ...UPDATES, latest: '1.3.2', newer: 3, releases: [{ ...UPDATES.releases[0], version: '1.3.2' }, ...UPDATES.releases] } });
  newer.w.localStorage.setItem('lw-update-dismissed', '1.3.1');
  await newer.helpers.viewOverview(newer.main);
  assert.equal(newer.main.querySelector('.update-notice')?.dataset.version, '1.3.2');
});

test('members never see the notice and the console never asks for it on their behalf', async () => {
  const p = page({ actions: ['telemetry.view'] });
  await p.helpers.viewOverview(p.main);
  assert.equal(p.main.querySelector('.update-notice'), null);
  assert.ok(!p.calls.some((c) => c.path.startsWith('/api/v1/admin/updates')), 'no request without fleet.view');
});

test('This deployment: the newest release, Check now, and the notice with its steps open', async () => {
  const p = page({ updates: CURRENT, afterCheck: UPDATES });
  const card = p.helpers.releaseCard(CURRENT, p.helpers.updateDeps());
  p.main.append(card);
  assert.equal(textOf(card.querySelector('h2')), 'You run Lolly Work 1.2.0, the newest stable release.');
  const check = [...card.querySelectorAll('button')].find((b: any) => textOf(b) === 'Check now') as any;
  check.click();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(p.calls.some((c) => c.path === '/api/v1/admin/updates/check' && c.method === 'POST'));
  const notice = card.querySelector('.update-notice');
  assert.ok(notice, 'the check found 1.3.1');
  assert.ok(notice.querySelector('details.update-steps').hasAttribute('open'), 'steps open on This deployment');
  assert.ok([...notice.querySelectorAll('button')].some((b: any) => textOf(b) === 'Check now'));
  assert.ok(![...notice.querySelectorAll('button')].some((b: any) => /^Dismiss/.test(textOf(b))), 'no dismissal here');
});

test('checks off, never run or failing each say so; an unsafe notes link is never an href', () => {
  const p = page();
  const deps = p.helpers.updateDeps();
  const off = p.helpers.releaseCard({ ...CURRENT, check: false, status: 'off', checkedAt: null }, deps);
  assert.match(textOf(off), /Release checks are off in this deployment’s configuration \(updates\.check\)/);
  assert.equal(off.querySelector('button'), null, 'no Check now when checks are off');
  const never = p.helpers.releaseCard({ ...CURRENT, status: 'never', checkedAt: null }, deps);
  assert.match(textOf(never), /Not checked yet/);
  const failed = p.helpers.releaseCard({ ...CURRENT, status: 'failed', error: 'refused' }, deps);
  assert.match(textOf(failed), /the address is not allowed by this deployment’s network policy/);
  const hostile = p.helpers.releaseCard({ ...UPDATES, releases: [{ ...UPDATES.releases[0], notesUrl: 'javascript:alert(1)' }, UPDATES.releases[1]] }, deps);
  assert.ok(![...hostile.querySelectorAll('a')].some((a: any) => /^javascript:/i.test(a.getAttribute('href') ?? '')));
});
