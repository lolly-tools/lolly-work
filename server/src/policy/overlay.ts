/**
 * Tool policy overlays - per-(input × group) access levels, tool visibility,
 * and the enforcement block (plans/03 §4, parent commercial-build §4.C).
 *
 * Overlays are server-owned data, never a fork of tool.json. Everything here
 * is pure so the same functions serve schema filtering, render-time
 * enforcement (422 INPUT_LOCKED), and catalog feed filtering.
 */

export type AccessLevel = 'editable' | 'choice' | 'locked' | 'hidden';

export interface InputRule {
  groups: string[]; // '*' wildcard allowed
  level: AccessLevel;
  /** For 'locked': the value rendered in place of user input. */
  value?: unknown;
  /** For 'choice': the allowed set. */
  allow?: unknown[];
}

export interface ToolOverlay {
  toolId: string;
  version: number;
  /** input id (or '*' default) → ordered rule list; first group-match wins. */
  inputAccess?: Record<string, InputRule[]>;
  visibility?: { groups: string[] };
  enforce?: {
    formats?: string[];
    c2pa?: 'org-identity' | 'off';
    watermark?: 'until-approved' | 'always' | 'never';
    escalation?: string;
  };
  defaults?: Record<string, unknown>;
}

export interface ResolvedAccess {
  level: AccessLevel;
  value?: unknown;
  allow?: unknown[];
}

const EDITABLE: ResolvedAccess = { level: 'editable' };

function ruleMatches(rule: InputRule, groups: string[]): boolean {
  return rule.groups.includes('*') || rule.groups.some((g) => groups.includes(g));
}

/** An OWN entry of the rule table, or undefined. `inputAccess` is a plain object
 *  parsed from jsonb and `inputId` reaches here from untrusted input (a collab op's
 *  key, a render param name), so a bare member access on it resolves inherited
 *  `Object.prototype` names: `inputAccess['toString']` is a truthy FUNCTION, which
 *  then throws `rules is not iterable` in the loop below. A deny-list of the three
 *  famous keys does not cover `toString`/`valueOf`/`hasOwnProperty`/…; an
 *  own-property check covers all of them by construction, and `Array.isArray`
 *  covers a table whose value is not a rule list at all. */
function rulesFor(table: Record<string, InputRule[]>, key: string): InputRule[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(table, key)) return undefined;
  const rules = table[key];
  return Array.isArray(rules) ? rules : undefined;
}

/** First matching rule for the input (falling back to the '*' input default) wins. */
export function resolveInputAccess(
  overlay: ToolOverlay | undefined,
  inputId: string,
  groups: string[],
): ResolvedAccess {
  if (!overlay?.inputAccess) return EDITABLE;
  const rules = rulesFor(overlay.inputAccess, inputId) ?? rulesFor(overlay.inputAccess, '*');
  if (!rules) return EDITABLE;
  for (const rule of rules) {
    if (!ruleMatches(rule, groups)) continue;
    const out: ResolvedAccess = { level: rule.level };
    if ('value' in rule) out.value = rule.value;
    if (rule.allow) out.allow = rule.allow;
    return out;
  }
  return EDITABLE;
}

/**
 * Whether ANY rule exists for this input - its own list, or the `'*'` input
 * default - regardless of whether a caller's groups match one. Pure and
 * group-blind on purpose: it answers "did an operator visibly try to govern
 * this field", not "does it apply to you".
 *
 * Exists for principals outside the normal group table who must NOT inherit
 * `resolveInputAccess`'s member-side fallback (EDITABLE-if-nothing-matches):
 * a live collab guest carries only the synthetic `guests` group
 * (`server/src/collab/guests.ts`), so a rule an operator wrote for a tool's
 * real editing groups never matches one - and falling open on a field the
 * operator was demonstrably trying to lock down is the opposite of "the
 * narrowest input surface of anyone" (plans/02 §8). A genuinely ungoverned
 * input (no rules at all) still reports false, so it stays editable for
 * everyone, guest included - this only tightens the GOVERNED case.
 */
export function inputIsGoverned(overlay: ToolOverlay | undefined, inputId: string): boolean {
  if (!overlay?.inputAccess) return false;
  return rulesFor(overlay.inputAccess, inputId) !== undefined || rulesFor(overlay.inputAccess, '*') !== undefined;
}

export function toolVisibleTo(overlay: ToolOverlay | undefined, groups: string[]): boolean {
  if (!overlay?.visibility) return true;
  return overlay.visibility.groups.includes('*') || overlay.visibility.groups.some((g) => groups.includes(g));
}

/**
 * Filter a tool's declared inputs for a caller: hidden inputs are ABSENT
 * (the caller never learns they exist); locked/choice inputs are annotated
 * so a shell can render the honest control state.
 */
export function filterInputs<T extends { id: string }>(
  inputs: T[],
  overlay: ToolOverlay | undefined,
  groups: string[],
): Array<T & { access?: ResolvedAccess }> {
  const out: Array<T & { access?: ResolvedAccess }> = [];
  for (const input of inputs) {
    const access = resolveInputAccess(overlay, input.id, groups);
    if (access.level === 'hidden') continue;
    out.push(access.level === 'editable' ? input : { ...input, access });
  }
  return out;
}

export interface ParamViolation {
  param: string;
  code: 'INPUT_LOCKED' | 'INPUT_HIDDEN' | 'INPUT_NOT_ALLOWED';
}

/**
 * Render-time enforcement: which supplied params does this caller's group
 * set forbid? (Hidden params are reported as violations too - a caller that
 * names an input it cannot see is probing, and 'hidden' must behave at least
 * as strictly as 'locked'.)
 */
