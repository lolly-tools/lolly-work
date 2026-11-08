// SPDX-License-Identifier: MPL-2.0
/**
 * Owner-published marks and licence records (plans/82 M4), under
 * `catalog.edit`.
 *
 * A mark states that the files in one scope are the workspace's own, on its
 * own terms: one asset (`asset:<id>`), a provider folder and everything below
 * it (`folder:<provider>/<path>`), a whole provider (`provider:<id>`) or a
 * pack id prefix (`prefix:lolly/logo/`). A licence record is the admin's own
 * record of one file's licence. Both reach only files whose own record
 * declares nothing, both are the admin's statement and not proof, and neither
 * is written back to a provider.
 *
 * - `GET/PUT/DELETE /api/v1/catalog/rights/marks`, audited
 *   `catalog.rights.mark` and `catalog.rights.unmark`.
 * - `GET/PUT/DELETE /api/v1/catalog/rights/licences`, audited
 *   `catalog.rights.licence` and `catalog.rights.licence.remove`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { AssetIndexEntry } from './lifecycle.ts';
import {
  defaultMarkTerms, LICENCE_ATTRIBUTION_MAX, LICENCE_DECLARATION_MAX, loadRightsEngine, MARK_HOLDER_MAX, MARK_TERMS_MAX, markCovers, markScopeKey,
  parseMarkScope, RIGHTS_NOTE_MAX, rightsAnswer, type AssetLicenceRecord, type AssetRightsMarkRecord, type MarkScope, type RightsAnswer, type RightsEngine,
} from './rights.ts';

type Router = ReturnType<typeof createRouter>;
type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

export interface CatalogRightsDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  audit: Audit;
  /** The workspace name, the holder a new mark is prefilled with. */
  workspaceName(): string;
  /** Every catalog entry as its source records it (pack, providers, instance), before any mark. */
  catalogEntries(): Promise<AssetIndexEntry[]>;
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const dateText = (iso: string): string => { const t = Date.parse(iso); return Number.isFinite(t) ? DATE.format(t) : iso; };
const personName = (u: UserRecord | undefined, id: string): string => (u ? [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email : id);

/** The sentence beside every mark: the holder's own statement, never proof. */
export function markStatement(mark: AssetRightsMarkRecord, statedByName: string): string {
  return `Recorded as ${mark.holder}'s own statement by ${statedByName} on ${dateText(mark.statedAt)}. Lolly does not check ownership.`;
}

/** The sentence beside every licence record: the admin's own record, never verified. */
export function licenceStatement(rec: AssetLicenceRecord, recordedByName: string): string {
  return `Recorded by ${recordedByName} on ${dateText(rec.recordedAt)} as this workspace's own record of the licence. Lolly does not check the licence.`;
}

/** Files a scope covers that record nothing of their own and carry no licence record: what the mark decides. */
export function markCoverage(engine: Pick<RightsEngine, 'assetLicenceDeclaration'>, scope: MarkScope, entries: readonly AssetIndexEntry[], licences: readonly AssetLicenceRecord[]): number {
  const recorded = new Set(licences.map((l) => l.assetId));
  let n = 0;
  for (const entry of entries) {
    if (!markCovers(scope, entry) || recorded.has(entry.id)) continue;
    if (!engine.assetLicenceDeclaration(entry as Record<string, unknown>)) n++;
  }
  return n;
}

/** What the engine reads in a declaration, for the person who typed it. */
function readingOf(answer: RightsAnswer): Record<string, unknown> {
  if (answer.state === 'travels') return { travels: true, licence: answer.licence };
  if (answer.state === 'held') {
    return {
      travels: false, licence: answer.licence, category: answer.category, reason: answer.reason,
      ...(answer.conditions?.length ? { conditions: answer.conditions } : {}), ...(answer.detail ? { detail: answer.detail } : {}),
    };
  }
  return { travels: true, exempt: answer.why };
}

const text = (raw: unknown, max: number): string | null | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length <= max ? t : null;
};

