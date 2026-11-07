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
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { AssetIndex, AssetIndexEntry } from '../catalog/lifecycle.ts';
import { entryCompany, HELD_LABEL, LICENCE_ATTRIBUTION_MAX, LICENCE_DECLARATION_MAX, loadRightsEngine, MARK_HOLDER_MAX, MARK_TERMS_MAX, parseMarkScope, RIGHTS_NOTE_MAX, rightsAnswer, type AssetRightsMarkRecord, type HeldCategory, type RightsAnswer, type RightsEngine } from '../catalog/rights.ts';
import { markCoverage, markStatement } from '../catalog/rights-routes.ts';
import { entryInFolders, folderRuleGroup, liveFolderRules, type PartnerFolderRecord } from './folders.ts';
import { companyGroup } from './people.ts';
import type { PartnerRightsState } from '../catalog/rights-mode.ts';
import { CHOICE_NOTE_MAX, CHOICES_PER_REQUEST, choiceFingerprint, choiceStanding, factsOf, type ChoiceStanding, type RightsChoiceRecord } from './rights.ts';
import { isProgrammeScoped, namesProgrammeGroup, PARTNER_GROUP, programmeGroup } from './types.ts';

type Router = ReturnType<typeof createRouter>;

type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

export interface RightsRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  audit: Audit;
  /** The composed feed a caller with these groups receives. */
  feedFor(groups: string[]): Promise<AssetIndex>;
  /** Every catalog entry as its source records it, before any mark. */
  catalogEntries(): Promise<AssetIndexEntry[]>;
  /** The licence gate's mode and why. */
  rightsMode?(): Promise<PartnerRightsState>;
  /** Bounds enforced elsewhere (the collection ZIP), read from their own constants. */
  extraLimits?(): Record<string, number>;
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
  /** A share anyway choice was made for this file and the facts have moved since. */
  needsChoosing?: true;
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
  /** Held files a live share anyway choice sends to one of the programme's audiences. */
  sharedAnyway: number;
  /** Held files whose choice no longer counts, because the facts moved. */
  needsChoosing: number;
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

