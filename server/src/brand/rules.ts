import type { BrandPolicyMappingV1, BrandSystemV1 } from '@lolly-tools/core/brand-system-v1';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { BrandError, type BrandSnapshot } from './service.ts';
import { resolveInputAccess, type ToolOverlay } from '../policy/overlay.ts';

export interface RuleResult {
  id: string; state: 'pass' | 'fail' | 'unknown' | 'outside'; reason: string; enforced: boolean;
  constraint?: { slot: keyof BrandPolicyMappingV1['fields']; kind: string; values?: string[]; max?: number };
}
interface RuleApi {
  brandSystemOf(doc: unknown): BrandSystemV1 | null;
  parseBrandPolicyMappings(raw: unknown): BrandPolicyMappingV1[];
  resolveBrandPolicy(system: BrandSystemV1, doc: unknown, toolId: string, format: string, mapping?: BrandPolicyMappingV1): RuleResult[];
  checkBrandPolicyValues(results: RuleResult[], mapping: BrandPolicyMappingV1 | undefined, values: Record<string, unknown>): RuleResult[];
  checkBrandPolicyDigests(results: RuleResult[], mapping: BrandPolicyMappingV1 | undefined, initial: Record<string, unknown>, observed: Record<string, string>): Promise<RuleResult[]>;
  brandRuleDisposition(results: RuleResult[]): 'blocked' | 'draft' | 'checked';
}
const specifier: string = '@lolly/engine/brand-policy';
export const ruleApi: RuleApi = await import(specifier);
export interface ManagedRulePolicy { sourceRevision: string; mappings: BrandPolicyMappingV1[]; manifests: Record<string, string>; reviewedBy: string }
export interface ManagedRuleContext {
  revision: string; sourceId: string; systemId: string | null; rulesDigest: string;
  mapping?: BrandPolicyMappingV1; results: RuleResult[];
}
export interface ManagedRuleReport extends ManagedRuleContext {
  scope: 'runtime-inputs'; disposition: 'draft' | 'checked' | 'not-applicable'; limitations: string[];
}
export const hash = (value: unknown) => sha256Hex(canonicalJson(value));

export async function sourceRules(snap: BrandSnapshot) {
  const head = snap.source.assets.find(a => a.id === snap.source.tokensHead);
  if (!head) return { doc: null, system: null, present: false };
  const url = (head.formats?.find(f => f.format === 'json') ?? head.formats?.[0])?.url;
  if (!url || !url.startsWith('/catalog/') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(url)) throw new BrandError('The managed tokens source is unavailable.');
  const doc = JSON.parse(await readFile(join(snap.source.root, url.slice(1)), 'utf8'));
  if (hash(doc) !== snap.source.tokensChecksum) throw new BrandError('Mounted tokens changed. Restart with the new source and review its mappings.', 409, 'BRAND_REVISION_CHANGED');
  const present = doc?.$extensions?.['com.suse.lolly']?.brandSystem !== undefined;
  return { doc, system: ruleApi.brandSystemOf(doc), present };
}

export async function managedRuleContext(snap: BrandSnapshot, toolId: string, format: string): Promise<ManagedRuleContext | undefined> {
  const { doc, system, present } = await sourceRules(snap);
  if (!present) return undefined;
  const policy = Object.hasOwn(snap.state.rulePolicies ?? {}, snap.source.id) ? snap.state.rulePolicies![snap.source.id] : undefined;
  if (policy && policy.sourceRevision !== snap.source.revision) throw new BrandError('Review rule mappings for the current source revision.', 409, 'BRAND_REVISION_CHANGED');
  const mapping = policy?.mappings.find(m => m.toolId === toolId);
  if (mapping && hash(JSON.parse(await readFile(join(snap.source.root, 'tools', toolId, 'tool.json'), 'utf8'))) !== policy!.manifests[toolId]) throw new BrandError('The mapped tool changed. Review its inputs again.', 409, 'BRAND_REVISION_CHANGED');
  return { revision: snap.revision, sourceId: snap.source.id, systemId: system?.id ?? null, rulesDigest: hash(doc), ...(mapping ? { mapping } : {}),
    results: system ? ruleApi.resolveBrandPolicy(system, doc, toolId, format, mapping) : [{ id: 'unsupported-guide', state: 'unknown', enforced: true, reason: 'This guide version cannot be checked by this server.' }] };
}

