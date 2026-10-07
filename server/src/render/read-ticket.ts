// SPDX-License-Identifier: MPL-2.0
/**
 * A render may read its instance's catalog for five minutes, without a person's
 * cookie. A ticket may also name project files the render's inputs use: the
 * worker then reads those files, and only those, for as long as the person who
 * submitted the render can still see the project (plan 76 M4j).
 */
import type { IncomingMessage } from 'node:http';
import { mintToken, verifyToken } from '../iam/tokens.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import type { ProjectRecord, Store, UserRecord } from '../store/types.ts';
import { loadEngine } from './contract.ts';

/** The most project files one render may read. */
export const RENDER_READ_FILE_LIMIT = 64;
/** The longest ticket the worker accepts (workers/render/src/server.ts). */
const TICKET_MAX_LENGTH = 8192;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const FILE_PATH = /^\/api\/v1\/projects\/([^/]+)\/files\/([^/]+)$/;

/** Project files a render may read: these ids, in this project, while `userId`
 *  (the person who submitted the render) can see the project. */
export interface RenderFileScope { projectId: string; ids: string[]; userId: string }
interface RenderRead { groups: string[]; revision: string; files?: RenderFileScope }

const validScope = (files: unknown): files is RenderFileScope => {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return false;
  const { projectId, ids, userId } = files as Record<string, unknown>;
  return typeof projectId === 'string' && ID.test(projectId) && typeof userId === 'string' && ID.test(userId)
    && Array.isArray(ids) && ids.length > 0 && ids.length <= RENDER_READ_FILE_LIMIT && ids.every((id) => typeof id === 'string' && ID.test(id));
};

/** A ticket longer than the worker accepts drops its file scope, so the render
 *  still runs and only the file reads are refused. */
export function mintRenderRead(groups: string[], revision: string, secret: string, files?: RenderFileScope): string {
  const plain = () => mintToken('lw/render-read', { groups, revision }, secret, 300);
  if (!files || !validScope(files)) return plain();
  const scoped = mintToken('lw/render-read', { groups, revision, files }, secret, 300);
  return scoped.length <= TICKET_MAX_LENGTH ? scoped : plain();
}

export function renderReader(req: IncomingMessage, revision: string, secret: string | readonly string[]): UserRecord | null {
  const path = new URL(req.url ?? '/', 'http://local').pathname;
  if (!['GET', 'HEAD'].includes(req.method ?? '') || !/^(\/catalog\/|\/tools\/|\/api\/auth\/config$)/.test(path)) return null;
  const raw = req.headers['x-lw-render-read'];
  if (typeof raw !== 'string' || raw.length > TICKET_MAX_LENGTH) return null;
  const ticket = verifyToken<RenderRead>('lw/render-read', raw, secret);
  if (!ticket || ticket.revision !== revision || !Array.isArray(ticket.groups)
    || ticket.groups.some(g => typeof g !== 'string')) return null;
  return { id: 'render-read', sub: 'render-read', email: '', groups: ticket.groups, idpGroups: ticket.groups,
    localGroups: [], role: 'member', sessionEpoch: 0, createdAt: '', lastSeenAt: '' };
}

/**
 * The project file a request reads under a render ticket. Only GET or HEAD of
 * `/api/v1/projects/<project>/files/<file>` qualifies, with an unexpired ticket
 * whose file scope names that project and lists that file. Says nothing about
 * the person; {@link createRenderFileReader} checks them.
 */
export function renderFileTicket(req: IncomingMessage, secret: string | readonly string[]): { projectId: string; fileId: string; userId: string } | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  let projectId: string, fileId: string;
  try {
    const match = FILE_PATH.exec(new URL(req.url ?? '/', 'http://local').pathname);
    if (!match) return null;
    projectId = decodeURIComponent(match[1]!); fileId = decodeURIComponent(match[2]!);
  } catch { return null; }
  const raw = req.headers['x-lw-render-read'];
  if (typeof raw !== 'string' || raw.length > TICKET_MAX_LENGTH) return null;
  const files = verifyToken<RenderRead>('lw/render-read', raw, secret)?.files;
  if (!validScope(files) || files.projectId !== projectId || !files.ids.includes(fileId)) return null;
  return { projectId, fileId, userId: files.userId };
}

export interface RenderFileReaderDeps {
  secret: string | readonly string[];
  store: Pick<Store, 'getUser' | 'getProject'>;
  projectAccessOf(user: UserRecord, project: ProjectRecord): Promise<ProjectAccess>;
}

