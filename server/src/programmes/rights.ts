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
import type { Store } from '../store/types.ts';
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

/**
 * The checksum a choice binds: the head format's own checksum where the
 * catalog records one, else the entry's version (a federated entry's hash of
 * its upstream date and formats). Either moves when the file does.
 */
export function assetChecksum(entry: AssetIndexEntry): string {
  const head = Array.isArray(entry.formats) ? entry.formats.find((f) => f && f.format !== 'thumb') : undefined;
  const checksum = (head as { checksum?: unknown } | undefined)?.checksum;
  if (typeof checksum === 'string' && checksum) return checksum;
  return typeof entry.version === 'string' ? entry.version : '';
}

/** sha256 over the canonical facts, as `sha256:<hex>`. */
export function choiceFingerprint(facts: ChoiceFacts): string {
  return `sha256:${sha256Hex(canonicalJson({
    assetId: facts.assetId, checksum: facts.checksum, declaration: facts.declaration, group: facts.group, rulesVersion: facts.rulesVersion,
  }))}`;
}

/** The facts of one entry for one audience, now. */
export function factsOf(engine: RightsEngine, entry: AssetIndexEntry, group: string): ChoiceFacts {
  return {
    assetId: entry.id, checksum: assetChecksum(entry), declaration: engine.assetLicenceDeclaration(entry as Record<string, unknown>),
    group, rulesVersion: engine.RIGHTS_RULES_VERSION,
  };
}

/**
 * How a choice compares with the file as it is now: `live` (the facts it
 * was made about still hold and the file is still held), `needs-choosing`
 * (the facts moved, so the choice no longer counts), `not-needed` (the file
 * now travels without it) or `gone` (the file is no longer in the feed).
 */
export type ChoiceStanding = 'live' | 'needs-choosing' | 'not-needed' | 'gone';

export function choiceStanding(engine: RightsEngine, choice: RightsChoiceRecord, entry: AssetIndexEntry | undefined, companies: ReadonlySet<string> = new Set()): ChoiceStanding {
  if (!entry) return 'gone';
  if (rightsAnswer(engine, entry, companies).state !== 'held') return 'not-needed';
  return choiceFingerprint(factsOf(engine, entry, choice.group)) === choice.fingerprint ? 'live' : 'needs-choosing';
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

type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

/**
 * Withdraw every choice made for a programme or for one company, auditing
 * each as `programme.rights.withdraw` with `via`. Ending a partnership (M5)
 * calls this. A withdrawn choice is not restored later: it was remembered
 * against its facts, so the admin chooses again where needed.
 */
export async function withdrawRightsChoices(store: Store, audit: Audit, actor: string, pick: { programmeId?: string; companyId?: string }, via: string): Promise<RightsChoiceRecord[]> {
  // A programme's own choices and its companies' carry its id; a company's carry the company's.
  const gone = (await store.listRightsChoices()).filter((c) => (pick.companyId ? c.companyId === pick.companyId : !!pick.programmeId && c.programmeId === pick.programmeId));
  for (const c of gone) {
    await store.deleteRightsChoice({ assetId: c.assetId, group: c.group });
    await audit(actor, 'programme.rights.withdraw', `programme:${c.programmeId}`, {
      assetId: c.assetId, group: c.group, licence: c.declared, fingerprint: c.fingerprint, via,
    });
  }
  return gone;
}

/** A choice as an exit lists it: the file, the audience and the licence recorded. */
const exitView = (c: RightsChoiceRecord): ExitRightsChoice => ({ assetId: c.assetId, group: c.group, ...(c.declared ? { licence: c.declared } : {}) });

/**
 * The share anyway store as ending a partnership needs it (plans/82 M5): the
 * choices a programme or company holds, and their withdrawal, audited as
 * `programme.rights.withdraw` with the exit's `via`. The exit route and the
 * minute sweep for scheduled ends take the same object.
 */
export function exitRightsChoices(store: Store, audit: Audit): ExitRightsChoices {
  return {
    list: async (pick) => (await store.listRightsChoices())
      .filter((c) => (pick.companyId ? c.companyId === pick.companyId : !!pick.programmeId && c.programmeId === pick.programmeId))
      .map(exitView),
    withdraw: async (actor, pick, via) => (await withdrawRightsChoices(store, audit, actor, pick, via)).map(exitView),
  };
}

