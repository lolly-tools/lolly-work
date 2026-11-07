// SPDX-License-Identifier: MPL-2.0
/**
 * Scheduled ends and the notice before them (plans/82 M5).
 *
 * An admin can end a programme or a company on a date instead of now. The
 * exit's receipt waits in state `scheduled` with the selection and the
 * project choice, and the minute sweep runs it at the end of that day in UTC,
 * as membership ends already run, with `via: 'scheduled'`. Change and Cancel
 * exist until then.
 *
 * The notice is on by default ("Tell them before the end", one tick per
 * end): from the days `NOTICE_DAYS_BEFORE` before the end day (14 and 1,
 * counted in UTC, or at once when the end is nearer), each person whose
 * access ends gets an inbox notice, emailed too when `notify.people.email` is
 * on. The person who scheduled the end gets the
 * same two reminders. A membership end date gets the same notice, to the
 * person only. Nobody else is told and nothing is broadcast. Each send is
 * audited once with counts, never addresses.
 *
 * The wording states only what Lolly Work does. It never states the
 * partner's or the lead organisation's processes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Message } from '../inbox/target.ts';
import type { NoticeContext } from '../access/messages.ts';
import type { MailParts, PeopleNotifier } from '../notify/people.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { isEnded, programmeGroup } from './types.ts';
import { companyGroup, type MembershipRecord } from './people.ts';
import { applyExit, EXIT_ROW_BOUND, planExit, PROJECT_MODES, type ExitRightsChoices, type ProgrammeExitRecord, type ProjectsMode } from './exit.ts';
import { REOPEN_DAYS } from './reopen.ts';

type Router = ReturnType<typeof createRouter>;
type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

/** Days before an end that the notice goes out: two reminders. */
export const NOTICE_DAYS_BEFORE = [14, 1] as const;
/** How often the server runs the sweep that ends memberships, runs scheduled
 *  exits and sends the notices (main.ts). A serverless deploy crons
 *  POST /api/v1/programmes/sweep instead. */
export const PROGRAMME_SWEEP_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The limits an end works within, each the constant the code enforces, for
 * the console's End card and the limits panel: the rows one account may hold
 * and still be ended in one step, the days Reopen is offered, the notice
 * timings, whether the notice is also emailed and how often the sweep runs.
 */
export function exitLimits(emailOn: boolean): { rowBound: number; reopenDays: number; noticeDaysBefore: number[]; email: boolean; sweepSeconds: number } {
  return { rowBound: EXIT_ROW_BOUND, reopenDays: REOPEN_DAYS, noticeDaysBefore: [...NOTICE_DAYS_BEFORE], email: emailOn, sweepSeconds: PROGRAMME_SWEEP_MS / 1000 };
}

export type NoticeStage = 'd14' | 'd1';
export interface NoticesSent { d14?: string; d1?: string }

/** A day an admin typed, as the end of that day in UTC; an instant stays as given. */
export function endOfDay(input: unknown, now = Date.now()): string | { error: string } {
  if (typeof input !== 'string' || !input.trim()) return { error: 'at is a date (YYYY-MM-DD)' };
  const raw = input.trim();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw);
  if (!Number.isFinite(t)) return { error: 'at is a date (YYYY-MM-DD)' };
  if (t <= now) return { error: 'the end date has passed; end it now instead' };
  return new Date(t).toISOString();
}

/** Which reminder is due now, if any: the last one whose day has come and
 *  that has not been sent. Days are counted in UTC from the day the access
 *  ends, so an end on 21 November is told from 7 November and again from
 *  20 November. When the end is nearer than 14 days the first send is the
 *  day-before one, and it counts for both. */
export function noticeDue(endsAt: string, sent: NoticesSent | undefined, now = Date.now()): NoticeStage | null {
  const end = Date.parse(endsAt);
  if (end <= now) return null;
  const endDay = new Date(end);
  const endDayStart = Date.UTC(endDay.getUTCFullYear(), endDay.getUTCMonth(), endDay.getUTCDate());
  if (now >= endDayStart - NOTICE_DAYS_BEFORE[1] * DAY_MS) return sent?.d1 ? null : 'd1';
  if (now >= endDayStart - NOTICE_DAYS_BEFORE[0] * DAY_MS) return sent?.d14 || sent?.d1 ? null : 'd14';
  return null;
}

