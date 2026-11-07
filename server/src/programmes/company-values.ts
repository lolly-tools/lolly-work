// SPDX-License-Identifier: MPL-2.0
/**
 * Company values in tools (plans/82 M3, section 3): how a published template
 * or a tool takes a partner company's logo and details.
 *
 * Declaring: a published template's `publication.bindings` and a tool
 * overlay's `bindings` map an input id to a company field (`logo`, `name`,
 * `contact` and the rest of COMPANY_FIELDS). Resolving happens here, once, for
 * every place that asks: org-config for the app, the effective schema for
 * agents, Preview for admins and server renders.
 *
 * Order, most specific first: the caller's own value (unless the input is
 * locked), then the caller's company profile, then the template's values, then
 * the overlay's group defaults, then the tool's own default. An input a
 * template binds and leaves out of its `editable` list is locked to the company
 * value; so is every input a rules tool binds, since a rules tool has no list of
 * its own to leave one out of; and an input an overlay binds is locked to it
 * when the overlay's own rule already locks that input for the caller. A bound
 * input left editable is pre-filled and free.
 *
 * Which company: the one among the caller's groups that the template was
 * published to, else the caller's only company. Two candidates mean no company
 * values at all: the bound inputs open up with the tool's default, and nothing
 * names a company. Never a guess.
 */
import { resolveInputAccess, type InputRule, type ResolvedAccess, type ToolOverlay } from '../policy/overlay.ts';
import { COMPANY_GROUP_PREFIX, isCompanyGroup, isProgrammeGroup, programmeGroup } from './types.ts';
import type { CompanyRecord } from './people.ts';
import type { ProgrammeRecord } from './types.ts';
import { contactLine, type CompanyProfile } from './profile.ts';

export const COMPANY_FIELDS = [
  'name', 'logo', 'logoLight', 'logoDark', 'mark', 'website', 'contact', 'contactEmail', 'contactPhone', 'address', 'currency', 'taxNote',
] as const;
export type CompanyField = (typeof COMPANY_FIELDS)[number];
export type Bindings = Record<string, CompanyField>;

/** Fields whose value is a logo asset. */
export const LOGO_FIELDS: ReadonlySet<CompanyField> = new Set(['logo', 'logoLight', 'logoDark', 'mark']);

/** The words the console and Preview use for each field. */
export const FIELD_LABELS: Record<CompanyField, string> = {
  name: 'Company name', logo: 'Logo (by mode)', logoLight: 'Logo for light surfaces', logoDark: 'Logo for dark surfaces', mark: 'Mark',
  website: 'Website', contact: 'Contact', contactEmail: 'Contact email', contactPhone: 'Contact phone', address: 'Address', currency: 'Currency', taxNote: 'Tax note',
};

const INPUT_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * Validate a bindings map against the inputs it may name. An unknown input or
 * field is refused rather than dropped, the way `editable` refuses an unknown
 * id. `null` (or an empty map) clears the bindings.
 */
export function normalizeBindings(raw: unknown, inputIds?: readonly string[]): { bindings: Bindings | undefined } | { error: string } {
  if (raw === null || raw === undefined) return { bindings: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'bindings must map input ids to company fields' };
  const known = inputIds ? new Set(inputIds) : null;
  const out: Bindings = {};
  for (const [id, field] of Object.entries(raw as Record<string, unknown>)) {
    if (!INPUT_ID.test(id)) return { error: 'bindings must map input ids to company fields' };
    if (known && !known.has(id)) return { error: `the tool has no input "${id}"` };
    if (typeof field !== 'string' || !(COMPANY_FIELDS as readonly string[]).includes(field)) {
      return { error: `"${String(field).slice(0, 40)}" is not a company field: ${COMPANY_FIELDS.join(', ')}` };
    }
    out[id] = field as CompanyField;
  }
  return { bindings: Object.keys(out).length ? out : undefined };
}

/** What a company gives: its record, programme and current profile. */
export interface CompanyContext {
  company: Pick<CompanyRecord, 'id' | 'name' | 'programmeId'>;
  programme?: Pick<ProgrammeRecord, 'id' | 'name'>;
  revision: number;
  profile: CompanyProfile;
}