export function checkParams(
  params: Record<string, unknown>,
  overlay: ToolOverlay | undefined,
  groups: string[],
): ParamViolation[] {
  const violations: ParamViolation[] = [];
  for (const [param, value] of Object.entries(params)) {
    const access = resolveInputAccess(overlay, param, groups);
    if (access.level === 'locked') violations.push({ param, code: 'INPUT_LOCKED' });
    else if (access.level === 'hidden') violations.push({ param, code: 'INPUT_HIDDEN' });
    else if (access.level === 'choice' && access.allow && !access.allow.some((a) => a === value)) {
      violations.push({ param, code: 'INPUT_NOT_ALLOWED' });
    }
  }
  return violations;
}

/** Locked values a render must use regardless of caller input. */
export function lockedValues(overlay: ToolOverlay | undefined, groups: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!overlay?.inputAccess) return out;
  for (const inputId of Object.keys(overlay.inputAccess)) {
    if (inputId === '*') continue;
    const access = resolveInputAccess(overlay, inputId, groups);
    if (access.level === 'locked' && 'value' in access) out[inputId] = access.value;
  }
  return out;
}

const ACCESS_LEVELS: AccessLevel[] = ['editable', 'choice', 'locked', 'hidden'];
const WATERMARKS = ['until-approved', 'always', 'never'] as const;

/**
 * Validate + normalize an overlay edit from the control plane (console/CLI)
 * into a storable ToolOverlay, bumping the version past `currentVersion` so
 * policyVersion (and with it org-config ETags and render cache keys) moves.
 * Returns null when the shape is invalid - the route answers 400, nothing is
 * half-written. Groups are trimmed, deduped, and never empty ('*' = everyone);
 * a 'choice' rule needs a non-empty allow list; only 'locked' rules carry a
 * baked value. An overlay that governs nothing (no rules, no visibility, no
 * enforce, no defaults) is returned with empty sections - storing it is a
 * legitimate "reset to ungoverned".
 */
export function normalizeOverlay(toolId: string, raw: unknown, currentVersion = 0): ToolOverlay | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const body = raw as {
    inputAccess?: unknown; visibility?: unknown; enforce?: unknown; defaults?: unknown;
  };
  const overlay: ToolOverlay = { toolId, version: currentVersion + 1 };

  const cleanGroups = (v: unknown): string[] | null => {
    if (!Array.isArray(v)) return null;
    const groups = [...new Set(v.filter((g): g is string => typeof g === 'string').map((g) => g.trim()).filter(Boolean))];
    return groups.length ? groups : null;
  };

  if (body.inputAccess !== undefined) {
    if (!body.inputAccess || typeof body.inputAccess !== 'object' || Array.isArray(body.inputAccess)) return null;
    const inputAccess: Record<string, InputRule[]> = {};
    for (const [inputId, rulesRaw] of Object.entries(body.inputAccess as Record<string, unknown>)) {
      if (!inputId || !Array.isArray(rulesRaw)) return null;
      const rules: InputRule[] = [];
      for (const r of rulesRaw) {
        const rule = r as Partial<InputRule>;
        if (!ACCESS_LEVELS.includes(rule?.level as AccessLevel)) return null;
        const groups = cleanGroups(rule.groups);
        if (!groups) return null;
        const out: InputRule = { groups, level: rule.level as AccessLevel };
        if (rule.level === 'locked' && 'value' in (rule as object)) out.value = rule.value;
        if (rule.level === 'choice') {
          if (!Array.isArray(rule.allow) || !rule.allow.length) return null;
          out.allow = rule.allow;
        }
        rules.push(out);
      }
      if (rules.length) inputAccess[inputId] = rules;
    }
    if (Object.keys(inputAccess).length) overlay.inputAccess = inputAccess;
  }

  if (body.visibility !== undefined && body.visibility !== null) {
    const groups = cleanGroups((body.visibility as { groups?: unknown }).groups);
    if (!groups) return null;
    overlay.visibility = { groups };
  }

  if (body.enforce !== undefined && body.enforce !== null) {
    if (typeof body.enforce !== 'object' || Array.isArray(body.enforce)) return null;
    const e = body.enforce as { watermark?: unknown; formats?: unknown };
    const enforce: NonNullable<ToolOverlay['enforce']> = {};
    if (e.watermark !== undefined) {
      if (!WATERMARKS.includes(e.watermark as typeof WATERMARKS[number])) return null;
      enforce.watermark = e.watermark as typeof WATERMARKS[number];
    }
    if (e.formats !== undefined) {
      const formats = Array.isArray(e.formats) ? e.formats.filter((f): f is string => typeof f === 'string' && !!f) : null;
      if (!formats) return null;
      if (formats.length) enforce.formats = formats;
    }
    if (Object.keys(enforce).length) overlay.enforce = enforce;
  }

  if (body.defaults !== undefined && body.defaults !== null) {
    if (typeof body.defaults !== 'object' || Array.isArray(body.defaults)) return null;
    if (Object.keys(body.defaults as object).length) overlay.defaults = body.defaults as Record<string, unknown>;
  }

  return overlay;
}

/** Catalog feed filtering: drop tools invisible to the caller (plans/06 §1). */
export function filterToolIndex<T extends { id: string }>(
  tools: T[],
  overlays: Map<string, ToolOverlay>,
  groups: string[],
): T[] {
  return tools.filter((t) => toolVisibleTo(overlays.get(t.id), groups));
}
