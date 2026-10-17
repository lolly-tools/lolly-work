// SPDX-License-Identifier: MPL-2.0
/**
 * History across documents (plan 221): `GET /api/v1/history` lists the saved
 * versions of every document the caller may read, newest first, one page at a
 * time, in one request instead of one per project or document.
 *
 * Only a signed-in person reads it. A service token is refused (401), and so is
 * a call an agent makes for a person (403): an agent's access is one project or
 * one document, never the person's whole history.
 *
 * The server works out what a page may hold before it reads the store
 * (`historyScope`), by the rules that read one document's versions
 * (versions/routes.ts): project access (`effectiveProjectAccess`, so membership
 * end dates, groups and sharing apply), then `session.view` over the document,
 * its project and `*`. Documents in projects the person cannot see, deleted
 * documents and documents whose `session.view` a grant denies are never read.
 *
 * Which projects: the person's own by default, by the rule their Projects list
 * uses (lolly plan 299 section 6): projects they own or were added to, directly
 * or through a group, projects they pinned, and projects they opened in the last
 * RECENT_PROJECT_DAYS days, never a project they hid. Archived projects are left
 * out unless `archived=1`. `project=<id>` reads that one project instead, when
 * the person can see it.
 *
 * Paging is by keyset. `before` is an opaque position, the time and id of the
 * last entry of the page before, so it only ever names an entry the caller was
 * shown. Entries carry no content and no email address.
 */
import type { IncomingMessage } from 'node:http';
import { createRouter, sendError, sendJson } from '../api/router.ts';
import { evaluate, grantDecision, type Grant, type PrincipalCtx, type Role } from '../rbac/evaluate.ts';
import { effectiveProjectAccess, projectRelation, type ProjectAccess } from '../rbac/project-access.ts';
import {
  SESSION_VERSION_KINDS, VERSION_HISTORY_DEFAULT, VERSION_LIST_MAX,
  type ProjectMemberRecord, type ProjectRecord, type ProjectUserStateRecord, type SessionVersionKind, type Store, type UserRecord, type VersionHistoryQuery,
} from '../store/types.ts';
import { versionNamer } from './routes.ts';

interface Dependencies {
  store: Store;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  /** Whether an agent makes this request for a person (project-requests.ts). */
  delegated(req: IncomingMessage): boolean;
}

/** How recently a project opened only by browsing must have been opened to
 *  count as the person's own (the shell's `lib/team-project-listing.ts`). */
export const RECENT_PROJECT_DAYS = 30;
const DAY_MS = 86_400_000;
const VERSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** A project or tool id to filter on: matched exactly, so only its length and
 *  control characters are checked. */
const FILTER_ID = /^[^\u0000-\u001f]{1,200}$/;

/** What a history page may read: projects, less documents a grant takes out. */
export interface HistoryScope { projectIds: string[]; exceptSessionIds: string[] }

/**
 * The documents a person's history may show, among `projects` (each with the
 * person's access to it). Reading a document's versions needs `session.view`
 * over `['*', 'session:<id>', 'project:<id>']`. Grants match by selector, so the
 * decision splits in two: the project's own decision over `['*', 'project:<id>']`
 * includes or leaves out the whole project, and a deny on `session:<id>` then
 * takes that one document out. A grant that allows one document is not followed
 * into a project whose own decision is no. Where that decision is a deny, the
 * deny wins for the document too; otherwise the role lacks `session.view`, which
 * no member role does. Either way, leaving the document out never shows
 * something the person may not read.
 */
export function historyScope(principal: PrincipalCtx, projects: ReadonlyArray<{ id: string; access: ProjectAccess }>, grants: Grant[]): HistoryScope {
  const projectIds = projects
    .filter((p) => p.access !== 'none' && evaluate(principal, 'session.view', ['*', `project:${p.id}`], grants))
    .map((p) => p.id);
  // grantDecision over the one grant says whether it applies to this person.
  const exceptSessionIds = [...new Set(grants
    .filter((g) => g.action === 'session.view' && g.effect === 'deny' && g.resource.startsWith('session:')
      && grantDecision(principal, g.action, [g.resource], [g]) === 'deny')
    .map((g) => g.resource.slice('session:'.length)))];
  return { projectIds, exceptSessionIds };
}

/** Whether a project the person can open belongs in their own list (the shell's
 *  `isOwnProject`): never when hidden; when pinned or in a relationship; else
 *  when opened in the last RECENT_PROJECT_DAYS days. */
export function ownProject(user: UserRecord, project: ProjectRecord, membership: ProjectMemberRecord | null, state: ProjectUserStateRecord | undefined, now = Date.now()): boolean {
  if (state?.listed === 'hidden') return false;
  if (state?.listed === 'pinned') return true;
  const via = projectRelation(user, project, membership, now);
  if (via === 'owner' || via === 'member' || via === 'group' || via === 'custom-group') return true;
  const opened = state?.lastOpenedAt ? Date.parse(state.lastOpenedAt) : NaN;
  return Number.isFinite(opened) && now - opened <= RECENT_PROJECT_DAYS * DAY_MS;
}

