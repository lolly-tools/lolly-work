// SPDX-License-Identifier: MPL-2.0
/** Agent access follows both the current project membership and the person who invited it. */
import { randomId, sha256Hex } from '../lib/crypto.ts';
import { evaluate, mayEditCollab, mayJoinCollab, type Grant, type Role } from '../rbac/evaluate.ts';
import { accessAtLeast, effectiveProjectAccess } from '../rbac/project-access.ts';
import type { DocumentAgentRecord, ProjectAgentRecord, Store, UserRecord } from '../store/types.ts';

export const AGENT_TOKEN_PREFIX = 'lwa_';
export const agentSecret = () => { const secret = AGENT_TOKEN_PREFIX + randomId(32); return { secret, tokenHash: sha256Hex(secret) }; };
export const principalOf = (user: UserRecord) => ({ userId: user.id, groups: user.groups, role: user.role as Role });
export const projectAgentCanWrite = (user: UserRecord, grants: Grant[]) =>
  evaluate(principalOf(user), 'session.create', ['*'], grants) || evaluate(principalOf(user), 'session.edit', ['*'], grants);

export function projectAgentDocument(record: ProjectAgentRecord, sessionId: string): DocumentAgentRecord {
  return { ...record, id: `agt_${sha256Hex(`${record.id}:${sessionId}`).slice(0, 16)}`, sessionId, projectAgentId: record.id };
}

export async function projectAgentStanding(store: Store, record: ProjectAgentRecord) {
  const current = await store.getProjectAgent(record.id);
  if (!current || current.revokedAt || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) return null;
  const [creator, project, seat, grants] = await Promise.all([
    store.getUser(current.createdBy), store.getProject(current.projectId), store.getProjectMember(current.projectId, current.createdBy), store.listGrants(),
  ]);
  if (!creator || creator.disabledAt || current.userId !== current.createdBy || !project) return null;
  const access = effectiveProjectAccess(creator, project, seat, grants);
  if (!accessAtLeast(access, 'viewer')) return null;
  const mayEdit = current.role === 'editor' && !project.archivedAt && accessAtLeast(access, 'editor') && projectAgentCanWrite(creator, grants);
  return { record: current, creator, project, mayEdit, grants };
}

export async function agentStanding(store: Store, record: DocumentAgentRecord) {
  const invitation = record.projectAgentId ? await store.getProjectAgent(record.projectAgentId) : null;
  const current = record.projectAgentId ? (invitation ? projectAgentDocument(invitation, record.sessionId) : null) : await store.getDocumentAgent(record.id);
  if (current?.id !== record.id) return null;
  if (!current || current.revokedAt || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= Date.now()) return null;
  const [creator, session, project, creatorSeat, grants] = await Promise.all([
    store.getUser(current.createdBy), store.getSession(current.sessionId), store.getProject(current.projectId),
    store.getProjectMember(current.projectId, current.createdBy), store.listGrants(),
  ]);
  if (!creator || creator.disabledAt || current.userId !== current.createdBy || !session || session.deletedAt || session.toolId !== 'design'
    || !project || session.projectId !== current.projectId
    || !accessAtLeast(effectiveProjectAccess(creator, project, creatorSeat, grants), 'viewer')
    || !mayJoinCollab(principalOf(creator), grants)) return null;
  const mayEdit = current.role === 'editor' && current.userId === current.createdBy && !project.archivedAt
    && accessAtLeast(effectiveProjectAccess(creator, project, creatorSeat, grants), 'editor')
    && mayEditCollab(principalOf(creator), grants);
  return { record: current, creator, agent: creator, session, project, mayEdit, grants };
}

export async function resolveAgent(store: Store, authorization: string | undefined) {
  if (!authorization?.startsWith('Bearer ')) return null;
  const secret = authorization.slice(7);
  if (!/^lwa_[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const record = await store.findDocumentAgentByHash(sha256Hex(secret));
  if (record) { const standing = await agentStanding(store, record); return standing ? { ...standing, scope: 'document' as const } : null; }
  const project = await store.findProjectAgentByHash(sha256Hex(secret));
  const standing = project ? await projectAgentStanding(store, project) : null;
  return standing ? { ...standing, scope: 'project' as const } : null;
}
