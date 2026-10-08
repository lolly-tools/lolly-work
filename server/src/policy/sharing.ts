// SPDX-License-Identifier: MPL-2.0
/**
 * `policy.sharing` - the instance's sharing limits (lolly plan 299 M1,
 * lolly-work plan 79).
 *
 *   instance.enabled  whether a project may be shared with everyone signed in
 *                     to this instance (default true).
 *   instance.maxRole  the highest role that audience may get: viewer,
 *                     commenter (default) or editor. Never manager.
 *   customGroups      whether members may make their own groups and share
 *                     with them (default true).
 *   maxGrantDays      the longest end date a group grant or membership may
 *                     carry, in days (default: no limit).
 *
 * The limits apply at evaluation time as well as when a share is saved, so
 * lowering one also lowers shares made before the change.
 */
import type { ProjectMemberRole } from '../store/types.ts';

export type InstanceShareRole = Exclude<ProjectMemberRole, 'manager'>;
const INSTANCE_ROLES: readonly InstanceShareRole[] = ['viewer', 'commenter', 'editor'];

/** `policy.sharing` as written in the instance config. */
export interface SharingPolicyConfig {
  instance?: { enabled?: boolean; maxRole?: InstanceShareRole };
  customGroups?: boolean;
  maxGrantDays?: number;
}

/** The same policy with every default applied. */
export interface SharingPolicy {
  instanceAudience: boolean;
  instanceMaxRole: InstanceShareRole;
  customGroups: boolean;
  maxGrantDays: number | null;
}

export const MAX_GRANT_DAYS = 3660;

export function resolveSharingPolicy(cfg: SharingPolicyConfig | undefined): SharingPolicy {
  return {
    instanceAudience: cfg?.instance?.enabled !== false,
    instanceMaxRole: cfg?.instance?.maxRole ?? 'commenter',
    customGroups: cfg?.customGroups !== false,
    maxGrantDays: cfg?.maxGrantDays ?? null,
  };
}

/** Throws with the key that is wrong. Absent is valid (every default). */
export function validateSharingPolicy(cfg: unknown): void {
  if (cfg === undefined) return;
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('policy.sharing must be an object');
  const c = cfg as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!['instance', 'customGroups', 'maxGrantDays'].includes(key)) throw new Error(`policy.sharing.${key} is not a known setting`);
  }
  if (c.instance !== undefined) {
    if (!c.instance || typeof c.instance !== 'object' || Array.isArray(c.instance)) throw new Error('policy.sharing.instance must be an object');
    const i = c.instance as Record<string, unknown>;
    if (i.enabled !== undefined && typeof i.enabled !== 'boolean') throw new Error('policy.sharing.instance.enabled must be true or false');
    if (i.maxRole !== undefined && !(INSTANCE_ROLES as readonly unknown[]).includes(i.maxRole)) {
      throw new Error('policy.sharing.instance.maxRole must be viewer, commenter or editor');
    }
  }
  if (c.customGroups !== undefined && typeof c.customGroups !== 'boolean') throw new Error('policy.sharing.customGroups must be true or false');
  if (c.maxGrantDays !== undefined && (!Number.isInteger(c.maxGrantDays) || (c.maxGrantDays as number) < 1 || (c.maxGrantDays as number) > MAX_GRANT_DAYS)) {
    throw new Error(`policy.sharing.maxGrantDays must be a whole number of days from 1 to ${MAX_GRANT_DAYS}`);
  }
}