/**
 * The one company a caller speaks for. `publishedTo` is a template's audience
 * when the caller starts from one: a company in it, or in a programme in it,
 * is preferred over the caller's other companies.
 */
export function pickCompany(groups: readonly string[], companies: readonly CompanyRecord[], publishedTo?: readonly string[]): { company?: CompanyRecord; ambiguous: boolean } {
  const mine = companies.filter((c) => groups.includes(`${COMPANY_GROUP_PREFIX}${c.id}`));
  if (mine.length <= 1) return { ...(mine[0] ? { company: mine[0] } : {}), ambiguous: false };
  if (publishedTo?.length) {
    const reached = mine.filter((c) => publishedTo.includes(`${COMPANY_GROUP_PREFIX}${c.id}`) || publishedTo.includes(programmeGroup(c.programmeId)));
    if (reached.length === 1) return { company: reached[0]!, ambiguous: false };
  }
  return { ambiguous: true };
}

/** The programme a piece belongs to: the one that published the template
 *  (directly, or through a company in it) among the caller's own, else the
 *  caller's only programme, else none. Never a list and never a guess. */
export function pickProgramme(groups: readonly string[], companies: readonly CompanyRecord[], publishedTo?: readonly string[]): string | undefined {
  const strip = (g: string) => g.slice('programme-'.length);
  const mine = groups.filter(isProgrammeGroup).map(strip);
  if (publishedTo?.length) {
    const reached = new Set<string>();
    for (const g of publishedTo) {
      if (isProgrammeGroup(g) && mine.includes(strip(g))) reached.add(strip(g));
      if (isCompanyGroup(g) && groups.includes(g)) {
        const c = companies.find((x) => `${COMPANY_GROUP_PREFIX}${x.id}` === g);
        if (c && mine.includes(c.programmeId)) reached.add(c.programmeId);
      }
    }
    if (reached.size) return reached.size === 1 ? [...reached][0] : undefined;
  }
  return mine.length === 1 ? mine[0] : undefined;
}

export type Theme = 'light' | 'dark';

/** The mode a render draws in, from the token selection it parsed (`_themes`). */
export function themeOf(selection: unknown): Theme {
  if (!selection || typeof selection !== 'object') return 'light';
  return Object.values(selection as Record<string, unknown>).some((v) => typeof v === 'string' && /^dark$/i.test(v)) ? 'dark' : 'light';
}

/** The value one company field gives, for a theme. Undefined when the company has none. */
export function fieldValue(field: CompanyField, ctx: CompanyContext, theme: Theme): string | undefined {
  const p = ctx.profile;
  switch (field) {
    case 'name': return ctx.company.name;
    // The logo for the mode, falling back to the other surface's logo: the
    // company's own mark is always better than the lead brand's placeholder.
    case 'logo': return theme === 'dark' ? p.logoDark ?? p.logoLight : p.logoLight ?? p.logoDark;
    case 'logoLight': return p.logoLight;
    case 'logoDark': return p.logoDark;
    case 'mark': return p.mark;
    case 'website': return p.website;
    case 'contact': return contactLine(p.contact);
    case 'contactEmail': return p.contact?.email;
    case 'contactPhone': return p.contact?.phone;
    case 'address': return p.address;
    case 'currency': return p.currency;
    case 'taxNote': return p.taxNote;
  }
}

/** How each bound input is treated for one caller. */
export interface BindingPlan {
  /** Input id to company field, the template's bindings over the overlay's. */
  bound: Bindings;
  /** Company values for bound inputs, by input id (asset ids for logo fields). */
  values: Record<string, string>;
  /** Bound inputs locked to their company value. */
  locked: string[];
  /** True when the caller speaks for two companies: the bound inputs open up
   *  with the tool's default instead. */
  ambiguous: boolean;
}

/**
 * Decide, for one caller and one tool, which inputs take company values and
 * which of those are locked.
 */
