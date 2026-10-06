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


test('client badges distinguish all families, keep model separate and never render supplied icons or markup', () => {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin', runScripts: 'outside-only' });
  try {
    const w = dom.window; w.matchMedia = () => ({ matches: false });
    w.eval(source + '\nwindow.agentClient = { agentClientCell, agentClientMark, activityLine };');
    for (const [family, label, mark] of [['claude', 'Claude', 'CL'], ['codex', 'Codex', 'CX'], ['gemini', 'Gemini', 'GM'], ['qwen', 'Qwen', 'QW'], ['glm', 'GLM', 'GL'], ['deepseek', 'DeepSeek', 'DS']]) {
      const cell = w.agentClient.agentClientCell({ name: label + ' CLI', family, version: '1.2' });
      assert.ok(cell.textContent.includes(label)); assert.ok(cell.textContent.includes('v1.2'));
      assert.equal(cell.querySelector('.agent-client-mark').textContent, mark);
      assert.equal(cell.textContent.includes('Model:'), false);
      assert.ok(cell.textContent.includes('Client-reported'));
    }
    const cell = w.agentClient.agentClientCell({ name: 'Cursor', family: 'other', model: '<img src=x>', icons: [{ src: 'https://evil.test' }] });
    assert.ok(cell.textContent.includes('Cursor')); assert.ok(cell.textContent.includes('Model: <img src=x>'));
    assert.equal(cell.querySelector('img'), null);
    assert.equal(w.agentClient.agentClientCell(null).textContent, 'Not reported');
    assert.equal(w.agentClient.agentClientMark({ family: 'constructor' }).textContent, 'AG');
    const line = w.document.createElement('div');
    line.append(...w.agentClient.activityLine({ action: 'agent.connect', actor: { id: 'one', kind: 'agent', name: 'Helper', client: { name: 'Codex', family: 'codex', model: 'gpt-5' } }, payload: {} }).flat(Infinity));
    assert.ok(line.textContent.includes('Codex · gpt-5'));
    assert.equal(line.querySelector('.agent-client-tag').title, 'Reported on this request; not verified by Lolly.');
  } finally { dom.window.close(); }
});
