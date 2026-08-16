/**
 * Render cache key (plans/07 §4): toolId + toolVersion + engineVersion +
 * catalogVersion + policyVersion + sorted-normalized query. Policy edits and
 * pack publishes invalidate exactly the affected keys - the brand-refresh
 * ripple depends on this composition.
 *
 * The render pipeline itself (fourth HostV1 shell - jsdom fast path, with
 * Chromium workers as a later addition - see pipeline.ts) consumes this key
 * contract; it was fixed first because links sign over it.
 */
import { sha256Hex } from '../lib/crypto.ts';

export interface RenderKeyParts {
  toolId: string;
  toolVersion: string;
  engineVersion: string;
  catalogVersion: string;
  policyVersion: string;
  format: string;
  params: Record<string, unknown>;
}

/** Sorted, duplicate-free, value-stringified param normalization. */
export function normalizeParams(params: Record<string, unknown>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&');
}

export function renderCacheKey(parts: RenderKeyParts): string {
  return sha256Hex(
    [parts.toolId, parts.toolVersion, parts.engineVersion, parts.catalogVersion, parts.policyVersion, parts.format, normalizeParams(parts.params)].join('\n'),
  );
}
