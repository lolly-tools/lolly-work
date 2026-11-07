// SPDX-License-Identifier: MPL-2.0
/**
 * Partner programmes (plans/82 M1).
 *
 * A programme is an admin-named arrangement with outside people: a distributor
 * network, ISVs, resellers, or whatever the organisation calls its partner
 * types. Lolly Work never hard-codes a list of types; the name is the admin's.
 *
 * A programme wraps one local group, `programme-<id>`. Membership is that
 * group, so every existing lever (invitations with groups, SCIM, People,
 * grants on `group:<name>`) adds and removes programme members, and the group
 * prefix is reserved so no other group can be mistaken for one.
 *
 * What a programme adds is a SCOPE. A person in any programme sees nothing
 * internal except what one of their programmes includes (Andy, 2026-11-06,
 * decision 2), and the programme includes things through levers that already
 * exist, so each inclusion is reviewable where it always was:
 *
 * - **tools**: a `tool.use` allow grant for the programme group. Every other
 *   tool is absent, whatever its overlay's visibility says.
 * - **assets**: a collection whose groups name the programme group grants its
 *   members (decision 3); an instance asset or a provider whose groups name the
 *   programme group is included too. "Everyone" (`*`) never includes a
 *   programme (decision 10).
 * - **design-system essentials** (tokens, fonts, palettes) always reach a
 *   programme member, because every tool draws with them.
 *
 * Admins and owners are never scoped, so adding one to a programme to try it
 * cannot lock them out of the deployment they run.
 */

export interface ProgrammeRecord {
  /** A permanent slug, like a tool or asset id. */
  id: string;
  /** The admin's own name for this partner type ("Distributors", "VARs"). */
  name: string;
  description?: string;
  /** The internal group that owns the programme: when a partnership ends, its
   *  people's projects move to this team, read-only, by default (Andy,
   *  2026-11-06). */
  team?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Bumped on every save, so the audit and a client can see it move. */
  version: number;
  /** Tools its people use only through the templates published to them
   *  (plans/82 M2 W5). Off unless listed; see programmes/templates-only.ts. */
  templatesOnly?: string[];
  /** Set when the partnership ended (plans/82 M5): a state, not a deletion.
   *  The record, its companies and their profiles stay for the history and
   *  the files that name them; Delete is the separate step. */
  endedAt?: string;
  /** Who ended it, a user id. */
  endedBy?: string;
  /** The exit receipt that ended it (programmes/exit.ts). */
  endedExit?: string;
}

/** Whether a programme or company record is ended (plans/82 M5). */
export function isEnded(rec: { endedAt?: string } | null | undefined): boolean {
  return !!rec?.endedAt;
}

/** Programme ids are slugs short enough that the group name fits the local-group rule. */
export const PROGRAMME_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Every programme group starts with this, and no other group may. */
export const PROGRAMME_GROUP_PREFIX = 'programme-';

/** The group a programme wraps. */
export function programmeGroup(id: string): string {
  return `${PROGRAMME_GROUP_PREFIX}${id}`;
}

export function isProgrammeGroup(group: string): boolean {
  return group.startsWith(PROGRAMME_GROUP_PREFIX) && group.length > PROGRAMME_GROUP_PREFIX.length;
}

/** The programme groups among a person's groups. */
export function programmeGroupsOf(groups: readonly string[]): string[] {
  return groups.filter(isProgrammeGroup);
}

/** Every company group starts with this (plans/82 M1 part 2). */
export const COMPANY_GROUP_PREFIX = 'company-';

/** A partner company's group, `company-<id>`. */
export function isCompanyGroup(group: string): boolean {
  return group.startsWith(COMPANY_GROUP_PREFIX) && group.length > COMPANY_GROUP_PREFIX.length;
}

/**
 * A group that partner scope reads: a programme's or a company's. What is
 * shared with either reaches the partners in it, and nothing shared with
 * everyone does. Both are reserved names only the programme routes create.
 */
export function isPartnerGroup(group: string): boolean {
  return isProgrammeGroup(group) || isCompanyGroup(group);
}

/** The programme and company groups among a person's groups. */
export function partnerGroupsOf(groups: readonly string[]): string[] {
  return groups.filter(isPartnerGroup);
}

