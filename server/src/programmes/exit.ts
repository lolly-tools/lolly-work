// SPDX-License-Identifier: MPL-2.0
/**
 * Ending a partnership (plans/82 M1 part 2, widened in M5).
 *
 * One step covers everything a programme or a company owns, and leaves a
 * receipt that the ended page, the audit and Reopen read. Selected by
 * programme, company, domain or a list of addresses:
 *
 * - Domain rules that would let the same people back in are withdrawn first.
 * - Each partner account in the selection leaves. A person who is also in
 *   another live programme leaves this programme and company only (their
 *   groups and memberships) and keeps the account. Everyone else is disabled
 *   and signed out everywhere, their links, tokens and password links are
 *   revoked and their projects move as chosen. An account over the
 *   offboarding bound (`EXIT_ROW_BOUND` rows of one kind) is not disabled: it
 *   is listed as not ended, loses the selection's groups and keeps signing in
 *   until an admin clears its rows by hand.
 * - Open invitations in the selection are revoked.
 * - Service tokens placed in the programme or company are revoked, and so are
 *   those of the one company or programme a domain feeds.
 * - For a programme or company: templates published only to the selection
 *   are retired, a template also published elsewhere keeps its other
 *   audiences, the selection's provider folder rules end and its share-anyway
 *   choices are withdrawn.
 * - The programme or company is marked ended. Ended is a state, not a
 *   deletion: the record, the profile and its history stay, and list imports
 *   and new domain rules answer 409 PROGRAMME_ENDED until it is reopened.
 *
 * A domain or list exit selects people, not a programme, so everyone it
 * selects is disabled, as before, and nothing is marked ended.
 *
 * `planExit` reads and decides without writing; the dry run shows its answer.
 * `applyExit` does it and returns the receipt it stored.
 */
import type { ApiTokenRecord, InvitationRecord, ProjectRecord, Store, UserRecord } from '../store/types.ts';
import type { InstanceAssetRecord } from '../catalog/instance-assets.ts';
import { randomId } from '../lib/crypto.ts';
import {
  isEnded, isProgrammeGroup, isProgrammeScoped, PARTNER_GROUP, programmeGroup, type ProgrammeRecord,
} from './types.ts';
import { companyGroup, type CompanyRecord, type MembershipRecord } from './people.ts';
import { domainOfEmail, normaliseDomain, type DomainRule, type PartnerDomainRecord } from './domains.ts';
import { withdrawDomainRules } from './domain-routes.ts';
import { endFolderRules } from './folder-routes.ts';
import type { PartnerFolderRecord } from './folders.ts';
import { PUBLISHED_TYPES, retireTemplate } from './template-routes.ts';
import type { ReopenResult } from './reopen.ts';

type Audit = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => Promise<unknown>;

/** Rows of one kind (links, API tokens, password links) one account may hold
 *  and still be ended in one step: the offboarding bound. */
export const EXIT_ROW_BOUND = 1000;
/** Addresses one list exit may name. */
export const EXIT_LIST_MAX = 1000;
/** Rows the dry run reads per account to tell whether it is over the bound. */
const SCAN_ROWS = 10 * 201;

export const PROJECT_MODES = ['team-readonly', 'me-readonly', 'me', 'keep'] as const;
export type ProjectsMode = (typeof PROJECT_MODES)[number];

/** What an exit selects. Exactly one key is set. */
export interface ExitSelection {
  programme?: string;
  company?: string;
  domain?: string;
  emails?: string[];
}

/** A share-anyway choice inside the selection (plans/82 M4). */
export interface ExitRightsChoice { assetId: string; group: string; licence?: string }

/** M4's share-anyway store, as the exit needs it: list the choices for a
 *  programme or company, and withdraw them. Absent until that store exists. */
export interface ExitRightsChoices {
  list(pick: { programmeId?: string; companyId?: string }): Promise<ExitRightsChoice[]>;
  withdraw(actor: string, pick: { programmeId?: string; companyId?: string }, via: string): Promise<ExitRightsChoice[]>;
}

/** One project as it was before the exit moved it, so Reopen can put it back. */
export interface ExitProjectBefore {
  id: string;
  name: string;
  before: Pick<ProjectRecord, 'ownerId' | 'visibility' | 'sharing'> & { archivedAt: string | null };
}

