// SPDX-License-Identifier: MPL-2.0
/**
 * The credits a collection ZIP carries (plans/82 M4, approved by Andy as
 * written in the plan's section 5).
 *
 * Every collection ZIP a link serves gains two entries, written before any
 * file so a download cut short still holds them:
 *
 * - `CREDITS.txt`, the `.lolly` text: the engine's `packCreditsText`, the
 *   function the app's `.lolly` builder prints with, so the two read alike;
 * - `credits.json`, the same entries as data.
 *
 * Only the files in the ZIP are listed. A file the server left out is not
 * named, for the same reason the link page never names one: the person
 * holding the link is told nothing about files they were not given. Nothing
 * is embedded in any file.
 *
 * The ZIP streams, so the server cannot read the finished archive back. It
 * records the two entries as written, with their hashes, and never says the
 * credits were included; a reader with the file in hand can confirm them.
 */
import { createHash } from 'node:crypto';
import type { AssetIndexEntry } from '../catalog/lifecycle.ts';
import type { RightsEngine } from '../catalog/rights.ts';

/** One file in the ZIP, as `packCreditsText` reads it. */
export interface CreditEntry {
  label: string;
  id: string;
  /** The entry name inside the ZIP. */
  path: string;
  licence?: string;
  credit?: string;
  notices?: string[];
  /** The bytes were held back by default and travel because someone chose to send them. */
  includedByChoice?: true;
}

/** One member to credit: its catalog entry when known, and its entry name in the ZIP. */
export interface CreditMember {
  id: string;
  path: string;
  /** The name to fall back on when the entry is unknown. */
  fallbackLabel: string;
  entry?: AssetIndexEntry;
  includedByChoice?: boolean;
}

export interface CollectionCredits {
  entries: CreditEntry[];
  files: Array<{ name: 'CREDITS.txt' | 'credits.json'; bytes: Buffer; sha256: string }>;
}

/** The credit fields for one entry, read as the `.lolly` builder reads them. */
export function creditEntry(engine: RightsEngine, member: CreditMember): CreditEntry {
  const entry = member.entry;
  const label = entry && typeof entry.name === 'string' && entry.name ? entry.name : member.fallbackLabel;
  if (!entry) return { label, id: member.id, path: member.path, ...(member.includedByChoice ? { includedByChoice: true as const } : {}) };
  const answer = engine.redistribution(entry as Record<string, unknown>);
  const attribution = typeof entry.attribution === 'string' ? entry.attribution.trim().slice(0, 1024) : '';
  return {
    label, id: member.id, path: member.path,
    ...(answer.licence ? { licence: answer.licence } : {}),
    ...(attribution ? { credit: attribution } : {}),
    ...(answer.notices.length ? { notices: [...answer.notices] } : {}),
    ...(member.includedByChoice ? { includedByChoice: true as const } : {}),
  };
}

const sha256 = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * The two credits entries for the files a ZIP carries, or none when it
 * carries no catalog file. `CREDITS.txt` lists every file and holds nothing
 * back: a Work ZIP never lists a file it left out.
 */
export function collectionCredits(engine: RightsEngine, members: readonly CreditMember[]): CollectionCredits {
  const entries = members.map((m) => creditEntry(engine, m));
  const text = engine.packCreditsText(entries, []);
  if (!text) return { entries, files: [] };
  // Byte for byte the text a `.lolly` carries.
  const txt = Buffer.from(text, 'utf8');
  const json = Buffer.from(`${JSON.stringify({ travelled: entries }, null, 2)}\n`, 'utf8');
  return {
    entries,
    files: [
      { name: 'CREDITS.txt', bytes: txt, sha256: sha256(txt) },
      { name: 'credits.json', bytes: json, sha256: sha256(json) },
    ],
  };
}

/** The credit line a collection link page prints under one file. */
export interface PageCreditLine {
  /** The recorded credit, or '' when none was recorded. */
  text: string;
  licenceName: string;
  licenceUrl: string;
  sourceUrl?: string;
}

/**
 * The line under a file whose licence asks for a credit (plans/82 M4): the
 * recorded credit, the licence's name linked to its text, and the source when
 * the record names a public address. A licence asks when its reviewed profile
 * makes attribution the obligation, or, for one recognised and not yet
 * interpreted (NC, ND), when Attribution is among its recorded conditions:
 * printing the credit interprets nothing. No line for a dedication, a
 * courtesy credit, an owner-published file or a file with no licence.
 */
export function pageCreditLine(engine: RightsEngine, entry: AssetIndexEntry): PageCreditLine | null {
  const declared = engine.assetLicenceDeclaration(entry as Record<string, unknown>);
  if (!declared) return null;
  const id = engine.normaliseLicence(declared).id;
  const profile = id ? engine.licenceProfile(id) : null;
  if (!profile || profile.courtesyCredit) return null;
  const asks = profile.reviewed ? profile.obligation === 'attribution' : profile.conditions.includes('Attribution');
  const licenceUrl = engine.publicLocator(profile.url);
  if (!asks || !licenceUrl) return null;
  const text = typeof entry.attribution === 'string' ? entry.attribution.trim().slice(0, 300) : '';
  const work = (entry.rights as { works?: Array<{ sourceUrl?: unknown }> } | undefined)?.works?.[0];
  const sourceUrl = engine.publicLocator(work?.sourceUrl ?? entry.sourceUrl);
  return { text, licenceName: profile.name, licenceUrl, ...(sourceUrl ? { sourceUrl } : {}) };
}
