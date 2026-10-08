// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { AGENT_FAMILY_NAMES } from '../server/src/agents/client-info.ts';

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

test('saved-session links retain document identity across activity, agents and split shell origins', async () => {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin', runScripts: 'outside-only' });
  try {
    const w = dom.window; w.matchMedia = () => ({ matches: false });
    w.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
    w.eval(source + '\nwindow.links = { actSessionObj, actToolObj, actProjectObj, activityLine, viewAgents, setOrigin: value => { lollyAppUrl = value; } };');
    for (const origin of ['', 'https://shell.test']) {
      w.links.setOrigin(origin);
      assert.equal(w.links.actSessionObj('ses_one /?#', 'design').getAttribute('href'), `${origin}/#/team/ses_one%20%2F%3F%23`);
      assert.equal(w.links.actSessionObj('ses_without_tool').getAttribute('href'), `${origin}/#/team/ses_without_tool`);
      assert.equal(w.links.actToolObj('design').getAttribute('href'), `${origin}/t/design`);
      assert.equal(w.links.actProjectObj('project one').getAttribute('href'), `${origin}/#/p?team=project%20one`);
      const activity = w.document.createElement('div');
      activity.append(...w.links.activityLine({ action: 'agent.connect', subject: 'session:ses_existing', actor: { kind: 'agent', name: 'Helper' }, payload: {} }).flat(Infinity));
      assert.equal(activity.querySelector('a[href*="/team/"]')?.getAttribute('href'), `${origin}/#/team/ses_existing`);
    }
    w.fetch = async () => ({ status: 200, ok: true, json: async () => ({
      summary: { agentsUsed: 1, toolCalls: 0, succeeded: 0, partial: 0, rejected: 0, connected: 0, invited: 1, revoked: 0, acceptedOps: 0, rejectedOps: 0 },
      updatedAt: '2026-01-01T00:00:00Z', timeline: [], names: {}, agents: [{ id: 'agent', label: 'Helper', project: { id: 'prj_one', name: 'Project' }, session: { id: 'ses_existing', name: 'Existing document' }, status: 'active', connected: false, calls: 0, lastActivity: '2026-01-01T00:00:00Z' }],
    }) });
    const main = w.document.createElement('main'); w.document.body.append(main);
    await w.links.viewAgents(main);
    assert.equal(main.querySelector('a[href*="/team/"]')?.getAttribute('href'), 'https://shell.test/#/team/ses_existing', 'agent rows must open an existing shared document even without tool metadata');
    assert.equal(main.querySelector('a[href*="?session="]'), null);
  } finally { dom.window.close(); }
});


test('client badges distinguish all families, keep model separate and never render supplied icons or markup', () => {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin', runScripts: 'outside-only' });
  try {
    const w = dom.window; w.matchMedia = () => ({ matches: false });
    w.eval(source + '\nwindow.agentClient = { agentClientCell, agentClientMark, activityLine, AGENT_CLIENTS };');
    for (const [family, label, mark] of [['claude', 'Claude', 'CL'], ['codex', 'Codex', 'CX'], ['gemini', 'Gemini', 'GM'], ['qwen', 'Qwen', 'QW'], ['glm', 'GLM', 'GL'], ['deepseek', 'DeepSeek', 'DS']]) {
      const cell = w.agentClient.agentClientCell({ name: label + ' CLI', family, version: '1.2' });
      assert.ok(cell.textContent.includes(label)); assert.ok(cell.textContent.includes('v1.2'));
      assert.equal(cell.querySelector('.agent-client-mark').textContent, mark);
      assert.equal(cell.textContent.includes('Model:'), false);
      assert.ok(cell.textContent.includes('Client-reported'));
    }
    assert.deepEqual(Object.keys(w.agentClient.AGENT_CLIENTS).sort(), Object.keys(AGENT_FAMILY_NAMES).sort(), 'console and server recognize the same roster');
    for (const [family, label] of Object.entries(AGENT_FAMILY_NAMES)) {
      assert.equal(w.agentClient.AGENT_CLIENTS[family][0], label);
      const named = w.agentClient.agentClientCell({ name: label, family, version: '1' });
      assert.ok(named.textContent.includes(label));
    }
    const model = w.agentClient.agentClientCell({ name: 'OpenCode', family: 'opencode', model: 'Aleph-Alpha/Kolibri-1', modelFamily: 'kolibri' });
    assert.ok(model.textContent.includes('OpenCode')); assert.ok(model.textContent.includes('Model: Kolibri · Aleph-Alpha/Kolibri-1'));
    const custom = w.agentClient.agentClientCell({ name: 'My studio agent', title: 'Studio helper', family: 'other' });
    assert.ok(custom.textContent.includes('Studio helper')); assert.ok(custom.textContent.includes('My studio agent'));
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
