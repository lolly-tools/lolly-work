// SPDX-License-Identifier: MPL-2.0
/** Read-only agent observability. Never return credentials, arguments or document contents. */
import type { Store, DocumentAgentRecord } from '../store/types.ts';
import type { AgentRoomBridge } from './types.ts';
import { normalizeActivity } from '../activity/feed.ts';
import { displayName } from '../iam/member.ts';

type Invitation = Omit<DocumentAgentRecord, 'tokenHash' | 'sessionId'> & { sessionId?: string };
// Project invitations are supported by newer hosts; document-only hosts remain compatible.
type ObservableStore = Store & { getProjectAgent?: (id: string) => Promise<Invitation | null> };
const EVENT_LIMIT = 10_000, AGENT_LIMIT = 500;
const text = (value: unknown, max = 100) => typeof value === 'string' ? value.slice(0, max) : undefined;
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

export async function agentDashboard(store: ObservableStore, rooms?: AgentRoomBridge, days = 30, now = Date.now()) {
  const since = new Date(now - days * 86400_000).toISOString();
  const audit = await store.listAuditBefore(0, EVENT_LIMIT + 1, { since, until: new Date(now).toISOString(), agents: true });
  const truncated = audit.length > EVENT_LIMIT;
  const events = normalizeActivity(audit.slice(-EVENT_LIMIT), [], new Map()).sort((a, b) => b.at.localeCompare(a.at) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
  const byAgent = new Map<string, typeof events>();
  for (const event of events) {
    const id = event.actor.kind === 'agent' ? event.actor.id : text(event.payload.agentId);
    if (id) { const rows = byAgent.get(id) ?? []; rows.push(event); byAgent.set(id, rows); }
  }
  const ids = [...byAgent.keys()].slice(0, AGENT_LIMIT);
  const records = new Map<string, Invitation | null>();
  // Bound query concurrency; no whole-project or whole-account inventory scans.
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map(async id => {
      records.set(id, await store.getDocumentAgent(id) ?? await store.getProjectAgent?.(id) ?? null);
    }));
  }
  const inviterIds = new Set<string>();
  for (const id of ids) {
    const record = records.get(id), recent = byAgent.get(id)!;
    const inviter = record?.createdBy ?? recent.find(e => typeof e.payload.invitedBy === 'string')?.payload.invitedBy;
    if (typeof inviter === 'string') inviterIds.add(inviter.replace(/^user:/, ''));
    else if (recent.some(e => e.actor.kind === 'user')) inviterIds.add(recent.find(e => e.actor.kind === 'user')!.actor.id!);
  }
  const users = new Map((await store.getUsersByIds([...inviterIds])).map(u => [u.id, u]));
  const names = Object.fromEntries([...users].map(([id, user]) => [id, displayName(user)]));
  const projectCache = new Map<string, ReturnType<Store['getProject']>>();
  const sessionCache = new Map<string, ReturnType<Store['getSession']>>();
  const projectOf = (id: string) => { if (!projectCache.has(id)) projectCache.set(id, store.getProject(id)); return projectCache.get(id)!; };
  const sessionOf = (id: string) => { if (!sessionCache.has(id)) sessionCache.set(id, store.getSession(id)); return sessionCache.get(id)!; };
  const agents: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 8) {
    agents.push(...await Promise.all(ids.slice(i, i + 8).map(async id => {
      const record = records.get(id), recent = byAgent.get(id)!;
      const newest = recent[0]!;
      const invitation = recent.find(e => ['agent.invite', 'agent.project-invite'].includes(e.action));
      const invitedBy = record?.createdBy ?? text(recent.find(e => typeof e.payload.invitedBy === 'string')?.payload.invitedBy)?.replace(/^user:/, '') ?? invitation?.actor.id;
      const projectId = record?.projectId ?? text(recent.find(e => typeof e.payload.projectId === 'string')?.payload.projectId)
        ?? recent.find(e => e.subject?.startsWith('project:'))?.subject?.slice(8);
      const sessionId = record?.sessionId ?? (invitation?.subject?.startsWith('session:') ? invitation.subject.slice(8) : undefined);
      const [project, session] = await Promise.all([projectId ? projectOf(projectId) : null, sessionId ? sessionOf(sessionId) : null]);
      const calls = recent.filter(e => e.action === 'agent.tool-call');
      const status = !record ? 'unavailable' : record.revokedAt ? 'revoked' : Date.parse(record.expiresAt) <= now ? 'expired'
        : !users.get(record.createdBy) || users.get(record.createdBy)?.disabledAt || !project || project.archivedAt || sessionId && (!session || session.deletedAt) ? 'unavailable' : 'active';
      return {
        id, label: record?.label ?? text(recent.find(e => e.payload.agentLabel)?.payload.agentLabel, 80) ?? 'Agent',
        invitedBy: invitedBy ? { id: invitedBy, name: names[invitedBy] ?? 'Former member' } : null,
        scope: sessionId ? 'document' : 'project', role: record?.role ?? text(invitation?.payload.role) ?? null,
        project: projectId ? { id: projectId, name: project?.name ?? 'Unavailable project' } : null,
        session: sessionId ? { id: sessionId, name: text(session?.meta?.label) ?? text(session?.meta?.title) ?? text(session?.meta?.name) ?? sessionId, toolId: session?.toolId ?? null } : null,
        status, expiresAt: record?.expiresAt ?? null,
        connected: rooms ? status === 'active' && rooms.connected(id) : null,
        lastActivity: newest.at, lastTool: text(calls[0]?.payload.tool),
        calls: calls.length, rejected: calls.filter(e => e.payload.outcome === 'rejected').length,
        partial: calls.filter(e => e.payload.outcome === 'partial').length,
      };
    })));
  }
  const calls = events.filter(e => e.action === 'agent.tool-call');
  const used = new Set(calls.map(e => e.actor.id).filter(Boolean));
  const timeline = events.slice(0, 100).map(e => {
    const record = records.get(e.actor.kind === 'agent' ? e.actor.id! : String(e.payload.agentId));
    const payload: Record<string, unknown> = {};
    for (const key of ['agentId', 'agentLabel', 'invitedBy', 'projectId', 'sessionId', 'tool', 'outcome', 'code', 'role']) {
      const value = text(e.payload[key]); if (value !== undefined) payload[key] = value;
    }
    if (record) payload.agentLabel = record.label;
    for (const key of ['acceptedOps', 'rejectedOps']) if (key in e.payload) payload[key] = count(e.payload[key]);
    const actor = e.actor.kind === 'user' ? { ...e.actor, name: names[e.actor.id!] ?? 'A teammate' }
      : { ...e.actor, name: record?.label ?? e.actor.name, ...(record ? { invitedBy: { id: record.createdBy, name: names[record.createdBy] ?? 'Former member' } } : e.actor.invitedBy ? { invitedBy: { ...e.actor.invitedBy, name: names[e.actor.invitedBy.id] ?? 'Former member' } } : {}) };
    return { ...e, actor, payload };
  });
  return {
    days, since, updatedAt: new Date(now).toISOString(), truncated, inventoryTruncated: byAgent.size > AGENT_LIMIT,
    limits: { events: EVENT_LIMIT, agents: AGENT_LIMIT, timeline: 100 },
    summary: {
      agentsSeen: byAgent.size, agentsUsed: used.size, connected: rooms ? agents.filter(a => a.connected).length : null,
      toolCalls: calls.length, succeeded: calls.filter(e => e.payload.outcome === 'succeeded').length,
      rejected: calls.filter(e => e.payload.outcome === 'rejected').length, partial: calls.filter(e => e.payload.outcome === 'partial').length,
      acceptedOps: calls.reduce((sum, e) => sum + count(e.payload.acceptedOps), 0), rejectedOps: calls.reduce((sum, e) => sum + count(e.payload.rejectedOps), 0),
      invited: events.filter(e => ['agent.invite', 'agent.project-invite'].includes(e.action)).length,
      revoked: events.filter(e => ['agent.revoke', 'agent.project-revoke'].includes(e.action)).length,
    }, agents, timeline, names,
  };
}
