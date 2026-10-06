// SPDX-License-Identifier: MPL-2.0
/** Agent identity comes from the authenticated invitation, never tool arguments. */
import type { DocumentAgentRecord, ProjectAgentRecord } from '../store/types.ts';

export const agentActor = (record: Pick<DocumentAgentRecord, 'id' | 'projectAgentId'>) => `agent:${record.projectAgentId ?? record.id}`;
export function agentAttribution(record: ProjectAgentRecord | DocumentAgentRecord): Record<string, unknown> {
  return {
    agentId: 'projectAgentId' in record ? record.projectAgentId ?? record.id : record.id,
    agentLabel: record.label,
    invitedBy: `user:${record.createdBy}`,
    actingFor: record.userId,
    projectId: record.projectId,
    ...('sessionId' in record ? { sessionId: record.sessionId } : {}),
    ...('projectAgentId' in record && record.projectAgentId ? { projectAgentId: record.projectAgentId, documentAgentId: record.id } : {}),
  };
}
