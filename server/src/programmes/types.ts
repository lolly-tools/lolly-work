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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Bumped on every save, so the audit and a client can see it move. */
  version: number;
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
  return name === PARTNER_GROUP || name.startsWith(PROGRAMME_GROUP_PREFIX) || name.startsWith('company-');
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
export function readProgrammeBody(raw: unknown): { name: string; description?: string } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'body must be a JSON object' };
  const b = raw as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80) return { error: 'name is required, at most 80 characters' };
  const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 500) : undefined;
  return { name, ...(description ? { description } : {}) };
}
