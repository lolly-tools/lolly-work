// SPDX-License-Identifier: MPL-2.0
/**
 * Programme people routes (plans/82 M1 part 2), all under `programme.manage`.
 *
 * - Companies inside a programme, each wrapping the reserved group company-<id>.
 * - Adding many people at once from a pasted list or CSV, previewed first, then
 *   applied in one step with a result per row. A list that has already run
 *   changes nothing.
 * - End dates: a membership can end at a set time, and the sweep removes the
 *   programme and company groups then (the partner marker stays).
 * - Ending a partnership by programme, company, domain or list: a dry run of
 *   who and what they own, then one audited step (programmes/exit.ts) that
 *   leaves a receipt. Only partner accounts are touched; an internal account
 *   in the selection is listed and left alone. A programme or company that
 *   ended is a state: list imports and token placements answer 409
 *   PROGRAMME_ENDED until it is reopened.
 * - Placing a service token in a programme, and optionally in one company in
 *   it (plans/82 M3), so an agent is scoped exactly like the people there.
 *   An owner act (`token.manage`), like minting the token.
 *
 * Previews and one confirmation, no approval chain: an admin acting alone can
 * do all of this (Andy, 2026-11-06).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { isEnded, noteCompanyProgramme, programmeGroup, PARTNER_GROUP } from './types.ts';
import { programmeTokenGroups, tokenGroupsWithout, tokenPlacement } from '../iam/service-tokens.ts';
import type { TxtLookup } from './domains.ts';
import { forgetDomainCompany, recheckDomains, sweepDomainRules } from './domain-routes.ts';
import { sweepFolderRules, withdrawFolderRules } from './folder-routes.ts';
import { applyExit, exitDone, exitPreview, planExit, readExitSelection, type ExitRightsChoices } from './exit.ts';
import {
  COMPANY_ID, companyGroup, membershipEnded, parsePeopleList, planRows,
  type CompanyRecord, type MembershipRecord, type PersonRow, type RowPlan,
} from './people.ts';

type Router = ReturnType<typeof createRouter>;

export interface PeopleRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** Invite an address with groups, through the invitation rules every other
   *  route follows (policy.invites, admission). */
  invite(actor: UserRecord, email: string, groups: string[], expiresAt?: string): Promise<{ status: 'created' | 'existing' | 'already-member' | 'refused'; invitationId?: string; reason?: string; groups?: string[] }>;
  /** What one sign-in message for a whole list says: where to sign in, the
   *  sign-ins on offer and the instance's invite note. */
  signIn(): { workspace: string; url: string; providers: string[]; note: string | null };
  /** DNS TXT lookups, for the sweep's daily look at partner domains. */
  resolveTxt: TxtLookup;
  /** Drop a deleted company's profile, its history and its logos (plans/82 M3). */
  forgetCompanyProfile?(companyId: string): Promise<void>;
  /** The share-anyway choices an exit withdraws (plans/82 M4). Absent until
   *  that store exists; the exit then lists and withdraws none. */
  rightsChoices?: ExitRightsChoices;
}

/** One message an admin can send to everyone a list invited, instead of one
 *  message per person: Work sends no email (docs/work/invitations.md). */
export function batchSignInMessage(info: ReturnType<PeopleRouteDeps['signIn']>, programme: string, endsAt: Array<string | undefined>): string {
  const ways = info.providers.length ? ` with ${info.providers.join(' or ')}` : '';
  // One date only when every person invited shares it; otherwise the message
  // states no date that would be wrong for some of them.
  const ends = [...new Set(endsAt)];
  const end = ends.length === 1 && ends[0] ? `Your access runs until ${new Date(ends[0]).toISOString().slice(0, 10)} (UTC).`
    : ends.some(Boolean) ? 'If your access has an end date, you will see it when you sign in.' : '';
  return [
    `You are invited to ${info.workspace} as part of ${programme}.`,
    `Open ${info.url} and sign in${ways}, using the email address this message was sent to.`,
    end, info.note ?? '',
  ].filter(Boolean).join('\n');
}

const now = (): string => new Date().toISOString();

async function accountsByEmail(store: Store): Promise<Map<string, UserRecord>> {
  const map = new Map<string, UserRecord>();
  for (const u of await store.listUsers()) if (u.email && !u.id.startsWith('svc_')) map.set(u.email.toLowerCase(), u);
  return map;
}

