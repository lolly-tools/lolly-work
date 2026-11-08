// SPDX-License-Identifier: MPL-2.0
/**
 * Share anyway (plans/82 M4): an admin's choice to send one file the licence
 * gate holds back to one audience, a programme or one company in it.
 *
 * A choice is remembered against its facts, never as a switch. It carries a
 * fingerprint over the asset id, its checksum, its licence declaration as
 * recorded, the audience group and the rules version, made the way the
 * engine fingerprints a `RightsDecisionV1`: sha256 over canonical JSON. A new
 * version of the file, a changed licence record or a new rules version
 * retires the choice, and the report lists it as needing a new choice. A
 * choice names one file, so it never covers a file synced later.
 */
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import type { AssetIndexEntry } from '../catalog/lifecycle.ts';
import { rightsAnswer, type RightsEngine } from '../catalog/rights.ts';
import type { RightsChoicePick, Store } from '../store/types.ts';
import type { AuditEventBody } from '../audit/chain.ts';
import type { ExitRightsChoice, ExitRightsChoices } from './exit.ts';

export const CHOICE_NOTE_MAX = 500;
/** Files one request may choose at once (several held files in one folder). */
export const CHOICES_PER_REQUEST = 200;

export interface RightsChoiceRecord {
  assetId: string;
  /** The audience: `programme-<id>` or `company-<id>`. */
  group: string;
  programmeId: string;
  companyId?: string;
  /** The licence declaration as recorded when chosen, '' when none was. */
  declared: string;
  /** The licence name the engine gave, '' when none. */
  licence: string;
  /** Why the gate held the file, in the engine's words, when chosen. */
  reason: string;
  checksum: string;
  rulesVersion: string;
  fingerprint: string;
  note?: string;
  chosenBy: string;
  chosenAt: string;
}

/** The facts a choice is remembered against. */
export interface ChoiceFacts {
  assetId: string;
  checksum: string;
  declaration: string;
  group: string;
  rulesVersion: string;
}

/** One checksum form: hex sha256 as stored with a blob, `sha256-<base64>` as a feed states it. */
export function canonicalChecksum(c: string): string {
  return /^[0-9a-f]{64}$/i.test(c) ? `sha256-${Buffer.from(c, 'hex').toString('base64')}` : c;
}

/** The bytes a local pin serves for a federated file (plans/27): checksum by format, and the pin's version. */
export interface PinnedBytes { checksums: ReadonlyMap<string, string>; version: number }
export type PinLookup = (assetId: string) => PinnedBytes | undefined;

/** The pins among instance records, as the federated bytes route finds them. */
export function pinLookup(records: Iterable<{ id: string; origin?: { provider: string; remoteId: string }; entry: AssetIndexEntry; headVersion?: number }>): PinLookup {
  const pins = new Map<string, PinnedBytes>();
  for (const r of records) {
    if (!r.origin) continue;
    const checksums = new Map<string, string>();
    for (const f of Array.isArray(r.entry.formats) ? r.entry.formats : []) {
      const c = (f as { checksum?: unknown }).checksum;
      if (typeof c === 'string' && c) checksums.set(String((f as { format?: unknown }).format ?? ''), canonicalChecksum(c));
    }
    pins.set(`ext/${r.origin.provider}/${r.origin.remoteId}`, { checksums, version: r.headVersion ?? 1 });
  }
  return (id) => pins.get(id);
}

/**
 * The bytes a choice binds: every rendition the entry serves, its localised
 * ones included, each by its checksum in one form, with the entry's version
 * beside them. A federated file that is pinned here is served from the pin,
 * so the pin's checksums stand for the renditions it holds. Otherwise a
 * federated entry's version stands in for checksums the provider does not
 * give, but only when the provider stated when the file last changed: a
 * version made from static format details alone does not move with the
 * bytes. Null when the identity cannot be established, and a choice is
 * never remembered against bytes that could change under it.
 */
export function assetIdentity(entry: AssetIndexEntry, pins?: PinLookup): string | null {
  type Rendition = { format: string; checksum: string | null; locale?: string };
  const pin = typeof entry.id === 'string' ? pins?.(entry.id) : undefined;
  const renditions: Rendition[] = [];
  const add = (f: unknown, locale?: string): void => {
    if (!f || typeof f !== 'object') return;
    const r = f as { format?: unknown; checksum?: unknown };
    const format = String(r.format ?? '');
    const own = typeof r.checksum === 'string' && r.checksum ? canonicalChecksum(r.checksum) : null;
    renditions.push({ format, checksum: (!locale ? pin?.checksums.get(format) : undefined) ?? own, ...(locale ? { locale } : {}) });
  };
  for (const f of Array.isArray(entry.formats) ? entry.formats : []) add(f);
  const locales = (entry as { locales?: unknown }).locales;
  if (locales && typeof locales === 'object') {
    for (const [locale, list] of Object.entries(locales as Record<string, unknown>)) if (Array.isArray(list)) for (const f of list) add(f, locale);
  }
  const version = typeof entry.version === 'string' && entry.version ? entry.version : typeof entry.version === 'number' ? String(entry.version) : null;
  const summed = renditions.length > 0 && renditions.every((r) => r.checksum !== null);
  const revised = typeof (entry as { updatedAt?: unknown }).updatedAt === 'string' && !!(entry as { updatedAt?: string }).updatedAt;
  const federated = typeof entry.id === 'string' && entry.id.startsWith('ext/') && version !== null && revised;
  if (!summed && !federated) return null;
  // Where a file is served from is not what it is, so addresses stay out.
  renditions.sort((a, b) => (a.locale ?? '').localeCompare(b.locale ?? '') || a.format.localeCompare(b.format) || (a.checksum ?? '').localeCompare(b.checksum ?? ''));
  return `sha256:${sha256Hex(canonicalJson({ renditions, version, ...(pin ? { pin: pin.version } : {}) }))}`;
}