export interface ProgrammeRightsReport {
  rules: string;
  totals: { assets: number; travel: number; held: number; exempt: number; sharedAnyway: number; needsChoosing: number };
  sources: SourceRow[];
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
  { key: string; row: Omit<SourceRow, 'assets' | 'travel' | 'held' | 'exempt' | 'sharedAnyway' | 'needsChoosing' | 'heldFiles' | 'heldMore'> } {
  if (answer.state === 'exempt') {
    if (answer.why === 'company-own') {
      const id = entryCompany(entry) ?? '';
      const name = sources.companies.find((c) => c.id === id)?.name ?? id;
      return { key: `company-own:${id}`, row: { kind: 'company-own', label: `Files ${name} supplied`, company: { id, name } } };
    }
    return answer.why === 'design-system'
      ? { key: 'design-system', row: { kind: 'design-system', label: 'Design system: tokens, fonts and palettes' } }
      : { key: 'published-by-brand-team', row: { kind: 'published-by-brand-team', label: 'Templates, rules files and brand skills the brand team published' } };
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
  engine: RightsEngine, feed: AssetIndex, groups: ReadonlySet<string>, sources: ReportSources, now: number, choices: readonly RightsChoiceRecord[] = [],
): ProgrammeRightsReport {
  const companies = new Set(sources.companies.map((c) => c.id));
  const rows = new Map<string, SourceRow & { licences: Map<string, number>; reasons: Map<HeldCategory, number> }>();
  const totals = { assets: 0, travel: 0, held: 0, exempt: 0, sharedAnyway: 0, needsChoosing: 0 };
  const entries = new Map((feed.assets ?? []).map((e) => [e.id, e]));
  const live = new Set<string>();
  const retired = new Set<string>();
  for (const choice of choices) {
    if (!groups.has(choice.group)) continue;
    const standing = choiceStanding(engine, choice, entries.get(choice.assetId));
    if (standing === 'live') live.add(choice.assetId);
    else if (standing === 'needs-choosing') retired.add(choice.assetId);
  }
  for (const entry of feed.assets ?? []) {
    const answer = rightsAnswer(engine, entry, companies);
    const { key, row: shape } = sourceOf(entry, answer, groups, sources, now);
    let row = rows.get(key);
    if (!row) {
      row = { ...shape, assets: 0, travel: { count: 0, byLicence: [] }, held: { count: 0, byReason: [] }, exempt: 0, sharedAnyway: 0, needsChoosing: 0, heldFiles: [], heldMore: 0, licences: new Map(), reasons: new Map() };
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
    } else if (live.has(entry.id)) {
      row.sharedAnyway++;
      totals.sharedAnyway++;
    } else {
      row.held.count++;
      totals.held++;
      const stale = retired.has(entry.id);
      if (stale) { row.needsChoosing++; totals.needsChoosing++; }
      row.reasons.set(answer.category, (row.reasons.get(answer.category) ?? 0) + 1);
      if (row.heldFiles.length < HELD_LISTED) {
        row.heldFiles.push({
          id: entry.id, name: nameOf(entry), licence: answer.licence, declared: answer.declared, category: answer.category, reason: answer.reason,
          ...(answer.conditions?.length ? { conditions: answer.conditions } : {}), ...(answer.detail ? { detail: answer.detail } : {}),
          ...(stale ? { needsChoosing: true as const } : {}),
        });
      } else row.heldMore++;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => ROW_ORDER[a.kind] - ROW_ORDER[b.kind] || b.held.count - a.held.count || a.label.localeCompare(b.label));
  return {
    rules: engine.RIGHTS_RULES_VERSION,
    totals,
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
      if (rightsAnswer(engine, entry).state !== 'held') continue;
      // A file the minter chose to send at mint, still on the facts it was chosen against, stays.
      const chosen = target.includeHeld?.find((h) => h.id === raw);
      if (chosen && chosen.fingerprint === choiceFingerprint(factsOf(engine, entry, 'link'))) continue;
      held++;
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

/**
 * Every bound these routes enforce, read from the constants that enforce
 * them, so the console can show an admin the limits as they are.
 */
export const RIGHTS_LIMITS = {
  heldFilesListedPerSource: HELD_LISTED,
  linksListed: LINKS_LISTED,
  choicesPerRequest: CHOICES_PER_REQUEST,
  choiceNote: CHOICE_NOTE_MAX,
  markHolder: MARK_HOLDER_MAX,
  markTerms: MARK_TERMS_MAX,
  markNote: RIGHTS_NOTE_MAX,
  licenceDeclaration: LICENCE_DECLARATION_MAX,
  licenceAttribution: LICENCE_ATTRIBUTION_MAX,
} as const;

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
    const [engine, feed, collections, instAssets, providers, folderRules, allChoices] = await Promise.all([
      loadRightsEngine(), deps.feedFor([...groups, PARTNER_GROUP]), store.listCollections(), store.listInstanceAssets(),
      store.listProviders({ includeFragment: false }), store.listPartnerFolders(), store.listRightsChoices(),
    ]);
    const now = Date.now();
    const choices = allChoices.filter((c) => c.programmeId === programme.id);
    const report = programmeRightsReport(engine, feed, new Set(groups), {
      collections, instAssets, providers, folderRules: folderRules.filter((r) => r.programmeId === programme.id),
      companies: companies.map((c) => ({ id: c.id, name: c.name })),
    }, now, choices);
    await attachMarks(engine, store, report, deps.catalogEntries);
    const links = await linksThatWouldLose(engine, store, deps.feedFor, now);
    const users = new Map((await store.listUsers()).map((u) => [u.id, u]));
    const entries = new Map((feed.assets ?? []).map((e) => [e.id, e]));
    const views = choices.map((c) => choiceView(engine, c, entries.get(c.assetId), users, companies));
    const mode = deps.rightsMode ? await deps.rightsMode() : null;
    sendJson(res, 200, {
      programme: { id: programme.id, name: programme.name },
      ...(mode ? { mode: { mode: mode.mode, source: mode.source, line: mode.line, ...(mode.decidedAt ? { decidedAt: mode.decidedAt } : {}) } } : {}),
      ...report,
      // For the admin only: what was shared anyway, to whom, by whom and why.
      choices: views,
      links,
      inForce: { marks: (await store.listAssetRightsMarks()).length, choices: views.filter((v) => v.standing === 'live').length },
      limits: { ...RIGHTS_LIMITS, ...(deps.extraLimits?.() ?? {}) },
    }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  /**
   * Share anyway: send held files to one audience, the programme or one of
   * its companies. Body: `{ assetIds: [...], company?, note? }`. Each file must
   * be in that audience's feed and held back now; one audited row per file.
   * Nothing is written unless every file qualifies.
   */
  router.add('PUT', '/api/v1/programmes/:id/rights/choices', async (req, res, ctx) => {
    const actor = await deps.requireAction(req, res, 'programme.manage'); if (!actor) return;
    const programme = await store.getProgramme(String(ctx.params.id));
    if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const body = ((await readJson(req)) ?? {}) as { assetIds?: unknown; assetId?: unknown; company?: unknown; note?: unknown };
    const ids = Array.isArray(body.assetIds) ? body.assetIds : typeof body.assetId === 'string' ? [body.assetId] : [];
    if (!ids.length || ids.length > CHOICES_PER_REQUEST || !ids.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512)) {
      return sendError(res, 400, 'INVALID_INPUT', `assetIds is a list of 1 to ${CHOICES_PER_REQUEST} catalog asset ids`);
    }
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.trim().length > CHOICE_NOTE_MAX)) {
      return sendError(res, 400, 'INVALID_INPUT', `note is text, at most ${CHOICE_NOTE_MAX} characters`);
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    let companyId: string | undefined;
    if (body.company !== undefined && body.company !== null && body.company !== '') {
      const company = (await store.listCompanies()).find((c) => c.id === body.company && c.programmeId === programme.id);
      if (!company) return sendError(res, 404, 'NOT_FOUND', 'no such company in this programme');
      companyId = company.id;
    }
    const group = companyId ? companyGroup(companyId) : programmeGroup(programme.id);
    const audience = [programmeGroup(programme.id), ...(companyId ? [companyGroup(companyId)] : []), PARTNER_GROUP];
    const [engine, feed] = await Promise.all([loadRightsEngine(), deps.feedFor(audience)]);
    const entries = new Map((feed.assets ?? []).map((e) => [e.id, e]));
    const companies = new Set(companyId ? [companyId] : []);
    const notInFeed = [...new Set(ids)].filter((id) => !entries.has(id));
    if (notInFeed.length) return sendError(res, 404, 'NOT_IN_FEED', `${notInFeed.length} of these files ${notInFeed.length === 1 ? 'is' : 'are'} not in this audience's feed`);
    const notHeld = [...new Set(ids)].filter((id) => rightsAnswer(engine, entries.get(id)!, companies).state !== 'held');
    if (notHeld.length) return sendError(res, 409, 'NOT_HELD', `${notHeld.length} of these files already reach this audience; share anyway is for files held back`);
    const at = new Date().toISOString();
    const made: RightsChoiceRecord[] = [];
    for (const id of new Set(ids)) {
      const entry = entries.get(id)!;
      const answer = rightsAnswer(engine, entry, companies);
      if (answer.state !== 'held') continue;
      const facts = factsOf(engine, entry, group);
      const rec: RightsChoiceRecord = {
        assetId: id, group, programmeId: programme.id, ...(companyId ? { companyId } : {}),
        declared: answer.declared, licence: answer.licence, reason: answer.reason, checksum: facts.checksum, rulesVersion: facts.rulesVersion,
        fingerprint: choiceFingerprint(facts), ...(note ? { note } : {}), chosenBy: actor.id, chosenAt: at,
      };
      await store.putRightsChoice(rec);
      await deps.audit(`user:${actor.id}`, 'programme.rights.share-anyway', `programme:${programme.id}`, {
        assetId: id, group, licence: rec.declared, reason: rec.reason, ...(note ? { note } : {}), fingerprint: rec.fingerprint,
      });
      made.push(rec);
    }
    const users = new Map([[actor.id, actor]]);
    const named = companyId ? (await store.listCompanies()).filter((x) => x.id === companyId) : [];
    sendJson(res, 200, { choices: made.map((c) => choiceView(engine, c, entries.get(c.assetId), users, named)) });
  });

  /** Withdraw one choice: `?assetId=&company=`. The file is held again. */
  router.add('DELETE', '/api/v1/programmes/:id/rights/choices', async (req, res, ctx) => {
    const actor = await deps.requireAction(req, res, 'programme.manage'); if (!actor) return;
    const programme = await store.getProgramme(String(ctx.params.id));
    if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const assetId = ctx.url.searchParams.get('assetId') ?? '';
    const companyId = ctx.url.searchParams.get('company') || undefined;
    const group = companyId ? companyGroup(companyId) : programmeGroup(programme.id);
    const prior = (await store.listRightsChoices()).find((c) => c.assetId === assetId && c.group === group && c.programmeId === programme.id);
    if (!prior) return sendError(res, 404, 'NOT_FOUND', 'no such choice in this programme');
    await store.deleteRightsChoice({ assetId, group });
    await deps.audit(`user:${actor.id}`, 'programme.rights.withdraw', `programme:${programme.id}`, {
      assetId, group, licence: prior.declared, fingerprint: prior.fingerprint, via: 'console',
    });
    sendJson(res, 200, { ok: true });
  });
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** One choice as the admin reads it: the file, the audience, who chose and when, and whether it still counts. */
function choiceView(
  engine: RightsEngine, c: RightsChoiceRecord, entry: AssetIndexEntry | undefined, users: ReadonlyMap<string, UserRecord>, companies: ReadonlyArray<{ id: string; name: string }>,
): Record<string, unknown> {
  const who = users.get(c.chosenBy);
  const standing: ChoiceStanding = choiceStanding(engine, c, entry);
  const company = c.companyId ? companies.find((x) => x.id === c.companyId) : undefined;
  return {
    assetId: c.assetId, name: entry ? nameOf(entry) : c.assetId, group: c.group,
    ...(c.companyId ? { company: { id: c.companyId, name: company?.name ?? c.companyId } } : {}),
    licence: c.licence, declared: c.declared, reason: c.reason, ...(c.note ? { note: c.note } : {}),
    chosenBy: { id: c.chosenBy, name: who ? personName(who) : c.chosenBy }, chosenAt: c.chosenAt, chosenOn: DATE.format(Date.parse(c.chosenAt)),
    standing, fingerprint: c.fingerprint,
  };
}
