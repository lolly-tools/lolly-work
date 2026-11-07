// SPDX-License-Identifier: MPL-2.0
/**
 * The licence report for a partner programme (plans/82 M4), under
 * `programme.manage`.
 *
 * `GET /api/v1/programmes/:id/rights-report` reads the programme's own feed,
 * every company in it included, and answers for each file the question the
 * licence gate asks: may these bytes be passed on? It counts the answers by
 * where the file came from (a provider folder, a whole provider, a collection
 * or a file shared with the programme directly), lists the files that would
 * be held back with the reason, and counts the live links made by staff that
 * would lose files once the gate holds. It writes nothing and changes nothing
 * a partner receives.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { AssetIndex, AssetIndexEntry } from '../catalog/lifecycle.ts';
import { entryCompany, HELD_LABEL, loadRightsEngine, parseMarkScope, rightsAnswer, type AssetRightsMarkRecord, type HeldCategory, type RightsAnswer, type RightsEngine } from '../catalog/rights.ts';
import { markCoverage, markStatement } from '../catalog/rights-routes.ts';
import { entryInFolders, folderRuleGroup, liveFolderRules, type PartnerFolderRecord } from './folders.ts';
import { companyGroup } from './people.ts';
import { isProgrammeScoped, namesProgrammeGroup, PARTNER_GROUP, programmeGroup } from './types.ts';

type Router = ReturnType<typeof createRouter>;

export interface RightsRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  /** The composed feed a caller with these groups receives. */
  feedFor(groups: string[]): Promise<AssetIndex>;
  /** Every catalog entry as its source records it, before any mark. */
  catalogEntries(): Promise<AssetIndexEntry[]>;
}

/** Held files listed per source row; the rest are counted. */
const HELD_LISTED = 100;
/** Links listed in the report; the rest are counted. */
const LINKS_LISTED = 50;

/** Where a file in the programme's feed came from. */
export type SourceKind = 'folder' | 'provider' | 'collection' | 'direct' | 'design-system' | 'published-by-brand-team' | 'company-own';

export interface ReportSources {
  collections: ReadonlyArray<{ id: string; name: string; members: string[]; groups?: string[] | '*' }>;
  instAssets: ReadonlyArray<{ id: string; groups?: string[] | '*' }>;
  providers: ReadonlyArray<{ id: string; label: string; exposure: { groups?: string[] | '*' } }>;
  folderRules: readonly PartnerFolderRecord[];
  companies: ReadonlyArray<{ id: string; name: string }>;
}

export interface HeldFile {
  id: string;
  name: string;
  licence: string;
  declared: string;
  category: HeldCategory;
  reason: string;
  conditions?: string[];
  detail?: string;
}

export interface SourceRow {
  kind: SourceKind;
  label: string;
  provider?: { id: string; label: string };
  path?: string;
  collection?: { id: string; name: string };
  company?: { id: string; name: string };
  /** The scope "These are ours" records for this row: a folder or a whole provider. */
  markScope?: string;
  /** The mark already stated on exactly that scope. */
  mark?: RowMark;
  assets: number;
  travel: { count: number; byLicence: Array<{ licence: string; count: number }> };
  held: { count: number; byReason: Array<{ category: HeldCategory; label: string; count: number }> };
  exempt: number;
  heldFiles: HeldFile[];
  /** Held files past the listed ones. */
  heldMore: number;
}

/** A mark as the report shows it to the admin: who stated it and when, and what it covers now. */
export interface RowMark {
  scope: string;
  holder: string;
  terms: string;
  note?: string;
  statedBy: { id: string; name: string };
  statedAt: string;
  statement: string;
  covered: { now: number; atStatement?: number };
}

/**
 * Held pack files under one top-level id prefix (`suse/`), by the
 * declaration they carry. A pack file reaches a programme through a
 * collection, so its row has no folder to mark; this is where the brand team
 * sees, for example, that every file under suse/ declares an identifier
 * these rules do not carry.
 */
export interface PrefixRow {
  prefix: string;
  held: number;
  byDeclaration: Array<{ declared: string; category: HeldCategory; label: string; count: number }>;
  /** One sentence per declaration, such as "210 files under suse/ declare LicenseRef-SUSE-Proprietary, an identifier these rules do not carry." */
  sentences: string[];
  /** Held files here that declare nothing: a mark at this prefix would reach them. */
  unrecorded: number;
  /** The scope "These are ours" records, offered only when a mark can act on some of these files. */
  markScope?: string;
  /** What would clear the files a mark cannot reach, when some declare an identifier these rules do not carry. */
  clearedBy?: string;
}

/** What clears pack files that declare an identifier these rules do not carry. */
export const IDENTIFIER_CLEARED_BY = 'The owner can record these as owner-published in the pack, or the rules can be widened. Ask your Lolly administrator.';

