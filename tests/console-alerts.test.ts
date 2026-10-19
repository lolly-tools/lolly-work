// SPDX-License-Identifier: MPL-2.0
/**
 * The console's alert banner in jsdom (plan 80 section 10): a person who can
 * read the overview gets the server's alerts above the view, asked for at most
 * once a minute; anyone else never asks. The banner survives a view replacing
 * its own children, and the server's words stay text.
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

const ALERT = {
  id: 'blob-offload-stored', kind: 'stored', level: 'warning', month: '2026-10', value: 11, threshold: 10,
  title: 'Blob storage has reached the offload threshold',
  detail: 'PostgreSQL holds <b>11.0 GiB</b> of project files and assets.',
  href: '#/docs?doc=operations&anchor=blob-offload-trigger',
};

function page(actions: string[]) {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/projects', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  const calls: string[] = [];
  w.fetch = async (path: string) => {
    calls.push(path);
    const json = (status: number, data: unknown) => ({ ok: status < 400, status, json: async () => data });
    return path === '/api/v1/alerts' ? json(200, { alerts: [ALERT] }) : json(404, { error: { message: 'nope' } });
  };
  w.eval(`${source}
window.helpers = { deploymentAlerts, showAlertBanner, setSession: (s) => { session = s; } };`);
  w.helpers.setSession({ kind: 'member', user: { role: 'admin' }, console: { actions, views: {} } });
  const main = w.document.createElement('main');
  w.document.getElementById('app').append(main);
  return { w, calls, main, helpers: w.helpers };
}

test('an administrator sees the alerts above the view, fetched once a minute at most', async () => {
  const p = page(['telemetry.view']);
  const alerts = await p.helpers.deploymentAlerts();
  assert.equal(alerts.length, 1);
  await p.helpers.deploymentAlerts();
  assert.deepEqual(p.calls, ['/api/v1/alerts'], 'the second navigation reuses the answer');
  p.main.append(p.w.document.createElement('h1'));
  p.helpers.showAlertBanner(p.main, alerts);
  const banner = p.main.firstElementChild;
  assert.equal(banner.getAttribute('aria-label'), 'Deployment alerts');
  assert.equal(banner.querySelector('strong').textContent, ALERT.title);
  assert.ok(banner.textContent.includes('<b>11.0 GiB</b>'), 'the detail is text');
  assert.equal(banner.querySelector('b'), null);
  assert.equal(banner.querySelector('a').getAttribute('href'), ALERT.href);
  assert.equal(banner.querySelector('a').textContent, 'What to do next');

  // A view that replaces its children keeps the banner on top.
  p.main.replaceChildren(p.w.document.createElement('h1'), p.w.document.createElement('p'));
  await pause();
  assert.equal(p.main.firstElementChild, banner);
  assert.equal(p.main.querySelectorAll('.alert-banner').length, 1);
});

test('someone without the overview permission never asks, and no alerts means no banner', async () => {
  const p = page(['user.invite']);
  assert.equal((await p.helpers.deploymentAlerts()).length, 0);
  assert.deepEqual(p.calls, []);
  p.helpers.showAlertBanner(p.main, []);
  assert.equal(p.main.querySelector('.alert-banner'), null);
});
