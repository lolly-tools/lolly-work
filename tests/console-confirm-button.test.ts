// SPDX-License-Identifier: MPL-2.0
/**
 * The console's two-step confirm button (armConfirmButton in console/app.js),
 * in jsdom with the arm timer under the test's control.
 *
 * Reported on lolly.ing, 2026-10-27: on #/grants, "Delete" became "Really
 * delete?", then a later activation only armed it again, so delete looked
 * broken. The arm had lapsed while assistive tech, and anything else reading
 * the page, was still told "Really delete? Activate again to confirm." These
 * tests hold the rule that the label, the accessible name, the armed attribute
 * and the live region always agree with what the button will do next.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const GRANT = { principal: 'group:brand', action: 'export.download', resource: '*', effect: 'deny' };

function harness() {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div><button id="elsewhere">Elsewhere</button>',
    { runScripts: 'outside-only', url: 'https://work.test/admin#/grants' });
  const w = dom.window;
  // Timers the test advances by hand: nothing lapses unless the test says so.
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;
  w.setTimeout = (fn: () => void, ms = 0) => { timers.set(++seq, { fn, ms }); return seq; };
  w.clearTimeout = (id: number) => { timers.delete(id); };
  const elapse = (ms: number) => {
    for (const [id, t] of [...timers]) if (t.ms <= ms) { timers.delete(id); t.fn(); }
  };
  w.requestAnimationFrame = (fn: () => void) => { fn(); return 0; };
  w.matchMedia = () => ({ matches: true });
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  let releaseDelete: () => void = () => {};
  w.fetch = async (path: string, opts: { method?: string; body?: string } = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (method === 'DELETE') await new Promise<void>((resolve) => { releaseDelete = resolve; });
    return { ok: true, status: 200, json: async () => (path === '/api/v1/grants' ? { grants: [GRANT] } : {}) };
  };
  w.eval(`${source}
window.helpers = { armConfirmButton, viewGrants, CONFIRM_ARM_MS };
route = () => { window.routed = (window.routed ?? 0) + 1; };
activityHeader = async () => null;`);
  const doc = w.document;
  const live = () => doc.getElementById('live').textContent;
  return { dom, w, doc, helpers: w.helpers, calls, elapse, live, release: () => releaseDelete() };
}

test('#/grants: a lapsed arm puts "Delete" back, says nothing changed, and the next activation arms again', async () => {
  const h = harness();
  try {
    const main = h.doc.getElementById('app');
    await h.helpers.viewGrants(main);
    const del = main.querySelector('button.danger');
    assert.equal(del.textContent, 'Delete');

    del.click();
    assert.equal(del.textContent, 'Really delete?');
    assert.equal(del.dataset.armed, 'true');
    assert.equal(h.live(), 'Really delete? Activate again to confirm.');

    h.elapse(h.helpers.CONFIRM_ARM_MS - 1);
    assert.equal(del.dataset.armed, 'true', 'still armed inside the window');

    h.elapse(h.helpers.CONFIRM_ARM_MS);
    assert.equal(del.textContent, 'Delete', 'the label goes back when the arm lapses');
    assert.equal(del.dataset.armed, undefined);
    assert.equal(h.live(), 'Delete not confirmed. Nothing changed.', 'the lapse replaces the stale prompt');

    del.click();
    assert.equal(h.calls.filter((c) => c.method === 'DELETE').length, 0, 'an activation after a lapse arms, it does not delete');
    assert.equal(del.textContent, 'Really delete?');

    del.click();
    assert.deepEqual(h.calls.filter((c) => c.method === 'DELETE').map((c) => c.body), [GRANT]);
    assert.equal(del.textContent, 'Delete', 'a running delete no longer shows the prompt it would not accept');
    assert.equal(del.dataset.armed, undefined);
    assert.equal(del.getAttribute('aria-busy'), 'true');
    assert.equal(h.live(), '', 'the answered prompt leaves the live region');

    h.release(); await settle(); await settle();
    assert.equal(h.w.routed, 1, 'the view re-renders once the delete lands');
  } finally { h.dom.window.close(); }
});

test('keyboard: Escape and moving focus away end the arm, and a compact action keeps its accessible name in step', () => {
  const h = harness();
  try {
    let confirmed = 0;
    const btn = h.helpers.armConfirmButton({}, 'Revoke', 'Really revoke?', () => { confirmed++; });
    btn.setAttribute('aria-label', 'Revoke'); // as the icon-only invitation actions do
    h.doc.body.append(btn);
    btn.focus();

    btn.click(); // Enter or Space on a focused button
    assert.equal(btn.getAttribute('aria-label'), 'Really revoke?');

    const esc = new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    btn.dispatchEvent(esc);
    assert.equal(esc.defaultPrevented, true, 'Escape is consumed by the arm, not a surrounding dialog');
    assert.equal(btn.textContent, 'Revoke');
    assert.equal(btn.getAttribute('aria-label'), 'Revoke');
    assert.equal(h.live(), 'Revoke not confirmed. Nothing changed.');
    assert.equal(h.doc.activeElement, btn, 'focus stays put');

    const idleEsc = new h.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    btn.dispatchEvent(idleEsc);
    assert.equal(idleEsc.defaultPrevented, false, 'an idle button leaves Escape to the page');

    btn.click();
    h.doc.getElementById('elsewhere').focus();
    assert.equal(btn.textContent, 'Revoke', 'tabbing away ends the arm');
    assert.equal(btn.dataset.armed, undefined);
    assert.equal(confirmed, 0);
  } finally { h.dom.window.close(); }
});

test('while the confirmed action runs the button ignores activations; a failure resets quietly for the caller to report', async () => {
  const h = harness();
  try {
    let runs = 0, finish: () => void = () => {};
    const btn = h.helpers.armConfirmButton({ class: 'danger' }, 'Reject', 'Really reject?',
      () => { runs++; return new Promise<void>((resolve) => { finish = resolve; }); });
    h.doc.body.append(btn);
    btn.click(); btn.click();
    assert.equal(runs, 1);
    btn.click();
    assert.equal(runs, 1, 'no second run while the first is in flight');
    assert.equal(btn.dataset.armed, undefined, 'and no re-arm either');
    finish(); await settle();
    assert.equal(btn.hasAttribute('aria-busy'), false);
    assert.equal(btn.textContent, 'Reject');

    const failing = h.helpers.armConfirmButton({}, 'Remove', 'Really remove?', (disarm: () => void) => { disarm(); });
    h.doc.body.append(failing);
    failing.click(); failing.click(); await settle();
    assert.equal(failing.textContent, 'Remove');
    assert.doesNotMatch(h.live(), /not confirmed/, 'disarm() after a failure is not a lapse');

    const removed = h.helpers.armConfirmButton({}, 'Forget', 'Really forget?', () => {});
    h.doc.body.append(removed);
    removed.click(); removed.remove();
    h.elapse(h.helpers.CONFIRM_ARM_MS);
    assert.equal(removed.textContent, 'Forget');
    assert.equal(h.live(), 'Really forget? Activate again to confirm.', 'a button a re-render removed announces nothing');
  } finally { h.dom.window.close(); }
});