/** Intersect the new choices with the caller's existing restrictions; never replace authority. */
export function projectRuleOverlay(original: ToolOverlay | undefined, context: ManagedRuleContext, groups: string[]): ToolOverlay | undefined {
  if (!context.mapping) return original;
  const next: ToolOverlay = structuredClone(original ?? { toolId: context.mapping.toolId, version: 0 });
  for (const result of context.results) {
    const c = result.constraint, id = c && context.mapping.fields[c.slot];
    if (!result.enforced || result.state === 'outside' || !c?.values || !id) continue;
    const access = resolveInputAccess(next, id, groups);
    if (access.level === 'hidden' || access.level === 'locked') continue;
    const allow = access.level === 'choice' ? c.values.filter(v => access.allow?.includes(v)) : c.values;
    next.inputAccess ??= {};
    next.inputAccess[id] = [{ groups: ['*'], level: 'choice', allow, reason: `Design-system rule: ${result.id}` }];
  }
  return next;
}

export function requireRuleValues(context: ManagedRuleContext | undefined, values: Record<string, unknown>): void {
  if (!context) return;
  const results = ruleApi.checkBrandPolicyValues(context.results, context.mapping, values);
  const failed = results.filter(r => r.enforced && r.state === 'fail');
  if (failed.length) throw new BrandError(`Required brand rules failed: ${failed.map(r => r.id).join(', ')}.`, 422, 'BRAND_RULE_VIOLATION');
}

/** Existing organisation restrictions also apply to defaults and hook-produced input values. */
export function governedInputs(overlay: ToolOverlay | undefined, groups: string[], ids: string[]) {
  return ids.flatMap(id => {
    const access = resolveInputAccess(overlay, id, groups);
    const values = access.level === 'choice' ? access.allow : access.level === 'locked' && 'value' in access ? [access.value] : undefined;
    return values ? [{ id, values }] : [];
  });
}
export function requireGovernedInputs(checks: ReturnType<typeof governedInputs>, observed: Record<string, string>): void {
  for (const check of checks) {
    if (!check.values.some(value => hash(value) === observed[check.id])) throw new BrandError(`Organisation policy could not be satisfied for ${check.id}.`, 422, 'INPUT_NOT_ALLOWED');
  }
}

export async function finishRuleReport(context: ManagedRuleContext | undefined, initial: Record<string, unknown>, observed: Record<string, string>): Promise<ManagedRuleReport | undefined> {
  if (!context) return undefined;
  const results = await ruleApi.checkBrandPolicyDigests(context.results, context.mapping, initial, observed);
  const disposition = ruleApi.brandRuleDisposition(results);
  if (disposition === 'blocked') throw new BrandError(`Required brand rules failed after rendering: ${results.filter(r => r.enforced && r.state === 'fail').map(r => r.id).join(', ')}.`, 422, 'BRAND_RULE_VIOLATION');
  return { ...context, results, disposition: results.some(r => r.enforced && r.state !== 'outside') ? disposition : 'not-applicable', scope: 'runtime-inputs', limitations: ['Input values were checked against server-reviewed mappings.', 'Pixel colours, font rendering, geometry and visible fixed artwork are not established by this report.'] };
}

/** Every transport carries the draft label in the artifact, including batch and legacy jobs. */
export function markBrandDraft(svg: string): string {
  if (!/<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg)) throw new BrandError('The unchecked output cannot carry a draft label.', 422, 'BRAND_DRAFT_UNLABELLED');
  const id = `lw-brand-draft-${sha256Hex(svg).slice(0, 20)}`;
  const mark = `<defs><pattern id="${id}" width="220" height="120" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)"><text x="8" y="48" font-family="sans-serif" font-size="30" font-weight="700" fill="white" stroke="black" stroke-width="1">DRAFT</text></pattern></defs><rect x="0" y="0" width="100%" height="100%" fill="url(#${id})" pointer-events="none"/>`;
  return svg.replace(/<\/svg>\s*$/i, `${mark}</svg>`);
}
