/**
 * RBAC - small fixed role set + fine-grained grants (plans/03).
 *
 * Evaluation is a pure function: deny wins → allow wins → role default.
 * Resources are passed as the set of selector strings the resource satisfies
 * (e.g. ['tool:event-badge', '*']) so the
 * evaluator never needs to look anything up.
 */

export type Effect = 'allow' | 'deny';

export interface Grant {
  /** 'group:<name>' | 'user:<id>' | '*' */
  principal: string;
  action: string;
  /** A resource selector, e.g. 'tool:event-badge', 'destination:archive', '*' (rbac/grant-shape.ts lists which forms each action is checked against). */
  resource: string;
  effect: Effect;
}

export interface PrincipalCtx {
  userId?: string;
  groups: string[];
  role: Role;
}

export const ROLES = ['viewer', 'member', 'author', 'approver', 'brand-manager', 'admin', 'owner', 'guest'] as const;
/** A role only a service token can hold, never a person, and only with scopes
 *  (iam/token-scopes.ts). It carries what the automation scopes need, without the
 *  admin role's wider authority; the scopes then decide which part of it is reachable. */
export const AUTOMATION_ROLE = 'automation';
export type Role = (typeof ROLES)[number] | typeof AUTOMATION_ROLE;

/** Actions each role allows by default (on any resource). Cumulative by construction below. */
const ROLE_ACTIONS: Record<Role, string[]> = (() => {
  // `collab.join` rides with `session.view`, not a level up: a live room's
  // presence lane is structurally unauthorized (plans/100 §7 item 5) and a
  // room's read gate is project visibility, not an edit right - so anyone who
  // can see a session can watch its collab, matching the observers-are-
  // presence-visible rule (plans/14 §6). `collab.edit` is NOT listed here at
  // all - see `mayEditCollab` below for why.
  const viewer = ['catalog.read', 'session.view', 'collab.join', 'comment.view', 'comment.create', 'comment.edit'];
  const member = [
    ...viewer,
    'tool.use',
    'session.create', 'session.edit', 'session.delete', 'session.share',
    'comment.resolve', 'comment.moderate',
    'project.create',
    // Members make their own groups to share with (lolly plan 299 M1); the
    // instance can switch that off (`policy.sharing.customGroups`) or deny it
    // per group with a grant.
    'group.create',
    'export.download', 'export.request',
    // Sending to an organization target is a member workflow once an owner has
    // configured and exposed that fixed target. Per-destination grants/groups
    // can narrow it; personal targets are outside this action entirely.
    'delivery.create',
    'link.create',
  ];
  const author = [...member, 'catalog.submit'];
  const approver = [...member, 'approval.act'];
  // The design system's day-to-day keeper: a member who can also change this
  // instance's colours, publish its brand page and pick its active source, and
  // nothing more. Reached only through an explicit `idp.roleGroups` mapping, so a
  // group that merely happens to be called `brand-manager` gains nothing.
  const brandManager = [...member, 'brand.edit', 'brand.page.publish', 'brand.switch'];
  const admin = [
    ...new Set([...author, ...approver]),
    // `catalog.edit` is org-defined metadata and an instance asset's own
    // descriptive fields (plans/31 section 4). Admin rather than author,
    // because editing what a SERVED asset says is a curation act on the whole
    // org's catalogue, not the contribution right `catalog.submit` carries -
    // and grant-narrowable, so "the brand team files assets, everyone else
    // reads" stays one row.
    // `catalog.collection.manage` is curation of a named, shareable set
    // (plans/31 section 5). Admin by default and grant-narrowable for the same
    // reason `catalog.edit` is: a collection speaks for the whole org's
    // catalogue, and a collection link hands its contents to a bearer with no
    // session, so the right to assemble one is a curation right rather than the
    // contribution right `catalog.submit` carries.
    'catalog.publish', 'catalog.expire', 'catalog.hold', 'catalog.scan', 'catalog.edit',
    'catalog.collection.manage',
    'catalog.provider.read', 'catalog.provider.manage',
    'brand.switch',
    'catalog.injectable.manage',
    // `brand.page.publish` puts files at a public address, even on a gated
    // instance, so it is a curation right and grant-narrowable like the rest.
    'brand.page.publish',
    // `brand.edit` changes the colours every member's work is drawn in, with no
    // redeploy, so it is a curation right and grant-narrowable like the rest.
    'brand.edit',
    'policy.edit', 'grant.edit', 'link.revoke', 'link.create-guest',
    // `fleet.manage` is rename/forget on install registry rows (plans/34 wave
    // 3) - bookkeeping under the enrollment covenant, never a remote action,
    // which is why admin tier suffices and no owner gate applies.
    'message.send', 'telemetry.view', 'fleet.view', 'fleet.manage', 'audit.export',
    'project.manage', 'project.archive', 'approval.assign', 'export.server',
    // `user.invite` (plans/74 W-ID-2) creates and revokes sign-in invitations.
    // Admin tier like group editing, which an invitation's groups amount to;
    // an invitation into a group that maps to the owner role stays owner-only
    // at the route.
    'user.invite',
    // `programme.manage` (plans/82 M1) names partner programmes and sets what
    // each includes: the tool.use grants and collection groups for its group.
    // Admin tier like grant editing, which it amounts to; grantable to a
    // partner or brand team.
    'programme.manage',
  ];
  // Credentials + the enable/disable kill switch stay owner-only: an admin can
  // shape a provider, but only an owner puts a key in or turns it on (plans/17 §6).
  // `catalog.provider.publish` (pushing lolly exports OUT to a destination DAM,
  // plans/27 §10) is owner-grantable too - an outbound write to a third party is
  // an owner's call, though they can grant it per-provider.
  // `scim.manage` mints the bearer an IdP holds to create, disable and re-group
  // people at this instance - an identity-infrastructure credential, so it sits
  // with the other owner-only keys rather than with admin curation (plans/31 §8).
  // `token.manage` (plans/35 wave 2) mints and revokes service tokens - an
  // automation credential is in the same class as a SCIM bearer or a provider
  // key, so it sits with them behind the owner.
  const owner = [...admin, 'instance.config', 'catalog.provider.credential', 'catalog.provider.publish', 'scim.manage', 'token.manage'];
  // Guests get NOTHING by default - their access is entirely link-scoped grants.
  const automation = ['catalog.read', 'tool.use', 'export.server', 'delivery.create', 'audit.export'];
  return { viewer, member, author, approver, 'brand-manager': brandManager, admin, owner, guest: [], automation };
})();

