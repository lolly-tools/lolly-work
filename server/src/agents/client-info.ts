// SPDX-License-Identifier: MPL-2.0
/** Display-only, client-reported identity. This never grants or changes access. */
export type AgentFamily =
  | 'claude' | 'codex' | 'gemini' | 'qwen' | 'glm' | 'deepseek' | 'openai'
  | 'jev' | 'laya' | 'kolibri' | 'mistral' | 'cursor' | 'copilot' | 'opencode'
  | 'cline' | 'roo' | 'windsurf' | 'openclaw' | 'goose' | 'continue' | 'aider'
  | 'amazon-q' | 'droid' | 'kimi' | 'grok' | 'llama' | 'vscode' | 'other';
export interface AgentClientInfo {
  name?: string;
  title?: string;
  version?: string;
  family: AgentFamily;
  model?: string;
  provider?: string;
  modelFamily?: AgentFamily;
  source: 'client-reported';
}
export const AGENT_FAMILY_NAMES: Record<AgentFamily, string> = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', qwen: 'Qwen', glm: 'GLM', deepseek: 'DeepSeek', openai: 'OpenAI',
  jev: 'Jev', laya: 'Laya', kolibri: 'Kolibri', mistral: 'Mistral', cursor: 'Cursor', copilot: 'GitHub Copilot',
  opencode: 'OpenCode', cline: 'Cline', roo: 'Roo Code', windsurf: 'Windsurf', openclaw: 'OpenClaw',
  goose: 'Goose', continue: 'Continue', aider: 'Aider', 'amazon-q': 'Amazon Q', droid: 'Factory Droid',
  kimi: 'Kimi', grok: 'Grok', llama: 'Llama', vscode: 'VS Code', other: 'Other client',
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clean = (v: unknown, max = 120): string | undefined => {
  if (typeof v !== 'string') return undefined;
  // Strip controls and bidi overrides; names never become URLs, HTML or icon markup.
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
  return s || undefined;
};
export function agentFamily(name: string | undefined): AgentFamily {
  const key = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Match known client/model prefixes, never the user-chosen invitation label.
  if (/^(?:anthropic)?claude(?:code|desktop|ai|mcp|client|cli|opus|sonnet|haiku|\d|$)/.test(key) || key === 'anthropic') return 'claude';
  if (/^(?:openai)?codex(?:mcp|client|cli|app|\d|$)/.test(key)) return 'codex';
  if (/^(?:google)?gemini(?:cli|client|mcp|code|\d|$)/.test(key) || key === 'google') return 'gemini';
  if (/^(?:alibaba)?qwen(?:code|cli|client|mcp|\d|$)/.test(key) || key === 'alibaba') return 'qwen';
  if (/^glm(?:code|cli|client|mcp|\d|$)/.test(key) || ['zhipu', 'zhipuai', 'zai'].includes(key)) return 'glm';
  if (/^deepseek(?:ai|code|coder|cli|client|mcp|chat|reasoner|r\d|v\d|\d|$)/.test(key)) return 'deepseek';
  if (/^(?:typesafe(?:ai)?)?jev(?:agent|mcp|client|cli|model|latest|\d|$)/.test(key) || ['typesafe', 'typesafeai'].includes(key)) return 'jev';
  if (/^(?:nandhakishorm)?laya(?:agent|mcp|client|cli|model|coreml|mlx|browser|small|large|base|tiny|\d|$)/.test(key)) return 'laya';
  if (/^(?:alephalpha)?kolibri(?:agent|mcp|client|cli|model|origin|a\d|\d|$)/.test(key)) return 'kolibri';
  if (/^(?:mistralai)?(?:mistral|ministral|codestral|devstral|pixtral|mixtral|voxtral)(?:ai|vibe|agent|mcp|client|cli|small|medium|large|nemo|latest|\d|$)/.test(key) || /^(?:vibe|lechat)(?:code|cli|agent|mcp|client|\d|$)/.test(key)) return 'mistral';
  if (/^cursor(?:agent|cli|ide|mcp|client|\d|$)/.test(key)) return 'cursor';
  if (/^(?:github|vscode)?copilot(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'copilot';
  if (/^opencode(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'opencode';
  if (/^cline(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'cline';
  if (/^roo(?:code|agent|cli|mcp|client|\d|$)/.test(key)) return 'roo';
  if (/^windsurf(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'windsurf';
  if (/^openclaw(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'openclaw';
  if (/^(?:block)?goose(?:agent|cli|mcp|client|desktop|\d|$)/.test(key)) return 'goose';
  if (/^continue(?:dev|agent|cli|mcp|client|\d|$)/.test(key)) return 'continue';
  if (/^aider(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'aider';
  if (/^(?:amazon|aws)q(?:developer|agent|cli|mcp|client|\d|$)/.test(key)) return 'amazon-q';
  if (/^(?:factory)?droid(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'droid';
  if (/^(?:moonshot(?:ai)?)?kimi(?:code|coding|agent|cli|mcp|client|k\d|\d|$)/.test(key)) return 'kimi';
  if (/^(?:xai)?grok(?:code|agent|cli|mcp|client|\d|$)/.test(key)) return 'grok';
  if (/^(?:meta(?:llama)?)?llama(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'llama';
  if (/^(?:vscode|visualstudiocode)(?:agent|cli|mcp|client|\d|$)/.test(key)) return 'vscode';
  if (key === 'openai' || /^(?:gpt\d|o[134]\d*)/.test(key)) return 'openai';
  return 'other';
}
/** Re-normalize stored metadata too; neither audit payloads nor client icons are trusted markup. */
export function normalizeAgentClient(value: unknown): AgentClientInfo | null {
  if (!object(value)) return null;
  const name = clean(value.name), title = clean(value.title), version = clean(value.version, 60), model = clean(value.model);
  if (!name && !model) return null;
  const provider = model ? clean(value.provider) : undefined;
  const family = agentFamily(name), reportedProvider = agentFamily(provider);
  const modelFamily = model ? agentFamily(model) : 'other';
  const namespacedModelFamily = modelFamily === 'other' && model?.includes('/') ? agentFamily(model.split('/').at(-1)) : modelFamily;
  return {
    ...(name ? { name } : {}), ...(title && name ? { title } : {}), ...(version && name ? { version } : {}),
    family, ...(model ? { model, ...(provider ? { provider } : {}), modelFamily: namespacedModelFamily !== 'other' ? namespacedModelFamily : reportedProvider } : {}), source: 'client-reported',
  };
}
/** Standard initialize metadata, or request-local metadata for clients that provide it. */
export function agentClientInfo(params: unknown, initializing = false): AgentClientInfo | null {
  if (!object(params)) return null;
  const meta = object(params._meta) ? params._meta : {};
  const implementation = initializing && object(params.clientInfo) ? params.clientInfo
    : object(meta['io.modelcontextprotocol/clientInfo']) ? meta['io.modelcontextprotocol/clientInfo'] : {};
  const agent = object(meta['tools.lolly/agent']) ? meta['tools.lolly/agent'] : {};
  return normalizeAgentClient({ name: implementation.name, title: implementation.title, version: implementation.version,
    model: agent.model, provider: agent.provider });
}