export interface ProgrammeRightsReport {
  rules: string;
  totals: { assets: number; travel: number; held: number; exempt: number };
  sources: SourceRow[];
  prefixes: PrefixRow[];
}

/** Group held pack files (not `ext/*` or `inst/*`) by top-level id prefix. */
export function packPrefixRows(held: ReadonlyArray<{ id: string; declared: string; category: HeldCategory }>): PrefixRow[] {
  const by = new Map<string, Map<string, { category: HeldCategory; count: number }>>();
  for (const f of held) {
    if (f.id.startsWith('ext/') || f.id.startsWith('inst/')) continue;
    const cut = f.id.indexOf('/');
    if (cut < 1) continue;
    const prefix = f.id.slice(0, cut + 1);
    const decls = by.get(prefix) ?? new Map();
    const key = f.declared;
    const row = decls.get(key) ?? { category: f.category, count: 0 };
    row.count++;
    decls.set(key, row);
    by.set(prefix, decls);
  }
  return [...by].map(([prefix, decls]) => {
    const byDeclaration = [...decls].map(([declared, d]) => ({ declared, category: d.category, label: HELD_LABEL[d.category], count: d.count }))
      .sort((a, b) => b.count - a.count || a.declared.localeCompare(b.declared));
    const held = byDeclaration.reduce((n, d) => n + d.count, 0);
    const unrecorded = byDeclaration.filter((d) => !d.declared).reduce((n, d) => n + d.count, 0);
    const sentences = byDeclaration.map((d) => {
      const files = `${d.count} ${d.count === 1 ? 'file' : 'files'} under ${prefix}`;
      return d.declared ? `${files} ${d.count === 1 ? 'declares' : 'declare'} ${d.declared}, ${d.label}.` : `${files} ${d.count === 1 ? 'records' : 'record'} no licence.`;
    });
    return {
      prefix, held, byDeclaration, sentences, unrecorded,
      ...(unrecorded ? { markScope: `prefix:${prefix}` } : {}),
      ...(byDeclaration.some((d) => d.category === 'identifier') ? { clearedBy: IDENTIFIER_CLEARED_BY } : {}),
    };
  }).sort((a, b) => b.held - a.held || a.prefix.localeCompare(b.prefix));
}

const nameOf = (entry: AssetIndexEntry): string => (typeof entry.name === 'string' && entry.name ? entry.name : entry.id);

/** The provider id of an `ext/<provider>/...` entry. */
const providerOf = (id: string): string | undefined => /^ext\/([^/]+)\//.exec(id)?.[1];

const folderOfEntry = (entry: AssetIndexEntry): unknown => (entry.meta as { providerFolder?: unknown } | undefined)?.providerFolder;

/**
 * The one source each file is counted under, most specific first: an exempt
 * file under its exemption, then a collection that names one of the
 * programme's groups, then a file shared with those groups directly, then the
 * narrowest provider folder given to them, then the whole provider.
 */
function sourceOf(entry: AssetIndexEntry, answer: RightsAnswer, groups: ReadonlySet<string>, sources: ReportSources, now: number):
  { key: string; row: Omit<SourceRow, 'assets' | 'travel' | 'held' | 'exempt' | 'heldFiles' | 'heldMore'> } {
  if (answer.state === 'exempt') {
    if (answer.why === 'company-own') {
      const id = entryCompany(entry) ?? '';
      const name = sources.companies.find((c) => c.id === id)?.name ?? id;
      return { key: `company-own:${id}`, row: { kind: 'company-own', label: `Files ${name} supplied`, company: { id, name } } };
    }
    return answer.why === 'design-system'
      ? { key: 'design-system', row: { kind: 'design-system', label: 'Design system: tokens, fonts and palettes' } }
      : { key: 'published-by-brand-team', row: { kind: 'published-by-brand-team', label: 'Templates and rules files the brand team published' } };
  }
  const collection = sources.collections.find((c) => namesProgrammeGroup(c.groups, groups) && c.members.includes(entry.id));
  if (collection) return { key: `collection:${collection.id}`, row: { kind: 'collection', label: collection.name, collection: { id: collection.id, name: collection.name } } };
  if (sources.instAssets.some((a) => a.id === entry.id && namesProgrammeGroup(a.groups, groups))) {
    return { key: 'direct', row: { kind: 'direct', label: 'Shared with the programme directly' } };
  }
  const providerId = providerOf(entry.id);
  if (providerId) {
    const provider = sources.providers.find((p) => p.id === providerId);
    const label = provider?.label ?? providerId;
    const paths = liveFolderRules(sources.folderRules, now)
      .filter((r) => r.provider === providerId && groups.has(folderRuleGroup(r)) && entryInFolders(folderOfEntry(entry), [r.path]))
      .map((r) => r.path)
      .sort((a, b) => b.length - a.length);
    if (paths.length) {
      const path = paths[0]!;
      return {
        key: `folder:${providerId}/${path}`,
        row: { kind: 'folder', label: `${label} / ${path || 'all of it'}`, provider: { id: providerId, label }, path, markScope: path ? `folder:${providerId}/${path}` : `provider:${providerId}` },
      };
    }
    return { key: `provider:${providerId}`, row: { kind: 'provider', label, provider: { id: providerId, label }, markScope: `provider:${providerId}` } };
  }
  return { key: 'direct', row: { kind: 'direct', label: 'Shared with the programme directly' } };
}

