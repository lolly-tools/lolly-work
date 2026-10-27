// SPDX-License-Identifier: MPL-2.0
/**
 * The console's Feature flags view: group rules are added, changed and
 * removed through the one PUT that carries the whole record, managed AI shows
 * no group rules, and a configured flag service is shown with its state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

type Rule = { group: string; default: string | null; visibility: string | null };
type Flag = { id: string; label: string; info: null; builtinDefault: boolean; default: string | null; visibility: string; groupRules: boolean; groups: Rule[]; flagService: boolean; updatedAt: null };
const flag = (id: string, extra: Partial<Flag> = {}): Flag => ({
  id, label: id, info: null, builtinDefault: false, default: null, visibility: 'show', groupRules: id !== 'ai', groups: [], flagService: false, updatedAt: null, ...extra,
});

async function fixture(opts: { flags?: Flag[]; flagService?: unknown; groups?: string[] } = {}) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { runScripts: 'outside-only', url: 'https://work.test/admin#/instance?tab=flags' });
  const w = dom.window, calls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
  let flags = opts.flags ?? [flag('ai'), flag('export-preflight')];
  w.matchMedia = () => ({ matches: true }); w.HTMLElement.prototype.scrollIntoView = () => {};
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.fetch = async (path: string, options: { method?: string; body?: string } = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method ?? 'GET', body });
    if (path === '/api/v1/groups') return { ok: true, status: 200, json: async () => ({ groups: (opts.groups ?? ['pilot', 'print']).map((name) => ({ name })) }) };
    if (options.method === 'PUT') {
      const id = decodeURIComponent(path.split('/').pop()!);
      flags = flags.map((f) => (f.id === id ? { ...f, default: body.default, visibility: body.visibility, groups: (body.groups ?? f.groups).filter((r: Rule) => r.default || r.visibility) } : f));
    }
    return { ok: true, status: 200, json: async () => ({ flags, flagService: opts.flagService ?? null }) };
  };
  w.eval(`${source}\nwindow.helpers = {viewFeatureFlags}; route = () => {}; activityHeader = async () => null;`);
  const main = w.document.getElementById('app');
  await w.helpers.viewFeatureFlags(main);
  const card = (id: string) => [...main.querySelectorAll('[data-flag]')].find((c: { dataset: { flag: string } }) => c.dataset.flag === id) as HTMLElement;
  const puts = () => calls.filter((c) => c.method === 'PUT');
  return { dom, w, main, card, puts };
}

test('managed AI shows no group rules; other flags offer them with labelled controls', async () => {
  const p = await fixture();
  try {
    assert.equal(p.card('ai').querySelector('.flag-groups'), null);
    const groups = p.card('export-preflight').querySelector('.flag-groups') as HTMLDetailsElement;
    assert.ok(groups);
    assert.equal(groups.open, false, 'closed while there are no rules');
    for (const control of groups.querySelectorAll('form input, form select')) {
      assert.ok(groups.querySelector(`label[for="${control.id}"]`), `${control.outerHTML} has a label`);
    }
    // Known groups are offered as suggestions.
    assert.deepEqual([...groups.querySelectorAll('datalist option')].map((o: { value: string }) => o.value), ['pilot', 'print']);
  } finally { p.dom.window.close(); }
});

test('adding a group rule PUTs the whole record with the new rule, and refuses an empty or duplicate group', async () => {
  const p = await fixture({ flags: [flag('export-preflight', { default: 'off', visibility: 'hide' })] });
  try {
    let form = p.card('export-preflight').querySelector('.flag-groups form') as HTMLFormElement;
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true })); await pause();
    assert.equal(p.puts().length, 0);
    assert.match(p.card('export-preflight').querySelector('.flag-groups .form-err')!.textContent!, /Enter a group name/);

    const [def, vis] = form.querySelectorAll('select') as unknown as HTMLSelectElement[];
    (form.querySelector('input') as HTMLInputElement).value = 'pilot';
    def!.value = 'on'; vis!.value = 'show';
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true })); await pause();
    assert.deepEqual(p.puts()[0]!.body, { default: 'off', visibility: 'hide', groups: [{ group: 'pilot', default: 'on', visibility: 'show' }] });
    assert.equal(p.puts()[0]!.path, '/api/v1/policy/flags/export-preflight');

    // Re-rendered from the answer: the rule is listed and the disclosure is open.
    const groups = p.card('export-preflight').querySelector('.flag-groups') as HTMLDetailsElement;
    assert.equal(groups.open, true);
    assert.match(groups.querySelector('table')!.textContent!, /pilot/);
    assert.equal(p.w.document.activeElement, groups.querySelector('form input'), 'focus returns to the add field');

    form = groups.querySelector('form') as HTMLFormElement;
    (form.querySelector('input') as HTMLInputElement).value = 'pilot';
    form.dispatchEvent(new p.w.Event('submit', { cancelable: true })); await pause();
    assert.equal(p.puts().length, 1, 'a duplicate is refused before any request');
    assert.match(groups.querySelector('.form-err')!.textContent!, /already has a rule/);
  } finally { p.dom.window.close(); }
});

test('changing and removing a rule keeps the other rules and the instance settings', async () => {
  const p = await fixture({ flags: [flag('neurospicy', { builtinDefault: true, default: 'on', groups: [
    { group: 'calm', default: 'off', visibility: null }, { group: 'pilot', default: 'on', visibility: 'show' },
  ] })] });
  try {
    const rows = p.card('neurospicy').querySelectorAll('.flag-groups tbody tr');
    assert.equal(rows.length, 2);
    const [def, vis] = rows[0]!.querySelectorAll('select') as unknown as HTMLSelectElement[];
    assert.equal(def!.getAttribute('aria-label'), 'Default state for calm');
    vis!.value = 'hide'; vis!.dispatchEvent(new p.w.Event('change')); await pause();
    assert.deepEqual(p.puts()[0]!.body, { default: 'on', visibility: 'show', groups: [
      { group: 'calm', default: 'off', visibility: 'hide' }, { group: 'pilot', default: 'on', visibility: 'show' },
    ] });

    const remove = p.card('neurospicy').querySelector('button[aria-label="Remove the rule for pilot"]') as HTMLButtonElement;
    remove.click(); await pause();
    assert.deepEqual(p.puts()[1]!.body, { default: 'on', visibility: 'show', groups: [{ group: 'calm', default: 'off', visibility: 'hide' }] });

    // An instance-level change still carries the rules, so it cannot drop them.
    const instanceDefault = p.card('neurospicy').querySelector('select[aria-label="Default state for neurospicy"]') as HTMLSelectElement;
    instanceDefault.value = 'off'; instanceDefault.dispatchEvent(new p.w.Event('change')); await pause();
    assert.deepEqual(p.puts()[2]!.body, { default: 'off', visibility: 'show', groups: [{ group: 'calm', default: 'off', visibility: 'hide' }] });
  } finally { p.dom.window.close(); }
});

test('a configured flag service is shown with its state, and the flags it decides are marked', async () => {
  const p = await fixture({
    flags: [flag('export-preflight', { flagService: true }), flag('jelly-effects')],
    flagService: { origin: 'https://flags.example.org', flags: ['export-preflight'], requests: 12, errors: 2,
      lastSuccessAt: '2026-10-27T10:00:00.000Z', lastError: { at: '2026-10-27T10:05:00.000Z', flag: 'export-preflight', reason: 'timeout' } },
  });
  try {
    const text = p.main.textContent!;
    assert.match(text, /Flag service/);
    assert.match(text, /https:\/\/flags\.example\.org decides the default of one flag/);
    assert.match(text, /Not answering/);
    assert.match(text, /export-preflight: timeout/);
    assert.match(p.card('export-preflight').textContent!, /Flag service decides/);
    assert.doesNotMatch(p.card('jelly-effects').textContent!, /Flag service decides/);
  } finally { p.dom.window.close(); }
});

test('without a flag service there is no service card', async () => {
  const p = await fixture();
  try {
    assert.doesNotMatch(p.main.textContent!, /Flag service/);
  } finally { p.dom.window.close(); }
});