/**
 * Which programme each company belongs to, by group: `company-<id>` to
 * `programme-<id>`. Input rules need it to let a company's rule override its
 * own programme's rule (plans/82, coordinator 2026-11-06), and a rule names
 * only the company. A company never changes programme (the routes refuse a
 * move), so the map only ever gains or loses whole entries. The app loads it
 * at boot, sets it on each company change, and reloads it every minute and
 * before org-config and Preview answer. A company missing here (brand new,
 * on another replica) is compared stricter-wins with the programmes, which is
 * never more permissive than the right answer.
 */
const companyProgrammes = new Map<string, string>();

/** Replace the whole map from the store's company records. */
export function setCompanyProgrammes(companies: ReadonlyArray<{ id: string; programmeId: string }>): void {
  companyProgrammes.clear();
  for (const c of companies) companyProgrammes.set(`${COMPANY_GROUP_PREFIX}${c.id}`, programmeGroup(c.programmeId));
}

/** Record one company, or forget it with `programmeId` null. */
export function noteCompanyProgramme(companyId: string, programmeId: string | null): void {
  if (programmeId) companyProgrammes.set(`${COMPANY_GROUP_PREFIX}${companyId}`, programmeGroup(programmeId));
  else companyProgrammes.delete(`${COMPANY_GROUP_PREFIX}${companyId}`);
}

/** The programme group a company group belongs to, when known. */
export function programmeOfCompany(group: string): string | undefined {
  return companyProgrammes.get(group);
}

/**
 * The marker a person keeps after leaving their last programme. Joining any
 * programme group adds it (the store's setLocalGroups), and leaving one never
 * removes it, so a former partner sees only the essentials rather than
 * everything internal. An admin who means to make the account an internal one
 * removes the group in People, deliberately.
 */
export const PARTNER_GROUP = 'partner';

/** A local group list with the partner marker added when it holds a programme group. */
export function withPartnerMarker(localGroups: string[]): string[] {
  return localGroups.some(isProgrammeGroup) && !localGroups.includes(PARTNER_GROUP) ? [...localGroups, PARTNER_GROUP] : localGroups;
}

/** Group names only the programme routes may create: programme groups, company
 *  groups (`company-<id>`, plans/82 M1 part 2) and the partner marker. */
export function reservedGroupName(name: string): boolean {
  return name === PARTNER_GROUP || name.startsWith(PROGRAMME_GROUP_PREFIX) || name.startsWith(COMPANY_GROUP_PREFIX);
}

/**
 * Whether a person is scoped to their programmes: they are, or were, in a
 * programme (a programme group or the partner marker) and their role is below
 * admin.
 */
export function isProgrammeScoped(groups: readonly string[], role: string | undefined): boolean {
  if (role === 'admin' || role === 'owner') return false;
  return groups.includes(PARTNER_GROUP) || groups.some(isProgrammeGroup);
}

/** Asset types every programme member receives: the design system the tools
 *  draw with. Nothing here is a logo or a picture. */
export const ESSENTIAL_ASSET_TYPES: ReadonlySet<string> = new Set(['tokens', 'font', 'palette']);

/** A group list grants a programme member only when it names one of their
 *  programme groups. `*` and other groups never do. */
export function namesProgrammeGroup(groups: readonly string[] | '*' | undefined, programmeGroups: ReadonlySet<string>): boolean {
  if (!groups || groups === '*') return false;
  return groups.some((g) => programmeGroups.has(g));
}

/** Sort for listing: by name, then id. */
export function sortProgrammes(list: ProgrammeRecord[]): ProgrammeRecord[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Validate an admin's programme body. */
export function readProgrammeBody(raw: unknown): { name: string; description?: string; team?: string | null } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'body must be a JSON object' };
  const b = raw as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) return { error: 'name is required, at most 80 characters' };
  const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 500) : undefined;
  // `team` absent keeps the stored team, null or "" clears it.
  let team: string | null | undefined;
  if (b.team === null || b.team === '') team = null;
  else if (typeof b.team === 'string') {
    if (reservedGroupName(b.team.trim())) return { error: 'the owning team is one of your own groups, not a programme or company group' };
    team = b.team.trim();
  } else if (b.team !== undefined) return { error: 'team must be a group name' };
  return { name, ...(description ? { description } : {}), ...(team !== undefined ? { team } : {}) };
}
