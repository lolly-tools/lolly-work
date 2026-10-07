// SPDX-License-Identifier: MPL-2.0
/**
 * Saved versions of a session (plan 76 milestone 4, R2): list, read, save with a
 * name, restore, and delete.
 *
 * Every route is for a signed-in PERSON: `memberOf`, a service token refused,
 * then the session read gate (`sessionFor`: 404, 403, 410). Reading needs
 * `session.view`; saving and restoring need editor access, `session.edit` and a
 * project that is not archived; deleting needs a project manager. Saves and
 * restores share one per-person rate limit.
 *
 * A restore runs under a per-session lock in this process, through the live
 * room when the host runs one (`rooms`, the gateway's `versions` bridge) and by
 * compare-and-swap otherwise (versions/restore.ts). It writes two rows that share
 * the request id: the 'before' version (the document it replaced, which Undo
 * restores) and the 'restore' version (the document it produced). A repeated
 * request id answers with the first request's result.
 *
 * Names never carry an email address: people are named with
 * `nameWithoutEmail`, agents by their label, and guests as "Guest".
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { createWindowQuota, nameWithoutEmail } from '../projects/sharing.ts';
import { evaluate, mayJoinCollab, type Role } from '../rbac/evaluate.ts';
import { accessAtLeast, effectiveProjectAccess, type ProjectAccess } from '../rbac/project-access.ts';
import {
  VERSION_LABEL_MAX, VERSION_LIST_DEFAULT, VERSION_LIST_MAX,
  type ProjectRecord, type SessionRecord, type SessionVersion, type SessionVersionSummary, type Store, type UserRecord,
} from '../store/types.ts';
import { RestoreError, restoreByCas, type RestoreBefore, type RestoreFailure, type RestorePolicy, type VersionRestoreResult, type VersionRoomBridge } from './restore.ts';

interface Dependencies {
  config: InstanceConfig;
  store: Store;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
  sessionFor(res: ServerResponse, user: UserRecord, id: string | null): Promise<{ session: SessionRecord; project: ProjectRecord; access: ProjectAccess } | null>;
  /** The live-room restore (AppDeps.versionRooms). Undefined where no room runs. */
  rooms?: VersionRoomBridge;
  /** The declared inputs of a tool in the active pack, or null when unreadable. */
  toolInputs(toolId: string): Promise<Array<{ id: string; type?: unknown }> | null>;
}

/** Saves and restores together, per person. */
export const VERSION_CHANGES_PER_MINUTE = 10;
export const VERSION_CHANGES_PER_HOUR = 60;
/** How long a restore's answer is kept for a retry with the same request id. */
const RESTORE_REPLAY_MS = 3_600_000;
const RESTORE_REPLAY_MAX = 1_000;
/** Pages read when looking for the restore row of a repeated request. */
const REPEAT_SCAN_PAGES = 10;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const key = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
const PRIVATE = { 'cache-control': 'private, no-store' };

const FAILURES: Record<RestoreFailure, [number, string]> = {
  FORBIDDEN: [403, 'FORBIDDEN'],
  READ_ONLY: [403, 'READ_ONLY'],
  RESTORE_INCOMPLETE: [409, 'RESTORE_INCOMPLETE'],
  SESSION_CHANGED: [409, 'SESSION_CHANGED'],
  VERSION_SPACE: [409, 'VERSION_SPACE'],
  SESSION_GONE: [410, 'SESSION_DELETED'],
  REPEATED: [409, 'SESSION_CHANGED'],
};
/** Errors the room raises when it closed or lost its lease under a restore. */
const ROOM_GONE = new Set(['collab-storage-unavailable', 'collab-owner-lost', 'collab-seat-missing', 'collab-owner-conflict', 'collab-room-owned']);

