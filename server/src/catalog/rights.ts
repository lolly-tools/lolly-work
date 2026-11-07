// SPDX-License-Identifier: MPL-2.0
/**
 * Licence records and what may leave the organisation (plans/82 M4).
 *
 * One question decides whether a catalog file may reach a partner, or anyone
 * holding a link: may these bytes be passed on? The answer comes from the
 * engine's `redistribution()`, the same function the app's `.lolly` builder
 * asks, so the server and the app give one answer with one reason. This module
 * adds only what a server needs around that answer:
 *
 * - the files that never wait on a licence record (the design system the
 *   programme exists to apply, the files the brand team authored and
 *   published, and a company's own supplied files for that company);
 * - a category for each held answer, so a report can count by reason, with
 *   the wording for a licence expression (`A OR B`, `A AND B`) that the engine
 *   holds as not recognised.
 *
 * It decides nothing about who asks. The caller says whether the gate applies.
 * Pure once the engine is loaded: no store, no clock and no network.
 */
import type { AssetIndexEntry } from './lifecycle.ts';

/**
 * Asset types that reach a programme whatever their licence record says.
 * `tokens`, `font` and `palette` are the design system the programme exists to
 * apply (a font's licence is not read yet; recording font licences is a later
 * step). `template`, `rules-tool` and `user-tool` are JSON the brand team
 * authored and published to the programme.
 */
export const RIGHTS_EXEMPT_TYPES: ReadonlySet<string> = new Set(['tokens', 'font', 'palette', 'template', 'rules-tool', 'user-tool']);

/** Why a file is exempt from the licence question. */
export type ExemptWhy = 'design-system' | 'published-by-brand-team' | 'company-own';

/** Why a file is held back, as a report counts it. */
export type HeldCategory =
  | 'not-recorded'
  | 'not-interpreted'
  | 'not-recognised'
  | 'identifier'
  | 'no-permission'
  | 'own-work-incomplete'
  | 'policy';

/** The words a report prints for each held category. */
export const HELD_LABEL: Readonly<Record<HeldCategory, string>> = {
  'not-recorded': 'licence not recorded',
  'not-interpreted': 'conditions recorded and not interpreted',
  'not-recognised': 'licence not recognised',
  identifier: 'an identifier these rules do not carry',
  'no-permission': 'a licence that records no permission to pass the file on',
  'own-work-incomplete': 'an own-work record with a part missing',
  policy: 'deployment policy',
};

/** The engine's answer, as `redistribution()` returns it. */
interface EngineRedistribution {
  travels: boolean;
  reason: string;
  kind: 'policy' | 'licence' | 'unknown';
  licence: string;
  notices: string[];
  owner?: { holder: string; terms: string };
}

/** The engine functions this module calls. */
export interface RightsEngine {
  redistribution(meta: Record<string, unknown>): EngineRedistribution;
  assetLicenceDeclaration(meta: Record<string, unknown>): string;
  normaliseLicence(text: string): { id: string | null; reviewed: boolean };
  licenceProfile(id: string | null): { name: string; reviewed: boolean; conditions: string[] } | null;
  readLicenceExpression(text: string): { operator: 'single' | 'or' | 'and'; terms: Array<{ id: string | null }> };
  RIGHTS_RULES_VERSION: string;
}

// A non-literal specifier keeps tsc from pulling the engine's browser-lib .ts
// source into this project's program, as the other catalog modules do.
const ENGINE_SPEC: string = '@lolly/engine';
let loading: Promise<RightsEngine> | null = null;