/** sha256 over the canonical facts, as `sha256:<hex>`. */
export function choiceFingerprint(facts: ChoiceFacts): string {
  return `sha256:${sha256Hex(canonicalJson({
    assetId: facts.assetId, checksum: facts.checksum, declaration: facts.declaration, group: facts.group, rulesVersion: facts.rulesVersion,
  }))}`;
}

/** The facts of one entry for one audience, now; null when its bytes have no identity. */
export function factsOf(engine: RightsEngine, entry: AssetIndexEntry, group: string, pins?: PinLookup): ChoiceFacts | null {
  const identity = assetIdentity(entry, pins);
  if (!identity) return null;
  return {
    assetId: entry.id, checksum: identity, declaration: engine.assetLicenceDeclaration(entry as Record<string, unknown>),
    group, rulesVersion: engine.RIGHTS_RULES_VERSION,
  };
}

/** The fingerprint a choice for this entry and audience carries now, or null
 *  when its bytes have no identity: a null never matches a stored choice. */
export function currentFingerprint(engine: RightsEngine, entry: AssetIndexEntry, group: string, pins?: PinLookup): string | null {
  const facts = factsOf(engine, entry, group, pins);
  return facts ? choiceFingerprint(facts) : null;
}

/**
 * How a choice compares with the file as it is now: `live` (the facts it
 * was made about still hold and the file is still held), `needs-choosing`
 * (the facts moved, so the choice no longer counts), `not-needed` (the file
 * now travels without it) or `gone` (the file is no longer in the feed).
 */
export type ChoiceStanding = 'live' | 'needs-choosing' | 'not-needed' | 'gone';

export function choiceStanding(engine: RightsEngine, choice: RightsChoiceRecord, entry: AssetIndexEntry | undefined, companies: ReadonlySet<string> = new Set(), pins?: PinLookup): ChoiceStanding {
  if (!entry) return 'gone';
  if (rightsAnswer(engine, entry, companies).state !== 'held') return 'not-needed';
  return currentFingerprint(engine, entry, choice.group, pins) === choice.fingerprint ? 'live' : 'needs-choosing';
}

/** The asset ids a caller holding `groups` receives through a live choice. */
export function liveChoiceIds(engine: RightsEngine, choices: readonly RightsChoiceRecord[], groups: ReadonlySet<string>, entries: ReadonlyMap<string, AssetIndexEntry>): Set<string> {
  const out = new Set<string>();
  for (const choice of choices) {
    if (!groups.has(choice.group)) continue;
    if (choiceStanding(engine, choice, entries.get(choice.assetId)) === 'live') out.add(choice.assetId);
  }
  return out;
}

/** Makes the audit event a store writes in the same transaction as a choice. */
export type AuditBodyOf = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => AuditEventBody;
const plainBody: AuditBodyOf = (actor, action, subject, payload) => ({ at: new Date().toISOString(), actor, action, subject, ...(payload ? { payload } : {}) });

/** The audit event for one withdrawn choice. */
export function withdrawEvent(bodyOf: AuditBodyOf, actor: string, c: RightsChoiceRecord, via: string): AuditEventBody {
  return bodyOf(actor, 'programme.rights.withdraw', `programme:${c.programmeId}`, { assetId: c.assetId, group: c.group, licence: c.declared, fingerprint: c.fingerprint, via });
}

/**
 * Withdraw every choice made for a programme (its companies' included) or for
 * one company, each audited as `programme.rights.withdraw` with `via`, the
 * deletes and their events in one transaction. Ending a partnership (M5) and
 * deleting a programme or company call this. A withdrawn choice is not
 * restored later: it was remembered against its facts, so the admin chooses
 * again where needed, and a programme or company made later with the same id
 * starts with none.
 */
export async function withdrawRightsChoices(store: Store, bodyOf: AuditBodyOf, actor: string, pick: { programmeId?: string; companyId?: string }, via: string): Promise<RightsChoiceRecord[]> {
  const which: RightsChoicePick | null = pick.companyId ? { companyId: pick.companyId } : pick.programmeId ? { programmeId: pick.programmeId } : null;
  if (!which) return [];
  return store.withdrawRightsChoicesAudited(which, (c) => withdrawEvent(bodyOf, actor, c, via));
}

/** A choice as an exit lists it: the file, the audience and the licence recorded. */
const exitView = (c: RightsChoiceRecord): ExitRightsChoice => ({ assetId: c.assetId, group: c.group, ...(c.declared ? { licence: c.declared } : {}) });

/**
 * The share anyway store as ending a partnership needs it (plans/82 M5): the
 * choices a programme or company holds, and their withdrawal, audited as
 * `programme.rights.withdraw` with the exit's `via`. The exit route, the
 * minute sweep for scheduled ends and the delete routes take the same object.
 */
export function exitRightsChoices(store: Store, bodyOf: AuditBodyOf = plainBody): ExitRightsChoices {
  return {
    list: async (pick) => (await store.listRightsChoices())
      .filter((c) => (pick.companyId ? c.companyId === pick.companyId : !!pick.programmeId && c.programmeId === pick.programmeId))
      .map(exitView),
    withdraw: async (actor, pick, via) => (await withdrawRightsChoices(store, bodyOf, actor, pick, via)).map(exitView),
    deleteAudience: async (actor, target, via) => (await store.deleteAudienceWithChoices(target, (c) => withdrawEvent(bodyOf, actor, c, via))).map(exitView),
  };
}

