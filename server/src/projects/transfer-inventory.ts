// SPDX-License-Identifier: MPL-2.0
/** A project-sized observation for planning a move, never a portable backup. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createRouter, sendError, sendJson } from '../api/router.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import { evaluate, type Role } from '../rbac/evaluate.ts';
import { SESSION_REVISION_LIMIT, type ProjectRecord, type SessionSummary, type Store, type UserRecord } from '../store/types.ts';

export const TRANSFER_INVENTORY_LIMITS = Object.freeze({ sessions: 200, files: 2000, folders: 1000, members: 2000 });
const VERSION_SAMPLE_LIMIT = 100;
type InventoryStore = Pick<Store, 'observeProjectTransferMetadata' | 'listSessionVersions' | 'collabLeaseActive'>;

export class InventoryLimitError extends Error {}

/** Only metadata reads: no document inputs, revision bodies, blobs or providers. */
export async function buildProjectTransferInventory(
  store: InventoryStore, project: ProjectRecord, visible: (session: Pick<SessionSummary, 'id' | 'projectId' | 'toolId' | 'toolVersion' | 'rev' | 'updatedAt'>) => boolean,
) {
  const startedAt = new Date().toISOString();
  const { folders, sessions: allSessions, files, members, folderLinksTruncated } = await store.observeProjectTransferMetadata(project.id, TRANSFER_INVENTORY_LIMITS);
  const sizes = { sessions: allSessions.length, files: files.length, folders: folders.length, members: members.length };
  for (const key of Object.keys(sizes) as Array<keyof typeof sizes>) {
    if (sizes[key] > TRANSFER_INVENTORY_LIMITS[key]) throw new InventoryLimitError(`This preview supports at most ${TRANSFER_INVENTORY_LIMITS[key]} ${key} per project.`);
  }
  if (folderLinksTruncated) throw new InventoryLimitError('This project has more folder links than this preview supports.');
  // Refuse a store returning another project's records before projecting them.
  if ([...folders, ...allSessions, ...files, ...members].some(row => row.projectId !== project.id)) throw new Error('Project inventory scope mismatch');
  const allowed = allSessions.filter(visible).sort((a, b) => a.id.localeCompare(b.id));
  const sessionIds = new Set(allowed.map(row => row.id));
  const allSessionIds = new Set(allSessions.map(row => row.id));
  const fileIds = new Set(files.map(row => row.id));
  const folderById = new Map(folders.map(row => [row.id, row]));
  const warnings = ['NON_SNAPSHOT', 'ASSET_DEPENDENCIES_NOT_INSPECTED', 'HISTORY_INCOMPLETE', 'IDENTITIES_REQUIRE_MAPPING', 'FILE_BYTES_NOT_VERIFIED'];
  if (allowed.length < allSessions.length) warnings.push('SESSION_ACCESS_OMITTED');
  let invalidFolderReferences = 0;
  for (const folder of folders) {
    if (folder.parentId && !folderById.has(folder.parentId)) invalidFolderReferences++;
    const seen = new Set<string>(); let current: typeof folder | undefined = folder;
    while (current) {
      if (seen.has(current.id)) { warnings.push('FOLDER_CYCLE'); break; }
      seen.add(current.id); current = current.parentId ? folderById.get(current.parentId) : undefined;
    }
    invalidFolderReferences += folder.items.filter(item => item.kind === 'session' ? !allSessionIds.has(item.ref) : !fileIds.has(item.ref)).length;
  }
  if (invalidFolderReferences) warnings.push('FOLDER_REFERENCES_UNRESOLVED');
  const sessions: Array<{ id: string; toolId: string; toolVersion: string; revision: number; updatedAt: string; activeCollaborationLease: boolean; versionSample: { count: number; limit: number; moreMayExist: boolean } }> = [];
  // Four sessions at a time bounds detail-query concurrency. Version summaries
  // omit document bytes; the input-bearing legacy revision lane is not read.
  for (let offset = 0; offset < allowed.length; offset += 4) {
    sessions.push(...await Promise.all(allowed.slice(offset, offset + 4).map(async row => {
      const [versions, active] = await Promise.all([
        store.listSessionVersions(row.id, { limit: VERSION_SAMPLE_LIMIT }), store.collabLeaseActive(row.id),
      ]);
      return { id: row.id, toolId: row.toolId, toolVersion: row.toolVersion, revision: row.rev, updatedAt: row.updatedAt,
        activeCollaborationLease: active, versionSample: { count: versions.length, limit: VERSION_SAMPLE_LIMIT, moreMayExist: versions.length === VERSION_SAMPLE_LIMIT } };
    })));
  }
  if (sessions.some(row => row.activeCollaborationLease)) warnings.push('LIVE_COLLABORATION');
  const sharing = project.sharing;
  const inventory = {
    schema: 'lolly-project-transfer-inventory-v1', mode: 'preview', readOnly: true,
    snapshotConsistent: false, complete: false, importReady: false,
    observedAt: new Date().toISOString(), observationStartedAt: startedAt,
    project: { id: project.id, name: project.name, archived: !!project.archivedAt },
    counts: { folders: folders.length, sessions: sessions.length, files: files.length,
      declaredFileBytes: files.reduce((sum, row) => sum + row.size, 0), explicitMembers: members.length,
      omittedSessions: allSessions.length - sessions.length },
    coverage: { fileBytesVerified: false, assetDependenciesComplete: false, historyComplete: false, identitiesMapped: false,
      pendingUploadsInspected: false, deletedSessionsInspected: false, liveGesturesInspected: false,
      legacyRevisionHistory: { inspected: false, retentionLimit: SESSION_REVISION_LIMIT },
      sessionVersionHistory: { sampled: true, sampleLimitPerSession: VERSION_SAMPLE_LIMIT, fullHistoryVerified: false } },
    limits: TRANSFER_INVENTORY_LIMITS,
    folders: folders.slice().sort((a, b) => a.id.localeCompare(b.id)).map(row => ({
      id: row.id, parentId: row.parentId && folderById.has(row.parentId) ? row.parentId : null,
      sessionIds: row.items.filter(item => item.kind === 'session' && sessionIds.has(item.ref)).map(item => item.ref),
      fileIds: row.items.filter(item => item.kind === 'file' && fileIds.has(item.ref)).map(item => item.ref),
    })),
    sessions,
    files: files.slice().sort((a, b) => a.id.localeCompare(b.id)).map(row => ({
      id: row.id, declaredBytes: row.size, declaredSha256: /^[a-f0-9]{64}$/.test(row.checksum) ? row.checksum : null,
      contentType: row.contentType, partCount: row.partCount, bytesVerified: false,
    })),
    access: { ownerId: project.ownerId, visibility: project.visibility === 'private' ? 'private' : { groups: [...project.visibility.groups] },
      general: sharing?.general ? { audience: sharing.general.audience, role: sharing.general.role } : null,
      groups: (sharing?.groups ?? []).map(group => group.kind === 'directory'
        ? { kind: group.kind, name: group.name, role: group.role, expiresAt: group.expiresAt ?? null }
        : { kind: group.kind, id: group.id, role: group.role, expiresAt: group.expiresAt ?? null }),
      settings: { viewersCanComment: sharing?.settings?.viewersCanComment ?? true,
        viewersCanExport: sharing?.settings?.viewersCanExport ?? true, editorsCanShare: sharing?.settings?.editorsCanShare ?? false },
      members: members.slice().sort((a, b) => a.userId.localeCompare(b.userId)).map(row => ({ userId: row.userId, role: row.role, expiresAt: row.expiresAt ?? null })),
      destinationMappingRequired: true },
    warnings: [...new Set(warnings)], invalidFolderReferences,
  };
  // This identifies the observation's projected metadata, not its authority,
  // the source's bytes or a consistent export checkpoint.
  return { ...inventory, observationSha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex') };
}

interface Dependencies {
  store: Store;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  delegated(req: IncomingMessage): boolean;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string, resources?: string[]): Promise<UserRecord | null>;
  projectAccessOf(user: UserRecord, project: ProjectRecord): Promise<ProjectAccess>;
}

export function registerProjectTransferInventoryRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  router.add('GET', '/api/v1/projects/:id/transfer-inventory', async (req, res, ctx) => {
    // Do not inherit a person's administrative powers through a scoped agent or
    // silently fall back to a cookie when an automation bearer is supplied.
    if (req.headers.authorization || d.delegated(req)) return sendError(res, 403, 'MEMBER_SESSION_REQUIRED', 'Sign in as a person to inspect a project transfer.');
    const id = ctx.params.id!;
    async function gate() {
      const user = await d.memberOf(req);
      if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
      const actionUser = await d.requireAction(req, res, 'project.manage', [`project:${id}`, '*']);
      if (!actionUser || actionUser.id !== user.id) return null;
      const project = await d.store.getProject(id);
      if (!project || !accessAtLeast(await d.projectAccessOf(user, project), 'viewer')) { sendError(res, 404, 'NOT_FOUND', 'no such project'); return null; }
      if (!accessAtLeast(await d.projectAccessOf(user, project), 'manager')) { sendError(res, 403, 'FORBIDDEN', 'you need to manage this project'); return null; }
      return { user, project };
    }
    const admitted = await gate(); if (!admitted) return;
    const grants = await d.store.listGrants();
    const visible = (user: UserRecord, sessionId: string, rules = grants) => evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'session.view', [`session:${sessionId}`, `project:${id}`, '*'], rules);
    let inventory;
    try { inventory = await buildProjectTransferInventory(d.store, admitted.project, row => visible(admitted.user, row.id)); }
    catch (error) {
      if (error instanceof InventoryLimitError) return sendError(res, 413, 'INVENTORY_LIMIT', error.message);
      throw error;
    }
    // Authorization can be revoked while metadata queries are in flight. A
    // second gate is deliberately not a claim that these reads form a snapshot.
    const current = await d.store.observeProjectTransferMetadata(id, TRANSFER_INVENTORY_LIMITS);
    const fresh = await gate(); if (!fresh || fresh.user.id !== admitted.user.id) return;
    const freshGrants = await d.store.listGrants();
    if (inventory.sessions.some(row => !visible(fresh.user, row.id, freshGrants))) return sendError(res, 403, 'ACCESS_CHANGED', 'Project access changed. Run the preview again.');
    const currentSessions = new Map(current.sessions.map(row => [row.id, row]));
    if (inventory.sessions.some(row => currentSessions.get(row.id)?.projectId !== id)) return sendError(res, 403, 'ACCESS_CHANGED', 'Project access changed. Run the preview again.');
    if (inventory.sessions.some(row => currentSessions.get(row.id)?.rev !== row.revision)) return sendError(res, 409, 'INVENTORY_CHANGED', 'Project sessions changed. Run the preview again.');
    sendJson(res, 200, inventory, { 'cache-control': 'private, no-store' });
  });
}