export function planBindings(opts: {
  overlayBindings?: Bindings;
  templateBindings?: Bindings;
  /** A tool template's editable list; absent means no rules. */
  templateEditable?: readonly string[];
  /** A rules tool locks every input it binds. */
  rulesTool?: boolean;
  /** Whether the overlay's own rule locks an input for this caller. */
  overlayLocks(id: string): boolean;
  ctx: CompanyContext | null;
  ambiguous: boolean;
  theme: Theme;
}): BindingPlan {
  const bound: Bindings = { ...opts.overlayBindings, ...opts.templateBindings };
  const plan: BindingPlan = { bound, values: {}, locked: [], ambiguous: opts.ambiguous && Object.keys(bound).length > 0 };
  if (!opts.ctx || opts.ambiguous) return plan;
  for (const [id, field] of Object.entries(bound)) {
    const value = fieldValue(field, opts.ctx, opts.theme);
    if (value === undefined) continue;
    plan.values[id] = value;
    const fromTemplate = !!opts.templateBindings && Object.hasOwn(opts.templateBindings, id);
    const lock = fromTemplate
      ? opts.rulesTool || (!!opts.templateEditable && !opts.templateEditable.includes(id))
      : opts.overlayLocks(id);
    if (lock) plan.locked.push(id);
  }
  return plan;
}

const ruleOf = (access: ResolvedAccess): InputRule => {
  const rule: InputRule = { groups: ['*'], level: access.level };
  if ('value' in access && access.value !== undefined) rule.value = access.value;
  if (access.allow) rule.allow = access.allow;
  if (access.reason) rule.reason = access.reason;
  if (access.by) rule.by = access.by;
  return rule;
};

/**
 * The overlay a caller's render enforces once company values apply: a bound
 * input the plan locks is locked to its company value (an input the tool's own
 * rules hide stays hidden), and when the caller speaks for two companies, a
 * bound input the template fixed opens up with the tool's own rule. `value`
 * maps a company value to what the render bakes (an asset id becomes the
 * resolved asset), so the same plan serves a render and a schema.
 */
export function bindOverlay(
  overlay: ToolOverlay | undefined,
  toolOverlay: ToolOverlay | undefined,
  plan: BindingPlan,
  groups: string[],
  toolId: string,
  companyName?: string,
  value: (id: string, raw: string) => unknown = (_id, raw) => raw,
): ToolOverlay | undefined {
  const ids = plan.ambiguous ? Object.keys(plan.bound) : plan.locked;
  if (!ids.length) return overlay;
  const inputAccess: Record<string, InputRule[]> = { ...overlay?.inputAccess };
  for (const id of ids) {
    const own = resolveInputAccess(toolOverlay, id, groups);
    if (plan.ambiguous) { inputAccess[id] = [ruleOf(own)]; continue; }
    if (own.level === 'hidden') { inputAccess[id] = [ruleOf(own)]; continue; }
    inputAccess[id] = [{ groups: ['*'], level: 'locked', value: value(id, plan.values[id]!),
      ...(companyName ? { by: `${companyName} details` } : {}), reason: 'Set from the company profile' }];
  }
  return { ...(overlay ?? { toolId, version: 0 }), inputAccess };
}

/** An overlay's defaults as group rules. The old flat shape is everyone's. */
export interface DefaultsRule { groups: string[]; values: Record<string, unknown> }

export function defaultsRules(defaults: ToolOverlay['defaults']): DefaultsRule[] {
  if (!defaults) return [];
  if (Array.isArray(defaults)) return defaults;
  return Object.keys(defaults).length ? [{ groups: ['*'], values: defaults }] : [];
}

/**
 * The overlay defaults that apply to these groups, merged least specific
 * first: everyone (`*`), then other groups, then a programme's, then a
 * company's, so the most specific value wins.
 */
export function defaultsFor(overlay: ToolOverlay | undefined, groups: readonly string[]): Record<string, unknown> {
  const rank = (rule: DefaultsRule): number => {
    const matched = rule.groups.filter((g) => g === '*' || groups.includes(g));
    if (!matched.length) return -1;
    return Math.max(...matched.map((g) => g === '*' ? 0 : isCompanyGroup(g) ? 3 : isProgrammeGroup(g) ? 2 : 1));
  };
  const rules = defaultsRules(overlay?.defaults).map((rule, at) => ({ rule, at, rank: rank(rule) })).filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.at - b.at);
  return Object.assign({}, ...rules.map((r) => r.rule.values)) as Record<string, unknown>;
}
