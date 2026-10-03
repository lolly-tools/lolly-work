// SPDX-License-Identifier: MPL-2.0
/**
 * Invite policy (plans/74, "Policy in Lolly Work"): who may invite new people
 * by email from inside Lolly, which addresses, for how long, and with which
 * project roles. Configured as `policy.invites` in the instance config and
 * advertised to the shell in org-config. Pure: the routes read the config and
 * the store and pass the facts in.
 *
 * What this governs: creating or extending an INVITATION, which lets a new
 * person sign in (when `idp.admission` reads invitations) and gives them the
 * projects named on it, whether it comes from a project invite or from the
 * console and `lw invite add` (`maxTtlHours` is the project invite's expiry;
 * the console sets its own). Adding someone who already has an account to a
 * project is sharing, not inviting: it needs manager on the project and a
 * role from `projectRoles`, and the allow tier and domain list do not apply
 * to it. Acceptance asks the tier and `projectRoles` again for each project
 * entry, against the person who added it.
 *
 * Tiers (`allow`):
 *   - owners:  an instance owner who holds `user.invite`.
 *   - admins:  anyone holding `user.invite` (admins and owners by role
 *              default; a grant can add a group or deny someone). The default.
 *   - members: any signed-in member, unless a grant denies them `user.invite`.
 * Project invitations also need manager (or higher) on that project, at
 * every tier.
 */
import { evaluate, grantDecision, type Grant, type Role } from '../rbac/evaluate.ts';
import { PROJECT_MEMBER_ROLES, type ProjectMemberRole, type UserRecord } from '../store/types.ts';

export type InviteAllow = 'owners' | 'admins' | 'members';
export const INVITE_ALLOW: readonly InviteAllow[] = ['owners', 'admins', 'members'];

/** `policy.invites` as written in the instance config: every key optional. */
export interface InvitePolicyConfig {
  allow?: InviteAllow;
  domains?: string[];
  maxTtlHours?: number;
  projectRoles?: ProjectMemberRole[];
  passwordDomains?: string[];
}

/** The same policy with every default applied. */
export interface InvitePolicy {
  allow: InviteAllow;
  /** Lowercased domain names. Empty means any domain. */
  domains: string[];
  maxTtlHours: number;
  projectRoles: ProjectMemberRole[];
  /** Lowercased domain names whose people usually sign in with a password
   *  (their organisation blocks the other sign-ins). When every address on
   *  an invite is in one of them, the console and the shell start the
   *  "set a password from the link" tick ticked. It only suggests: the tick
   *  is still an admin's choice. Empty by default. */
  passwordDomains: string[];
}

export const DEFAULT_INVITE_TTL_HOURS = 720;
/** The longest an invitation may stay open, matching the console's 366 days. */
export const MAX_INVITE_TTL_HOURS = 366 * 24;

const DOMAIN_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Fill in the defaults. Expects a config that `validateInvitePolicy` passed. */
export function resolveInvitePolicy(cfg: InvitePolicyConfig | undefined): InvitePolicy {
  return {
    allow: cfg?.allow ?? 'admins',
    domains: [...(cfg?.domains ?? [])],
    maxTtlHours: cfg?.maxTtlHours ?? DEFAULT_INVITE_TTL_HOURS,
    projectRoles: cfg?.projectRoles?.length ? [...cfg.projectRoles] : [...PROJECT_MEMBER_ROLES],
    passwordDomains: [...(cfg?.passwordDomains ?? [])],
  };
}

/** A list of domain names, lowercased, a leading "@" dropped, duplicates
 *  removed. Throws with the key that is wrong. */
function domainList(key: string, raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 1000) throw new Error(`policy.invites.${key} must be a list of domain names`);
  return [...new Set(raw.map((x) => {
    const n = typeof x === 'string' ? x.trim().toLowerCase().replace(/^@/, '') : '';
    if (!DOMAIN_NAME.test(n)) throw new Error(`policy.invites.${key} entry is not a domain name: ${String(x)}`);
    return n;
  }))];
}

/**
 * Validate `policy.invites` and normalise it in place (both domain lists
 * lowercased, a leading "@" dropped, duplicates removed). Throws with the
 * key that is wrong, like the rest of `parseConfig`.
 */
export function validateInvitePolicy(raw: unknown): InvitePolicyConfig | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('policy.invites must be an object');
  const p = raw as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!['allow', 'domains', 'maxTtlHours', 'projectRoles', 'passwordDomains'].includes(k)) {
      throw new Error(`policy.invites.${k} is not a known key (allow, domains, maxTtlHours, projectRoles, passwordDomains)`);
    }
  }
  if (p.allow !== undefined && !INVITE_ALLOW.includes(p.allow as InviteAllow)) {
    throw new Error(`policy.invites.allow must be one of: ${INVITE_ALLOW.join(', ')}`);
  }
  if (p.domains !== undefined) p.domains = domainList('domains', p.domains);
  if (p.passwordDomains !== undefined) p.passwordDomains = domainList('passwordDomains', p.passwordDomains);
  if (p.maxTtlHours !== undefined) {
    const h = p.maxTtlHours;
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > MAX_INVITE_TTL_HOURS) {
      throw new Error(`policy.invites.maxTtlHours must be a number of hours above 0 and at most ${MAX_INVITE_TTL_HOURS}`);
    }
  }
  if (p.projectRoles !== undefined) {
    if (!Array.isArray(p.projectRoles) || p.projectRoles.length === 0
      || p.projectRoles.some((r) => !PROJECT_MEMBER_ROLES.includes(r as ProjectMemberRole))) {
      throw new Error(`policy.invites.projectRoles must be a non-empty list of: ${PROJECT_MEMBER_ROLES.join(', ')}`);
    }
    p.projectRoles = [...new Set(p.projectRoles as ProjectMemberRole[])];
  }
  return p as InvitePolicyConfig;
}

/**
 * Whether the caller's tier lets them invite new people by email. This is
 * the org-config `can['user.invite']` bit, and the first half of the project
 * invite check (the second half is manager on the project). An explicit deny
 * of `user.invite` always wins.
 */
export function mayInviteNewPeople(user: Pick<UserRecord, 'id' | 'groups' | 'role'>, grants: Grant[], policy: InvitePolicy): boolean {
  const ctx = { userId: user.id, groups: user.groups, role: user.role as Role };
  if (user.role === 'guest') return false;
  switch (policy.allow) {
    case 'owners': return user.role === 'owner' && evaluate(ctx, 'user.invite', ['*'], grants);
    case 'admins': return evaluate(ctx, 'user.invite', ['*'], grants);
    case 'members': return grantDecision(ctx, 'user.invite', ['*'], grants) !== 'deny';
  }
}

/** Whether this address is one the policy lets you invite. */
export function inviteDomainAllowed(email: string, policy: InvitePolicy): boolean {
  if (!policy.domains.length) return true;
  const at = email.lastIndexOf('@');
  return at > 0 && policy.domains.includes(email.slice(at + 1).trim().toLowerCase());
}

/** What org-config tells the shell, so it can offer only what the server allows. */
export function invitePolicyForClient(policy: InvitePolicy): { domains: string[]; maxTtlHours: number; projectRoles: ProjectMemberRole[] } {
  return { domains: [...policy.domains], maxTtlHours: policy.maxTtlHours, projectRoles: [...policy.projectRoles] };
}