/**
 * End the memberships whose end date has passed: take the programme group and
 * the company group off the account (the partner marker stays, so the person
 * keeps only the essentials), revoke a pending invitation the membership made,
 * and audit each one. Idempotent; main.ts runs it on a timer.
 */
export async function sweepProgrammeEnds(store: Store, audit: PeopleRouteDeps['audit'], at = Date.now()): Promise<number> {
  const memberships = (await store.listMemberships()).filter((m) => membershipEnded(m, at));
  if (!memberships.length) return 0;
  const accounts = await accountsByEmail(store);
  const invitations = await store.listInvitations();
  const stamp = new Date(at).toISOString();
  for (const m of memberships) {
    const drop = new Set([programmeGroup(m.programmeId), ...(m.companyId ? [companyGroup(m.companyId)] : [])]);
    const account = m.userId ? await store.getUser(m.userId) : accounts.get(m.email) ?? null;
    if (account) {
      const next = account.localGroups.filter((g) => !drop.has(g));
      if (next.length !== account.localGroups.length) await store.setLocalGroups(account.id, next.includes(PARTNER_GROUP) ? next : [...next, PARTNER_GROUP]);
    }
    for (const inv of invitations.filter((i) => i.email === m.email && !i.acceptedAt && !i.revokedAt && i.groups.some((g) => drop.has(g)))) {
      await store.revokeInvitation(inv.id, stamp, { pendingOnly: true });
    }
    await store.putMembership({ ...m, endedAt: stamp });
    await audit('system', 'programme.member.end', `programme:${m.programmeId}`, {
      ...(account ? { user: account.id } : {}), ...(m.companyId ? { company: m.companyId } : {}), endsAt: m.endsAt,
    });
  }
  return memberships.length;
}

/**
 * Take groups off every live token that carries one of them, keeping the
 * partner marker: what deleting a company or a programme does to the tokens
 * placed in it. Audited per token.
 */
export async function dropTokenGroups(store: Store, audit: PeopleRouteDeps['audit'], actor: string, drop: ReadonlySet<string>, via: string): Promise<number> {
  let changed = 0;
  for (const t of await store.listApiTokens()) {
    if (t.revokedAt || !(t.groups ?? []).some((g) => drop.has(g))) continue;
    const groups = tokenGroupsWithout(t, drop)!;
    await store.putApiToken({ ...t, groups });
    await audit(actor, 'token.programme', `token:${t.id}`, { removed: (t.groups ?? []).filter((g) => drop.has(g)), via });
    changed++;
  }
  return changed;
}

/**
 * Remove the grants naming a group and take the group out of every collection
 * that names it: what deleting a company does (plans/82 M5), as deleting a
 * programme always did. Audited per grant and per collection.
 */
export async function forgetGroupReach(store: Store, audit: PeopleRouteDeps['audit'], actor: string, group: string, via: string): Promise<void> {
  for (const g of (await store.listGrants()).filter((x) => x.principal === `group:${group}`)) {
    await store.deleteGrant(g);
    await audit(actor, 'grant.delete', `grant:${g.principal}`, { ...g, via });
  }
  const at = now();
  for (const c of await store.listCollections()) {
    if (!Array.isArray(c.groups) || !c.groups.includes(group)) continue;
    const groups = c.groups.filter((g) => g !== group);
    const next = { ...c, groups: groups.length ? groups : '*' as const, updatedAt: at };
    await store.putCollection(next);
    await audit(actor, 'catalog.collection.edit', `collection:${c.id}`, { before: c, after: next, via });
  }
}

