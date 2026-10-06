// SPDX-License-Identifier: MPL-2.0
import type { AuditEvent } from './chain.ts';
export interface AuditFilter { actor?: string; action?: string; subject?: string; since?: string; until?: string; agents?: boolean }
export function matchesAudit(event: AuditEvent, filter: AuditFilter = {}): boolean {
  return (!filter.agents || isAgentEvent(event)) && (['actor', 'action', 'subject'] as const).every(key => !filter[key] || event[key] === filter[key])
    && (!filter.since || Date.parse(event.at) >= Date.parse(filter.since))
    && (!filter.until || Date.parse(event.at) <= Date.parse(filter.until));
}
/** Agent audit content includes delegated writes and legacy room joins. */
export function isAgentEvent(event: Pick<AuditEvent, 'actor' | 'action' | 'payload'>): boolean {
  return event.actor.startsWith('agent:') || event.action.startsWith('agent.')
    || event.actor.startsWith('user:') && ['collab.join', 'collab.leave'].includes(event.action) && typeof event.payload?.agentId === 'string';
}
/** Column names are fixed; every caller value stays a query parameter. */
export function auditWhere(before: number, filter: AuditFilter = {}) {
  const values: unknown[] = [];
  const parts: string[] = [];
  const add = (column: string, operator: string, value: unknown) => { values.push(value); parts.push(`${column} ${operator} $${values.length}`); };
  if (filter.agents) parts.push("(actor like 'agent:%' or action like 'agent.%' or (actor like 'user:%' and action in ('collab.join', 'collab.leave') and jsonb_typeof(payload->'agentId') = 'string'))");
  if (before > 0) add('seq', '<', before);
  for (const key of ['actor', 'action', 'subject'] as const) if (filter[key]) add(key, '=', filter[key]);
  if (filter.since) add('at', '>=', filter.since);
  if (filter.until) add('at', '<=', filter.until);
  return { sql: parts.length ? `where ${parts.join(' and ')}` : '', values };
}