/**
 * The project file read route's second way in (projects/file-routes.ts `gate`):
 * a render worker holding a ticket for this file. Answers the person who
 * submitted the render, read again from the store on every request, and only
 * while they are active and can still see the project, so removing them from
 * it stops the render's reads at once. Any other path, method or project gets
 * null, so the list, upload and delete routes never admit a ticket.
 */
export function createRenderFileReader(deps: RenderFileReaderDeps): (req: IncomingMessage, projectId: string) => Promise<UserRecord | null> {
  return async (req, projectId) => {
    const scope = renderFileTicket(req, deps.secret);
    if (!scope || scope.projectId !== projectId || scope.userId.startsWith('svc_')) return null;
    const [user, project] = await Promise.all([deps.store.getUser(scope.userId), deps.store.getProject(projectId)]);
    if (!user || user.disabledAt || !project) return null;
    return accessAtLeast(await deps.projectAccessOf(user, project), 'viewer') ? user : null;
  };
}

const TEAM_ASSET = /user\/team\/([A-Za-z0-9_-]{1,128})/g;
const FILE_ADDRESS = /\/api\/v1\/projects\/([A-Za-z0-9_-]{1,128})\/files\/([A-Za-z0-9_-]{1,128})(?![A-Za-z0-9_/-])/g;

/**
 * Project files a render's URL-mode query names, in the order they appear: the
 * asset id a session uses for a project file (`user/team/<file>`, see
 * projects/files.ts `projectFileAssetId`) and the file's own address on this
 * instance (`/api/v1/projects/<project>/files/<file>`, absolute or not), which
 * the shell fetches like any other image address. Reads the decoded values of
 * an already expanded query (no packed `z=`). Pure.
 */
export function projectFileRefs(query: string, max = RENDER_READ_FILE_LIMIT): { fileId: string; projectId?: string }[] {
  const refs: { fileId: string; projectId?: string }[] = [];
  const seen = new Set<string>();
  const add = (fileId: string, projectId?: string) => {
    const key = `${projectId ?? ''}/${fileId}`;
    if (refs.length < max && !seen.has(key)) { seen.add(key); refs.push({ fileId, ...(projectId ? { projectId } : {}) }); }
  };
  for (const [, value] of new URLSearchParams(query)) {
    const found: { at: number; fileId: string; projectId?: string }[] = [];
    for (const m of value.matchAll(TEAM_ASSET)) found.push({ at: m.index ?? 0, fileId: m[1]! });
    for (const m of value.matchAll(FILE_ADDRESS)) found.push({ at: m.index ?? 0, fileId: m[2]!, projectId: m[1]! });
    for (const ref of found.sort((a, b) => a.at - b.at)) add(ref.fileId, ref.projectId);
    if (refs.length >= max) break;
  }
  return refs;
}

export interface RenderFileScopeDeps {
  store: Pick<Store, 'getProjectFile' | 'getProject'>;
  projectAccessOf(user: UserRecord, project: ProjectRecord): Promise<ProjectAccess>;
}

/**
 * The file scope for a render `submitter` asks for with `query` (the render
 * mint site in api/app.ts). One project per ticket: the project of the first
 * ready file the query names; files of any other project are left out. Nothing
 * for a service token, a disabled account, or a person who cannot see that
 * project. At most {@link RENDER_READ_FILE_LIMIT} files.
 */
export async function renderFileScope(deps: RenderFileScopeDeps, query: string, submitter: UserRecord): Promise<RenderFileScope | undefined> {
  if (submitter.id.startsWith('svc_') || submitter.disabledAt) return undefined;
  let expanded = query;
  try { if (new URLSearchParams(query).has('z')) expanded = await (await loadEngine()).expandQuery(query); } catch { return undefined; }
  const refs = projectFileRefs(expanded);
  if (!refs.length) return undefined;
  const files = await Promise.all(refs.map((ref) => deps.store.getProjectFile(ref.fileId)));
  let projectId: string | undefined;
  const ids: string[] = [];
  refs.forEach((ref, i) => {
    const file = files[i];
    if (!file?.ready || (ref.projectId && ref.projectId !== file.projectId)) return;
    projectId ??= file.projectId;
    if (file.projectId === projectId && !ids.includes(file.id)) ids.push(file.id);
  });
  if (!projectId) return undefined;
  const project = await deps.store.getProject(projectId);
  if (!project || !accessAtLeast(await deps.projectAccessOf(submitter, project), 'viewer')) return undefined;
  return { projectId, ids, userId: submitter.id };
}