export function registerProgrammePeopleRoutes(router: Router, deps: PeopleRouteDeps): void {
  const { store } = deps;
  const manager = (req: IncomingMessage, res: ServerResponse) => deps.requireAction(req, res, 'programme.manage');
  const programmeOr404 = async (res: ServerResponse, id: string) => {
    const rec = await store.getProgramme(id);
    if (!rec) sendError(res, 404, 'NOT_FOUND', 'no such programme');
    return rec;
  };

  // ── companies ──────────────────────────────────────────────────────────────
  router.add('PUT', '/api/v1/programmes/:id/companies/:companyId', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const id = String(ctx.params.companyId);
    if (!COMPANY_ID.test(id)) return sendError(res, 400, 'INVALID_INPUT', 'company id must be lowercase letters, digits and hyphens, at most 48');
    const body = (await readJson(req)) as { name?: unknown } | null;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return sendError(res, 400, 'INVALID_INPUT', 'name is required, at most 120 characters');
    const prior = (await store.listCompanies()).find((c) => c.id === id);
    if (prior && prior.programmeId !== programme.id) return sendError(res, 409, 'COMPANY_IN_ANOTHER_PROGRAMME', 'this company id belongs to another programme');
    const at = now();
    if (!prior && isEnded(programme)) return sendError(res, 409, 'PROGRAMME_ENDED', `${programme.name} has ended; reopen it before adding a company`);
    // A rename keeps an ended company ended.
    const ended = prior?.endedAt ? { endedAt: prior.endedAt, ...(prior.endedBy ? { endedBy: prior.endedBy } : {}), ...(prior.endedExit ? { endedExit: prior.endedExit } : {}) } : {};
    const rec: CompanyRecord = { id, programmeId: programme.id, name, createdBy: prior?.createdBy ?? actor.id, createdAt: prior?.createdAt ?? at, updatedAt: at, ...ended };
    await store.putCompany(rec);
    noteCompanyProgramme(id, programme.id);
    await store.putLocalGroup({ name: companyGroup(id), description: `Partner company: ${name} (${programme.name})`, createdAt: prior?.createdAt ?? at });
    await deps.audit(`user:${actor.id}`, prior ? 'programme.company.edit' : 'programme.company.create', `programme:${programme.id}`, { company: id, name, ...(prior ? { before: prior.name } : {}) });
    sendJson(res, prior ? 200 : 201, rec);
  });

  router.add('DELETE', '/api/v1/programmes/:id/companies/:companyId', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const id = String(ctx.params.companyId);
    const rec = (await store.listCompanies()).find((c) => c.id === id && c.programmeId === programme.id);
    if (!rec) return sendError(res, 404, 'NOT_FOUND', 'no such company in this programme');
    await store.deleteLocalGroup(companyGroup(id));
    await store.deleteCompany(id);
    noteCompanyProgramme(id, null);
    await deps.forgetCompanyProfile?.(id);
    await forgetDomainCompany(store, id, now());
    await withdrawFolderRules(store, deps.audit, `user:${actor.id}`, { companyId: id }, 'company-delete');
    for (const m of (await store.listMemberships()).filter((x) => x.companyId === id)) {
      const { companyId: _drop, ...rest } = m;
      await store.putMembership(rest);
    }
    // Tokens placed in the company stay in its programme: the company group
    // goes, so a company made later with the same id never inherits them.
    await dropTokenGroups(store, deps.audit, `user:${actor.id}`, new Set([companyGroup(id)]), 'company-delete');
    // Grants and collection entries naming its group go with it (plans/82
    // M5), so a company made later with the same id inherits none of them.
    await forgetGroupReach(store, deps.audit, `user:${actor.id}`, companyGroup(id), 'company-delete');
    await store.deleteProgrammeExits({ companyId: id });
    await deps.audit(`user:${actor.id}`, 'programme.company.delete', `programme:${programme.id}`, { company: id, name: rec.name });
    sendJson(res, 200, { ok: true });
  });

  // ── people ─────────────────────────────────────────────────────────────────
  router.add('GET', '/api/v1/programmes/:id/people', async (req, res, ctx) => {
    if (!(await manager(req, res))) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const group = programmeGroup(programme.id);
    const [users, memberships, companies, invitations] = await Promise.all([
      store.listUsers(), store.listMemberships(), store.listCompanies(), store.listInvitations(),
    ]);
    const mine = memberships.filter((m) => m.programmeId === programme.id && !m.endedAt);
    const byEmail = new Map(mine.map((m) => [m.email, m]));
    const companyName = (id?: string) => companies.find((c) => c.id === id)?.name;
    const people = users.filter((u) => u.groups.includes(group)).map((u) => {
      const m = byEmail.get(u.email.toLowerCase());
      const company = companies.find((c) => u.groups.includes(companyGroup(c.id)));
      return { id: u.id, name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email, email: u.email,
        ...(company ? { company: { id: company.id, name: company.name } } : {}), ...(m?.endsAt ? { endsAt: m.endsAt } : {}),
        ...(m?.via === 'domain' && m.domain ? { joinedThrough: m.domain } : {}), disabled: !!u.disabledAt };
    });
    const signedIn = new Set(people.map((p) => p.email.toLowerCase()));
    const invited = invitations.filter((i) => !i.acceptedAt && !i.revokedAt && i.groups.includes(group) && !signedIn.has(i.email)).map((i) => {
      const m = byEmail.get(i.email);
      return { invitationId: i.id, email: i.email, ...(m?.companyId ? { company: { id: m.companyId, name: companyName(m.companyId) } } : {}),
        ...(m?.endsAt ? { endsAt: m.endsAt } : {}), ...(i.expiresAt ? { inviteEndsAt: i.expiresAt } : {}) };
    });
    sendJson(res, 200, { programme: programme.id, companies: companies.filter((c) => c.programmeId === programme.id), people, invited }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  /** Preview by default; `apply: true` does it. Body: `{ text }` (a pasted list or
   *  CSV: email, name, company, end date) or `{ rows: [{ email, name?, company?, endsAt? }] }`. */
  router.add('POST', '/api/v1/programmes/:id/people', async (req, res, ctx) => {
    const actor = await manager(req, res); if (!actor) return;
    const programme = await programmeOr404(res, String(ctx.params.id)); if (!programme) return;
    const body = (await readJson(req, 512 * 1024)) as { text?: unknown; rows?: unknown; apply?: unknown } | null;
    let rows: PersonRow[];
    if (typeof body?.text === 'string') rows = parsePeopleList(body.text);
    else if (Array.isArray(body?.rows)) {
      rows = (body.rows as Array<Record<string, unknown>>).map((r, i) => ({ line: i + 1, email: String(r?.email ?? '').trim().toLowerCase(),
        ...(typeof r?.name === 'string' && r.name.trim() ? { name: r.name.trim() } : {}),
        ...(typeof r?.company === 'string' && r.company.trim() ? { company: r.company.trim() } : {}),
        ...(typeof r?.endsAt === 'string' && r.endsAt.trim() ? { endsAt: r.endsAt.trim() } : {}) }));
    } else return sendError(res, 400, 'INVALID_INPUT', 'send text (a list or CSV) or rows');
    if (rows.length > 1000) return sendError(res, 400, 'INVALID_INPUT', 'at most 1000 people per list');
    if (isEnded(programme)) return sendError(res, 409, 'PROGRAMME_ENDED', `${programme.name} has ended; reopen it before adding people`);
    const group = programmeGroup(programme.id);
    const [companies, accounts, memberships, invitations] = await Promise.all([
      store.listCompanies(), accountsByEmail(store), store.listMemberships(), store.listInvitations(),
    ]);
    const programmeCompanies = companies.filter((c) => c.programmeId === programme.id);
    const endedCompany = programmeCompanies.find((c) => isEnded(c) && rows.some((r) => r.company && (r.company === c.id || r.company.toLowerCase() === c.name.toLowerCase())));
    if (endedCompany) return sendError(res, 409, 'PROGRAMME_ENDED', `${endedCompany.name} has ended; reopen it, or take it out of the list`);
    const plan = planRows(rows, {
      companies: programmeCompanies,
      accountFor: (email) => accounts.get(email) ?? null,
      memberAlready: (email, companyId, endsAtIso) => {
        const account = accounts.get(email);
        const m = memberships.find((x) => x.programmeId === programme.id && x.email === email && !x.endedAt);
        const wanted = [group, ...(companyId ? [companyGroup(companyId)] : [])];
        const inGroups = account
          ? wanted.every((g) => account.groups.includes(g))
          : invitations.some((i) => i.email === email && !i.revokedAt && !i.acceptedAt && wanted.every((g) => i.groups.includes(g)));
        return inGroups && (m?.endsAt ?? undefined) === endsAtIso;
      },
      now: Date.now(),
    });
    const summary = (list: RowPlan[]) => Object.fromEntries((['new', 'existing', 'already', 'invalid', 'duplicate'] as const).map((s) => [s, list.filter((r) => r.status === s).length]));
    if (body?.apply !== true) {
      return sendJson(res, 200, { dryRun: true, programme: programme.id, summary: summary(plan), rows: plan }, { 'cache-control': 'no-store' });
    }
    const results: Array<RowPlan & { result: string; reason?: string; invitationId?: string; userId?: string }> = [];
    for (const row of plan) {
      if (row.status !== 'new' && row.status !== 'existing') { results.push({ ...row, result: row.status === 'already' ? 'unchanged' : 'skipped' }); continue; }
      const groups = [group, ...(row.companyId ? [companyGroup(row.companyId)] : [])];
      let userId: string | undefined, invitationId: string | undefined;
      if (row.status === 'existing') {
        const account = accounts.get(row.email)!;
        if (account.disabledAt) { results.push({ ...row, result: 'refused', reason: 'account-disabled' }); continue; }
        if (account.role === 'admin' || account.role === 'owner') { results.push({ ...row, result: 'refused', reason: 'an admin or owner cannot be put in a programme from a list' }); continue; }
        const updated = await store.setLocalGroups(account.id, [...new Set([...account.localGroups, ...groups])]);
        userId = updated?.id;
        await deps.audit(`user:${actor.id}`, 'user.local-groups', `user:${account.id}`, { localGroups: updated?.localGroups ?? [], via: `programme:${programme.id}` });
      } else {
        const invited = await deps.invite(actor, row.email, groups, row.endsAtIso);
        if (invited.status === 'refused') { results.push({ ...row, result: 'refused', ...(invited.reason ? { reason: invited.reason } : {}) }); continue; }
        if (invited.status === 'existing' && invited.groups && !groups.every((g) => invited.groups!.includes(g))) {
          results.push({ ...row, result: 'refused', reason: 'this address already has an open invitation without this programme; revoke it in People and add the address again' });
          continue;
        }
        invitationId = invited.invitationId;
      }
      const prior = memberships.find((m) => m.programmeId === programme.id && m.email === row.email);
      const record: MembershipRecord = { programmeId: programme.id, email: row.email, ...(userId ? { userId } : {}),
        ...(row.companyId ? { companyId: row.companyId } : {}), ...(row.endsAtIso ? { endsAt: row.endsAtIso } : {}),
        addedBy: actor.id, addedAt: prior && !prior.endedAt ? prior.addedAt : now() };
      await store.putMembership(record);
      await deps.audit(`user:${actor.id}`, 'programme.member.add', `programme:${programme.id}`, {
        ...(userId ? { user: userId } : {}), ...(invitationId ? { invitation: invitationId } : {}),
        ...(row.companyId ? { company: row.companyId } : {}), ...(row.endsAtIso ? { endsAt: row.endsAtIso } : {}), via: 'list',
      });
      results.push({ ...row, result: row.status === 'existing' ? 'added' : 'invited', ...(userId ? { userId } : {}), ...(invitationId ? { invitationId } : {}) });
    }
    const invitedRows = results.filter((r) => r.result === 'invited');
    sendJson(res, 200, { dryRun: false, programme: programme.id, summary: summary(plan), rows: results,
      ...(invitedRows.length ? { message: batchSignInMessage(deps.signIn(), programme.name, invitedRows.map((r) => r.endsAtIso)) } : {}),
    }, { 'cache-control': 'no-store' });
  });

  /** Run the end-date sweep now: what the server's minute timer does, for a
   *  serverless deploy that crons this route with a service token instead. */
  router.add('POST', '/api/v1/programmes/sweep', async (req, res) => {
    const actor = await manager(req, res); if (!actor) return;
    const rulesEnded = await sweepDomainRules(store, deps.audit);
    const foldersEnded = await sweepFolderRules(store, deps.audit);
    const ended = await sweepProgrammeEnds(store, deps.audit);
    sendJson(res, 200, { ended, rulesEnded, foldersEnded, domainsChecked: await recheckDomains(store, deps.audit, deps.resolveTxt) });
  });

  // ── ending a partnership ───────────────────────────────────────────────────
  /** Preview by default; `apply: true` does it (programmes/exit.ts). Select by
   *  `programme`, `company`, `domain` or `emails`; `projects` is
   *  `team-readonly` (the default when the programme has an owning team),
   *  `me-readonly`, `me` or `keep`, and `transferTo` names who receives them.
   *  The apply step answers with the receipt's id as `exit`. */
  router.add('POST', '/api/v1/programmes/exit', async (req, res) => {
    const actor = await manager(req, res); if (!actor) return;
    const body = (await readJson(req, 512 * 1024)) as Record<string, unknown> | null;
    const selection = readExitSelection(body);
    if ('error' in selection) return sendError(res, 400, selection.code ?? 'INVALID_INPUT', selection.error);
    const planned = await planExit(store, selection, actor, { projects: body?.projects, transferTo: body?.transferTo, ...(deps.rightsChoices ? { rights: deps.rightsChoices } : {}) });
    if (!planned.ok) return sendError(res, planned.status, planned.code, planned.detail);
    if (body?.apply !== true) return sendJson(res, 200, exitPreview(planned.plan), { 'cache-control': 'no-store' });
    const record = await applyExit(store, deps.audit, planned.plan, {
      actorRef: `user:${actor.id}`, actorId: actor.id, ...(deps.rightsChoices ? { rights: deps.rightsChoices } : {}),
    });
    sendJson(res, 200, exitDone(record, planned.plan), { 'cache-control': 'no-store' });
  });

  // ── service tokens in a programme (plans/82 M3) ────────────────────────────
  /** Place a service token in a programme, and optionally one company in it,
   *  with `{ programme, company? }`, or take it out with `{ programme: null }`.
   *  The token then resolves to a principal carrying those groups, so it reaches
   *  what a person in that company reaches, through the same code. Taking a
   *  token out keeps the partner marker, so it keeps only the essentials and
   *  never becomes an internal token; mint a new one for internal work. Admin
   *  and owner tokens are never placed: those roles are never scoped. */
  router.add('PUT', '/api/v1/tokens/:id/programme', async (req, res, ctx) => {
    const actor = await deps.requireAction(req, res, 'token.manage'); if (!actor) return;
    const token = await store.getApiToken(String(ctx.params.id));
    if (!token || token.revokedAt) return sendError(res, 404, 'NOT_FOUND', 'no such live token');
    if (token.role === 'admin' || token.role === 'owner') {
      return sendError(res, 400, 'TOKEN_NOT_SCOPED', 'an admin or owner token is never scoped to a programme; mint one with scopes for the partner agent');
    }
    const body = (await readJson(req)) as { programme?: unknown; company?: unknown } | null;
    const before = tokenPlacement(token);
    let groups: string[] | undefined;
    let programmeId: string | undefined, companyId: string | undefined;
    if (body?.programme === null) {
      groups = before.partner ? [PARTNER_GROUP] : undefined;
    } else if (typeof body?.programme === 'string') {
      const programme = await store.getProgramme(body.programme);
      if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
      if (isEnded(programme)) return sendError(res, 409, 'PROGRAMME_ENDED', `${programme.name} has ended; reopen it before placing a token there`);
      programmeId = programme.id;
      if (body.company !== undefined && body.company !== null) {
        const company = typeof body.company === 'string' ? (await store.listCompanies()).find((c) => c.id === body.company) : undefined;
        if (!company || company.programmeId !== programme.id) return sendError(res, 404, 'NOT_FOUND', 'no such company in this programme');
        if (isEnded(company)) return sendError(res, 409, 'PROGRAMME_ENDED', `${company.name} has ended; reopen it before placing a token there`);
        companyId = company.id;
      }
      groups = programmeTokenGroups(programmeId, companyId);
    } else return sendError(res, 400, 'INVALID_INPUT', 'send a programme id, with an optional company id, or programme null');
    const next = { ...token };
    if (groups) next.groups = groups; else delete next.groups;
    await store.putApiToken(next);
    await deps.audit(`user:${actor.id}`, 'token.programme', `token:${token.id}`, {
      before: { ...(before.programmeId ? { programme: before.programmeId } : {}), ...(before.companyId ? { company: before.companyId } : {}) },
      after: { ...(programmeId ? { programme: programmeId } : {}), ...(companyId ? { company: companyId } : {}) },
    });
    sendJson(res, 200, { id: token.id, label: token.label, groups: next.groups ?? null,
      ...(programmeId ? { programme: programmeId } : {}), ...(companyId ? { company: companyId } : {}) }, { 'cache-control': 'no-store' });
  });
}