const longDate = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * The notice to the people whose access ends. `accountEnds` is false for
 * someone who keeps the account through another programme; `projects` is
 * the exit's project choice, so the sentence about their pieces is true.
 */
export function accessEndsNotice(o: {
  id: string; users: string[]; programme: string; endsAt: string; accountEnds: boolean; projects?: string;
}, ctx: NoticeContext): { message: Message; mail: MailParts } {
  const day = longDate(o.endsAt);
  const title = `Your access through ${o.programme} ends on ${day}`;
  const pieces = !o.accountEnds ? 'Your access through your other programmes stays as it is.'
    : o.projects === 'me' ? `Pieces you saved to team projects stay with ${ctx.workspace}.`
    : `Pieces you saved to team projects stay with ${ctx.workspace}, read-only.`;
  const body = [`Your access to ${ctx.workspace} through ${o.programme} ends on ${day}.`, pieces,
    o.accountEnds ? 'Download anything you want to keep before then.' : ''].filter(Boolean).join(' ');
  const url = `${ctx.appBase}/#/projects`;
  return {
    message: {
      id: o.id, kind: 'notice', severity: 'action', audience: { users: o.users }, title, body,
      cta: { label: 'Open Projects', url },
      data: { kind: 'access-ends', at: ctx.at, endsAt: o.endsAt },
      endsAt: o.endsAt, dismissible: true,
    },
    mail: { subject: title, text: `${body}\n\nOpen Projects: ${url || ctx.baseUrl}` },
  };
}

/** The same reminder to the person who scheduled the end. */
export function scheduledEndNotice(o: { id: string; userId: string; name: string; endsAt: string; programmeId: string }, ctx: NoticeContext): { message: Message; mail: MailParts } {
  const day = longDate(o.endsAt);
  const title = `${o.name} ends on ${day}`;
  const body = `${o.name} ends on ${day}. Change the date, or end now.`;
  const url = `${ctx.baseUrl}/admin#/programmes?id=${encodeURIComponent(o.programmeId)}`;
  return {
    message: {
      id: o.id, kind: 'notice', severity: 'info', audience: { users: [o.userId] }, title, body,
      cta: { label: 'Open', url }, data: { kind: 'scheduled-end', at: ctx.at, endsAt: o.endsAt }, endsAt: o.endsAt, dismissible: true,
    },
    mail: { subject: title, text: `${body}\n\n${url}` },
  };
}

export interface ScheduleDeps {
  store: Store;
  audit: Audit;
  /** Absent in a sweep that cannot send notices; the exits still run. */
  people?: PeopleNotifier;
  context(nowMs: number): NoticeContext;
  rights?: ExitRightsChoices;
}

/** Take an end's notices out of every inbox now: the end moved, was called
 *  off, ran early or was reopened, so the date they state is no longer true. */
export async function retireExitNotices(store: Store, exitId: string, at = new Date().toISOString()): Promise<number> {
  let n = 0;
  for (const m of await store.listMessages()) {
    if (!m.id.startsWith(`msg_exit_${exitId}_`) || (m.endsAt && m.endsAt <= at)) continue;
    await store.putMessage({ ...m, endsAt: at });
    n++;
  }
  return n;
}

/** The account to run a scheduled exit as: its scheduler, when still here. */
async function schedulerOf(store: Store, rec: ProgrammeExitRecord): Promise<UserRecord> {
  const u = await store.getUser(rec.createdBy);
  return u ?? ({ id: rec.createdBy, sub: '', email: '', groups: [], localGroups: [], idpGroups: [], role: 'admin', sessionEpoch: 0, createdAt: rec.createdAt } as unknown as UserRecord);
}

