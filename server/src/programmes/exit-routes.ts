// SPDX-License-Identifier: MPL-2.0
/**
 * Exit receipts and Reopen (plans/82 M5), under `programme.manage`.
 *
 * - `GET /api/v1/programmes/:id/exits` lists a programme's receipts and its
 *   companies', newest first, each with whether Reopen is offered and until
 *   when.
 * - `GET /api/v1/programmes/exits/:id` reads one receipt whole.
 * - `POST /api/v1/programmes/exits/:id/reopen` previews a reopen by default;
 *   `apply: true` reopens. `projects: false` keeps moved projects where the
 *   exit put them ("Give their projects back", ticked by default).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import type { TxtLookup } from './domains.ts';
import type { ProgrammeExitRecord } from './exit.ts';
import { REOPEN_DAYS, reopenExit, reopenOffered, reopenUntil } from './reopen.ts';
import { exitLimits, retireExitNotices } from './exit-schedule.ts';

type Router = ReturnType<typeof createRouter>;
type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

export interface ExitRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  audit: Audit;
  resolveTxt: TxtLookup;
  /** Whether the notice before an end is also emailed, for the limits shown. */
  emailOn?(): boolean;
}

/** One receipt as the console lists it: counts, never the whole result. */
async function exitSummary(store: Store, rec: ProgrammeExitRecord, names: Map<string, string>) {
  const r = rec.result;
  const count = (o: string) => r?.accounts.filter((a) => a.outcome === o).length ?? 0;
  const until = reopenUntil(rec);
  return {
    id: rec.id, state: rec.state, selection: rec.selection,
    ...(rec.programmeId ? { programme: rec.programmeId } : {}), ...(rec.companyId ? { company: rec.companyId } : {}),
    createdAt: rec.createdAt, createdBy: { id: rec.createdBy, name: names.get(rec.createdBy) ?? rec.createdBy },
    ...(rec.doneAt ? { doneAt: rec.doneAt } : {}), ...(rec.via ? { via: rec.via } : {}),
    ...(r ? { counts: {
      ended: count('ended'), stays: count('stays'), notEnded: count('not-ended'), invitations: r.invitations.length, tokens: r.tokens.length,
      templates: r.templates.length, folders: r.folders.length, domainRules: r.domainRules.length, rightsChoices: r.rightsChoices.length,
      projects: r.accounts.reduce((n, a) => n + a.projects.length, 0),
    } } : {}),
    reopen: { offered: reopenOffered(rec), ...(until ? { until } : {}), days: REOPEN_DAYS },
    ...(rec.reopened ? { reopened: { at: rec.reopened.at, by: { id: rec.reopened.by, name: names.get(rec.reopened.by) ?? rec.reopened.by } } } : {}),
  };
}

export function registerExitRoutes(router: Router, deps: ExitRouteDeps): void {
  const { store } = deps;
  const manager = (req: IncomingMessage, res: ServerResponse) => deps.requireAction(req, res, 'programme.manage');
  const names = async () => new Map((await store.listUsers()).map((u) => [u.id, [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email]));

  router.add('GET', '/api/v1/programmes/:id/exits', async (req, res, ctx) => {
    if (!(await manager(req, res))) return;
    const programme = await store.getProgramme(String(ctx.params.id));
    if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const people = await names();
    const list = await store.listProgrammeExits({ programmeId: programme.id });
    sendJson(res, 200, {
      programme: programme.id, reopenDays: REOPEN_DAYS, limits: exitLimits(deps.emailOn?.() ?? false),
      exits: await Promise.all(list.map((r) => exitSummary(store, r, people))),
    }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  router.add('GET', '/api/v1/programmes/exits/:exit', async (req, res, ctx) => {
    if (!(await manager(req, res))) return;
    const rec = await store.getProgrammeExit(String(ctx.params.exit));
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such exit');
    sendJson(res, 200, { ...rec, ...(await exitSummary(store, rec, await names())) }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  router.add('POST', '/api/v1/programmes/exits/:exit/reopen', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const rec = await store.getProgrammeExit(String(ctx.params.exit));
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such exit');
    if (rec.state !== 'done' || !rec.result) return sendError(res, 409, 'NOT_REOPENABLE', rec.state === 'reopened' ? 'this end was reopened already' : 'this end has not happened');
    if (!reopenOffered(rec)) return sendError(res, 409, 'REOPEN_CLOSED', `Reopen is offered for ${REOPEN_DAYS} days after an end; add the people again by list`);
    const body = ((await readJson(req)) ?? {}) as { apply?: unknown; projects?: unknown };
    if (body.projects !== undefined && typeof body.projects !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', 'projects must be true or false');
    const apply = body.apply === true;
    const projects = body.projects !== false;
    const at = new Date().toISOString();
    const result = await reopenExit(store, deps.audit, rec, { apply, projects, actorRef: `user:${actor.id}`, actorId: actor.id, resolveTxt: deps.resolveTxt });
    if (apply) {
      await store.putProgrammeExit({ ...rec, state: 'reopened', reopened: { at, by: actor.id, projects, result } });
      // A notice that named the end date is no longer true.
      await retireExitNotices(store, rec.id, at);
      await deps.audit(`user:${actor.id}`, 'programme.exit.reopen', rec.programmeId ? `programme:${rec.programmeId}` : 'programme:list', {
        exit: rec.id, projects,
        accounts: result.accounts.filter((a) => a.result === 'enabled' || a.result === 'rejoined').length,
        ...(result.accounts.some((a) => a.result === 'left-disabled') ? { leftDisabled: result.accounts.filter((a) => a.result === 'left-disabled').length } : {}),
        ...(result.accounts.some((a) => a.result === 'gone') ? { gone: result.accounts.filter((a) => a.result === 'gone').length } : {}),
        templates: result.templates.filter((t) => t.result !== 'kept').length, folders: result.folders.filter((f) => f.result === 'restored').length,
        domainRules: result.domainRules.filter((d) => d.result === 'restored').length, projectsReturned: result.projects.filter((p) => p.result === 'returned').length,
        ...(result.reopened.programme ? { programme: result.reopened.programme } : {}), ...(result.reopened.companies.length ? { companies: result.reopened.companies } : {}),
      });
    }
    sendJson(res, 200, { dryRun: !apply, exit: rec.id, giveProjectsBack: projects, ...result }, { 'cache-control': 'no-store' });
  });
}