/** What happened to one account. */
export interface ExitAccountResult {
  id: string;
  email: string;
  name: string;
  /** `ended`: disabled and signed out. `stays`: in another live programme,
   *  so it left this one and kept the account. `not-ended`: refused by the
   *  offboarding bound, still signing in. */
  outcome: 'ended' | 'stays' | 'not-ended';
  reason?: string;
  /** The live programmes it stays in, by name. */
  stays?: string[];
  /** Set when the account was disabled before this exit, so Reopen leaves it so. */
  disabledBefore?: string;
  groupsRemoved: string[];
  /** Programmes whose membership this exit ended. */
  memberships: string[];
  projects: ExitProjectBefore[];
  revoked?: { credentials: number; links: number; passwordLinks: number };
}

/** The receipt's account of what one exit did. */
export interface ExitResult {
  accounts: ExitAccountResult[];
  skipped: Array<{ id: string; email: string; reason: string }>;
  invitations: Array<{ id: string; email: string }>;
  tokens: Array<{ id: string; label: string }>;
  templates: Array<{ id: string; name: string; action: 'retire' | 'narrow'; groupsBefore: string[]; groupsAfter: string[] }>;
  folders: PartnerFolderRecord[];
  domainRules: Array<{ domain: string; rule: DomainRule }>;
  /** Domain records removed because the exit left them no rule, kept whole. */
  domainsRemoved: PartnerDomainRecord[];
  rightsChoices: ExitRightsChoice[];
  /** What the exit marked ended: the programme, and the companies. */
  ended: { programme?: string; companies: string[] };
}

/**
 * One exit, from the dry run's choices to what it did (migrations/0093).
 * `scheduled` waits for its date, `done` ran, `cancelled` was called off
 * before its date and `reopened` was undone.
 */
export interface ProgrammeExitRecord {
  id: string;
  state: 'scheduled' | 'done' | 'cancelled' | 'reopened';
  selection: ExitSelection;
  /** The programme it belongs to, when there is one. */
  programmeId?: string;
  /** The company, for a company exit. */
  companyId?: string;
  projects: ProjectsMode;
  /** Who receives moved projects, a user id. */
  transferTo: string;
  team?: string;
  createdBy: string;
  createdAt: string;
  /** When it ran, and who ran it ('system' for a scheduled end). */
  doneAt?: string;
  doneBy?: string;
  via?: 'scheduled';
  result?: ExitResult;
  /** A scheduled end: the instant it runs, whether the people it ends are
   *  told before (on unless unticked), and the reminders sent so far. */
  endsAt?: string;
  notice?: boolean;
  notices?: { d14?: string; d1?: string };
  /** Who last changed or cancelled a scheduled end, and when. */
  changedBy?: string;
  changedAt?: string;
  /** Set when the end was reopened (programmes/reopen.ts): who, when,
   *  whether projects went back, and what was put back. */
  reopened?: { at: string; by: string; projects: boolean; result: ReopenResult };
}

export const exitId = (): string => `pex_${randomId(12)}`;

const nameOf = (u: UserRecord): string => [u.firstname, u.lastname].filter(Boolean).join(' ') || u.email;

/** One account the exit would touch, and what would happen to it. */
interface PlannedAccount {
  user: UserRecord;
  outcome: 'ends' | 'stays' | 'cannot-end';
  /** Local groups the exit takes off (programme and company exits only). */
  drop: string[];
  stays: string[];
  projects: ProjectRecord[];
  links: number;
  reason?: string;
}

export interface ExitPlan {
  selection: ExitSelection;
  programme: ProgrammeRecord | null;
  company: CompanyRecord | null;
  /** The group a programme or company exit selects people by. */
  selectGroup?: string;
  selectDomain?: string;
  /** Groups inside the selection: the programme's and its companies', or the company's. */
  inside: Set<string>;
  projectsMode: ProjectsMode;
  transferTo: UserRecord;
  team?: string;
  accounts: PlannedAccount[];
  skipped: Array<{ id: string; email: string; reason: string }>;
  pending: InvitationRecord[];
  tokens: ApiTokenRecord[];
  rulesEnding: Array<{ domain: string; programme: { id: string; name: string }; company?: { id: string; name: string } }>;
  templates: Array<{ rec: InstanceAssetRecord; action: 'retire' | 'narrow'; groupsAfter: string[] }>;
  folders: PartnerFolderRecord[];
  rightsChoices: ExitRightsChoice[];
  withdraw?: { domain?: string; programmeId?: string; companyId?: string };
}

export type PlanOutcome = { ok: true; plan: ExitPlan } | { ok: false; status: number; code: string; detail: string };

