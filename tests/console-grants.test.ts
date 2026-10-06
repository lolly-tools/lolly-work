// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
async function fixture(grants: unknown[] = []) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { runScripts: 'outside-only', url: 'https://work.test/admin#/grants' });
  const w = dom.window, calls: Array<{path: string; body?: unknown}> = [];
  w.matchMedia = () => ({ matches: true }); w.HTMLElement.prototype.scrollIntoView = () => {};
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.fetch = async (path: string, options: {body?: string} = {}) => {
    calls.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
    return { ok: true, status: 200, json: async () => path === '/api/v1/grants' ? { grants } : {} };
  };
  w.eval(`${source}\nwindow.helpers = {viewGrants}; route = () => {window.routed = true;}; activityHeader = async () => null;`);
  const main = w.document.getElementById('app'); await w.helpers.viewGrants(main);
  const form = main.querySelector('form'), selects = form.querySelectorAll('select'), inputs = form.querySelectorAll('input');
  return { dom, w, main, form, kind: selects[0], effect: selects[1], name: inputs[0], action: inputs[1], resource: inputs[2], calls };
}

test('grant authoring names accounts and groups clearly, previews the exact rule and submits its existing API contract', async () => {
  const p = await fixture();
  try {
    p.kind.value = 'user'; p.kind.dispatchEvent(new p.w.Event('change'));
    assert.equal(p.form.querySelector(`label[for="${p.name.id}"]`).textContent, 'Account ID');
    p.name.value = 'usr_ana'; p.action.value = 'tool.use'; p.resource.value = 'tool:design'; p.effect.value = 'allow';
    p.effect.dispatchEvent(new p.w.Event('input'));
    assert.ok(p.form.querySelector('.grant-preview').textContent.includes('Allow tool.use for person usr_ana, on tool:design.'));
    p.form.dispatchEvent(new p.w.Event('submit', {cancelable: true})); await pause();
    assert.deepEqual(p.calls.find(c => c.body)?.body, {principal: 'user:usr_ana', action: 'tool.use', resource: 'tool:design', effect: 'allow'});
    assert.equal(p.w.routed, true);
  } finally { p.dom.window.close(); }
});

test('everyone hides the irrelevant target field; custom actions still require deliberate confirmation', async () => {
  const p = await fixture();
  try {
    p.kind.value = '*'; p.kind.dispatchEvent(new p.w.Event('change'));
    assert.equal(p.name.disabled, true); assert.equal(p.name.parentElement.hidden, true);
    p.action.value = 'brand.switch'; p.action.dispatchEvent(new p.w.Event('input'));
    p.form.dispatchEvent(new p.w.Event('submit', {cancelable: true})); await pause();
    assert.equal(p.calls.filter(c => c.body).length, 0);
    assert.ok(p.form.querySelector('.form-err').textContent.includes('press Add grant again'));
    p.form.dispatchEvent(new p.w.Event('submit', {cancelable: true})); await pause();
    assert.deepEqual(p.calls.find(c => c.body)?.body, {principal: '*', action: 'brand.switch', resource: '*', effect: 'deny'});
  } finally { p.dom.window.close(); }
});

test('existing grants lead the view; Add grant reveals and focuses the composer without losing its draft', async () => {
  const p = await fixture([{ principal: 'group:brand', action: 'tool.use', resource: '*', effect: 'allow' }]);
  try {
    const composer = p.main.querySelector('.grant-compose'); assert.equal(composer.open, false);
    p.main.querySelector('.page-action').click(); assert.equal(composer.open, true); assert.equal(p.w.document.activeElement, p.kind);
    p.name.value = 'draft'; composer.open = false; p.main.querySelector('.page-action').click(); assert.equal(p.name.value, 'draft');
    p.name.value = ''; p.form.dispatchEvent(new p.w.Event('submit', {cancelable: true})); await pause();
    assert.equal(p.w.document.activeElement, p.name); assert.equal(p.name.getAttribute('aria-invalid'), 'true');
    assert.equal(p.calls.filter(c => c.body).length, 0);
  } finally { p.dom.window.close(); }
});
