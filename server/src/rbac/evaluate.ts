/**
 * RBAC — small fixed role set + fine-grained grants (plans/03).
 *
 * Evaluation is a pure function: deny wins → allow wins → role default.
 * Resources are passed as the set of selector strings the resource satisfies
 * (e.g. ['tool:event-badge', 'tool:tag/external-facing', '*']) so the
 * evaluator never needs to look anything up.
 */

export type Effect = 'allow' | 'deny';

export interface Grant {
  /** 'group:<name>' | 'user:<id>' | '*' */
  principal: string;
  action: string;
  /** A resource selector, e.g. 'tool:event-badge', 'catalog:tag/x', '*' */
  resource: string;
  effect: Effect;
}

export interface PrincipalCtx {
  userId?: string;
  groups: string[];
  role: Role;
}

export const ROLES = ['viewer', 'member', 'author', 'approver', 'admin', 'owner', 'guest'] as const;
export type Role = (typeof ROLES)[number];

/** Actions each role allows by default (on any resource). Cumulative by construction below. */
const ROLE_ACTIONS: Record<Role, string[]> = (() => {
  // `collab.join` rides with `session.view`, not a level up: a live room's
  // presence lane is structurally unauthorized (plans/100 §7 item 5) and a
  // room's read gate is project visibility, not an edit right — so anyone who
  // can see a session can watch its collab, matching the observers-are-
  // presence-visible rule (plans/14 §6). `collab.edit` is NOT listed here at
  // all — see `mayEditCollab` below for why.
  const viewer = ['catalog.read', 'session.view', 'collab.join'];
  const member = [
    ...viewer,
    'tool.use',
    'session.create', 'session.edit', 'session.delete', 'session.share',
    'project.create',
    'export.download', 'export.request',
    'link.create',
  ];
  const author = [...member, 'catalog.submit'];
  const approver = [...member, 'approval.act'];
  const admin = [
    ...new Set([...author, ...approver]),
    'catalog.publish', 'catalog.expire', 'catalog.hold', 'catalog.scan',
    'catalog.provider.read', 'catalog.provider.manage',
    'brand.switch',
    'catalog.injectable.manage',
    'policy.edit', 'grant.edit', 'link.revoke', 'link.create-guest',
    'message.send', 'telemetry.view', 'fleet.view', 'audit.export',
    'project.manage', 'project.archive', 'approval.assign', 'export.server',
  ];
  // Credentials + the enable/disable kill switch stay owner-only: an admin can
  // shape a provider, but only an owner puts a key in or turns it on (plans/17 §6).
  // `catalog.provider.publish` (pushing lolly exports OUT to a destination DAM,
  // plans/27 §10) is owner-grantable too — an outbound write to a third party is
  // an owner's call, though they can grant it per-provider.
  const owner = [...admin, 'instance.config', 'catalog.provider.credential', 'catalog.provider.publish'];
  // Guests get NOTHING by default — their access is entirely link-scoped grants.
  return { viewer, member, author, approver, admin, owner, guest: [] };
})();

export function roleAllows(role: Role, action: string): boolean {
  return (ROLE_ACTIONS[role] ?? []).includes(action);
}

/** Map an effective group set to the highest role any group carries (plans/02
 *  §4). Runs on the effective union (idp ∪ local), so a local group named after
 *  a role escalates exactly like an IdP one. Lives here so the store can derive
 *  role on upsert without importing the HTTP app. */
export function roleFromGroups(groups: string[]): Role {
  for (const role of ['owner', 'admin', 'approver', 'author'] as const) {
    if (groups.includes(role)) return role;
  }
  return 'member';
}

function principalMatches(selector: string, ctx: PrincipalCtx): boolean {
  if (selector === '*') return true;
  if (selector.startsWith('group:')) return ctx.groups.includes(selector.slice(6));
  if (selector.startsWith('user:')) return ctx.userId === selector.slice(5);
  return false;
}

/**
 * The EXPLICIT grant decision for `ctx`/`action`/`resource`, ignoring role
 * defaults: any matching deny → 'deny'; else any matching allow → 'allow';
 * else 'none'. Callers that must distinguish "an explicit allow grant" from
 * "the role happens to allow this" (e.g. org-config tool visibility, where the
 * role default 'tool.use' would otherwise un-hide every governed tool) use this
 * instead of evaluate().
 */
export function grantDecision(
  ctx: PrincipalCtx,
  action: string,
  resourceSelectors: string[],
  grants: Grant[],
): 'allow' | 'deny' | 'none' {
  let allowed = false;
  for (const g of grants) {
    if (g.action !== action) continue;
    if (!principalMatches(g.principal, ctx)) continue;
    if (g.resource !== '*' && !resourceSelectors.includes(g.resource)) continue;
    if (g.effect === 'deny') return 'deny';
    allowed = true;
  }
  return allowed ? 'allow' : 'none';
}

