// SPDX-License-Identifier: MPL-2.0
/**
 * Published templates (plans/82 M2): a brand team's starting point for one tool,
 * published to partner programmes, with its own rules.
 *
 * A published template IS an instance asset of type `template` (plan 299's data
 * submission), so who sees it, its versions, its lifecycle and its audit are the
 * instance asset's own. What this module adds is the template's RULES and its
 * RETIREMENT, kept on the record as `publication`:
 *
 * - `editable` lists the inputs the people it is published to may change. Every
 *   other input is fixed to the template's value. Absent means no rules: every
 *   input stays editable, as a template always was (decision D3, 2026-11-07).
 * - `fixedTheme` keeps the colourway and mode the template was made in. Absent
 *   means people may pick another colourway or mode from the brand's own, which
 *   moves every colour the tool takes from the design system.
 * - `retiredAt`, `retiredBy` and `replacedBy` retire it: new starts stop, saved
 *   copies keep working, and a server render that names it answers 410 with
 *   the replacement (decision D2). Lifecycle revoke stays the hard stop.
 *
 * The served feed carries `meta.version`, `meta.editable`, `meta.fixedTheme`,
 * `meta.retired`, `meta.replacedBy` and `meta.bindings`, never a rule's name or
 * reason: the app offers what may change and nothing else (Andy, 2026-10-19).
 *
 * On a server render that names a template (`template=inst/<id>`), its rules
 * become an overlay already resolved for the caller: each input takes the
 * stricter of the tool's own rule and the template's, so a template can narrow
 * what a programme may change but never widen it. The existing checks then
 * refuse a fixed input with 422 INPUT_LOCKED and bake the fixed values.
 */
import { resolveInputAccess, type AccessLevel, type InputRule, type ResolvedAccess, type ToolOverlay } from '../policy/overlay.ts';
import type { AssetIndexEntry } from './lifecycle.ts';
import type { InstanceAssetRecord } from './instance-assets.ts';

/** The rules and retirement of one published template. */
export interface TemplatePublication {
  /** Input ids the people it reaches may change; absent means every input. */
  editable?: string[];
  /** True when people may not change the colourway or mode. */
  fixedTheme?: boolean;
  /** When and by whom it was retired ('user:<id>'). */
  retiredAt?: string;
  retiredBy?: string;
  /** The published template that replaces it. */
  replacedBy?: string;
  /** Inputs that take the partner company's values (plans/82 M3): input id to
   *  company field (programmes/company-values.ts). A bound input left out of
   *  `editable` is locked to the company value; in a rules tool every bound
   *  input is. */
  bindings?: Record<string, import('../programmes/company-values.ts').CompanyField>;
}

/** What a server render needs from a template the caller may use. */
export interface RenderTemplate {
  id: string;
  name: string;
  /** The tool the template starts. */
  toolId: string;
  /** The version the caller is served (the asset's head). */
  version: number;
  values: Record<string, unknown>;
  editable?: string[];
  fixedTheme?: boolean;
  retired?: { replacedBy?: string };
  /** Its company bindings, and the groups it was published to, which decide
   *  the company and programme a render is for (plans/82 M3). */
  bindings?: Record<string, import('../programmes/company-values.ts').CompanyField>;
  groups?: string[];
}

/** The id a template-scoped render names: an instance template, `inst/<id>`.
 *  A bare id stays a tool's own shipped template, as it always was. */
export function isPublishedTemplateRef(ref: unknown): ref is string {
  return typeof ref === 'string' && /^inst\/[A-Za-z0-9_-]{1,64}$/.test(ref);
}

const INPUT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Validate an editable list against the tool's declared inputs. Unknown ids are
 * refused rather than dropped, so a typo cannot quietly fix an input the admin
 * meant to leave open. `null` clears the rules (every input editable again).
 */
export function normalizeEditable(raw: unknown, inputIds: readonly string[]): { editable: string[] | undefined } | { error: string } {
  if (raw === null || raw === undefined) return { editable: undefined };
  if (!Array.isArray(raw)) return { error: 'editable must be a list of input ids' };
  const known = new Set(inputIds);
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !INPUT_ID.test(id)) return { error: 'editable must be a list of input ids' };
    if (!known.has(id)) return { error: `the tool has no input "${id}"` };
    if (!out.includes(id)) out.push(id);
  }
  return { editable: out };
}

/** Whether a template record is retired. */
export function templateRetired(rec: Pick<InstanceAssetRecord, 'publication'>): boolean {
  return !!rec.publication?.retiredAt;
}

