// SPDX-License-Identifier: MPL-2.0
/** Shared subfolders inherit their project's access; moving an item changes no content. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import { randomId } from '../lib/crypto.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import type { ProjectRecord, Store, UserRecord } from '../store/types.ts';

interface Dependencies {
  store: Store;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  projectAccessOf(user: UserRecord, project: ProjectRecord): Promise<ProjectAccess>;
  audit(actor: string, action: string, subject: string, payload: Record<string, unknown>): Promise<unknown>;
}

export function registerProjectFolderRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  async function gate(req: IncomingMessage, res: ServerResponse, id: string, write = false) {
    const user = write ? await d.requireAction(req, res, 'session.edit') : await d.memberOf(req);
    if (!user) { if (!write) sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    const project = await d.store.getProject(id);
    if (!project || !accessAtLeast(await d.projectAccessOf(user, project), 'viewer')) { sendError(res, 404, 'NOT_FOUND', 'no such project'); return null; }
    if (write && (!accessAtLeast(await d.projectAccessOf(user, project), 'editor') || project.archivedAt)) { sendError(res, 403, 'READ_ONLY', 'you cannot change this project'); return null; }
    return { user, project };
  }
  const nameOf = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 200 && !/[\u0000-\u001f]/.test(value) ? value.trim() : null;
  router.add('GET', '/api/v1/projects/:id/folders', async (req, res, ctx) => {
    if (!await gate(req, res, ctx.params.id!)) return;
    sendJson(res, 200, { folders: await d.store.listProjectFolders(ctx.params.id!) }, { 'cache-control': 'private, no-store' });
  });
  router.add('POST', '/api/v1/projects/:id/folders', async (req, res, ctx) => {
    const admitted = await gate(req, res, ctx.params.id!, true); if (!admitted) return;
    const body = await readJson(req) as { name?: unknown; parentId?: unknown } | null;
    const name = nameOf(body?.name), folders = await d.store.listProjectFolders(admitted.project.id);
    const parentId = body?.parentId ?? null;
    if (!name || parentId !== null && (typeof parentId !== 'string' || !folders.some(f => f.id === parentId))) return sendError(res, 400, 'INVALID_INPUT', 'a name and a parent in this project are required');
    if (folders.length >= 1000) return sendError(res, 409, 'FOLDER_LIMIT', 'this project has reached its folder limit');
    const folder = { id: `fld_${randomId(8)}`, projectId: admitted.project.id, parentId: parentId as string | null, name,
      createdAt: new Date().toISOString(), createdBy: admitted.user.id, items: [] };
    await d.store.putProjectFolder(folder);
    await d.audit(`user:${admitted.user.id}`, 'project.folder.create', `project:${admitted.project.id}`, { folderId: folder.id, parentId });
    sendJson(res, 201, { folder });
  });
  router.add('PATCH', '/api/v1/projects/:id/folders/:folderId', async (req, res, ctx) => {
    const admitted = await gate(req, res, ctx.params.id!, true); if (!admitted) return;
    const folder = (await d.store.listProjectFolders(admitted.project.id)).find(f => f.id === ctx.params.folderId);
    if (!folder) return sendError(res, 404, 'NOT_FOUND', 'no such folder');
    const body = await readJson(req) as { name?: unknown; parentId?: unknown } | null, name = nameOf(body?.name);
    if (!name || body?.parentId !== undefined) return sendError(res, 400, 'INVALID_INPUT', 'a folder name is required');
    await d.store.putProjectFolder({ ...folder, name });
    await d.audit(`user:${admitted.user.id}`, 'project.folder.rename', `project:${admitted.project.id}`, { folderId: folder.id });
    sendJson(res, 200, { folder: { ...folder, name } });
  });
  router.add('PUT', '/api/v1/projects/:id/folders/items/:kind/:ref', async (req, res, ctx) => {
    const admitted = await gate(req, res, ctx.params.id!, true); if (!admitted) return;
    const body = await readJson(req) as { folderId?: unknown } | null;
    if (!body || !Object.hasOwn(body, 'folderId')) return sendError(res, 400, 'INVALID_INPUT', 'folderId required, or null for the project root');
    const folderId = body.folderId;
    if (folderId !== null && (typeof folderId !== 'string' || !(await d.store.listProjectFolders(admitted.project.id)).some(f => f.id === folderId))) return sendError(res, 400, 'INVALID_INPUT', 'choose a folder in this project');
    const kind = ctx.params.kind, ref = ctx.params.ref!;
    if (kind !== 'session' && kind !== 'file') return sendError(res, 400, 'INVALID_INPUT', 'choose a session or file');
    const item = kind === 'session' ? await d.store.getSession(ref) : await d.store.getProjectFile(ref);
    if (!item || item.projectId !== admitted.project.id || ('deletedAt' in item && item.deletedAt) || ('ready' in item && !item.ready)) return sendError(res, 404, 'NOT_FOUND', 'no such project item');
    await d.store.assignProjectFolderItem(admitted.project.id, folderId as string | null, kind, ref);
    await d.audit(`user:${admitted.user.id}`, 'project.folder.move', `project:${admitted.project.id}`, { folderId, kind, ref });
    sendJson(res, 200, { folderId, kind, ref });
  });
}