/** The opaque `before` of a page that ends at this entry. */
export function historyCursor(entry: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify([entry.at, entry.id])).toString('base64url');
}

/** The position in a `before`, or null when it is not one this route made. */
export function historyPosition(value: string): { at: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [at, id] = parsed;
    if (typeof at !== 'string' || typeof id !== 'string' || !VERSION_ID.test(id)) return null;
    const time = new Date(at);
    return Number.isFinite(time.getTime()) && time.toISOString() === at ? { at, id } : null;
  } catch { return null; }
}

type Filters = Omit<VersionHistoryQuery, 'projectIds' | 'exceptSessionIds'> & { project?: string; archived: boolean };

/** The query string as filters, or an error message for the 400. */
function filtersOf(params: URLSearchParams): Filters | string {
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? VERSION_HISTORY_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > VERSION_LIST_MAX) return `limit must be a whole number from 1 to ${VERSION_LIST_MAX}`;
  const out: Filters = { limit, archived: params.get('archived') === '1' };
  const before = params.get('before');
  if (before !== null) {
    const after = historyPosition(before);
    if (!after) return 'before must be a position from this history. Refresh to start again.';
    out.after = after;
  }
  const project = params.get('project');
  if (project !== null) {
    if (!FILTER_ID.test(project)) return 'project must be a project id';
    out.project = project;
  }
  const tool = params.get('tool');
  if (tool !== null) {
    if (!FILTER_ID.test(tool)) return 'tool must be a tool id';
    out.toolId = tool;
  }
  const kind = params.get('kind');
  if (kind !== null) {
    const kinds = [...new Set(kind.split(','))];
    if (!kinds.every((k): k is SessionVersionKind => (SESSION_VERSION_KINDS as readonly string[]).includes(k))) {
      return `kind must be one or more of ${SESSION_VERSION_KINDS.join(', ')}, separated by commas`;
    }
    out.kinds = kinds;
  }
  if (params.get('kept') === '1') out.kept = true;
  for (const name of ['from', 'to'] as const) {
    const value = params.get(name);
    if (value === null) continue;
    const time = new Date(value);
    if (!value || !Number.isFinite(time.getTime())) return `${name} must be a date and time`;
    out[name] = time.toISOString();
  }
  return out;
}

export function registerHistoryRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  router.add('GET', '/api/v1/history', async (req, res, ctx) => {
    const user = await d.memberOf(req);
    if (!user || user.id.startsWith('svc_')) return sendError(res, 401, 'UNAUTHORIZED', 'History needs a signed-in person.');
    if (d.delegated(req)) return sendError(res, 403, 'FORBIDDEN', 'An agent cannot read history across projects.');
    const filters = filtersOf(ctx.url.searchParams);
    if (typeof filters === 'string') return sendError(res, 400, 'INVALID_INPUT', filters);
    const { project: projectId, archived, ...query } = filters;
    const [projects, memberships, grants, states] = await Promise.all([
      projectId ? d.store.getProject(projectId).then((p) => (p ? [p] : [])) : d.store.listProjects(),
      d.store.listUserProjectMemberships(user.id), d.store.listGrants(), d.store.listProjectUserState(user.id),
    ]);
    const mine = new Map(memberships.map((m) => [m.projectId, m]));
    const own = new Map(states.map((s) => [s.projectId, s]));
    const withAccess = projects.map((p) => ({ project: p, id: p.id, access: effectiveProjectAccess(user, p, mine.get(p.id) ?? null, grants) }));
    let candidates = withAccess;
    if (projectId) {
      // One named project, as its own session list answers it.
      if (!withAccess.length) return sendError(res, 404, 'NOT_FOUND', 'no such project');
      if (withAccess[0]!.access === 'none') return sendError(res, 403, 'FORBIDDEN', 'you cannot see this project');
    } else {
      const now = Date.now();
      candidates = withAccess.filter(({ project, access }) => access !== 'none' && (archived || !project.archivedAt)
        && ownProject(user, project, mine.get(project.id) ?? null, own.get(project.id), now));
    }
    const principal = { userId: user.id, groups: user.groups, role: user.role as Role };
    const scope = historyScope(principal, candidates, grants);
    if (!scope.projectIds.length) return sendJson(res, 200, { entries: [] });
    const entries = await d.store.listVersionHistory({ ...query, ...scope });
    const named = await versionNamer(d.store, entries);
    const byId = new Map(candidates.map(({ project }) => [project.id, project]));
    sendJson(res, 200, {
      entries: entries.map((entry) => {
        const project = byId.get(entry.projectId);
        return { ...named(entry), projectName: project?.name ?? null, ...(project?.archivedAt ? { projectArchived: true } : {}) };
      }),
      ...(entries.length === query.limit ? { before: historyCursor(entries.at(-1)!) } : {}),
    });
  }, { delivery: 'person-private' });
}