export function roleAllows(role: Role, action: string): boolean {
  return (ROLE_ACTIONS[role] ?? []).includes(action);
}

/** Every action some role carries: the vocabulary the routes check. A grant for
 *  any other action string would never be asked about. */
export function knownActions(): ReadonlySet<string> {
  return KNOWN_ACTIONS;
}
const KNOWN_ACTIONS: ReadonlySet<string> = new Set(Object.values(ROLE_ACTIONS).flat());

/** Map an effective group set to the highest role any group carries (plans/02
 *  §4). Runs on the effective union (idp ∪ local), so a local group named after
 *  a role escalates exactly like an IdP one. Lives here so the store can derive
 *  role on upsert without importing the HTTP app. */
export type RoleGroups = Partial<Record<Exclude<Role, 'guest' | typeof AUTOMATION_ROLE>, string[]>>;
/** The roles a person's groups can give them, highest first: the one order that
 *  decides a person's role, in the store's SQL as much as here. */
export const PERSON_ROLES = ['owner', 'admin', 'brand-manager', 'approver', 'author', 'member', 'viewer'] as const;
/** Roles a group of the same name gives when the role has no mapping. Later roles
 *  need a mapping, so a new role never promotes a group that already exists. */
export const GROUP_NAMED_ROLES: readonly string[] = ['owner', 'admin', 'approver', 'author'];
export function roleFromGroups(groups: string[], mapping: RoleGroups = {}): Role {
  for (const role of PERSON_ROLES) {
    const names = mapping[role] ?? (GROUP_NAMED_ROLES.includes(role) ? [role] : []);
    if (names.some(name => groups.includes(name))) return role;
  }
  return 'member';
}

