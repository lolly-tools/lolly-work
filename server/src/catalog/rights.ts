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
  /** The `.lolly` credits text, for a collection ZIP. */
  packCreditsText(carried: ReadonlyArray<{ label: string; id: string; path: string; licence?: string; credit?: string; notices?: string[]; includedByChoice?: true }>, heldBack: readonly never[]): string;
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

// -- Marks and licence records (plans/82 M4, W-M4-2) -------------------------
//
// A brand team that recorded no licences states, once, that a folder, a
// provider, an id prefix or one file is its own. A mark is a catalog
// statement, not proof: it reaches only a file whose own record declares
// nothing, and it reaches it as one owner-published record, the exact record
// the engine's `ownerPublished()` reads. A licence record is the admin's own
// record of one file's licence, for a file that carries none. Neither ever
// replaces what a file records itself, and neither is written back to a
// provider: both live in Work's own tables.

/** The fixed declaration a mark records, so a machine reader sees an identifier and not prose. */
export const OWNER_PUBLISHED_DECLARATION = 'LicenseRef-Owner-Published';
export const MARK_HOLDER_MAX = 256;
export const MARK_TERMS_MAX = 1024;
export const RIGHTS_NOTE_MAX = 500;
export const LICENCE_DECLARATION_MAX = 200;
export const LICENCE_ATTRIBUTION_MAX = 1024;

/** One mark: who the holder is, on what terms, and who stated it and when. */
export interface AssetRightsMarkRecord {
  /** `asset:<id>`, `folder:<provider>/<path>`, `provider:<id>` or `prefix:<id prefix>`. */
  scope: string;
  holder: string;
  terms: string;
  note?: string;
  statedBy: string;
  statedAt: string;
  /** Files with no record of their own that the mark covered when it was stated. */
  coveredAtStatement?: number;
}

/** The admin's own record of one file's licence. */
export interface AssetLicenceRecord {
  assetId: string;
  /** The declaration exactly as typed. */
  declaration: string;
  attribution?: string;
  note?: string;
  recordedBy: string;
  recordedAt: string;
}

export type MarkScope =
  | { kind: 'asset'; id: string }
  | { kind: 'folder'; provider: string; path: string }
  | { kind: 'provider'; provider: string }
  | { kind: 'prefix'; prefix: string };

const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]*\/(?:[A-Za-z0-9._-]+\/)*$/;

/** Read a scope string, or null when it is not one of the four. */
export function parseMarkScope(raw: unknown): MarkScope | null {
  if (typeof raw !== 'string' || raw.length > 1100) return null;
  const at = raw.indexOf(':');
  if (at < 1) return null;
  const kind = raw.slice(0, at);
  const rest = raw.slice(at + 1);
  if (kind === 'asset') return ASSET_ID.test(rest) && !rest.includes('..') ? { kind, id: rest } : null;
  if (kind === 'provider') return PROVIDER_ID.test(rest) ? { kind, provider: rest } : null;
  if (kind === 'folder') {
    const slash = rest.indexOf('/');
    if (slash < 1) return null;
    const provider = rest.slice(0, slash);
    const segments = rest.slice(slash + 1).split('/').map((s) => s.trim()).filter(Boolean);
    if (!PROVIDER_ID.test(provider) || !segments.length || segments.some((s) => s === '.' || s === '..' || /[\u0000-\u001f]/.test(s))) return null;
    const path = segments.join('/');
    return path.length <= 1024 ? { kind, provider, path } : null;
  }
  if (kind === 'prefix') {
    if (!PREFIX.test(rest) || rest.length > 512 || rest.startsWith('ext/') || rest.startsWith('inst/')) return null;
    return { kind, prefix: rest };
  }
  return null;
}

/** The canonical string for a scope, so one statement has one key. */
export function markScopeKey(scope: MarkScope): string {
  switch (scope.kind) {
    case 'asset': return `asset:${scope.id}`;
    case 'folder': return `folder:${scope.provider}/${scope.path}`;
    case 'provider': return `provider:${scope.provider}`;
    case 'prefix': return `prefix:${scope.prefix}`;
  }
}

const folderOfEntry = (entry: AssetIndexEntry): string | undefined => {
  const folder = (entry.meta as { providerFolder?: unknown } | undefined)?.providerFolder;
  return typeof folder === 'string' ? folder : undefined;
};

/**
 * How narrowly a scope covers an entry, or 0 when it does not: one file,
 * then the longest folder path, then the whole provider, then the longest id
 * prefix.
 */
