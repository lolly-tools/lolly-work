// SPDX-License-Identifier: MPL-2.0
/**
 * The console's Limits and quotas panel (plans/82 M7), in jsdom: one card per area, each
 * limit with its value in words and where it comes from, maxima in full, no "null".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');

test('each area is a card, and each limit reads its value and source', async () => {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/instance?tab=limits', runScripts: 'outside-only' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const limits = [
    { id: 'automation.tokenLimits.rendersPerDay', area: 'Agent tokens', label: 'Renders a day per agent token', value: 1000, unit: 'count', source: 'configuration' },
    { id: 'tokens.rendersPerMonth.maximum', area: 'Agent tokens', label: 'Maximum renders a month per agent token', value: 31_000_000, unit: 'count', source: 'built-in' },
    { id: 'automation.tokenLimits.rendersPerMonth', area: 'Agent tokens', label: 'Renders a month per agent token', value: null, unit: 'count', source: 'built-in' },
    { id: 'renders.concurrency', area: 'Renders', label: 'Durable renders at once', value: 6, unit: 'count', source: 'environment' },
    { id: 'renders.attemptTimeoutMs', area: 'Renders', label: 'Time for one render attempt', value: 120_000, unit: 'ms', source: 'built-in' },
    { id: 'programmes.partnerRightsMode', area: 'Partner programmes', label: 'Partner licence gate', value: 'gate', unit: 'mode', source: 'configuration' },
    { id: 'policy.retention.auditDays', area: 'Retention and purge', label: 'Audit retention', value: 0, unit: 'days', source: 'built-in' },
  ];
  w.fetch = async () => ({ ok: true, status: 200, headers: new w.Headers({ 'content-type': 'application/json' }), json: async () => ({ limits }) });
  w.eval(`${source}; window.viewLimits = viewLimits;`);
  const main = w.document.createElement('main');
  await w.viewLimits(main);
  assert.deepEqual([...main.querySelectorAll('.limits-area h2')].map((h: any) => h.textContent), ['Agent tokens', 'Renders', 'Partner programmes', 'Retention and purge']);
  const row = (id: string) => main.querySelector(`tr[data-limit="${id}"]`).textContent.replace(/\s+/g, ' ');
  assert.match(row('automation.tokenLimits.rendersPerDay'), /1,000Configuration/);
  assert.match(row('tokens.rendersPerMonth.maximum'), /31,000,000Built-in default/, 'a maximum in full, never 31000K');
  assert.match(row('automation.tokenLimits.rendersPerMonth'), /No cap/);
  assert.match(row('renders.concurrency'), /6Environment/);
  assert.match(row('renders.attemptTimeoutMs'), /2 min/);
  assert.match(row('programmes.partnerRightsMode'), /GateConfiguration/);
  assert.match(row('policy.retention.auditDays'), /0 \(kept\)/);
  assert.match(main.textContent, /7 limits, 3 set by configuration or the environment/);
  assert.doesNotMatch(main.textContent, /null|undefined/);
  dom.window.close();
});
