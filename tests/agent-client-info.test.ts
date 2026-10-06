// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentClientInfo, agentFamily, normalizeAgentClient } from '../server/src/agents/client-info.ts';

test('recognizes common agent clients without using invitation labels or guessing a model', () => {
  for (const [name, family] of [['Claude Code', 'claude'], ['claude-desktop', 'claude'], ['codex-mcp-client', 'codex'], ['OpenAI Codex', 'codex'], ['gemini-cli', 'gemini'], ['Qwen Code', 'qwen'], ['GLM-4.6', 'glm'], ['z.ai', 'glm'], ['DeepSeek', 'deepseek'], ['deepseek-ai', 'deepseek']] as const) {
    const info = agentClientInfo({ clientInfo: { name, version: '1.2.3' } }, true)!;
    assert.equal(info.family, family, name); assert.equal(info.version, '1.2.3');
    assert.equal(info.model, undefined); assert.equal(info.source, 'client-reported');
  }
  assert.equal(agentFamily('Cursor'), 'other');
  assert.equal(agentFamily('not-claude-code'), 'other');
  assert.equal(agentClientInfo({ agentLabel: 'Claude', clientInfo: { name: 'custom-editor', title: 'Codex' } }, true)?.family, 'other');
  assert.equal(agentClientInfo({ clientInfo: { version: '1' } }, true), null);
  assert.equal(agentClientInfo(null, true), null);
});

test('explicit models stay separate from client identity and survive audit normalization', () => {
  const meta = { 'tools.lolly/agent': { model: 'private-deployment-42', provider: 'Anthropic' } };
  const info = agentClientInfo({ clientInfo: { name: 'Cursor', version: '1' }, _meta: meta }, true)!;
  assert.equal(info.family, 'other'); assert.equal(info.modelFamily, 'claude'); assert.equal(info.provider, 'Anthropic');
  assert.deepEqual(normalizeAgentClient(info), info);
  const codex = agentClientInfo({ clientInfo: { name: 'Codex' }, _meta: { 'tools.lolly/agent': { model: 'gpt-5', provider: 'Claude' } } }, true)!;
  assert.equal(codex.family, 'codex'); assert.equal(codex.modelFamily, 'openai');
  assert.equal(agentClientInfo({ _meta: { 'tools.lolly/agent': { model: 'deepseek-r1' } } })?.modelFamily, 'deepseek');
});

test('request metadata is independent; missing or forged fields never inherit another client', () => {
  const info = agentClientInfo({ _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'Gemini CLI', version: '0.8' }, 'tools.lolly/agent': { model: 'gemini-2.5-pro' } } })!;
  assert.equal(info.family, 'gemini'); assert.equal(info.model, 'gemini-2.5-pro');
  assert.equal(agentClientInfo({ clientInfo: { name: 'Claude Code' } }), null, 'clientInfo outside initialize is not request metadata');
  assert.equal(agentClientInfo({ name: 'read_document', arguments: { clientInfo: { name: 'Claude' } } }), null);
  assert.equal(agentClientInfo({}), null);
  assert.equal(normalizeAgentClient({ name: 'Cursor', family: 'claude', modelFamily: 'claude', source: 'verified' })?.family, 'other');
});

test('only bounded display fields are retained; controls, arbitrary URLs and icons are dropped', () => {
  const info = normalizeAgentClient({ name: '\u202eCodex\u0000', title: '<img src=x>', version: 'v'.repeat(200), model: 'm'.repeat(200), provider: 'p'.repeat(200), secret: 'PRIVATE KEY', icon: 'https://evil.test/icon', websiteUrl: 'https://evil.test', nested: { key: 'PRIVATE KEY' } })!;
  assert.equal(info.name, 'Codex'); assert.equal(info.family, 'codex'); assert.equal(info.title, '<img src=x>');
  assert.equal(info.version?.length, 60); assert.equal(info.model?.length, 120); assert.equal(info.provider?.length, 120);
  for (const value of ['PRIVATE KEY', 'evil.test', 'nested', 'icon', 'websiteUrl']) assert.equal(JSON.stringify(info).includes(value), false);
  for (const value of [null, [], 'Codex', { name: {} }, { name: [] }, { name: '\u0000' }]) assert.equal(normalizeAgentClient(value), null);
});
