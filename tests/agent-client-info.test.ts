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
  assert.equal(agentFamily('Cursor'), 'cursor');
  assert.equal(agentFamily('not-claude-code'), 'other');
  assert.equal(agentClientInfo({ agentLabel: 'Claude', clientInfo: { name: 'custom-editor', title: 'Codex' } }, true)?.family, 'other');
  assert.equal(agentClientInfo({ clientInfo: { version: '1' } }, true), null);
  assert.equal(agentClientInfo(null, true), null);
});

test('explicit models stay separate from client identity and survive audit normalization', () => {
  const meta = { 'tools.lolly/agent': { model: 'private-deployment-42', provider: 'Anthropic' } };
  const info = agentClientInfo({ clientInfo: { name: 'Cursor', version: '1' }, _meta: meta }, true)!;
  assert.equal(info.family, 'cursor'); assert.equal(info.modelFamily, 'claude'); assert.equal(info.provider, 'Anthropic');
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
  assert.equal(normalizeAgentClient({ name: 'Cursor', family: 'claude', modelFamily: 'claude', source: 'verified' })?.family, 'cursor');
});

test('only bounded display fields are retained; controls, arbitrary URLs and icons are dropped', () => {
  const info = normalizeAgentClient({ name: '\u202eCodex\u0000', title: '<img src=x>', version: 'v'.repeat(200), model: 'm'.repeat(200), provider: 'p'.repeat(200), secret: 'PRIVATE KEY', icon: 'https://evil.test/icon', websiteUrl: 'https://evil.test', nested: { key: 'PRIVATE KEY' } })!;
  assert.equal(info.name, 'Codex'); assert.equal(info.family, 'codex'); assert.equal(info.title, '<img src=x>');
  assert.equal(info.version?.length, 60); assert.equal(info.model?.length, 120); assert.equal(info.provider?.length, 120);
  for (const value of ['PRIVATE KEY', 'evil.test', 'nested', 'icon', 'websiteUrl']) assert.equal(JSON.stringify(info).includes(value), false);
  for (const value of [null, [], 'Codex', { name: {} }, { name: [] }, { name: '\u0000' }]) assert.equal(normalizeAgentClient(value), null);
});


test('recognizes additional named clients and model namespaces without mistaking suffix lookalikes', () => {
  const cases = [
    ['Jev', 'jev'], ['TypeSafe/Jev-1', 'jev'], ['Laya', 'laya'], ['NandhaKishorM/Laya-4B', 'laya'],
    ['Kolibri', 'kolibri'], ['Aleph-Alpha/Kolibri-1', 'kolibri'], ['Mistral Vibe', 'mistral'], ['vibe-cli', 'mistral'], ['Le Chat', 'mistral'], ['mistralai/devstral-small-2505', 'mistral'], ['codestral-latest', 'mistral'],
    ['Cursor Agent', 'cursor'], ['GitHub Copilot', 'copilot'], ['copilot-cli', 'copilot'], ['OpenCode', 'opencode'], ['Cline', 'cline'], ['Roo Code', 'roo'], ['Windsurf', 'windsurf'],
    ['OpenClaw', 'openclaw'], ['Goose Desktop', 'goose'], ['Continue.dev', 'continue'], ['Aider', 'aider'], ['Amazon Q Developer', 'amazon-q'], ['Factory Droid', 'droid'],
    ['Kimi Code', 'kimi'], ['moonshotai/kimi-k2', 'kimi'], ['xAI/Grok-4', 'grok'], ['meta-llama/Llama-4', 'llama'], ['Visual Studio Code', 'vscode'],
  ] as const;
  for (const [name, family] of cases) {
    const info = agentClientInfo({ clientInfo: { name, version: '1' } }, true)!;
    assert.equal(info.family, family, name); assert.equal(info.model, undefined);
    assert.deepEqual(normalizeAgentClient(info), info);
  }
  for (const name of ['jevel', 'malaya', 'kolibridge', 'not-mistral-vibe', 'cursorily', 'copilotage', 'clineage', 'my-openclaw', 'continueous', 'gooseberry']) assert.equal(agentFamily(name), 'other', name);
  const info = agentClientInfo({ clientInfo: { name: 'opencode' }, _meta: { 'tools.lolly/agent': { model: 'Aleph-Alpha/Kolibri-1' } } }, true)!;
  assert.equal(info.family, 'opencode'); assert.equal(info.modelFamily, 'kolibri');
  const unknown = agentClientInfo({ clientInfo: { name: 'My studio agent', title: 'Studio helper' } }, true)!;
  assert.equal(unknown.name, 'My studio agent'); assert.equal(unknown.title, 'Studio helper'); assert.equal(unknown.family, 'other');
});
