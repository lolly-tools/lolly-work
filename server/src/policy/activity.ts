// SPDX-License-Identifier: MPL-2.0
export type ActivityMode = 'off' | 'owner-only' | 'delegated';
export interface ActivityPolicy { mode: ActivityMode; auditSessionUpdates: boolean }

export function activityAvailable(policy: ActivityPolicy, role: string): boolean {
  return policy.mode === 'delegated' || (policy.mode === 'owner-only' && role === 'owner');
}
