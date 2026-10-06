// SPDX-License-Identifier: MPL-2.0
/** Display-only, client-reported identity. This never grants or changes access. */
export type AgentFamily = 'claude' | 'codex' | 'gemini' | 'qwen' | 'glm' | 'deepseek' | 'openai' | 'other';
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
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', qwen: 'Qwen', glm: 'GLM', deepseek: 'DeepSeek', openai: 'OpenAI', other: 'Other client',
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
  return {
    ...(name ? { name } : {}), ...(title && name ? { title } : {}), ...(version && name ? { version } : {}),
    family, ...(model ? { model, ...(provider ? { provider } : {}), modelFamily: modelFamily !== 'other' ? modelFamily : reportedProvider } : {}), source: 'client-reported',
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
