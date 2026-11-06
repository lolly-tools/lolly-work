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
 * - Ending a partnership by programme, company or list: a dry run of who and
 *   what they own, then one audited step that transfers their projects,
 *   disables their accounts, ends their sessions and revokes their links,
 *   tokens and pending invitations. Only partner accounts are touched; an
 *   internal account in the selection is listed and left alone.
 *
 * Previews and one confirmation, no approval chain: an admin acting alone can
 * do all of this (Andy, 2026-11-06).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { isProgrammeScoped, programmeGroup, PARTNER_GROUP } from './types.ts';
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
    const rec: CompanyRecord = { id, programmeId: programme.id, name, createdBy: prior?.createdBy ?? actor.id, createdAt: prior?.createdAt ?? at, updatedAt: at };
    await store.putCompany(rec);
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
    for (const m of (await store.listMemberships()).filter((x) => x.companyId === id)) {
      const { companyId: _drop, ...rest } = m;
      await store.putMembership(rest);
    }
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
        disabled: !!u.disabledAt };
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
    const group = programmeGroup(programme.id);
    const [companies, accounts, memberships, invitations] = await Promise.all([
      store.listCompanies(), accountsByEmail(store), store.listMemberships(), store.listInvitations(),
    ]);
    const programmeCompanies = companies.filter((c) => c.programmeId === programme.id);
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
    sendJson(res, 200, { ended: await sweepProgrammeEnds(store, deps.audit) });
  });

  // ── ending a partnership ───────────────────────────────────────────────────
  /** Preview by default; `apply: true` does it. Select by `programme`, `company`
   *  or `emails`; `projects` is `transfer-readonly` (default), `transfer` or
   *  `keep`, and `transferTo` names who receives them (default: whoever ends it). */
  router.add('POST', '/api/v1/programmes/exit', async (req, res) => {
    const actor = await manager(req, res); if (!actor) return;
    const body = (await readJson(req, 512 * 1024)) as { programme?: unknown; company?: unknown; emails?: unknown; projects?: unknown; transferTo?: unknown; apply?: unknown } | null;
    const [users, invitations, projects, companies] = await Promise.all([store.listUsers(), store.listInvitations(), store.listProjects(), store.listCompanies()]);
    let selectGroup: string | undefined;
    let emails: Set<string> | undefined;
    let programme: Awaited<ReturnType<Store['getProgramme']>> = null;
    if (typeof body?.programme === 'string') {
      programme = await store.getProgramme(body.programme);
      if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
      selectGroup = programmeGroup(body.programme);
    } else if (typeof body?.company === 'string') {
      const company = companies.find((c) => c.id === body.company);
      if (!company) return sendError(res, 404, 'NOT_FOUND', 'no such company');
      programme = await store.getProgramme(company.programmeId);
      selectGroup = companyGroup(body.company);
    } else if (Array.isArray(body?.emails) && body.emails.every((e) => typeof e === 'string')) {
      emails = new Set((body.emails as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean));
      if (!emails.size || emails.size > 1000) return sendError(res, 400, 'INVALID_INPUT', 'name between 1 and 1000 addresses');
    } else return sendError(res, 400, 'INVALID_INPUT', 'select by programme, company or emails');
    // Where their projects go (Andy, 2026-11-06): to the team that owns the
    // programme, read-only, by default. "team-readonly": owned by whoever made
    // the programme (or you, when that account cannot hold work), shared with
    // the owning team as viewers, and archived. "me-readonly" and "me" move them
    // to you; "keep" leaves them.
    const modes = ['team-readonly', 'me-readonly', 'me', 'keep'] as const;
    type Mode = (typeof modes)[number];
    const team = programme?.team;
    const asked = (modes as readonly string[]).includes(String(body?.projects)) ? body!.projects as Mode : undefined;
    if (asked === 'team-readonly' && !team) return sendError(res, 400, 'NO_OWNING_TEAM', 'this programme has no owning team: set one on its page, or move the projects to yourself');
    const projectsMode: Mode = asked ?? (team ? 'team-readonly' : 'me-readonly');
    let transferTo = actor;
    if (projectsMode === 'team-readonly' && programme) {
      const maker = await store.getUser(programme.createdBy);
      if (maker && !maker.disabledAt && !isProgrammeScoped(maker.groups, maker.role)) transferTo = maker;
    }
    if (typeof body?.transferTo === 'string') {
      const target = await store.getUser(body.transferTo);
      if (!target || target.disabledAt || isProgrammeScoped(target.groups, target.role)) return sendError(res, 400, 'INVALID_INPUT', 'transfer to an enabled internal account');
      transferTo = target;
    }
    const selected = users.filter((u) => !u.id.startsWith('svc_') && (selectGroup ? u.groups.includes(selectGroup) : emails!.has(u.email.toLowerCase())));
    const partners = selected.filter((u) => isProgrammeScoped(u.groups, u.role) && u.id !== actor.id);
    const skipped = selected.filter((u) => !partners.includes(u)).map((u) => ({ id: u.id, email: u.email, reason: u.id === actor.id ? 'your own account' : 'not a partner account' }));
    const pending = invitations.filter((i) => !i.acceptedAt && !i.revokedAt && (selectGroup ? i.groups.includes(selectGroup) : emails!.has(i.email)));
    // The same bounded read the single-account offboarding preview uses; past
    // 200 the count says "200 or more" rather than reading everything.
    const linksOf = async (userId: string) => Math.min(200, (await store.subjectRows(userId, 'links', '', 201)).length);
    const accounts = await Promise.all(partners.map(async (u) => ({
      id: u.id, name: [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email, email: u.email, disabled: !!u.disabledAt,
      projects: projects.filter((p) => p.ownerId === u.id).map((p) => ({ id: p.id, name: p.name })),
      links: await linksOf(u.id),
    })));
    if (body?.apply !== true) {
      return sendJson(res, 200, { dryRun: true, projects: projectsMode, transferTo: { id: transferTo.id, email: transferTo.email }, ...(team ? { team } : {}),
        accounts, skipped, pendingInvitations: pending.map((i) => ({ id: i.id, email: i.email })) }, { 'cache-control': 'no-store' });
    }
    const at = now();
    const done: Array<Record<string, unknown>> = [];
    for (const a of accounts) {
      for (const p of a.projects) {
        if (projectsMode === 'keep') continue;
        const project = await store.getProject(p.id);
        if (!project) continue;
        const readOnly = projectsMode !== 'me';
        const next = { ...project, ownerId: transferTo.id, ...(readOnly ? { archivedAt: at } : {}) };
        if (projectsMode === 'team-readonly' && team) {
          const visible = project.visibility === 'private' ? [] : project.visibility.groups;
          next.visibility = { groups: [...new Set([...visible, team])] };
          const grants = (project.sharing?.groups ?? []).filter((g) => !(g.kind === 'directory' && g.name === team));
          next.sharing = { ...project.sharing, groups: [...grants, { kind: 'directory', name: team, role: 'viewer' }] };
        }
        await store.putProject(next);
        await deps.audit(`user:${actor.id}`, 'project.transfer', `project:${p.id}`, { from: a.id, to: transferTo.id, via: 'programme-exit',
          ...(readOnly ? { archived: true } : {}), ...(projectsMode === 'team-readonly' ? { team } : {}) });
      }
      const result = await store.offboardUser(a.id, actor.id, at, 1000);
      await deps.audit(`user:${actor.id}`, 'user.offboard', `user:${a.id}`, { ...result, via: 'programme-exit' });
      for (const m of (await store.listMemberships()).filter((x) => !x.endedAt && x.email === a.email.toLowerCase())) await store.putMembership({ ...m, endedAt: at });
      done.push({ id: a.id, result: result.status, projects: projectsMode === 'keep' ? 0 : a.projects.length });
    }
    for (const inv of pending) {
      await store.revokeInvitation(inv.id, at, { pendingOnly: true });
      await deps.audit(`user:${actor.id}`, 'invite.revoke', `invitation:${inv.id}`, { was: 'pending', via: 'programme-exit' });
    }
    await deps.audit(`user:${actor.id}`, 'programme.exit', selectGroup ? `group:${selectGroup}` : 'programme:list', {
      accounts: done.length, invitationsRevoked: pending.length, skipped: skipped.length, projects: projectsMode, transferTo: transferTo.id, ...(team ? { team } : {}),
    });
    sendJson(res, 200, { dryRun: false, accounts: done, skipped, invitationsRevoked: pending.length }, { 'cache-control': 'no-store' });
  });
}
