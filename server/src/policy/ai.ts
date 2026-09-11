/** Managed AI execution policy. The instance configuration is the approval
 * ceiling; the audited `ai` governance flag is the operator's stop switch.
 * Personal feature choices and injectable flags cannot grant AI execution. */
import type { FlagGovernance } from './feature-flags.ts';

export const AI_CAPABILITIES = [
  'speech', 'transcription', 'upscale', 'matte', 'ocr', 'depth',
  'reword', 'ai-detect', 'embedding', 'watermark',
] as const;
export type AiCapability = typeof AI_CAPABILITIES[number];
export interface AiConfig { enabled: boolean; capabilities: AiCapability[] }
export interface AiPolicy {
  version: 1;
  enabled: boolean;
  capabilities: AiCapability[];
  maxAgeSeconds: 60;
}

export function validateAiConfig(value: unknown): asserts value is AiConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('policy.ai must be an object');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !['enabled', 'capabilities'].includes(key))) throw new Error('unknown policy.ai key');
  if (typeof v.enabled !== 'boolean') throw new Error('policy.ai.enabled must be true or false');
  if (!Array.isArray(v.capabilities) || v.capabilities.some((c) => !AI_CAPABILITIES.includes(c))) {
    throw new Error('policy.ai.capabilities must list supported AI capabilities');
  }
  if (new Set(v.capabilities).size !== v.capabilities.length) throw new Error('policy.ai.capabilities must not contain duplicates');
  if (v.enabled && !v.capabilities.length) throw new Error('enabled policy.ai needs an explicit capability list');
}

export function resolveAiPolicy(config: AiConfig | undefined, governance: Map<string, FlagGovernance>): AiPolicy {
  const enabled = config?.enabled === true && governance.get('ai')?.default === 'on';
  return {
    version: 1, enabled,
    capabilities: enabled ? [...config.capabilities].sort() : [],
    maxAgeSeconds: 60,
  };
}