export function registerVersionRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  // The instance cap on version content (policy.versions.maxBytes), set once at boot.
  d.store.configureVersionLimits({ instanceMaxBytes: d.config.policy.versions?.maxBytes });
  const quotas = { minute: createWindowQuota(VERSION_CHANGES_PER_MINUTE, 60_000), hour: createWindowQuota(VERSION_CHANGES_PER_HOUR, 3_600_000) };
  const locks = new Map<string, Promise<unknown>>();
  const replays = new Map<string, { at: number; body: Record<string, unknown> }>();

  /** Spend one save-or-restore unit, or answer 429 and return false. */
  const allowed = (res: ServerResponse, userId: string): boolean => {
    for (const [quota, retryAfterSec] of [[quotas.minute, 60], [quotas.hour, 3600]] as const) {
      if (quota.take(userId)) continue;
      res.setHeader('retry-after', String(retryAfterSec));
      sendError(res, 429, 'RATE_LIMITED', 'Too many version changes. Try again in a minute.');
      return false;
    }
    return true;
  };

  /** The shared gate: a person, the session, and `session.view`. */
  const gate = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const user = await d.memberOf(req);
    if (!user || user.id.startsWith('svc_')) { sendError(res, 401, 'UNAUTHORIZED', 'Versions need a signed-in person.'); return null; }
    const found = await d.sessionFor(res, user, id);
    if (!found) return null;
    const grants = await d.store.listGrants();
    const principal = { userId: user.id, groups: user.groups, role: user.role as Role };
    const selectors = ['*', `session:${found.session.id}`, `project:${found.project.id}`];
    if (!evaluate(principal, 'session.view', selectors, grants)) { sendError(res, 403, 'FORBIDDEN', 'you cannot see this session'); return null; }
    return { ...found, user, grants, principal, mayEdit: evaluate(principal, 'session.edit', selectors, grants) };
  };
  type Gate = NonNullable<Awaited<ReturnType<typeof gate>>>;

  /** Saving and restoring: editor access, `session.edit`, a live project. */
  const writable = (res: ServerResponse, g: Gate): boolean => {
    if (!accessAtLeast(g.access, 'editor') || !g.mayEdit) { sendError(res, 403, 'READ_ONLY', 'Only editors can change versions.'); return false; }
    if (g.project.archivedAt) { sendError(res, 409, 'PROJECT_ARCHIVED', 'restore the project before changing its versions'); return false; }
    return true;
  };

  /** Names for creators and contributors, built at read time and never an email. */
  const namer = async (versions: SessionVersionSummary[]) => {
    const userIds = new Set<string>();
    const agentIds = new Set<string>();
    for (const v of versions) {
      if (v.createdBy) userIds.add(v.createdBy);
      for (const c of v.contributors) {
        if (c.kind === 'user') userIds.add(c.id);
        else if (c.kind === 'agent') agentIds.add(c.id);
      }
    }
    const users = new Map((await d.store.getUsersByIds([...userIds])).map((u) => [u.id, nameWithoutEmail(u)]));
    const agents = new Map<string, string>();
    for (const id of agentIds) {
      const agent = await d.store.getDocumentAgent(id) ?? await d.store.getProjectAgent(id);
      agents.set(id, agent?.label?.trim() || 'Agent');
    }
    return <T extends SessionVersionSummary>(v: T) => ({
      ...v,
      ...(v.createdBy ? { createdByName: users.get(v.createdBy) ?? 'Member' } : {}),
      contributors: v.contributors.map((c) => ({ ...c,
        name: c.kind === 'guest' ? 'Guest' : c.kind === 'agent' ? agents.get(c.id) ?? 'Agent' : users.get(c.id) ?? 'Member' })),
    });
  };

  router.add('GET', '/api/v1/sessions/:id/versions', async (req, res, ctx) => {
    const g = await gate(req, res, ctx.params.id as string);
    if (!g) return;
    const rawLimit = ctx.url.searchParams.get('limit');
    const limit = rawLimit === null ? VERSION_LIST_DEFAULT : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > VERSION_LIST_MAX) return sendError(res, 400, 'INVALID_INPUT', `limit must be a whole number from 1 to ${VERSION_LIST_MAX}`);
    const before = ctx.url.searchParams.get('before');
    if (before !== null && !key(before)) return sendError(res, 400, 'INVALID_INPUT', 'before must be a version id');
    const versions = await d.store.listSessionVersions(g.session.id, { limit, ...(before ? { before } : {}) });
    const named = await namer(versions);
    sendJson(res, 200, { versions: versions.map(named), ...(versions.length === limit ? { before: versions.at(-1)!.id } : {}) }, PRIVATE);
  });

  router.add('GET', '/api/v1/sessions/:id/versions/:versionId', async (req, res, ctx) => {
    const g = await gate(req, res, ctx.params.id as string);
    if (!g) return;
    const id = ctx.params.versionId as string;
    const version = key(id) ? await d.store.getSessionVersion(g.session.id, id) : null;
    if (!version) return sendError(res, 404, 'NOT_FOUND', 'This version is no longer available.');
    sendJson(res, 200, { version: (await namer([version]))(version) }, PRIVATE);
  });

  router.add('POST', '/api/v1/sessions/:id/versions', async (req, res, ctx) => {
    const g = await gate(req, res, ctx.params.id as string);
    if (!g || !writable(res, g)) return;
    const body = await readJson(req);
    const label = object(body) && typeof body.label === 'string' ? body.label.trim() : '';
    if (!label || [...label].length > VERSION_LABEL_MAX || !object(body) || !key(body.requestId)) {
      return sendError(res, 400, 'INVALID_INPUT', `A name of 1 to ${VERSION_LABEL_MAX} characters and a requestId are required.`);
    }
    if (!allowed(res, g.user.id)) return;
    // The durable row: a live room commits every accepted batch to it.
    const session = await d.store.getSession(g.session.id);
    if (!session || session.deletedAt) return sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
    let put;
    try {
      put = await d.store.putSessionVersion({ sessionId: session.id, rev: session.rev, kind: 'named', label, inputs: session.inputs,
        meta: session.meta, contributors: [{ id: g.user.id, kind: 'user', edits: 1 }], createdBy: g.user.id, requestId: body.requestId });
    } catch (error) {
      if ((error as Error)?.message === 'session-gone') return sendError(res, 410, 'SESSION_DELETED', 'this session was deleted');
      throw error;
    }
    if (put === 'version-limit') return sendError(res, 409, 'VERSION_LIMIT', 'This document has too many named versions. Delete one first.');
    if (put === 'version-space') return sendError(res, 409, 'VERSION_SPACE', 'History is full. Ask a manager to delete old versions.');
    if (put.created) await d.audit(`user:${g.user.id}`, 'session.version.save', `session:${session.id}`, { versionId: put.version.id, labelLength: [...label].length });
    sendJson(res, put.created ? 201 : 200, { version: (await namer([put.version]))(put.version) });
  });

  router.add('POST', '/api/v1/sessions/:id/versions/:versionId/restore', async (req, res, ctx) => {
    const g = await gate(req, res, ctx.params.id as string);
    if (!g || !writable(res, g)) return;
    if (d.rooms && !mayJoinCollab(g.principal, g.grants)) return sendError(res, 403, 'FORBIDDEN', 'Restoring needs access to the live document.');
    const body = await readJson(req);
    if (!object(body) || !key(body.requestId)) return sendError(res, 400, 'INVALID_INPUT', 'A requestId is required.');
    const requestId = body.requestId;
    const versionId = ctx.params.versionId as string;
    if (!key(versionId)) return sendError(res, 404, 'NOT_FOUND', 'This version is no longer available.');
    if (!allowed(res, g.user.id)) return;
    const sessionId = g.session.id;
    // One restore at a time per document in this process; the unique index on
    // (session, person, kind, request id) is the backstop across processes.
    const previous = locks.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => restore(g, versionId, requestId));
    locks.set(sessionId, run);
    try {
      const out = await run;
      if ('error' in out) return sendError(res, out.status, out.error, out.message);
      sendJson(res, 200, out.body);
    } finally {
      if (locks.get(sessionId) === run) locks.delete(sessionId);
    }
  });

  type RestoreAnswer = { body: Record<string, unknown> } | { status: number; error: string; message: string };

  const restore = async (g: Gate, versionId: string, requestId: string): Promise<RestoreAnswer> => {
    const sessionId = g.session.id;
    const replayKey = `${sessionId}\n${g.user.id}\n${requestId}`;
    const now = Date.now();
    for (const [k, entry] of replays) if (now - entry.at > RESTORE_REPLAY_MS) replays.delete(k); else break;
    const replay = replays.get(replayKey);
    if (replay) return { body: replay.body };
    const target = await d.store.getSessionVersion(sessionId, versionId);
    if (!target) return { status: 404, error: 'NOT_FOUND', message: 'This version is no longer available.' };

    for (let attempt = 0; ; attempt++) {
      let createdBefore: string | undefined;
      const beforeCommit = async (before: RestoreBefore): Promise<string> => {
        const put = await d.store.putSessionVersion({ sessionId, rev: before.revision, kind: 'before', inputs: before.inputs, meta: before.meta,
          contributors: [], createdBy: g.user.id, requestId });
        if (put === 'version-space' || put === 'version-limit') throw new RestoreError('VERSION_SPACE', 'History is full. Ask a manager to delete old versions.');
        if (!put.created) throw new RestoreError('REPEATED', 'This restore was already asked for.', put.version.id);
        createdBefore = put.version.id;
        return put.version.id;
      };
      let result: VersionRestoreResult;
      try {
        result = d.rooms
          ? await d.rooms.restore({ sessionId, user: g.user, target, beforeCommit })
          : await restoreByCas({ store: d.store, policy: restorePolicy }, { sessionId, user: g.user, target, beforeCommit });
      } catch (error) {
        // Nothing was committed: a 'before' row this attempt wrote is not a
        // version anyone can use, so it goes (no restore row points at it yet).
        if (createdBefore) await d.store.deleteSessionVersion(sessionId, createdBefore).catch(() => false);
        if (error instanceof RestoreError && error.code === 'REPEATED' && error.beforeId) {
          const earlier = await restoreRowFor(sessionId, error.beforeId);
          if (earlier) {
            const body = answer(earlier.rev, false, earlier.id, error.beforeId, [], []);
            remember(replayKey, body);
            return { body };
          }
          // An earlier attempt with this id stopped before it finished: its
          // 'before' row is an orphan. Remove it and run the restore once more.
          await d.store.deleteSessionVersion(sessionId, error.beforeId);
          if (attempt === 0) continue;
        }
        return failure(error);
      }
      let restored: string | null = null;
      try {
        const put = await d.store.putSessionVersion({ sessionId, rev: result.revision, kind: 'restore', inputs: result.inputs, meta: result.meta,
          contributors: [{ id: g.user.id, kind: 'user', edits: 1 }], createdBy: g.user.id, restoredFrom: target.id, beforeId: result.beforeId, requestId });
        // The document is already restored; a full history only costs the row.
        restored = typeof put === 'string' ? null : put.version.id;
      } catch (error) {
        console.error(`[lolly-work] restore version row failed for ${sessionId}:`, (error as Error)?.message ?? error);
      }
      await d.audit(`user:${g.user.id}`, 'session.restore', `session:${sessionId}`, {
        versionId: target.id, beforeVersionId: result.beforeId, revision: result.revision, live: result.live,
        skipped: result.skipped.length, vetoed: result.vetoed.length,
      });
      const body = answer(result.revision, result.live, restored, result.beforeId, result.skipped, result.vetoed);
      remember(replayKey, body);
      return { body };
    }
  };

  const answer = (revision: number, live: boolean, restored: string | null, before: string, skipped: string[], vetoed: string[]) =>
    ({ revision, live, restored, before, skipped, vetoed });

  const remember = (replayKey: string, body: Record<string, unknown>): void => {
    replays.set(replayKey, { at: Date.now(), body });
    if (replays.size > RESTORE_REPLAY_MAX) replays.delete(replays.keys().next().value as string);
  };

  /** The restore row an earlier request wrote with this 'before' row, if any. */
  const restoreRowFor = async (sessionId: string, beforeId: string): Promise<SessionVersionSummary | null> => {
    let before: string | undefined;
    for (let page = 0; page < REPEAT_SCAN_PAGES; page++) {
      const rows = await d.store.listSessionVersions(sessionId, { limit: VERSION_LIST_MAX, ...(before ? { before } : {}) });
      const found = rows.find((row) => row.kind === 'restore' && row.beforeId === beforeId);
      if (found) return found;
      if (rows.length < VERSION_LIST_MAX) return null;
      before = rows.at(-1)!.id;
    }
    return null;
  };

  const failure = (error: unknown): RestoreAnswer => {
    if (error instanceof RestoreError) {
      const [status, code] = FAILURES[error.code];
      return { status, error: code, message: error.message };
    }
    const message = (error as Error)?.message ?? '';
    if (message === 'session-gone') return { status: 410, error: 'SESSION_DELETED', message: 'this session was deleted' };
    if (ROOM_GONE.has(message)) return { status: 409, error: 'SESSION_CHANGED', message: 'The document changed while restoring. Try again.' };
    throw error;
  };

  /** The compare-and-swap path's write rights, read fresh per attempt. */
  const restorePolicy = async (user: UserRecord, sessionId: string): Promise<RestorePolicy | null> => {
    const session = await d.store.getSession(sessionId);
    if (!session || session.deletedAt) return null;
    const [person, project, membership, grants, overlays, inputs] = await Promise.all([
      d.store.getUser(user.id), d.store.getProject(session.projectId), d.store.getProjectMember(session.projectId, user.id),
      d.store.listGrants(), d.store.listOverlays(), d.toolInputs(session.toolId),
    ]);
    if (!person || person.disabledAt || !project) return null;
    const access = effectiveProjectAccess(person, project, membership, grants);
    if (access === 'none') return null;
    const principal = { userId: person.id, groups: person.groups, role: person.role as Role };
    const selectors = ['*', `session:${session.id}`, `project:${project.id}`];
    return {
      groups: person.groups, overlay: overlays.get(session.toolId), isGuest: false,
      declared: inputs ? new Set(inputs.map((i) => i.id)) : null,
      types: new Map((inputs ?? []).filter((i): i is { id: string; type: string } => typeof i.type === 'string').map((i) => [i.id, i.type])),
      mayEdit: accessAtLeast(access, 'editor') && evaluate(principal, 'session.edit', selectors, grants) && !project.archivedAt,
    };
  };

  router.add('DELETE', '/api/v1/sessions/:id/versions/:versionId', async (req, res, ctx) => {
    const g = await gate(req, res, ctx.params.id as string);
    if (!g) return;
    if (!accessAtLeast(g.access, 'manager')) return sendError(res, 403, 'FORBIDDEN', 'Only project managers can delete versions.');
    const id = ctx.params.versionId as string;
    const version: SessionVersion | null = key(id) ? await d.store.getSessionVersion(g.session.id, id) : null;
    if (!version || !await d.store.deleteSessionVersion(g.session.id, version.id)) return sendError(res, 404, 'NOT_FOUND', 'This version is no longer available.');
    await d.audit(`user:${g.user.id}`, 'session.version.delete', `session:${g.session.id}`, { versionId: version.id, kind: version.kind });
    sendJson(res, 200, { deleted: true });
  });
}
