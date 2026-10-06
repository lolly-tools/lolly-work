// SPDX-License-Identifier: MPL-2.0
/** Project invitations delegate only the inviter’s access and can be revoked by managers. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import { randomId } from '../lib/crypto.ts';
import { accessAtLeast } from '../rbac/project-access.ts';
import { nameWithoutEmail } from '../projects/sharing.ts';
import type { ProjectAgentRecord } from '../store/types.ts';
import { agentAttribution } from './attribution.ts';
import { agentSecret, projectAgentCanWrite } from './access.ts';
import type { Dependencies } from './routes.ts';

export function registerProjectInvitations(router: ReturnType<typeof createRouter>, d: Dependencies) {
  const safe = (r: ProjectAgentRecord) => ({ id: r.id, projectId: r.projectId, label: r.label, role: r.role,
    createdBy: r.createdBy, createdAt: r.createdAt, expiresAt: r.expiresAt, ...(r.revokedAt ? { revokedAt: r.revokedAt } : {}), connected: d.rooms?.connected(r.id) ?? false });
  async function gate(req: IncomingMessage, res: ServerResponse, id: string) {
    const user = await d.memberOf(req); if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'Sign in first.'); return null; }
    const project = await d.store.getProject(id), access = project ? await d.projectAccessOf(user, project) : 'none';
    if (!project || !accessAtLeast(access, 'viewer')) { sendError(res, 404, 'NOT_FOUND', 'This project is not available.'); return null; }
    return { user, project, access, canEdit: accessAtLeast(access, 'editor') && projectAgentCanWrite(user, await d.store.listGrants()) };
  }
  router.add('GET', '/api/v1/projects/:id/agents', async (req, res, ctx) => {
    const admitted = await gate(req, res, ctx.params.id!); if (!admitted) return;
    const records = (await d.store.listProjectAgents(admitted.project.id)).slice(-200);
    const people = new Map((await d.store.getUsersByIds([...new Set(records.map(r => r.createdBy))])).map(user => [user.id, nameWithoutEmail(user)]));
    sendJson(res, 200, { enabled: true, canInvite: !admitted.project.archivedAt, canEdit: !admitted.project.archivedAt && admitted.canEdit,
      agents: records.map(r => ({ ...safe(r), actingFor: people.get(r.createdBy) ?? 'Member', canRevoke: r.createdBy === admitted.user.id || accessAtLeast(admitted.access, 'manager') })) }, { 'cache-control': 'private, no-store' });
  });
  router.add('POST', '/api/v1/projects/:id/agents', async (req, res, ctx) => {
    const admitted = await gate(req, res, ctx.params.id!); if (!admitted) return;
    const body = await readJson(req, 4096) as { label?: unknown; role?: unknown; hours?: unknown } | null;
    const label = typeof body?.label === 'string' ? body.label.trim() : '', role = body?.role, hours = body?.hours ?? 24;
    if (!label || label.length > 80 || /[\u0000-\u001f]/.test(label) || !['viewer', 'editor'].includes(String(role)) || !Number.isInteger(hours) || Number(hours) < 1 || Number(hours) > 168) {
      return sendError(res, 400, 'INVALID_INPUT', 'Choose an agent name, viewer or editor access, and an expiry from 1 to 168 hours.');
    }
    if (admitted.project.archivedAt || role === 'editor' && !admitted.canEdit) return sendError(res, 403, 'READ_ONLY', 'You cannot invite an editor to this project.');
    const { secret, tokenHash } = agentSecret(), now = Date.now();
    const record: ProjectAgentRecord = { id: `pag_${randomId(8)}`, projectId: admitted.project.id, userId: admitted.user.id, createdBy: admitted.user.id,
      label, role: role as 'viewer' | 'editor', tokenHash, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + Number(hours) * 3600000).toISOString() };
    if (!await d.store.createProjectAgent(record)) return sendError(res, 409, 'AGENT_LIMIT', 'Revoke an unused agent invitation before creating another.');
    await d.audit(`user:${admitted.user.id}`, 'agent.project-invite', `project:${admitted.project.id}`, { ...agentAttribution(record), role: record.role });
    sendJson(res, 201, { agent: safe(record), secret, endpoint: `${new URL(d.origin).origin}/api/workspace/mcp` }, { 'cache-control': 'no-store' });
  });
  router.add('DELETE', '/api/v1/projects/:id/agents/:agentId', async (req, res, ctx) => {
    const admitted = await gate(req, res, ctx.params.id!); if (!admitted) return;
    const agent = await d.store.getProjectAgent(ctx.params.agentId!);
    if (!agent || agent.projectId !== admitted.project.id) return sendError(res, 404, 'NOT_FOUND', 'This agent invitation is not available.');
    if (agent.createdBy !== admitted.user.id && !accessAtLeast(admitted.access, 'manager')) return sendError(res, 403, 'FORBIDDEN', 'Only the inviter or a project manager can revoke this invitation.');
    await d.store.revokeProjectAgent(agent.id, new Date().toISOString()); await d.rooms?.disconnect(agent.id);
    await d.audit(`user:${admitted.user.id}`, 'agent.project-revoke', `project:${admitted.project.id}`, agentAttribution(agent));
    res.writeHead(204); res.end();
  });
}
