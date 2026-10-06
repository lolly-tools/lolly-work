// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');

test('agent activity names the agent, links its inviter and renders labels as text', () => {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin', runScripts: 'outside-only' });
  try {
    const w = dom.window;
    w.matchMedia = () => ({ matches: false });
    w.eval(source + '\nwindow.agentActivity = { activityLine, ACT_CAT_LABEL };');
    const line = w.document.createElement('div');
    const nodes = w.agentActivity.activityLine({ action: 'agent.tool-call', actor: { id: 'agt_one', kind: 'agent', name: '<img src=x>', invitedBy: { id: 'u1', name: 'Ada' } }, payload: { tool: 'read_document', outcome: 'succeeded' } }, { u1: 'Ada' });
    line.append(...nodes.flat(Infinity));
    assert.match(line.textContent, /<img src=x> \(invited by Ada\) used read_document/);
    assert.equal(line.querySelector('a')?.getAttribute('href'), '#/users?focus=u1');
    assert.equal(line.querySelector('img'), null);
    assert.equal(w.agentActivity.ACT_CAT_LABEL.agent, 'Agents');
  } finally { dom.window.close(); }
});