/** Read an exit body's selection, or say what is wrong with it. */
export function readExitSelection(body: Record<string, unknown> | null): ExitSelection | { error: string; code?: string } {
  if (typeof body?.programme === 'string') return { programme: body.programme };
  if (typeof body?.company === 'string') return { company: body.company };
  if (typeof body?.domain === 'string') {
    const domain = normaliseDomain(body.domain);
    return domain ? { domain } : { error: 'give a domain name, such as partner.example', code: 'INVALID_DOMAIN' };
  }
  if (Array.isArray(body?.emails) && body.emails.every((e) => typeof e === 'string')) {
    const emails = [...new Set((body.emails as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (!emails.length || emails.length > EXIT_LIST_MAX) return { error: `name between 1 and ${EXIT_LIST_MAX} addresses` };
    return { emails };
  }
  return { error: 'select by programme, company, domain or emails' };
}

/** Live rows of one kind an account made, read in pages up to a cap: enough
 *  to tell whether the offboarding bound would refuse it. */
async function liveRows(store: Store, userId: string, category: 'links' | 'credentials'): Promise<{ live: number; complete: boolean }> {
  let after = '';
  let live = 0;
  let read = 0;
  for (;;) {
    const page = await store.subjectRows(userId, category, after, 201);
    live += page.filter((r) => !r.value.revokedAt).length;
    read += page.length;
    if (page.length < 201) return { live, complete: true };
    if (live > EXIT_ROW_BOUND || read >= SCAN_ROWS) return { live, complete: live > EXIT_ROW_BOUND };
    after = page[page.length - 1]!.key;
  }
}

/**
 * Decide what an exit would do, without writing anything. `actor` is the
 * person asking (never ended by their own exit); `opts.transferTo` names who
 * receives moved projects when it is not the default.
 */
export async function planExit(
  store: Store, selection: ExitSelection, actor: UserRecord,
  opts: { projects?: unknown; transferTo?: unknown; rights?: ExitRightsChoices } = {},
): Promise<PlanOutcome> {
  const [users, invitations, projects, companies, partnerDomains, programmes] = await Promise.all([
    store.listUsers(), store.listInvitations(), store.listProjects(), store.listCompanies(), store.listPartnerDomains(), store.listProgrammes(),
  ]);
  const programmeById = new Map(programmes.map((p) => [p.id, p]));
  let programme: ProgrammeRecord | null = null;
  let company: CompanyRecord | null = null;
  let selectGroup: string | undefined;
  let withdraw: ExitPlan['withdraw'];
  const inside = new Set<string>();
  // The one group a domain feeds, when it feeds exactly one: its tokens end too.
  let tokenGroup: { group: string; programmeOnly: boolean } | undefined;
  if (selection.programme !== undefined) {
    programme = programmeById.get(selection.programme) ?? null;
    if (!programme) return { ok: false, status: 404, code: 'NOT_FOUND', detail: 'no such programme' };
    selectGroup = programmeGroup(programme.id);
    withdraw = { programmeId: programme.id };
    inside.add(selectGroup);
    for (const c of companies) if (c.programmeId === programme.id) inside.add(companyGroup(c.id));
  } else if (selection.company !== undefined) {
    company = companies.find((c) => c.id === selection.company) ?? null;
    if (!company) return { ok: false, status: 404, code: 'NOT_FOUND', detail: 'no such company' };
    programme = programmeById.get(company.programmeId) ?? null;
    selectGroup = companyGroup(company.id);
    withdraw = { companyId: company.id };
    inside.add(selectGroup);
  } else if (selection.domain !== undefined) {
    withdraw = { domain: selection.domain };
    const rules = partnerDomains.find((d) => d.domain === selection.domain)?.rules ?? [];
    // A domain that feeds one programme ends with that programme's owning team.
    const fed = [...new Set(rules.map((r) => r.programmeId))];
    if (fed.length === 1) programme = programmeById.get(fed[0]!) ?? null;
    const groups = [...new Set(rules.map((r) => (r.companyId ? companyGroup(r.companyId) : programmeGroup(r.programmeId))))];
    if (groups.length === 1) tokenGroup = { group: groups[0]!, programmeOnly: isProgrammeGroup(groups[0]!) };
  }
  const emails = selection.emails ? new Set(selection.emails) : undefined;

  // Where their projects go (Andy, 2026-11-06): to the team that owns the
  // programme, read-only, by default. "team-readonly": owned by whoever made
  // the programme (or you, when that account cannot hold work), shared with
  // the owning team as viewers, and archived. "me-readonly" and "me" move them
  // to you; "keep" leaves them.
  const team = programme?.team;
  const asked = (PROJECT_MODES as readonly string[]).includes(String(opts.projects)) ? opts.projects as ProjectsMode : undefined;
  if (asked === 'team-readonly' && !team) {
    return { ok: false, status: 400, code: 'NO_OWNING_TEAM', detail: 'this programme has no owning team: set one on its page, or move the projects to yourself' };
  }
  const projectsMode: ProjectsMode = asked ?? (team ? 'team-readonly' : 'me-readonly');
  let transferTo = actor;
  if (projectsMode === 'team-readonly' && programme) {
    const maker = users.find((u) => u.id === programme!.createdBy);
    if (maker && !maker.disabledAt && !isProgrammeScoped(maker.groups, maker.role)) transferTo = maker;
  }
  if (typeof opts.transferTo === 'string') {
    const target = users.find((u) => u.id === opts.transferTo);
    if (!target || target.disabledAt || isProgrammeScoped(target.groups, target.role)) {
      return { ok: false, status: 400, code: 'INVALID_INPUT', detail: 'transfer to an enabled internal account' };
    }
    transferTo = target;
  }

  const picks = (email: string, groups: readonly string[]) =>
    selectGroup ? groups.includes(selectGroup) : selection.domain ? domainOfEmail(email) === selection.domain : emails!.has(email.toLowerCase());
  const selected = users.filter((u) => !u.id.startsWith('svc_') && picks(u.email, u.groups));
  const partners = selected.filter((u) => isProgrammeScoped(u.groups, u.role) && u.id !== actor.id);
  const skipped = selected.filter((u) => !partners.includes(u)).map((u) => ({ id: u.id, email: u.email, reason: u.id === actor.id ? 'your own account' : 'not a partner account' }));

  // A programme still running, other than the one ending.
  const live = (group: string) => {
    if (!isProgrammeGroup(group)) return false;
    const p = programmeById.get(group.slice('programme-'.length));
    return !!p && !isEnded(p) && !(selection.programme && p.id === selection.programme);
  };
  const companyOf = new Map(companies.map((c) => [companyGroup(c.id), c]));
  const accounts: PlannedAccount[] = await Promise.all(partners.map(async (u): Promise<PlannedAccount> => {
    let drop: string[] = [];
    if (selection.programme !== undefined) {
      drop = u.localGroups.filter((g) => inside.has(g));
    } else if (company) {
      // The company's group, and its programme's unless another live company
      // of that programme still holds the person.
      const other = u.localGroups.some((g) => g !== selectGroup && companyOf.get(g)?.programmeId === company!.programmeId && !isEnded(companyOf.get(g)));
      drop = u.localGroups.filter((g) => g === selectGroup || (!other && g === programmeGroup(company!.programmeId)));
    }
    const left = u.groups.filter((g) => !drop.includes(g));
    const stays = selectGroup ? [...new Set(left.filter(live).map((g) => programmeById.get(g.slice('programme-'.length))!.name))] : [];
    const owned = projects.filter((p) => p.ownerId === u.id);
    const links = await liveRows(store, u.id, 'links');
    let outcome: PlannedAccount['outcome'] = stays.length ? 'stays' : 'ends';
    let reason: string | undefined;
    if (outcome === 'ends') {
      const tokens = links.live > EXIT_ROW_BOUND ? null : await liveRows(store, u.id, 'credentials');
      if (links.live > EXIT_ROW_BOUND || (tokens && tokens.live > EXIT_ROW_BOUND)) {
        outcome = 'cannot-end';
        reason = `More than ${EXIT_ROW_BOUND} live ${links.live > EXIT_ROW_BOUND ? 'links' : 'API tokens'}: revoke some on their page, then disable the account there.`;
      }
    }
    return { user: u, outcome, drop, stays, projects: outcome === 'ends' ? owned : [], links: Math.min(links.live, EXIT_ROW_BOUND + 1), ...(reason ? { reason } : {}) };
  }));
  const pending = invitations.filter((i) => !i.acceptedAt && !i.revokedAt && picks(i.email, i.groups));

  // Service tokens placed in the programme or company end with it (plans/82
  // M3), and so do those of the one company or programme a domain feeds. A
  // token in a programme alone is taken only when it names no company, so a
  // domain of one company never ends another company's agent.
  const allTokens = selectGroup || tokenGroup ? await store.listApiTokens() : [];
  const tokens = allTokens.filter((t) => {
    if (t.revokedAt) return false;
    const g = t.groups ?? [];
    if (selectGroup) return g.includes(selectGroup);
    return !!tokenGroup && g.includes(tokenGroup.group) && (!tokenGroup.programmeOnly || !g.some((x) => x.startsWith('company-')));
  });

  const rulesEnding = withdraw ? partnerDomains.flatMap((d) => d.rules
    .filter((r) => d.domain === withdraw!.domain || (!!withdraw!.programmeId && r.programmeId === withdraw!.programmeId) || (!!withdraw!.companyId && r.companyId === withdraw!.companyId))
    .map((r) => ({
      domain: d.domain, programme: { id: r.programmeId, name: programmeById.get(r.programmeId)?.name ?? r.programmeId },
      ...(r.companyId ? { company: { id: r.companyId, name: companies.find((c) => c.id === r.companyId)?.name ?? r.companyId } } : {}),
    }))) : [];

  // What a programme or company owns beyond its people: templates published
  // to it, its folder rules and its share-anyway choices.
  const templates: ExitPlan['templates'] = [];
  let folders: PartnerFolderRecord[] = [];
  let rightsChoices: ExitRightsChoice[] = [];
  if (inside.size) {
    for (const rec of await store.listInstanceAssets()) {
      const groups = Array.isArray(rec.groups) ? rec.groups : [];
      if (!PUBLISHED_TYPES.has(String(rec.entry.type)) || rec.publication?.retiredAt || !groups.some((g) => inside.has(g))) continue;
      const after = groups.filter((g) => !inside.has(g));
      templates.push({ rec, action: after.length ? 'narrow' : 'retire', groupsAfter: after });
    }
    const pick = company ? { companyId: company.id } : { programmeId: programme!.id };
    folders = (await store.listPartnerFolders()).filter((r) => (pick.companyId ? r.companyId === pick.companyId : r.programmeId === pick.programmeId));
    rightsChoices = opts.rights ? await opts.rights.list(pick) : [];
  }

  return {
    ok: true,
    plan: {
      selection, programme, company, ...(selectGroup ? { selectGroup } : {}), ...(selection.domain ? { selectDomain: selection.domain } : {}),
      inside, projectsMode, transferTo, ...(team ? { team } : {}), accounts, skipped, pending, tokens, rulesEnding, templates, folders, rightsChoices,
      ...(withdraw ? { withdraw } : {}),
    },
  };
}

/** The dry run's answer: who and what, per kind. `accounts` lists only those
 *  whose access ends, so a count of it is a count of people ended. */
export function exitPreview(plan: ExitPlan): Record<string, unknown> {
  const person = (a: PlannedAccount) => ({ id: a.user.id, name: nameOf(a.user), email: a.user.email, disabled: !!a.user.disabledAt });
  const target = plan.company ?? plan.programme;
  return {
    dryRun: true, projects: plan.projectsMode, transferTo: { id: plan.transferTo.id, email: plan.transferTo.email }, ...(plan.team ? { team: plan.team } : {}),
    accounts: plan.accounts.filter((a) => a.outcome === 'ends').map((a) => ({
      ...person(a), projects: a.projects.map((p) => ({ id: p.id, name: p.name })), links: a.links,
    })),
    stays: plan.accounts.filter((a) => a.outcome === 'stays').map((a) => ({ ...person(a), stays: a.stays })),
    cannotEnd: plan.accounts.filter((a) => a.outcome === 'cannot-end').map((a) => ({ ...person(a), links: a.links, reason: a.reason })),
    skipped: plan.skipped,
    pendingInvitations: plan.pending.map((i) => ({ id: i.id, email: i.email })),
    domainRules: plan.rulesEnding,
    tokens: plan.tokens.map((t) => ({ id: t.id, label: t.label })),
    templates: plan.templates.map((t) => ({ id: t.rec.id, name: String(t.rec.entry.name ?? t.rec.id), action: t.action, ...(t.action === 'narrow' ? { keeps: t.groupsAfter } : {}) })),
    folders: plan.folders.map((f) => ({ provider: f.provider, path: f.path, ...(f.companyId ? { company: f.companyId } : {}) })),
    rightsChoices: plan.rightsChoices.map((c) => ({ assetId: c.assetId, group: c.group, ...(c.licence ? { licence: c.licence } : {}) })),
    rowBound: EXIT_ROW_BOUND,
    ...(target && isEnded(target) ? { alreadyEnded: { at: target.endedAt, by: target.endedBy } } : {}),
  };
}

/** Move one project as the plan says, and return how it was. */
async function moveProject(store: Store, audit: Audit, plan: ExitPlan, actorRef: string, fromId: string, project: ProjectRecord, at: string): Promise<ExitProjectBefore | null> {
  if (plan.projectsMode === 'keep') return null;
  const current = await store.getProject(project.id);
  if (!current) return null;
  const readOnly = plan.projectsMode !== 'me';
  const next: ProjectRecord = { ...current, ownerId: plan.transferTo.id, ...(readOnly ? { archivedAt: current.archivedAt ?? at } : {}) };
  if (plan.projectsMode === 'team-readonly' && plan.team) {
    const visible = current.visibility === 'private' ? [] : current.visibility.groups;
    next.visibility = { groups: [...new Set([...visible, plan.team])] };
    const grants = (current.sharing?.groups ?? []).filter((g) => !(g.kind === 'directory' && g.name === plan.team));
    next.sharing = { ...current.sharing, groups: [...grants, { kind: 'directory', name: plan.team, role: 'viewer' }] };
  }
  await store.putProject(next);
  await audit(actorRef, 'project.transfer', `project:${current.id}`, { from: fromId, to: plan.transferTo.id, via: 'programme-exit',
    ...(readOnly ? { archived: true } : {}), ...(plan.projectsMode === 'team-readonly' ? { team: plan.team } : {}) });
  return {
    id: current.id, name: current.name,
    before: { ownerId: current.ownerId, visibility: current.visibility, ...(current.sharing ? { sharing: current.sharing } : {}), archivedAt: current.archivedAt ?? null },
  };
}

/** End the live memberships of one address that `pick` chooses, from a
 *  snapshot read once per exit and kept current as it goes. */
async function endMemberships(store: Store, all: MembershipRecord[], email: string, pick: (m: MembershipRecord) => boolean, at: string): Promise<string[]> {
  const ended: string[] = [];
  for (const [i, m] of all.entries()) {
    if (m.endedAt || m.email !== email.toLowerCase() || !pick(m)) continue;
    const next = { ...m, endedAt: at };
    await store.putMembership(next);
    all[i] = next;
    ended.push(m.programmeId);
  }
  return ended;
}

/** The memberships a person leaves when a programme or company exit takes
 *  them out without ending their account: that programme's, or, for a
 *  company, the ones naming the company, and the programme's too when its
 *  group went. Null for a domain or list exit, which selects people. */
function leavesMembership(plan: ExitPlan, drop: readonly string[]): ((m: MembershipRecord) => boolean) | null {
  if (plan.selection.programme !== undefined && plan.programme) {
    const id = plan.programme.id;
    return (m) => m.programmeId === id;
  }
  if (plan.company) {
    const { id, programmeId } = plan.company;
    const programmeGone = drop.includes(programmeGroup(programmeId));
    return (m) => m.programmeId === programmeId && (m.companyId === id || programmeGone);
  }
  return null;
}

/** Take groups off an account, keeping the partner marker. */
async function dropGroups(store: Store, userId: string, drop: readonly string[]): Promise<string[]> {
  if (!drop.length) return [];
  const u = await store.getUser(userId);
  if (!u) return [];
  const gone = u.localGroups.filter((g) => drop.includes(g));
  if (!gone.length) return [];
  const next = u.localGroups.filter((g) => !drop.includes(g));
  await store.setLocalGroups(userId, next.includes(PARTNER_GROUP) ? next : [...next, PARTNER_GROUP]);
  return gone;
}

/**
 * Do what the plan says and store the receipt. `actorRef` is the audit actor
 * (`user:<id>`, or `system` for a scheduled end); `actorId` is the account
 * ending it, which offboarding never disables.
 */
export async function applyExit(
  store: Store, audit: Audit, plan: ExitPlan,
  opts: {
    actorRef: string; actorId: string; createdBy?: string; createdAt?: string; id?: string; via?: 'scheduled'; rights?: ExitRightsChoices;
    /** The scheduled receipt this run completes; its schedule fields are kept. */
    prior?: ProgrammeExitRecord;
    /** Who the ended mark names, when not the person running it (a scheduled
     *  end names the person who scheduled it). */
    endedBy?: string;
  },
): Promise<ProgrammeExitRecord> {
  const at = new Date().toISOString();
  const { actorRef } = opts;
  const result: ExitResult = {
    accounts: [], skipped: plan.skipped, invitations: [], tokens: [], templates: [], folders: [], domainRules: [], domainsRemoved: [], rightsChoices: [],
    ended: { companies: [] },
  };
  // First, so nobody new joins through a domain while the rest runs.
  if (plan.withdraw) {
    for (const r of await withdrawDomainRules(store, audit, actorRef, plan.withdraw, at)) {
      result.domainRules.push({ domain: r.domain, rule: r.rule });
      if (r.removed && !result.domainsRemoved.some((d) => d.domain === r.domain)) result.domainsRemoved.push(r.removed);
    }
  }
  const memberships = await store.listMemberships();
  for (const a of plan.accounts) {
    const u = (await store.getUser(a.user.id)) ?? a.user;
    const row: ExitAccountResult = { id: u.id, email: u.email, name: nameOf(u), outcome: 'ended', groupsRemoved: [], memberships: [], projects: [] };
    const leaves = leavesMembership(plan, a.drop);
    if (a.outcome === 'stays') {
      row.outcome = 'stays';
      row.stays = a.stays;
      row.groupsRemoved = await dropGroups(store, u.id, a.drop);
      row.memberships = leaves ? await endMemberships(store, memberships, u.email, leaves, at) : [];
      await audit(actorRef, 'programme.member.leave', plan.programme ? `programme:${plan.programme.id}` : 'programme:list', {
        user: u.id, ...(plan.company ? { company: plan.company.id } : {}), removed: row.groupsRemoved, stays: a.stays, via: 'programme-exit',
      });
      result.accounts.push(row);
      continue;
    }
    const offboard = await store.offboardUser(u.id, opts.actorId, at, EXIT_ROW_BOUND);
    await audit(actorRef, 'user.offboard', `user:${u.id}`, { ...offboard, via: 'programme-exit' });
    if (offboard.status !== 'disabled') {
      // Not ended: the account keeps signing in. A programme or company exit
      // still takes it out, so what was shared with it stops reaching it and
      // its links answer 410 through the maker check.
      row.outcome = 'not-ended';
      row.reason = offboard.status === 'limit'
        ? `More than ${EXIT_ROW_BOUND} live links, API tokens or password links: revoke some on their page, then disable the account there.`
        : `Could not be disabled (${offboard.status}).`;
      row.groupsRemoved = await dropGroups(store, u.id, a.drop);
      row.memberships = leaves ? await endMemberships(store, memberships, u.email, leaves, at) : [];
      result.accounts.push(row);
      continue;
    }
    if (u.disabledAt) {
      // Disabled before this exit: keep the date it was disabled on.
      row.disabledBefore = u.disabledAt;
      await store.setUserDisabled(u.id, u.disabledAt);
    }
    row.revoked = { credentials: offboard.credentialsRevoked, links: offboard.linksRevoked, passwordLinks: offboard.passwordLinksRevoked };
    for (const p of a.projects) {
      const moved = await moveProject(store, audit, plan, actorRef, u.id, p, at);
      if (moved) row.projects.push(moved);
    }
    row.groupsRemoved = await dropGroups(store, u.id, a.drop);
    row.memberships = await endMemberships(store, memberships, u.email, () => true, at);
    result.accounts.push(row);
  }
  for (const inv of plan.pending) {
    await store.revokeInvitation(inv.id, at, { pendingOnly: true });
    await audit(actorRef, 'invite.revoke', `invitation:${inv.id}`, { was: 'pending', via: 'programme-exit' });
    result.invitations.push({ id: inv.id, email: inv.email });
  }
  for (const t of plan.tokens) {
    if (!(await store.revokeApiToken(t.id, at))) continue;
    result.tokens.push({ id: t.id, label: t.label });
    await audit(actorRef, 'token.revoke', `token:${t.id}`, { via: 'programme-exit', group: plan.selectGroup ?? (t.groups ?? []).find((g) => g !== PARTNER_GROUP) });
  }
  const programmeId = plan.programme?.id;
  for (const t of plan.templates) {
    const rec = await store.getInstanceAsset(t.rec.id);
    if (!rec || rec.publication?.retiredAt || !programmeId) continue;
    const groupsBefore = Array.isArray(rec.groups) ? rec.groups : [];
    const groupsAfter = groupsBefore.filter((g) => !plan.inside.has(g));
    if (groupsAfter.length === groupsBefore.length) continue;
    if (groupsAfter.length) {
      await store.putInstanceAsset({ ...rec, groups: groupsAfter });
      await audit(actorRef, 'programme.template.update', `programme:${programmeId}`, {
        template: rec.id, before: { groups: groupsBefore }, after: { groups: groupsAfter }, via: 'programme-exit',
      });
    } else {
      await retireTemplate(store, audit, actorRef, programmeId, rec, { at, via: 'programme-exit' });
    }
    result.templates.push({ id: rec.id, name: String(rec.entry.name ?? rec.id), action: groupsAfter.length ? 'narrow' : 'retire', groupsBefore, groupsAfter });
  }
  if (plan.inside.size && programmeId) {
    const pick = plan.company ? { companyId: plan.company.id } : { programmeId };
    result.folders = await endFolderRules(store, audit, actorRef, pick, 'programme-exit');
    if (opts.rights) result.rightsChoices = await opts.rights.withdraw(actorRef, pick, 'programme-exit');
  }

  const id = opts.id ?? exitId();
  const endedBy = opts.endedBy ?? opts.createdBy ?? opts.actorId;
  // Mark what ended. A record already ended keeps its first end.
  if (plan.selection.programme !== undefined && plan.programme) {
    const current = await store.getProgramme(plan.programme.id);
    if (current && !isEnded(current)) {
      await store.putProgramme({ ...current, endedAt: at, endedBy, endedExit: id, updatedAt: at, version: current.version + 1 });
      result.ended.programme = current.id;
    }
  }
  if (plan.inside.size) {
    for (const c of await store.listCompanies()) {
      if (isEnded(c) || !plan.inside.has(companyGroup(c.id))) continue;
      await store.putCompany({ ...c, endedAt: at, endedBy, endedExit: id, updatedAt: at });
      result.ended.companies.push(c.id);
    }
  }

  const record: ProgrammeExitRecord = {
    ...opts.prior, id, state: 'done', selection: plan.selection,
    ...(plan.programme ? { programmeId: plan.programme.id } : {}), ...(plan.company ? { companyId: plan.company.id } : {}),
    projects: plan.projectsMode, transferTo: plan.transferTo.id, ...(plan.team ? { team: plan.team } : {}),
    createdBy: opts.createdBy ?? opts.actorId, createdAt: opts.createdAt ?? at, doneAt: at, doneBy: opts.via === 'scheduled' ? 'system' : opts.actorId,
    ...(opts.via ? { via: opts.via } : {}), result,
  };
  await store.putProgrammeExit(record);
  const count = (o: ExitAccountResult['outcome']) => result.accounts.filter((x) => x.outcome === o).length;
  await audit(actorRef, 'programme.exit', plan.selectGroup ? `group:${plan.selectGroup}` : plan.selectDomain ? `domain:${plan.selectDomain}` : 'programme:list', {
    exit: id, accounts: count('ended'), ...(count('stays') ? { stays: count('stays') } : {}), ...(count('not-ended') ? { notEnded: count('not-ended') } : {}),
    invitationsRevoked: result.invitations.length, skipped: result.skipped.length, projects: plan.projectsMode, transferTo: plan.transferTo.id,
    ...(plan.team ? { team: plan.team } : {}), ...(result.domainRules.length ? { domainRules: result.domainRules.length } : {}),
    ...(result.tokens.length ? { tokensRevoked: result.tokens.length } : {}),
    ...(result.templates.length ? { templates: result.templates.length } : {}), ...(result.folders.length ? { folders: result.folders.length } : {}),
    ...(result.rightsChoices.length ? { rightsChoices: result.rightsChoices.length } : {}),
    ...(result.ended.programme ? { endedProgramme: result.ended.programme } : {}), ...(result.ended.companies.length ? { endedCompanies: result.ended.companies } : {}),
    ...(opts.via ? { via: opts.via } : {}),
  });
  return record;
}

/** The apply step's answer, the same shape as the preview where they overlap.
 *  `accounts` lists only the accounts ended. */
export function exitDone(record: ProgrammeExitRecord, plan: ExitPlan): Record<string, unknown> {
  const r = record.result!;
  const accounts = r.accounts.filter((a) => a.outcome === 'ended');
  return {
    dryRun: false, exit: record.id,
    accounts: accounts.map((a) => ({ id: a.id, email: a.email, result: 'disabled', projects: a.projects.length })),
    stays: r.accounts.filter((a) => a.outcome === 'stays').map((a) => ({ id: a.id, email: a.email, stays: a.stays ?? [] })),
    notEnded: r.accounts.filter((a) => a.outcome === 'not-ended').map((a) => ({ id: a.id, email: a.email, reason: a.reason })),
    skipped: r.skipped, invitationsRevoked: r.invitations.length,
    domainRules: r.domainRules.length ? plan.rulesEnding : [], tokensRevoked: r.tokens.length,
    templates: r.templates.map((t) => ({ id: t.id, name: t.name, action: t.action })),
    foldersEnded: r.folders.length, rightsChoicesWithdrawn: r.rightsChoices.length,
    ended: r.ended,
  };
}
