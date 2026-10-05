// SPDX-License-Identifier: MPL-2.0
/** HTTP hosts inject a live document connection without importing the socket server. */
import type { DocumentAgentRecord } from '../store/types.ts';

export interface AgentRoomBridge {
  read(record: DocumentAgentRecord): Promise<Record<string, unknown>>;
  apply(record: DocumentAgentRecord, arguments_: Record<string, unknown>): Promise<Record<string, unknown>>;
  disconnect(id: string): Promise<void>;
  connected(id: string): boolean;
}
