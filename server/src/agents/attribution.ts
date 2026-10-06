// SPDX-License-Identifier: MPL-2.0
/** Identity is taken from an authenticated invitation, never a tool argument. */
import type { DocumentAgentRecord } from '../store/types.ts';
type Identity = Pick<DocumentAgentRecord, 'id' | 'label' | 'createdBy' | 'userId' | 'projectId'> & { sessionId?: string; projectAgentId?: string };
export const agentActor = (record: Pick<Identity, 'id' | 'projectAgentId'>) => `agent:${record.projectAgentId ?? record.id}`;
export function agentAttribution(record: Identity): Record<string, unknown> {
  return { agentId: record.projectAgentId ?? record.id, agentLabel: record.label, invitedBy: `user:${record.createdBy}`,
    actingFor: record.userId, projectId: record.projectId, ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.projectAgentId ? { projectAgentId: record.projectAgentId, documentAgentId: record.id } : {}) };
}
