/**
 * Service tokens (plans/35 wave 2) - automation identity. The SCIM-token
 * posture exactly (scim/tokens.ts): minted once, shown once, stored only as
 * sha256, revoked by a database write. What differs is who holds one: not an
 * IdP but the org's own automation - CI running `lw export`/`lw apply`, a
 * governance-drift check, an audit poller - which until this existed had to
 * carry a person's session cookie in a secret store.
 *
 * A presented token resolves to a SYNTHETIC principal: `svc_<id>`, the
 * token's role and no groups, unless an owner placed it in a partner programme
 * (plans/82 M3), when it carries that programme's group, optionally one
 * company's group and the partner marker. RBAC evaluates it exactly like a
 * person (role defaults + grants against `user:svc_<id>`), audit records it
 * exactly like a person, partner scope reads its groups exactly like a
 * person's, and no second authorization model exists anywhere.
 */
import { randomId, sha256Hex } from '../lib/crypto.ts';
import type { ApiTokenRecord } from '../store/types.ts';
import type { UserRecord } from '../store/types.ts';
import {
  COMPANY_GROUP_PREFIX, PARTNER_GROUP, PROGRAMME_GROUP_PREFIX, isCompanyGroup, isProgrammeGroup, programmeGroup,
} from '../programmes/types.ts';

/** The visible prefix on every service token, so a leaked one is recognizable
 *  in a log or a paste and can be grepped for. */
export const SERVICE_TOKEN_PREFIX = 'lwt_';

export function mintServiceSecret(): { secret: string; tokenHash: string } {
  const secret = `${SERVICE_TOKEN_PREFIX}${randomId(24)}`;
  return { secret, tokenHash: sha256Hex(secret) };
}

export function hashServiceSecret(secret: string): string {
  return sha256Hex(secret);
}

/** The synthetic principal a live token resolves to. A UserRecord shape so
 *  every existing call site (RBAC, audit, display) works unchanged; the id
 *  prefix keeps it recognizable everywhere it appears. A scoped token also carries
 *  its limits, which the tool checks in automation/effective-contract.ts read. */
export function serviceAccountFor(rec: ApiTokenRecord): UserRecord & { tokenScopes?: readonly string[]; tokenTools?: readonly string[] } {
  return {
    ...(rec.scopes ? { tokenScopes: rec.scopes } : {}),
    ...(rec.tools ? { tokenTools: rec.tools } : {}),
    id: `svc_${rec.id}`,
    sub: `token:${rec.id}`,
    email: `${rec.label} (service token)`,
    idpGroups: [],
    localGroups: [...(rec.groups ?? [])],
    groups: [...(rec.groups ?? [])],
    role: rec.role,
    sessionEpoch: 0,
    createdAt: rec.createdAt,
    lastSeenAt: rec.lastUsedAt ?? rec.createdAt,
  };
}

/**
 * The groups a token placed in a partner programme carries (plans/82 M3): the
 * programme's group, the company's group when it names one, and the partner
 * marker. The marker is what keeps a token that leaves its programme scoped to
 * the essentials, the way it keeps a person who leaves: a token a partner held
 * never becomes an internal one by losing a group.
 */
export function programmeTokenGroups(programmeId: string, companyId?: string): string[] {
  return [programmeGroup(programmeId), ...(companyId ? [`${COMPANY_GROUP_PREFIX}${companyId}`] : []), PARTNER_GROUP];
}

/** A token's programme and company ids, read back from its groups. */
export function tokenPlacement(rec: Pick<ApiTokenRecord, 'groups'>): { programmeId?: string; companyId?: string; partner: boolean } {
  const groups = rec.groups ?? [];
  const programme = groups.find(isProgrammeGroup);
  const company = groups.find(isCompanyGroup);
  return {
    ...(programme ? { programmeId: programme.slice(PROGRAMME_GROUP_PREFIX.length) } : {}),
    ...(company ? { companyId: company.slice(COMPANY_GROUP_PREFIX.length) } : {}),
    partner: groups.includes(PARTNER_GROUP) || !!programme,
  };
}

/** A token's groups without the ones named: what a company or programme delete
 *  leaves. The partner marker always stays. */
export function tokenGroupsWithout(rec: Pick<ApiTokenRecord, 'groups'>, drop: ReadonlySet<string>): string[] | undefined {
  if (!rec.groups) return undefined;
  const next = rec.groups.filter((g) => !drop.has(g));
  return next.includes(PARTNER_GROUP) ? next : [...next, PARTNER_GROUP];
}
