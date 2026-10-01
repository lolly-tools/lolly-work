// SPDX-License-Identifier: MPL-2.0
import type { AuditEvent } from './chain.ts';
export interface AuditFilter { actor?: string; action?: string; subject?: string; since?: string; until?: string }
export function matchesAudit(event: AuditEvent, filter: AuditFilter = {}): boolean {
  return (['actor', 'action', 'subject'] as const).every(key => !filter[key] || event[key] === filter[key])
    && (!filter.since || Date.parse(event.at) >= Date.parse(filter.since))
    && (!filter.until || Date.parse(event.at) <= Date.parse(filter.until));
}
/** Column names are fixed; every caller value stays a query parameter. */
export function auditWhere(before: number, filter: AuditFilter = {}) {
  const values: unknown[] = [];
  const parts: string[] = [];
  const add = (column: string, operator: string, value: unknown) => { values.push(value); parts.push(`${column} ${operator} $${values.length}`); };
  if (before > 0) add('seq', '<', before);
  for (const key of ['actor', 'action', 'subject'] as const) if (filter[key]) add(key, '=', filter[key]);
  if (filter.since) add('at', '>=', filter.since);
  if (filter.until) add('at', '<=', filter.until);
  return { sql: parts.length ? `where ${parts.join(' and ')}` : '', values };
}