export function markCovers(scope: MarkScope, entry: AssetIndexEntry): number {
  switch (scope.kind) {
    case 'asset': return entry.id === scope.id ? 4_000_000 : 0;
    case 'folder': {
      if (!entry.id.startsWith(`ext/${scope.provider}/`)) return 0;
      const folder = folderOfEntry(entry);
      return folder !== undefined && (folder === scope.path || folder.startsWith(`${scope.path}/`)) ? 3_000_000 + scope.path.length : 0;
    }
    case 'provider': return entry.id.startsWith(`ext/${scope.provider}/`) ? 2_000_000 : 0;
    case 'prefix': return entry.id.startsWith(scope.prefix) && !entry.id.startsWith('ext/') && !entry.id.startsWith('inst/') ? 1_000_000 + scope.prefix.length : 0;
  }
}

/** The narrowest mark covering an entry, or null. */
export function narrowestMark(entry: AssetIndexEntry, marks: ReadonlyArray<{ scope: MarkScope; mark: AssetRightsMarkRecord }>): AssetRightsMarkRecord | null {
  let best: AssetRightsMarkRecord | null = null;
  let rank = 0;
  for (const { scope, mark } of marks) {
    const r = markCovers(scope, entry);
    if (r > rank) { rank = r; best = mark; }
  }
  return best;
}

/** The terms a mark carries when the brand team writes none of its own. */
export function defaultMarkTerms(holder: string): string {
  return `Published by ${holder} for the people and partner programmes of this workspace to use in their work. Not an open licence.`;
}

/**
 * The one record a mark composes onto a file: the owner, the fixed
 * declaration and an asserted own-work grant holding the terms. It never
 * names who stated the mark; that stays in the console and the audit.
 */
export function ownerPublishedRecord(entryId: string, mark: AssetRightsMarkRecord): Record<string, unknown> {
  return {
    works: [{
      id: entryId,
      creators: [{ name: mark.holder, role: 'owner' }],
      rights: [{ declaration: OWNER_PUBLISHED_DECLARATION, assertedBy: 'catalog', evidence: 'catalog-entry', status: 'unparsed', capturedAt: mark.statedAt }],
      grants: [{ kind: 'own-work', scope: mark.terms, asserted: true }],
    }],
  };
}

/** Where a file's licence answer comes from. */
export type RightsSource = 'own' | 'licence-record' | 'mark' | 'none';

/**
 * Compose licence records and marks onto every entry that records nothing
 * of its own. A licence record answers first, then the narrowest mark. An
 * entry with a declaration of its own is returned as it is, so a pack record,
 * a provider's value or a reviewed licence is never overwritten.
 */
export function composeRightsRecords(
  engine: Pick<RightsEngine, 'assetLicenceDeclaration'>,
  entries: readonly AssetIndexEntry[],
  marks: readonly AssetRightsMarkRecord[],
  licences: readonly AssetLicenceRecord[],
): AssetIndexEntry[] {
  if (!marks.length && !licences.length) return entries as AssetIndexEntry[];
  const scoped = marks.flatMap((mark) => {
    const scope = parseMarkScope(mark.scope);
    return scope ? [{ scope, mark }] : [];
  });
  const byAsset = new Map(licences.map((l) => [l.assetId, l]));
  return entries.map((entry) => {
    if (engine.assetLicenceDeclaration(entry as Record<string, unknown>)) return entry;
    const licence = byAsset.get(entry.id);
    if (licence) {
      const hasAttribution = typeof entry.attribution === 'string' && entry.attribution.trim();
      return { ...entry, license: licence.declaration, ...(licence.attribution && !hasAttribution ? { attribution: licence.attribution } : {}) };
    }
    const mark = narrowestMark(entry, scoped);
    return mark ? { ...entry, rights: ownerPublishedRecord(entry.id, mark) } : entry;
  });
}

/** Which record decides an entry's answer, read from the entry before composition. */
export function rightsSourceOf(
  engine: Pick<RightsEngine, 'assetLicenceDeclaration'>,
  entry: AssetIndexEntry,
  marks: readonly AssetRightsMarkRecord[],
  licences: readonly AssetLicenceRecord[],
): { source: RightsSource; mark?: AssetRightsMarkRecord; licence?: AssetLicenceRecord } {
  if (engine.assetLicenceDeclaration(entry as Record<string, unknown>)) return { source: 'own' };
  const licence = licences.find((l) => l.assetId === entry.id);
  if (licence) return { source: 'licence-record', licence };
  const mark = narrowestMark(entry, marks.flatMap((m) => { const scope = parseMarkScope(m.scope); return scope ? [{ scope, mark: m }] : []; }));
  return mark ? { source: 'mark', mark } : { source: 'none' };
}
