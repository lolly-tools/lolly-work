/**
 * Render cache key (plans/07 §4): toolId + toolVersion + engineVersion +
 * catalogVersion + policyVersion + canonical typed values and prepared context.
 * The context includes loaded source content, profile, dimensions and watermark.
 * This request key is not a complete dependency lock.
 *
 * The render pipeline itself (fourth HostV1 shell - jsdom fast path, with
 * Chromium workers as a later addition - see pipeline.ts) consumes this key
 * contract; it was fixed first because links sign over it.
 */
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';

export interface RenderKeyParts {
  toolId: string;
  toolVersion: string;
  engineVersion: string;
  catalogVersion: string;
  policyVersion: string;
  format: string;
  params: Record<string, unknown>;
  /** Output-affecting context: profile, dimensions, watermark, loaded sources and renderer. */
  context?: Record<string, unknown>;
}

/** Keep nested JSON and value types distinct; object key order is insignificant. */
export function normalizeParams(params: Record<string, unknown>): string {
  return canonicalJson(params);
}

export function renderCacheKey(parts: RenderKeyParts): string {
  return sha256Hex(canonicalJson({ apiVersion: 2, ...parts }));
}