const ROW_ORDER: Record<SourceKind, number> = {
  folder: 0, provider: 1, collection: 2, direct: 3, 'company-own': 4, 'published-by-brand-team': 5, 'design-system': 6,
};

/**
 * The report over one feed. `groups` are the programme's group and its
 * companies' groups; `companies` (ids) are the companies whose own files are
 * exempt.
 */
export function programmeRightsReport(
  engine: RightsEngine, feed: AssetIndex, groups: ReadonlySet<string>, sources: ReportSources, now: number,
): ProgrammeRightsReport {
  const companies = new Set(sources.companies.map((c) => c.id));
  const rows = new Map<string, SourceRow & { licences: Map<string, number>; reasons: Map<HeldCategory, number> }>();
  const totals = { assets: 0, travel: 0, held: 0, exempt: 0 };
  const heldAll: Array<{ id: string; declared: string; category: HeldCategory }> = [];
  for (const entry of feed.assets ?? []) {
    const answer = rightsAnswer(engine, entry, companies);
    const { key, row: shape } = sourceOf(entry, answer, groups, sources, now);
    let row = rows.get(key);
    if (!row) {
      row = { ...shape, assets: 0, travel: { count: 0, byLicence: [] }, held: { count: 0, byReason: [] }, exempt: 0, heldFiles: [], heldMore: 0, licences: new Map(), reasons: new Map() };
      rows.set(key, row);
    }
    row.assets++;
    totals.assets++;
    if (answer.state === 'exempt') {
      row.exempt++;
      totals.exempt++;
    } else if (answer.state === 'travels') {
      row.travel.count++;
      totals.travel++;
      row.licences.set(answer.licence, (row.licences.get(answer.licence) ?? 0) + 1);
    } else {
      row.held.count++;
      totals.held++;
      row.reasons.set(answer.category, (row.reasons.get(answer.category) ?? 0) + 1);
      heldAll.push({ id: entry.id, declared: answer.declared, category: answer.category });
      if (row.heldFiles.length < HELD_LISTED) {
        row.heldFiles.push({
          id: entry.id, name: nameOf(entry), licence: answer.licence, declared: answer.declared, category: answer.category, reason: answer.reason,
          ...(answer.conditions?.length ? { conditions: answer.conditions } : {}), ...(answer.detail ? { detail: answer.detail } : {}),
        });
      } else row.heldMore++;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => ROW_ORDER[a.kind] - ROW_ORDER[b.kind] || b.held.count - a.held.count || a.label.localeCompare(b.label));
  return {
    rules: engine.RIGHTS_RULES_VERSION,
    totals,
    prefixes: packPrefixRows(heldAll),
    sources: sorted.map(({ licences, reasons, ...row }) => ({
      ...row,
      travel: { count: row.travel.count, byLicence: [...licences].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([licence, count]) => ({ licence, count })) },
      held: { count: row.held.count, byReason: [...reasons].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category, count]) => ({ category, label: HELD_LABEL[category], count })) },
    })),
  };
}

export interface LinkLoss {
  id: string;
  kind: string;
  target: { kind: 'asset' | 'collection'; id: string; name: string };
  createdBy: { id: string; name: string };
  expiresAt: string;
  /** Files the link would leave out. */
  held: number;
  /** Files the link names. */
  files: number;
}