/**
 * Decide whether `ctx` may perform `action` on a resource satisfying
 * `resourceSelectors`. Grants with a non-matching principal/action/resource
 * are ignored; any matching deny refuses; else any matching allow permits;
 * else the role default answers.
 */
export function evaluate(
  ctx: PrincipalCtx,
  action: string,
  resourceSelectors: string[],
  grants: Grant[],
): boolean {
  const decision = grantDecision(ctx, action, resourceSelectors, grants);
  if (decision === 'deny') return false;
  return decision === 'allow' || roleAllows(ctx.role, action);
}

/**
 * Whether `ctx` may WRITE in a live collab room — deliberately `session.edit`
 * itself, not a parallel `collab.edit` action with its own role/grant
 * bindings (plans/14 §6, OSS plans/100 §7 item 7). A writer seat in a room
 * IS edit access to the session it holds; giving it a second action name
 * would let a `session.edit` grant and a `collab.edit` grant drift apart —
 * an admin could deny one and forget the other, and the room would then
 * disagree with the org-config bit that told the shell it could join
 * writable.
 *
 * This is the ONE function both surfaces call for that decision:
 *   - the gateway's per-connection writer/observer split
 *     (`server/src/collab/gateway.ts`, `admit()` and the re-check in
 *     `authorizeOps()`), and
 *   - the org-config `can['collab.edit']` bit
 *     (`server/src/policy/org-config.ts`) that lets the shell show an
 *     honest "Start a collab" affordance before a socket ever opens.
 * Neither may re-derive the answer with its own `evaluate(…, 'session.edit', …)`
 * call — routing both through here is what makes the two structurally unable
 * to disagree, rather than merely unlikely to.
 */
export function mayEditCollab(ctx: PrincipalCtx, grants: Grant[]): boolean {
  return evaluate(ctx, 'session.edit', ['*'], grants);
}

/**
 * Whether `ctx` may be in a live collab room at all — `collab.join`, which
 * UNLIKE `collab.edit` is a real action with its own row in the role table and
 * its own grants (see `ROLE_ACTIONS` above, and `tests/collab/permissions.test.ts`
 * 'unlike collab.edit, collab.join DOES read its own grants').
 *
 * It exists as a named helper for the same reason `mayEditCollab` does: the ws
 * gateway must not import bare `evaluate` (that is how the writer decision got
 * re-derived once already, and `tests/collab/permissions.test.ts` asserts the
 * import list structurally). The expression is byte-identical to the one
 * `policy/org-config.ts`'s generic `CLIENT_ACTIONS` loop produces for this
 * action, so the advertised `can['collab.join']` bit and the socket that
 * actually opens cannot disagree — the bit is not decoration.
 *
 * Enforced in THREE places, all of which must agree: the upgrade
 * (`collab/gateway.ts` `admit`), every subsequent gesture (`authorizeOps`, so a
 * revocation lands on the next op rather than the next reconnect), and the
 * invite surface (`collab/invites.ts` `mayJoinSession`, so an invite can never
 * name someone the gateway would refuse).
 */
export function mayJoinCollab(ctx: PrincipalCtx, grants: Grant[]): boolean {
  return evaluate(ctx, 'collab.join', ['*'], grants);
}

/**
 * Whether `ctx` may hand a guest-edit link to somebody outside the org —
 * `link.create-guest`, over the selectors the link's own target satisfies
 * (`links/sign.ts` `linkResourceSelectors`).
 *
 * A named helper for the same reason `mayEditCollab` and `mayJoinCollab` are:
 * the ws gateway must not import bare `evaluate` (`tests/collab/permissions.test.ts`
 * asserts its import list structurally), and this decision now has TWO enforcement
 * points that must agree — the mint (`POST /api/v1/links`) and the gateway's
 * per-gesture re-check of the inviter's standing (plans/02 §8's second revocation
 * lever: "the inviter losing `link.create-guest` kills all its live guest sessions
 * immediately"). Revoking the action from a group therefore stops future minting
 * AND evicts the guests already holding links, which is what makes the operator's
 * one lever cover the links they cannot enumerate.
 *
 * `selectors` is threaded rather than defaulted to `['*']` on purpose: a
 * tool-scoped grant would otherwise read as "no grant" on the re-check and evict
 * a guest the mint route had just allowed.
 */
export function mayCreateGuestLinks(ctx: PrincipalCtx, selectors: string[], grants: Grant[]): boolean {
  return evaluate(ctx, 'link.create-guest', selectors, grants);
}

/**
 * Escalation guard for the grants editor: an action only the owner role holds
 * by default (instance.config, catalog.provider.credential, …) may have its
 * grants created or deleted ONLY by an owner — otherwise an admin with
 * grant.edit could mint themselves owner powers.
 */
export function ownerOnlyAction(action: string): boolean {
  return roleAllows('owner', action) && !roleAllows('admin', action);
}

/** Machine-readable denial reason for honest client UI (plans/03 §7). */
export function denialCode(action: string): string {
  if (action === 'export.download') return 'EXPORT_REQUIRES_APPROVAL';
  return 'FORBIDDEN';
}