/**
 * The served entry of a template or rules tool, with what the app needs to
 * offer it: its version, the inputs people may change, and its retirement.
 * Any other instance asset is returned unchanged.
 */
export function servedTemplateEntry(rec: InstanceAssetRecord): AssetIndexEntry {
  const type = rec.entry.type;
  if (type !== 'template' && type !== 'rules-tool') return rec.entry;
  const pub = rec.publication;
  const meta: Record<string, unknown> = {
    ...((rec.entry.meta ?? {}) as Record<string, unknown>),
    version: rec.headVersion ?? 1,
    ...(pub?.editable ? { editable: [...pub.editable] } : {}),
    ...(pub?.fixedTheme ? { fixedTheme: true } : {}),
    ...(pub?.retiredAt ? { retired: true } : {}),
    ...(pub?.replacedBy ? { replacedBy: pub.replacedBy } : {}),
    // Which inputs take the partner company's values: the app seeds them
    // from org-config's `partner.company` (plans/82 M3).
    ...(pub?.bindings ? { bindings: { ...pub.bindings } } : {}),
  };
  return { ...rec.entry, meta };
}

/** A template's stored JSON, read back as its values. Null when it is not one. */
export function templateValues(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const doc = JSON.parse(Buffer.from(bytes).toString('utf8')) as { values?: unknown };
    const values = doc?.values;
    return values && typeof values === 'object' && !Array.isArray(values) ? values as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const STRICTNESS: Record<AccessLevel, number> = { editable: 0, choice: 1, locked: 2, hidden: 3 };

/** One rule that resolves to exactly `access` for anyone, carrying its attribution. */
function ruleOf(access: ResolvedAccess): InputRule {
  const rule: InputRule = { groups: ['*'], level: access.level };
  if ('value' in access && access.value !== undefined) rule.value = access.value;
  if (access.allow) rule.allow = access.allow;
  if (access.reason) rule.reason = access.reason;
  if (access.by) rule.by = access.by;
  return rule;
}

/**
 * The overlay a template-scoped render enforces for these groups: for each
 * input, the stricter of the tool's own rule and the template's. An input the
 * template fixes is locked to the template's value (or to nothing, which keeps
 * the tool's default); an input it leaves editable keeps whatever the tool's
 * rule says. Visibility, enforce and defaults stay the tool's.
 *
 * The result is already resolved for `groups`, so every rule names `*`. It is
 * only ever used for the one render it was built for.
 */
export function templateOverlay(
  tool: ToolOverlay | undefined,
  template: Pick<RenderTemplate, 'name' | 'values' | 'editable' | 'toolId'>,
  groups: string[],
  inputIds: readonly string[],
): ToolOverlay | undefined {
  if (!template.editable) return tool;
  const editable = new Set(template.editable);
  const ids = new Set([...inputIds, ...Object.keys(tool?.inputAccess ?? {}).filter((id) => id !== '*')]);
  const fixed = (id: string): ResolvedAccess => ({
    level: 'locked',
    ...(Object.hasOwn(template.values, id) ? { value: template.values[id] } : {}),
    by: template.name,
    reason: 'Fixed by the template',
  });
  const inputAccess: Record<string, InputRule[]> = {};
  for (const id of ids) {
    const own = resolveInputAccess(tool, id, groups);
    const theirs: ResolvedAccess = editable.has(id) ? { level: 'editable' } : fixed(id);
    const pick = STRICTNESS[theirs.level] > STRICTNESS[own.level] ? theirs : own;
    // Listed even when editable: the default below fixes whatever is not listed.
    inputAccess[id] = [ruleOf(pick)];
  }
  // Anything the tool does not declare is not the template's to open.
  inputAccess['*'] = [{ groups: ['*'], level: 'locked', by: template.name, reason: 'Fixed by the template' }];
  return {
    toolId: template.toolId,
    version: tool?.version ?? 0,
    ...(tool?.name ? { name: tool.name } : {}),
    inputAccess,
    ...(tool?.visibility ? { visibility: tool.visibility } : {}),
    ...(tool?.enforce ? { enforce: tool.enforce } : {}),
    ...(tool?.defaults ? { defaults: tool.defaults } : {}),
  };
}

/** The template's values a render starts from: declared inputs only, so an
 *  internal key the shell keeps in a saved document never reaches the tool. */
export function templateSeed(values: Record<string, unknown>, inputIds: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of inputIds) if (Object.hasOwn(values, id)) out[id] = values[id];
  return out;
}