/** Run one scheduled exit now, with the choices it was scheduled with. */
export async function runScheduledExit(d: ScheduleDeps, read: ProgrammeExitRecord, actorRef = 'system', actorId?: string, changes: Partial<ProgrammeExitRecord> = {}): Promise<ProgrammeExitRecord | null> {
  // Claimed first, so two replicas sweeping in the same minute, or a sweep
  // and an End now, never run one end twice.
  const rec = { ...read, ...changes };
  const running: ProgrammeExitRecord = { ...rec, state: 'running', changedAt: new Date().toISOString() };
  if (!(await d.store.replaceProgrammeExit(running, read))) return null;
  const scheduler = await schedulerOf(d.store, rec);
  const actor = actorId ? (await d.store.getUser(actorId)) ?? scheduler : scheduler;
  const rights = d.rights ? { rights: d.rights } : {};
  let planned = await planExit(d.store, rec.selection, actor, { projects: rec.projects, transferTo: rec.transferTo, ...rights });
  // The receiver or the owning team may have gone since: fall back to the
  // default for the programme as it is now, rather than not ending at all.
  if (!planned.ok && (planned.code === 'INVALID_INPUT' || planned.code === 'NO_OWNING_TEAM')) planned = await planExit(d.store, rec.selection, actor, rights);
  if (!planned.ok) {
    // It cannot run as it stands (the receiver and the default both refused):
    // back to waiting, where the programme page shows it to change or cancel.
    await d.store.replaceProgrammeExit(rec, running);
    return null;
  }
  await retireExitNotices(d.store, rec.id);
  return applyExit(d.store, d.audit, planned.plan, {
    actorRef, actorId: actor.id, createdBy: rec.createdBy, createdAt: rec.createdAt, id: rec.id, prior: rec,
    endedBy: actorRef === 'system' ? rec.createdBy : actor.id,
    ...(actorRef === 'system' ? { via: 'scheduled' as const } : {}), ...rights,
  });
}

/**
 * The scheduled part of the minute sweep: run the exits whose day has ended,
 * and send the reminders that are due. Returns how many exits ran.
 */
export async function sweepScheduledExits(d: ScheduleDeps, now = Date.now()): Promise<number> {
  let ran = 0;
  for (const rec of await d.store.listProgrammeExits({ state: 'scheduled' })) {
    if (!rec.endsAt) continue;
    if (Date.parse(rec.endsAt) <= now) {
      if (await runScheduledExit(d, rec)) ran++;
      continue;
    }
    const stage = rec.notice === false ? null : noticeDue(rec.endsAt, rec.notices, now);
    if (stage) await sendExitNotice(d, rec, stage, now);
  }
  await sweepMembershipNotices(d, now);
  return ran;
}

/** One reminder for one scheduled exit: the people it ends, and its scheduler. */
async function sendExitNotice(d: ScheduleDeps, rec: ProgrammeExitRecord, stage: NoticeStage, now: number): Promise<void> {
  const at = new Date(now).toISOString();
  // Marked first, so a sweep on another replica never sends it twice.
  const notices: NoticesSent = { ...rec.notices, [stage]: at, ...(stage === 'd1' && !rec.notices?.d14 ? { d14: at } : {}) };
  if (!(await d.store.replaceProgrammeExit({ ...rec, notices }, rec))) return;
  const ctx = d.context(now);
  const planned = await planExit(d.store, rec.selection, await schedulerOf(d.store, rec), { projects: rec.projects, transferTo: rec.transferTo });
  if (!planned.ok) return;
  const { plan } = planned;
  const label = plan.programme?.name ?? rec.programmeId ?? '';
  const target = plan.company?.name ?? label;
  const ends = plan.accounts.filter((a) => a.outcome !== 'stays').map((a) => a.user.id);
  const stays = plan.accounts.filter((a) => a.outcome === 'stays').map((a) => a.user.id);
  let emailed = false;
  if (d.people) {
    if (ends.length) {
      const n = accessEndsNotice({ id: `msg_exit_${rec.id}_${stage}`, users: ends, programme: label, endsAt: rec.endsAt!, accountEnds: true, projects: rec.projects }, ctx);
      await d.people.tell({ ...n, kind: 'access-ends' });
    }
    if (stays.length) {
      const n = accessEndsNotice({ id: `msg_exit_${rec.id}_${stage}_stays`, users: stays, programme: label, endsAt: rec.endsAt!, accountEnds: false }, ctx);
      await d.people.tell({ ...n, kind: 'access-ends' });
    }
    const scheduler = await d.store.getUser(rec.createdBy);
    if (scheduler && !scheduler.disabledAt && rec.programmeId) {
      await d.people.tell({ ...scheduledEndNotice({ id: `msg_exit_${rec.id}_${stage}_scheduler`, userId: scheduler.id, name: target, endsAt: rec.endsAt!, programmeId: rec.programmeId }, ctx), kind: 'access-ends' });
    }
    emailed = d.people.emailOn;
  }
  await d.audit('system', 'programme.exit.notice', rec.programmeId ? `programme:${rec.programmeId}` : 'programme:list', {
    exit: rec.id, stage, people: ends.length + stays.length, scheduler: true, emailed, endsAt: rec.endsAt,
  });
}