/** The engine's rights functions, loaded once. */
export function loadRightsEngine(): Promise<RightsEngine> {
  loading ??= (import(ENGINE_SPEC) as Promise<RightsEngine>).catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** One file's answer. `travels` and `exempt` both mean the bytes may go. */
export type RightsAnswer =
  | { state: 'exempt'; why: ExemptWhy }
  | {
    state: 'travels';
    /** The licence name, or "Owner-published, not an open licence". */
    licence: string;
    /** The declaration as recorded. */
    declared: string;
    notices: string[];
    owner?: { holder: string; terms: string };
  }
  | {
    state: 'held';
    category: HeldCategory;
    /** The engine's own sentence. */
    reason: string;
    /** Which kind of rule held the bytes, as the credits file prints it. */
    kind: 'policy' | 'licence' | 'unknown';
    /** The licence name, or '' when nothing names one. */
    licence: string;
    /** The declaration as recorded, kept whole for the report. */
    declared: string;
    /** For a licence recorded and not interpreted: its elements ("Attribution, NonCommercial"). */
    conditions?: string[];
    /** For an expression: what it says, in plain words. */
    detail?: string;
  };

const OR_DETAIL = 'a choice of licences the rights holder offered, none selected';
const AND_DETAIL = 'cumulative; these rules record both and read neither as one';

/** The company id an entry's own supplied file belongs to, if any (`meta.company`, plans/82 M3). */
export function entryCompany(entry: AssetIndexEntry): string | undefined {
  const company = (entry.meta as { company?: unknown } | undefined)?.company;
  return typeof company === 'string' && company ? company : undefined;
}

/**
 * Why an entry never waits on a licence record, or null. A company's own file
 * is exempt only for that company: `companies` holds the company ids the
 * caller belongs to.
 */
export function exemptWhy(entry: AssetIndexEntry, companies: ReadonlySet<string> = new Set()): ExemptWhy | null {
  const type = typeof entry.type === 'string' ? entry.type : '';
  if (type === 'tokens' || type === 'font' || type === 'palette') return 'design-system';
  if (RIGHTS_EXEMPT_TYPES.has(type)) return 'published-by-brand-team';
  const company = entryCompany(entry);
  if (company && companies.has(company)) return 'company-own';
  return null;
}

/**
 * Sort an engine answer that holds bytes into the report's categories. The
 * engine's own reason travels unchanged beside the category.
 */
function categorise(engine: RightsEngine, entry: AssetIndexEntry, answer: EngineRedistribution, declared: string): RightsAnswer {
  const base = { state: 'held' as const, reason: answer.reason, kind: answer.kind, licence: answer.licence, declared };
  if (answer.kind === 'policy') return { ...base, category: 'policy' };
  if (!declared) {
    // The own-work record holds the only declaration, or nothing does.
    return answer.reason === 'licence not recorded' ? { ...base, category: 'not-recorded' } : { ...base, category: 'own-work-incomplete' };
  }
  const normalised = engine.normaliseLicence(declared);
  const profile = normalised.id ? engine.licenceProfile(normalised.id) : null;
  if (profile?.reviewed) return { ...base, category: 'no-permission' };
  if (profile) return { ...base, category: 'not-interpreted', conditions: [...profile.conditions] };
  if (normalised.id && /^licenseref-/i.test(normalised.id)) {
    // An own-work record that left a part out says so before the identifier does.
    if (answer.reason.startsWith('the own-work record')) return { ...base, category: 'own-work-incomplete' };
    return { ...base, category: 'identifier' };
  }
  if (normalised.id) return { ...base, category: 'not-interpreted' };
  if (answer.reason.startsWith('the own-work record')) return { ...base, category: 'own-work-incomplete' };
  const expression = engine.readLicenceExpression(declared);
  if (expression.operator === 'or') return { ...base, category: 'not-recognised', detail: OR_DETAIL };
  if (expression.operator === 'and') return { ...base, category: 'not-recognised', detail: AND_DETAIL };
  return { ...base, category: 'not-recognised' };
}

/**
 * May this catalog file leave the organisation? `companies` names the
 * companies the receiver belongs to, for the company-own exemption; a bearer
 * link has none.
 */
export function rightsAnswer(engine: RightsEngine, entry: AssetIndexEntry, companies: ReadonlySet<string> = new Set()): RightsAnswer {
  const exempt = exemptWhy(entry, companies);
  if (exempt) return { state: 'exempt', why: exempt };
  const answer = engine.redistribution(entry as Record<string, unknown>);
  const declared = engine.assetLicenceDeclaration(entry as Record<string, unknown>);
  if (answer.travels) {
    return { state: 'travels', licence: answer.licence, declared, notices: answer.notices, ...(answer.owner ? { owner: answer.owner } : {}) };
  }
  return categorise(engine, entry, answer, declared);
}

/** The same answer, loading the engine first. */
export async function assetRedistribution(entry: AssetIndexEntry, companies: ReadonlySet<string> = new Set()): Promise<RightsAnswer> {
  return rightsAnswer(await loadRightsEngine(), entry, companies);
}