const personName = (u: UserRecord): string => [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email;

/**
 * Live links made by staff that would lose files once the gate holds: every
 * bearer link to a catalog asset or collection, because the gate applies to
 * whoever holds the link. A link made by a partner loses nothing, because its
 * files already come from the partner's own feed. Each file is read as the
 * link's maker sees it.
 */
export async function linksThatWouldLose(engine: RightsEngine, store: Store, feedFor: (groups: string[]) => Promise<AssetIndex>, now: number):
  Promise<{ count: number; files: number; links: LinkLoss[]; more: number }> {
  const feeds = new Map<string, Promise<Map<string, AssetIndexEntry>>>();
  const feedOf = (groups: string[]): Promise<Map<string, AssetIndexEntry>> => {
    const key = [...new Set(groups)].sort().join('\n');
    let found = feeds.get(key);
    if (!found) {
      found = feedFor(groups).then((index) => new Map((index.assets ?? []).map((e) => [e.id, e])));
      feeds.set(key, found);
    }
    return found;
  };
  const users = new Map((await store.listUsers()).map((u) => [u.id, u]));
  const losing: LinkLoss[] = [];
  let files = 0;
  for (const link of await store.listAllLinks()) {
    if (link.revokedAt || link.exp * 1000 <= now) continue;
    if (link.kind !== 'share' && link.kind !== 'download' && link.kind !== 'embed') continue;
    const target = link.target;
    if (!target.assetId && !target.collectionId) continue;
    const maker = users.get(link.createdBy);
    if (!maker || maker.disabledAt || isProgrammeScoped(maker.groups, maker.role)) continue;
    const collection = target.collectionId ? await store.getCollection(target.collectionId) : null;
    if (target.collectionId && !collection) continue;
    const ids = collection ? collection.members : [target.assetId!];
    const entries = await feedOf(maker.groups);
    let held = 0;
    let firstName = '';
    for (const raw of ids) {
      const entry = entries.get(raw) ?? entries.get((await store.getAlias(raw)) ?? raw);
      if (!entry) continue;
      firstName ||= nameOf(entry);
      if (rightsAnswer(engine, entry).state === 'held') held++;
    }
    if (!held) continue;
    files += held;
    losing.push({
      id: link.id, kind: link.kind,
      target: collection ? { kind: 'collection', id: collection.id, name: collection.name } : { kind: 'asset', id: target.assetId!, name: firstName || target.assetId! },
      createdBy: { id: maker.id, name: personName(maker) },
      expiresAt: new Date(link.exp * 1000).toISOString(),
      held, files: ids.length,
    });
  }
  losing.sort((a, b) => b.held - a.held || a.id.localeCompare(b.id));
  return { count: losing.length, files, links: losing.slice(0, LINKS_LISTED), more: Math.max(0, losing.length - LINKS_LISTED) };
}

/** Put the mark stated on each row's own scope beside the row, with what it covers now. */
async function attachMarks(engine: RightsEngine, store: Store, report: ProgrammeRightsReport, catalogEntries: () => Promise<AssetIndexEntry[]>): Promise<void> {
  const marks = await store.listAssetRightsMarks();
  if (!marks.length) return;
  const byScope = new Map(marks.map((m) => [m.scope, m]));
  const wanted = report.sources.filter((row) => row.markScope && byScope.has(row.markScope));
  if (!wanted.length) return;
  const [entries, licences, users] = await Promise.all([catalogEntries(), store.listAssetLicences(), store.listUsers()]);
  const nameOf = (id: string): string => { const u = users.find((x) => x.id === id); return u ? personName(u) : id; };
  for (const row of wanted) {
    const mark = byScope.get(row.markScope!) as AssetRightsMarkRecord;
    const scope = parseMarkScope(mark.scope);
    const name = nameOf(mark.statedBy);
    row.mark = {
      scope: mark.scope, holder: mark.holder, terms: mark.terms, ...(mark.note ? { note: mark.note } : {}),
      statedBy: { id: mark.statedBy, name }, statedAt: mark.statedAt, statement: markStatement(mark, name),
      covered: { now: scope ? markCoverage(engine, scope, entries, licences) : 0, ...(mark.coveredAtStatement !== undefined ? { atStatement: mark.coveredAtStatement } : {}) },
    };
  }
}

export function registerRightsRoutes(router: Router, deps: RightsRouteDeps): void {
  const { store } = deps;

  router.add('GET', '/api/v1/programmes/:id/rights-report', async (req, res, ctx) => {
    if (!(await deps.requireAction(req, res, 'programme.manage'))) return;
    const programme = await store.getProgramme(String(ctx.params.id));
    if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const companies = (await store.listCompanies()).filter((c) => c.programmeId === programme.id);
    const groups = [programmeGroup(programme.id), ...companies.map((c) => companyGroup(c.id))];
    const [engine, feed, collections, instAssets, providers, folderRules] = await Promise.all([
      loadRightsEngine(), deps.feedFor([...groups, PARTNER_GROUP]), store.listCollections(), store.listInstanceAssets(),
      store.listProviders({ includeFragment: false }), store.listPartnerFolders(),
    ]);
    const now = Date.now();
    const report = programmeRightsReport(engine, feed, new Set(groups), {
      collections, instAssets, providers, folderRules: folderRules.filter((r) => r.programmeId === programme.id),
      companies: companies.map((c) => ({ id: c.id, name: c.name })),
    }, now);
    await attachMarks(engine, store, report, deps.catalogEntries);
    const links = await linksThatWouldLose(engine, store, deps.feedFor, now);
    sendJson(res, 200, { programme: { id: programme.id, name: programme.name }, ...report, links }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });
}