/** Reminders for membership end dates: the person only, at the same two times. */
async function sweepMembershipNotices(d: ScheduleDeps, now: number): Promise<number> {
  if (!d.people) return 0;
  const due: Array<{ m: MembershipRecord; stage: NoticeStage }> = [];
  for (const m of await d.store.listMemberships()) {
    if (m.endedAt || !m.endsAt) continue;
    const stage = noticeDue(m.endsAt, m.notices, now);
    if (stage) due.push({ m, stage });
  }
  if (!due.length) return 0;
  const ctx = d.context(now);
  const at = new Date(now).toISOString();
  const programmes = new Map((await d.store.listProgrammes()).map((p) => [p.id, p]));
  const byEmail = new Map((await d.store.listUsers()).map((u) => [u.email.toLowerCase(), u]));
  let sent = 0;
  for (const { m, stage } of due) {
    await d.store.putMembership({ ...m, notices: { ...m.notices, [stage]: at, ...(stage === 'd1' && !m.notices?.d14 ? { d14: at } : {}) } });
    const programme = programmes.get(m.programmeId);
    const user = m.userId ? await d.store.getUser(m.userId) : byEmail.get(m.email);
    if (!programme || isEnded(programme) || !user || user.disabledAt) continue;
    const n = accessEndsNotice({
      id: `msg_member_${sha256Hex(`${m.programmeId} ${m.email} ${m.endsAt}`).slice(0, 24)}_${stage}`, users: [user.id],
      programme: programme.name, endsAt: m.endsAt!, accountEnds: false,
    }, ctx);
    await d.people.tell({ ...n, kind: 'access-ends' });
    sent++;
  }
  if (sent) await d.audit('system', 'programme.member.notice', 'programme:memberships', { people: sent, emailed: d.people.emailOn });
  return sent;
}

/**
 * When a partner's access through a programme ends, for org-config's
 * `partner.accessEndsAt`: the earliest of their live membership end dates and
 * the scheduled ends of a programme or company they are in, with the
 * programme it ends through. A scheduled end with its notice turned off is
 * left out, as the admin chose not to tell. Null when nothing is set.
 */
export async function accessEndsFor(store: Store, user: UserRecord, now = Date.now()): Promise<{ at: string; programme: { id: string; name: string } } | null> {
  const programmes = new Map((await store.listProgrammes()).map((p) => [p.id, p]));
  const email = user.email.toLowerCase();
  let best: { at: string; programmeId: string } | null = null;
  const offer = (at: string | undefined, programmeId: string | undefined) => {
    if (!at || !programmeId || Date.parse(at) <= now) return;
    if (!best || Date.parse(at) < Date.parse(best.at)) best = { at, programmeId };
  };
  for (const m of await store.listMemberships()) {
    if (m.endedAt || (m.userId ? m.userId !== user.id : m.email !== email)) continue;
    if (user.groups.includes(programmeGroup(m.programmeId))) offer(m.endsAt, m.programmeId);
  }
  for (const rec of await store.listProgrammeExits({ state: 'scheduled' })) {
    if (rec.notice === false) continue;
    const group = rec.selection.company ? companyGroup(rec.selection.company) : rec.selection.programme ? programmeGroup(rec.selection.programme) : null;
    if (group && user.groups.includes(group)) offer(rec.endsAt, rec.programmeId);
  }
  const found = best as { at: string; programmeId: string } | null;
  const programme = found ? programmes.get(found.programmeId) : undefined;
  return found && programme ? { at: found.at, programme: { id: programme.id, name: programme.name } } : null;
}

/**
 * Change or cancel a scheduled end, under `programme.manage`:
 * `PUT /api/v1/programmes/exits/:exit` with `{ at?, notice?, projects? }`
 * (`at: 'now'` ends it now with its choices), and
 * `DELETE /api/v1/programmes/exits/:exit` to call it off.
 */
