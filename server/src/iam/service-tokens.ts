/**
 * Service tokens (plans/35 wave 2) - automation identity. The SCIM-token
 * posture exactly (scim/tokens.ts): minted once, shown once, stored only as
 * sha256, revoked by a database write. What differs is who holds one: not an
 * IdP but the org's own automation - CI running `lw export`/`lw apply`, a
 * governance-drift check, an audit poller - which until this existed had to
 * carry a person's session cookie in a secret store.
 *
 * A presented token resolves to a SYNTHETIC principal: `svc_<id>`, the
 * token's role, no groups. RBAC evaluates it exactly like a person (role
 * defaults + grants against `user:svc_<id>`), audit records it exactly like
 * a person, and no second authorization model exists anywhere.
 */
import { randomId, sha256Hex } from '../lib/crypto.ts';
import { ROLES } from '../rbac/evaluate.ts';
import type { ApiTokenRecord } from '../store/types.ts';
import type { UserRecord } from '../store/types.ts';

/** The visible prefix on every service token, so a leaked one is recognizable
 *  in a log or a paste and can be grepped for. */
export const SERVICE_TOKEN_PREFIX = 'lwt_';

/** Roles a token may carry: everything but guest (a guest's whole model is
 *  link-scoped grants, which a bearer header cannot carry). Minting is
 *  owner-gated regardless, so an owner token is an owner's deliberate act. */
export const TOKEN_ROLES: readonly string[] = ROLES.filter((r) => r !== 'guest');

export function mintServiceSecret(): { secret: string; tokenHash: string } {
  const secret = `${SERVICE_TOKEN_PREFIX}${randomId(24)}`;
  return { secret, tokenHash: sha256Hex(secret) };
}

export function hashServiceSecret(secret: string): string {
  return sha256Hex(secret);
}

/** The synthetic principal a live token resolves to. A UserRecord shape so
 *  every existing call site (RBAC, audit, display) works unchanged; the id
 *  prefix keeps it recognizable everywhere it appears. */
export function serviceAccountFor(rec: ApiTokenRecord): UserRecord {
  return {
    id: `svc_${rec.id}`,
    sub: `token:${rec.id}`,
    email: `${rec.label} (service token)`,
    idpGroups: [],
    localGroups: [],
    groups: [],
    role: rec.role,
    sessionEpoch: 0,
    createdAt: rec.createdAt,
    lastSeenAt: rec.lastUsedAt ?? rec.createdAt,
  };
}