export function registerCatalogRightsRoutes(router: Router, deps: CatalogRightsDeps): void {
  const { store, audit } = deps;
  const editor = (req: IncomingMessage, res: ServerResponse) => deps.requireAction(req, res, 'catalog.edit');
  const people = async () => new Map((await store.listUsers()).map((u) => [u.id, u]));

  router.add('GET', '/api/v1/catalog/rights/marks', async (req, res) => {
    if (!(await editor(req, res))) return;
    const [engine, marks, licences, entries, users] = await Promise.all([loadRightsEngine(), store.listAssetRightsMarks(), store.listAssetLicences(), deps.catalogEntries(), people()]);
    sendJson(res, 200, {
      marks: marks.map((mark) => {
        const scope = parseMarkScope(mark.scope);
        const name = personName(users.get(mark.statedBy), mark.statedBy);
        return {
          ...mark, statedBy: { id: mark.statedBy, name }, statement: markStatement(mark, name),
          covered: { now: scope ? markCoverage(engine, scope, entries, licences) : 0, ...(mark.coveredAtStatement !== undefined ? { atStatement: mark.coveredAtStatement } : {}) },
        };
      }),
      defaults: { holder: deps.workspaceName(), terms: defaultMarkTerms(deps.workspaceName()) },
    }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  /** Record or change one mark. Body: `{ scope, holder?, terms?, note? }`. */
  router.add('PUT', '/api/v1/catalog/rights/marks', async (req, res) => {
    const actor = await editor(req, res); if (!actor) return;
    const body = ((await readJson(req)) ?? {}) as { scope?: unknown; holder?: unknown; terms?: unknown; note?: unknown };
    const scope = parseMarkScope(body.scope);
    if (!scope) return sendError(res, 400, 'INVALID_INPUT', 'scope is asset:<id>, folder:<provider>/<path>, provider:<id> or prefix:<id prefix ending in />');
    const holderIn = text(body.holder, MARK_HOLDER_MAX);
    const termsIn = text(body.terms, MARK_TERMS_MAX);
    const noteIn = text(body.note, RIGHTS_NOTE_MAX);
    if (holderIn === null) return sendError(res, 400, 'INVALID_INPUT', `holder is text, at most ${MARK_HOLDER_MAX} characters`);
    if (termsIn === null) return sendError(res, 400, 'INVALID_INPUT', `terms are text, at most ${MARK_TERMS_MAX} characters`);
    if (noteIn === null) return sendError(res, 400, 'INVALID_INPUT', `note is text, at most ${RIGHTS_NOTE_MAX} characters`);
    if ((scope.kind === 'folder' || scope.kind === 'provider') && !(await store.getProvider(scope.provider, { includeFragment: false }))) {
      return sendError(res, 404, 'NOT_FOUND', 'no such provider');
    }
    const [engine, entries, licences, all] = await Promise.all([loadRightsEngine(), deps.catalogEntries(), store.listAssetLicences(), store.listAssetRightsMarks()]);
    if (scope.kind !== 'provider' && !entries.some((e) => markCovers(scope, e))) {
      return sendError(res, 404, 'NOTHING_COVERED', 'no file in the catalog sits in that scope');
    }
    if (scope.kind === 'asset') {
      const own = engine.assetLicenceDeclaration(entries.find((e) => e.id === scope.id) as Record<string, unknown>);
      if (own) return sendError(res, 409, 'LICENCE_RECORDED', `this file records its own licence (${own}), and a mark never replaces one`);
    }
    const key = markScopeKey(scope);
    const prior = all.find((m) => m.scope === key);
    const holder = holderIn || deps.workspaceName();
    const mark: AssetRightsMarkRecord = {
      scope: key, holder, terms: termsIn || defaultMarkTerms(holder), ...(noteIn ? { note: noteIn } : {}),
      statedBy: actor.id, statedAt: new Date().toISOString(), coveredAtStatement: markCoverage(engine, scope, entries, licences),
    };
    await store.putAssetRightsMark(mark);
    await audit(`user:${actor.id}`, 'catalog.rights.mark', `rights-mark:${key}`, {
      scope: key, holder: mark.holder, terms: mark.terms, ...(mark.note ? { note: mark.note } : {}), covered: mark.coveredAtStatement,
      ...(prior ? { before: { holder: prior.holder, terms: prior.terms, ...(prior.note ? { note: prior.note } : {}) } } : {}),
    });
    const name = personName(actor, actor.id);
    sendJson(res, prior ? 200 : 201, { mark: { ...mark, statedBy: { id: actor.id, name } }, statement: markStatement(mark, name), covered: { now: mark.coveredAtStatement, atStatement: mark.coveredAtStatement } });
  });

  /** Withdraw one mark: `?scope=`. Its files fall back to what they record themselves. */
  router.add('DELETE', '/api/v1/catalog/rights/marks', async (req, res, ctx) => {
    const actor = await editor(req, res); if (!actor) return;
    const scope = parseMarkScope(ctx.url.searchParams.get('scope') ?? '');
    const key = scope ? markScopeKey(scope) : '';
    const prior = key ? (await store.listAssetRightsMarks()).find((m) => m.scope === key) : undefined;
    if (!prior) return sendError(res, 404, 'NOT_FOUND', 'no mark on that scope');
    await store.deleteAssetRightsMark(key);
    await audit(`user:${actor.id}`, 'catalog.rights.unmark', `rights-mark:${key}`, {
      scope: key, before: { holder: prior.holder, terms: prior.terms, ...(prior.note ? { note: prior.note } : {}), statedBy: prior.statedBy, statedAt: prior.statedAt },
    });
    sendJson(res, 200, { ok: true });
  });

  router.add('GET', '/api/v1/catalog/rights/licences', async (req, res) => {
    if (!(await editor(req, res))) return;
    const [engine, licences, users] = await Promise.all([loadRightsEngine(), store.listAssetLicences(), people()]);
    sendJson(res, 200, {
      licences: licences.map((rec) => {
        const name = personName(users.get(rec.recordedBy), rec.recordedBy);
        return {
          ...rec, recordedBy: { id: rec.recordedBy, name }, statement: licenceStatement(rec, name),
          reads: readingOf(rightsAnswer(engine, { id: rec.assetId, license: rec.declaration })),
        };
      }),
    }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  /** Record or change the licence of one file that records none. Body: `{ assetId, declaration, attribution?, note? }`. */
  router.add('PUT', '/api/v1/catalog/rights/licences', async (req, res) => {
    const actor = await editor(req, res); if (!actor) return;
    const body = ((await readJson(req)) ?? {}) as { assetId?: unknown; declaration?: unknown; attribution?: unknown; note?: unknown };
    const assetId = typeof body.assetId === 'string' ? body.assetId : '';
    const declaration = text(body.declaration, LICENCE_DECLARATION_MAX);
    const attribution = text(body.attribution, LICENCE_ATTRIBUTION_MAX);
    const note = text(body.note, RIGHTS_NOTE_MAX);
    if (!parseMarkScope(`asset:${assetId}`)) return sendError(res, 400, 'INVALID_INPUT', 'assetId is a catalog asset id');
    if (!declaration) return sendError(res, 400, 'INVALID_INPUT', `declaration is the licence as written, such as CC-BY-NC-4.0, at most ${LICENCE_DECLARATION_MAX} characters`);
    if (attribution === null) return sendError(res, 400, 'INVALID_INPUT', `attribution is text, at most ${LICENCE_ATTRIBUTION_MAX} characters`);
    if (note === null) return sendError(res, 400, 'INVALID_INPUT', `note is text, at most ${RIGHTS_NOTE_MAX} characters`);
    const [engine, entries, licences] = await Promise.all([loadRightsEngine(), deps.catalogEntries(), store.listAssetLicences()]);
    const entry = entries.find((e) => e.id === assetId);
    if (!entry) return sendError(res, 404, 'NOT_FOUND', 'no such asset');
    const own = engine.assetLicenceDeclaration(entry as Record<string, unknown>);
    if (own) return sendError(res, 409, 'LICENCE_RECORDED', `this file records its own licence (${own}); Work records a licence only for a file that records none`);
    const prior = licences.find((l) => l.assetId === assetId);
    const rec: AssetLicenceRecord = {
      assetId, declaration, ...(attribution ? { attribution } : {}), ...(note ? { note } : {}), recordedBy: actor.id, recordedAt: new Date().toISOString(),
    };
    await store.putAssetLicence(rec);
    await audit(`user:${actor.id}`, 'catalog.rights.licence', `asset:${assetId}`, {
      assetId, declaration, ...(attribution ? { attribution } : {}), ...(note ? { note } : {}),
      ...(prior ? { before: { declaration: prior.declaration, ...(prior.attribution ? { attribution: prior.attribution } : {}), ...(prior.note ? { note: prior.note } : {}) } } : {}),
    });
    const name = personName(actor, actor.id);
    sendJson(res, prior ? 200 : 201, {
      licence: { ...rec, recordedBy: { id: actor.id, name } }, statement: licenceStatement(rec, name),
      reads: readingOf(rightsAnswer(engine, { ...entry, license: declaration })),
    });
  });

  /** Remove one licence record: `?assetId=`. */
  router.add('DELETE', '/api/v1/catalog/rights/licences', async (req, res, ctx) => {
    const actor = await editor(req, res); if (!actor) return;
    const assetId = ctx.url.searchParams.get('assetId') ?? '';
    const prior = (await store.listAssetLicences()).find((l) => l.assetId === assetId);
    if (!prior) return sendError(res, 404, 'NOT_FOUND', 'no licence record for that asset');
    await store.deleteAssetLicence(assetId);
    await audit(`user:${actor.id}`, 'catalog.rights.licence.remove', `asset:${assetId}`, {
      assetId, before: { declaration: prior.declaration, ...(prior.attribution ? { attribution: prior.attribution } : {}), recordedBy: prior.recordedBy, recordedAt: prior.recordedAt },
    });
    sendJson(res, 200, { ok: true });
  });
}