export function registerScheduleRoutes(router: Router, deps: ScheduleDeps & {
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
}): void {
  const { store } = deps;
  const waiting = async (res: ServerResponse, id: string): Promise<ProgrammeExitRecord | null> => {
    const rec = await store.getProgrammeExit(id);
    if (!rec) { sendError(res, 404, 'NOT_FOUND', 'no such exit'); return null; }
    if (rec.state !== 'scheduled') { sendError(res, 409, 'NOT_SCHEDULED', `this end is ${rec.state === 'done' ? 'done' : rec.state} and cannot be changed`); return null; }
    return rec;
  };
  router.add('PUT', '/api/v1/programmes/exits/:exit', async (req, res, ctx) => {
    const actor = await deps.requireAction(req, res, 'programme.manage'); if (!actor) return;
    const rec = await waiting(res, String(ctx.params.exit)); if (!rec) return;
    const body = ((await readJson(req)) ?? {}) as { at?: unknown; notice?: unknown; projects?: unknown };
    if (body.notice !== undefined && typeof body.notice !== 'boolean') return sendError(res, 400, 'INVALID_INPUT', 'notice must be true or false');
    if (body.projects !== undefined && !(PROJECT_MODES as readonly string[]).includes(String(body.projects))) {
      return sendError(res, 400, 'INVALID_INPUT', `projects is one of ${PROJECT_MODES.join(', ')}`);
    }
    if (body.at === 'now') {
      const done = await runScheduledExit(deps, rec, `user:${actor.id}`, actor.id, body.projects ? { projects: body.projects as ProjectsMode } : {});
      if (!done) return sendError(res, 409, 'CANNOT_END', 'this end is already running, or cannot run as scheduled; reload the programme page');
      return sendJson(res, 200, { exit: done.id, state: done.state, doneAt: done.doneAt }, { 'cache-control': 'no-store' });
    }
    const at = body.at === undefined ? rec.endsAt! : endOfDay(body.at);
    if (typeof at === 'object') return sendError(res, 400, 'INVALID_INPUT', at.error);
    const now = new Date().toISOString();
    const next: ProgrammeExitRecord = {
      ...rec, endsAt: at, ...(body.notice !== undefined ? { notice: body.notice } : {}), ...(body.projects ? { projects: body.projects as ProjectsMode } : {}),
      changedBy: actor.id, changedAt: now,
    };
    // A new date gets its own reminders, and the ones sent for the old date go.
    const fresh = at !== rec.endsAt || next.notice === false;
    if (fresh) delete next.notices;
    if (!(await store.replaceProgrammeExit(next, rec))) return sendError(res, 409, 'EXIT_CHANGED', 'this end changed or started running meanwhile; reload and try again');
    if (fresh) await retireExitNotices(store, rec.id);
    await deps.audit(`user:${actor.id}`, 'programme.exit.change', rec.programmeId ? `programme:${rec.programmeId}` : 'programme:list', {
      exit: rec.id, before: { endsAt: rec.endsAt, notice: rec.notice !== false, projects: rec.projects },
      after: { endsAt: next.endsAt, notice: next.notice !== false, projects: next.projects },
    });
    sendJson(res, 200, { exit: rec.id, state: 'scheduled', endsAt: next.endsAt, notice: next.notice !== false, projects: next.projects }, { 'cache-control': 'no-store' });
  });
  router.add('DELETE', '/api/v1/programmes/exits/:exit', async (req, res, ctx) => {
    const actor = await deps.requireAction(req, res, 'programme.manage'); if (!actor) return;
    const rec = await waiting(res, String(ctx.params.exit)); if (!rec) return;
    if (!(await store.replaceProgrammeExit({ ...rec, state: 'cancelled', changedBy: actor.id, changedAt: new Date().toISOString() }, rec))) {
      return sendError(res, 409, 'EXIT_CHANGED', 'this end changed or started running meanwhile; reload and try again');
    }
    await retireExitNotices(store, rec.id);
    await deps.audit(`user:${actor.id}`, 'programme.exit.cancel', rec.programmeId ? `programme:${rec.programmeId}` : 'programme:list', { exit: rec.id, endsAt: rec.endsAt });
    sendJson(res, 200, { exit: rec.id, state: 'cancelled' }, { 'cache-control': 'no-store' });
  });
}
