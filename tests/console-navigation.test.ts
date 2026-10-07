// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');

function page() {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/users', runScripts: 'outside-only' });
  const w = dom.window;
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.eval(`${source}\nwindow.helpers = { consoleNavigation, sectionTabs, el, setSession: s => { session = s; } };`);
  return { dom, w, helpers: w.helpers };
}

test('task navigation and its mobile picker expose only permitted sections; search finds direct provider access', async () => {
  const p = page();
  try {
    const views = Object.fromEntries(['overview', 'projects', 'users', 'contractors', 'catalog', 'providers', 'tools', 'injectables', 'approvals', 'chains', 'grants', 'tokens', 'activity', 'rooms', 'links', 'messages', 'audit', 'fleet', 'instance', 'setup', 'preview', 'docs'].map(id => [id, ['users', 'providers'].includes(id)]));
    p.helpers.setSession({ console: { views, actions: [] } });
    const nav = p.helpers.consoleNavigation('users'); p.w.document.body.append(nav);
    assert.deepEqual([...nav.querySelectorAll('a')].map((a: any) => a.textContent), ['People', 'Providers']);
    assert.deepEqual([...nav.querySelectorAll('option')].map((o: any) => o.value), ['users', 'providers']);
    assert.equal(nav.querySelector('[aria-current=page]').textContent, 'People');
    const search = nav.querySelector('input');
    search.value = 'assets'; search.dispatchEvent(new p.w.Event('input'));
    assert.equal(nav.querySelector('a[href="#/users"]').hidden, true);
    assert.equal(nav.querySelector('a[href="#/providers"]').hidden, false, 'a task-group name also matches its sections');
    const navigated = new Promise<void>(resolve => {
      p.w.addEventListener('hashchange', () => resolve(), { once: true });
    });
    search.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter' }));
    await navigated;
    assert.equal(p.w.location.hash, '#/providers');
    search.value = 'no such section'; search.dispatchEvent(new p.w.Event('input'));
    assert.equal(nav.querySelector('.nav-empty').hidden, false);
    search.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(search.value, '');
    assert.equal(nav.querySelector('.nav-empty').hidden, true);
    assert.equal(nav.querySelector('a[href="#/users"]').hidden, false);
  } finally { p.dom.window.close(); }
});

test('task panels keep edited controls and selection; keyboard activation and counts remain accessible', () => {
  const p = page();
  try {
    const input = p.helpers.el('input', { value: 'Unsaved draft' });
    const check = p.helpers.el('input', { type: 'checkbox', checked: 'checked' });
    const tabs = p.helpers.sectionTabs('Accounts', [
      { id: 'directory', label: 'Directory', content: input },
      { id: 'requests', label: 'Requests', content: check, count: 2 },
    ]);
    p.w.document.body.append(tabs.element);
    const buttons = [...tabs.element.querySelectorAll('[role=tab]')] as any[];
    input.value = 'Changed draft';
    buttons[0].dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    assert.equal(p.w.document.activeElement, buttons[1]);
    assert.equal(buttons[1].getAttribute('aria-selected'), 'true');
    assert.equal(tabs.element.querySelector('#accounts-directory').hidden, true);
    assert.equal(check.checked, true);
    tabs.setCount('requests', 1); assert.equal(buttons[1].textContent, 'Requests 1');
    tabs.setCount('requests', 0); assert.equal(buttons[1].querySelector('.tab-count').hidden, true);
    buttons[1].dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Home', cancelable: true }));
    assert.equal(p.w.document.activeElement, buttons[0]);
    assert.equal(input.value, 'Changed draft');
    assert.equal(buttons[0].getAttribute('aria-controls'), 'accounts-directory');
    assert.equal(tabs.element.querySelector('#accounts-directory').getAttribute('aria-labelledby'), buttons[0].id);
  } finally { p.dom.window.close(); }
});