/**
 * A view as a partner (programmes/view-as.ts) answers as a synthetic member whose id
 * names the real admin (`view-as:<admin id>`), and whose groups carry one marker,
 * `view-as-viewer:<admin id>`. A view never shows the admin anything they could not
 * see themselves: the admin's own explicit denies apply to that member here, the
 * admin's tool visibility in policy/overlay.ts and the admin's own feed in
 * catalog/served-index.ts. view-as.ts records the admin on every request it admits.
 */
export const VIEW_AS_VIEWER_PREFIX = 'view-as-viewer:';
export interface ViewAsViewer { userId: string; groups: string[]; role: Role }
const viewers = new Map<string, ViewAsViewer>();
export function setViewAsViewer(subjectId: string, viewer: ViewAsViewer): void {
  viewers.set(subjectId, { userId: viewer.userId, groups: [...viewer.groups], role: viewer.role });
}
/** The admin behind a view's subject id, or undefined for anyone else. */
export function viewAsViewerOf(userId: string | undefined): ViewAsViewer | undefined {
  return userId ? viewers.get(userId) : undefined;
}
/** The admin behind a view, from the marker in its groups, or undefined. */
export function viewAsViewerForGroups(groups: readonly string[]): ViewAsViewer | undefined {
  const marker = groups.find((g) => g.startsWith(VIEW_AS_VIEWER_PREFIX));
  return marker ? viewers.get(`view-as:${marker.slice(VIEW_AS_VIEWER_PREFIX.length)}`) : undefined;
}

function principalMatches(selector: string, ctx: Pick<PrincipalCtx, 'userId' | 'groups'>): boolean {
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
  ctx: Pick<PrincipalCtx, 'userId' | 'groups'>,
  action: string,
  resourceSelectors: string[],
  grants: Grant[],
): 'allow' | 'deny' | 'none' {
  let allowed = false;
  const viewer = viewAsViewerOf(ctx.userId);
  for (const g of grants) {
    if (g.action !== action) continue;
    if (g.resource !== '*' && !resourceSelectors.includes(g.resource)) continue;
    const own = principalMatches(g.principal, ctx);
    if (g.effect === 'deny' && (own || (viewer !== undefined && principalMatches(g.principal, viewer)))) return 'deny';
    if (!own) continue;
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
 * Whether `ctx` may WRITE in a live collab room - deliberately `session.edit`
 * itself, not a parallel `collab.edit` action with its own role/grant
 * bindings (plans/14 §6, OSS plans/100 §7 item 7). A writer seat in a room
 * IS edit access to the session it holds; giving it a second action name
 * would let a `session.edit` grant and a `collab.edit` grant drift apart - 
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
 * call - routing both through here is what makes the two structurally unable
 * to disagree, rather than merely unlikely to.
 */
export function mayEditCollab(ctx: PrincipalCtx, grants: Grant[]): boolean {
  return evaluate(ctx, 'session.edit', ['*'], grants);
}

/**
 * Whether `ctx` could act on some approval: `approval.act` from the role, or an allow
 * grant on any resource. A reviewer's grant is usually scoped, for example to
 * `chain:brand-review`, so asking about `*` alone would miss the person it was written for.
 *
 * This only tells the shell that reviewing can apply to this person. It gives no right to
 * act: each approvals route still decides on its own request and, for acting, on the
 * step's approver groups.
 */
export function mayActOnSomeApproval(ctx: PrincipalCtx, grants: Grant[]): boolean {
  if (evaluate(ctx, 'approval.act', ['*'], grants)) return true;
  return grants.some(grant => grant.action === 'approval.act' && grant.effect === 'allow'
    && evaluate(ctx, 'approval.act', [grant.resource, '*'], grants));
}

/**
 * Whether `ctx` may be in a live collab room at all - `collab.join`, which
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
 * actually opens cannot disagree - the bit is not decoration.
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
 * Whether `ctx` may hand a guest-edit link to somebody outside the org - 
 * `link.create-guest`, over the selectors the link's own target satisfies
 * (`links/sign.ts` `linkResourceSelectors`).
 *
 * A named helper for the same reason `mayEditCollab` and `mayJoinCollab` are:
 * the ws gateway must not import bare `evaluate` (`tests/collab/permissions.test.ts`
 * asserts its import list structurally), and this decision now has TWO enforcement
 * points that must agree - the mint (`POST /api/v1/links`) and the gateway's
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
 * grants created or deleted ONLY by an owner - otherwise an admin with
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
