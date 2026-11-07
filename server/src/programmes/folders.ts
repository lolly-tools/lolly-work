// SPDX-License-Identifier: MPL-2.0
/**
 * Provider folders per programme or company (plans/82 M1 part 2c).
 *
 * A folder rule gives the assets in one folder of a connected provider, and
 * every folder below it, to one programme or to one company in it, until an
 * optional end date. It reaches them even when the provider's own exposure
 * groups do not, the way a collection that names a programme does, and it is
 * read where the partner feed is composed, so the feed, the file bytes, live
 * search and links all follow. A rule names its provider by id and its folder
 * by the path the driver reports (`meta.providerFolder`); '' is the whole
 * provider. Nothing here touches the provider itself: the rules live in their
 * own table, so editing a provider's settings never drops them.
 */
import { programmeGroup } from './types.ts';
import { companyGroup } from './people.ts';

export interface PartnerFolderRecord {
  provider: string;
  /** Below the federated root, `a/b/c`; '' for the whole provider. */
  path: string;
  programmeId: string;
  /** Narrows the rule to one company in the programme. */
  companyId?: string;
  /** The rule stops counting at this instant. */
  endsAt?: string;
  addedBy: string;
  addedAt: string;
}

/** The group a rule gives to: the company's when it names one, else the programme's. */
export function folderRuleGroup(rec: PartnerFolderRecord): string {
  return rec.companyId ? companyGroup(rec.companyId) : programmeGroup(rec.programmeId);
}

/** A folder path as an admin typed it, normalised, or null when it is not one. */
export function normaliseFolderPath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const segments = input.trim().split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..' || /[\u0000-\u001f]/.test(s))) return null;
  const path = segments.join('/');
  return path.length <= 1024 ? path : null;
}

/** Whether a file in `folder` sits at or below the rule's `path`. */
export function folderWithin(folder: string, path: string): boolean {
  return path === '' || folder === path || folder.startsWith(`${path}/`);
}

/** The rules still running at `now`. */
export function liveFolderRules(rules: readonly PartnerFolderRecord[], now: number): PartnerFolderRecord[] {
  return rules.filter((r) => !r.endsAt || Date.parse(r.endsAt) > now);
}

/**
 * For a caller holding `partnerGroups`, the folder paths each provider gives
 * them, from the live rules naming one of those groups.
 */
export function foldersFor(rules: readonly PartnerFolderRecord[], partnerGroups: ReadonlySet<string>, now: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of liveFolderRules(rules, now)) {
    if (!partnerGroups.has(folderRuleGroup(r))) continue;
    out.set(r.provider, [...(out.get(r.provider) ?? []), r.path]);
  }
  return out;
}

/** Whether a federated entry (by provider and reported folder) falls under
 *  any given path. The empty path is the whole provider, so it covers an
 *  entry whose driver reports no folder (a fragment synced before drivers
 *  did) as well. */
export function entryInFolders(folder: unknown, paths: readonly string[] | undefined): boolean {
  return !!paths?.length && paths.some((p) => p === '' || (typeof folder === 'string' && folderWithin(folder, p)));
}

/** The earliest rule end after `now`, or Infinity: the feed is recomposed then. */
export function nextFolderRuleEnd(rules: readonly PartnerFolderRecord[], now: number): number {
  let next = Infinity;
  for (const r of rules) {
    const t = r.endsAt ? Date.parse(r.endsAt) : NaN;
    if (Number.isFinite(t) && t > now && t < next) next = t;
  }
  return next;
}
