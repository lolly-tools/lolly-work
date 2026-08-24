/**
 * SCIM 2.0 resource mapping (plans/31 §8) - the pure translation between SCIM
 * JSON and this instance's user + local-group model. No store, no HTTP, so the
 * routes and the tests fold the same rules.
 *
 * The mapping is deliberately thin because the model already fits:
 *  - a SCIM User IS a `UserRecord`. Its `id` is our user id; its `externalId`
 *    is `sub` (the IdP subject OIDC login also keys on, so provisioning and
 *    sign-in resolve to one row); `userName` is the email; `active` is the
 *    inverse of `disabledAt`.
 *  - a SCIM Group IS a local group. Its `id` and `displayName` are the group
 *    name; its `members` are the users carrying it in `localGroups`. Membership
 *    is stored per-USER here (localGroups), so a group PATCH becomes a set of
 *    per-user edits - `applyMemberOps` computes the target set the route diffs.
 *
 * Only the subset plans/31 §8 names is modelled: Users create/patch (the
 * `active=false` deprovision is the one that earns the wave) and Group
 * membership. Passwords, bulk, sort and ETags are declared unsupported in the
 * ServiceProviderConfig the routes serve.
 */
import { displayName } from '../iam/member.ts';
import type { UserRecord } from '../store/types.ts';

export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** SCIM `active` arrives as a boolean or, from some IdPs, the string
 *  "true"/"false" (any case). Anything else is not a decision, so it reads as
 *  null and the caller leaves the flag alone. */
export function toBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

// ── serialization ────────────────────────────────────────────────────────────

/** A `UserRecord` as a SCIM User resource. `groups` is read-only per the spec -
 *  membership is written through Groups, never here. */
export function userToScim(u: UserRecord, baseUrl: string): Record<string, unknown> {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(u.sub ? { externalId: u.sub } : {}),
    userName: u.email,
    name: { givenName: u.firstname ?? '', familyName: u.lastname ?? '' },
    displayName: displayName(u),
    emails: [{ value: u.email, primary: true }],
    active: !u.disabledAt,
    groups: u.groups.map((g) => ({ value: g, display: g })),
    meta: {
      resourceType: 'User',
      location: `${baseUrl}/scim/v2/Users/${encodeURIComponent(u.id)}`,
      created: u.createdAt,
      lastModified: u.lastSeenAt,
    },
  };
}

/** A local group as a SCIM Group resource. `id` and `displayName` are the group
 *  name (stable and unique); members carry each user's id + display name. */
export function groupToScim(
  name: string, members: Array<{ id: string; display: string }>, baseUrl: string,
): Record<string, unknown> {
  return {
    schemas: [GROUP_SCHEMA],
    id: name,
    displayName: name,
    members: members.map((m) => ({ value: m.id, display: m.display, $ref: `${baseUrl}/scim/v2/Users/${encodeURIComponent(m.id)}` })),
    meta: { resourceType: 'Group', location: `${baseUrl}/scim/v2/Groups/${encodeURIComponent(name)}` },
  };
}

export function scimList(resources: Array<Record<string, unknown>>, total = resources.length, startIndex = 1): Record<string, unknown> {
  return {
    schemas: [LIST_SCHEMA],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export function scimErrorBody(status: number, detail: string, scimType?: string): Record<string, unknown> {
  return { schemas: [ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) };
}

// ── parsing: user create / replace ────────────────────────────────────────────

export interface UserFields {
  /** The IdP subject: externalId when given, else userName. Becomes `sub`. */
  sub: string;
  email: string;
  firstname?: string;
  lastname?: string;
  active: boolean;
}

/** Parse a POST /Users (or PUT replace) body into the fields we store. userName
 *  is required; externalId is preferred as the durable subject and falls back to
 *  userName so an IdP that omits it still provisions. */
export function parseUserCreate(body: unknown): UserFields | { error: string } {
  if (!isObj(body)) return { error: 'body must be a SCIM User' };
  const userName = str(body.userName).trim();
  if (!userName) return { error: 'userName is required' };
  const externalId = str(body.externalId).trim();
  const name = isObj(body.name) ? body.name : {};
  const active = body.active === undefined ? true : toBool(body.active);
  if (active === null) return { error: 'active must be a boolean' };
  const firstname = str(name.givenName).trim();
  const lastname = str(name.familyName).trim();
  return {
    sub: externalId || userName,
    email: userName,
    ...(firstname ? { firstname } : {}),
    ...(lastname ? { lastname } : {}),
    active,
  };
}

// ── parsing: user PATCH ───────────────────────────────────────────────────────

export interface UserPatch {
  active?: boolean;
  firstname?: string;
  lastname?: string;
  email?: string;
}

/**
 * Parse a SCIM PatchOp for a User into the changes we apply. Handles both the
 * path-addressed form (`{op:'replace', path:'active', value:false}`) and the
 * value-object form (`{op:'replace', value:{active:false}}`) that different
 * IdPs send, and the string-boolean `active` Azure emits. Unknown attributes
 * are ignored rather than refused, so an IdP that also pushes `displayName` or
 * `title` does not get a 400 for the parts we do not model.
 */
export function parseUserPatch(body: unknown): UserPatch | { error: string } {
  if (!isObj(body) || !Array.isArray(body.Operations)) return { error: 'a PatchOp needs an Operations array' };
  const out: UserPatch = {};
  const setPath = (path: string, value: unknown): string | null => {
    const p = path.toLowerCase();
    if (p === 'active') {
      const b = toBool(value);
      if (b === null) return 'active must be a boolean';
      out.active = b;
    } else if (p === 'name.givenname') out.firstname = str(value).trim();
    else if (p === 'name.familyname') out.lastname = str(value).trim();
    else if (p === 'username') out.email = str(value).trim();
    // Anything else is a modelled-nowhere attribute: ignore it.
    return null;
  };
  for (const raw of body.Operations) {
    if (!isObj(raw)) continue;
    const op = str(raw.op).toLowerCase();
    if (op !== 'replace' && op !== 'add') continue; // remove of active/name is not meaningful
    const path = str(raw.path).trim();
    if (path) {
      const err = setPath(path, raw.value);
      if (err) return { error: err };
    } else if (isObj(raw.value)) {
      // No path: the value object names the attributes. Support both nested
      // (`name.givenName`) and flattened (`"name.givenName"`) key forms.
      const v = raw.value;
      if (v.active !== undefined) { const err = setPath('active', v.active); if (err) return { error: err }; }
      if (v.userName !== undefined) out.email = str(v.userName).trim();
      const nested = isObj(v.name) ? v.name : {};
      const given = v['name.givenName'] ?? nested.givenName;
      const family = v['name.familyName'] ?? nested.familyName;
      if (given !== undefined) out.firstname = str(given).trim();
      if (family !== undefined) out.lastname = str(family).trim();
    }
  }
  return out;
}

// ── parsing: group membership PATCH ───────────────────────────────────────────

export type MemberOp =
  | { op: 'add'; ids: string[] }
  | { op: 'remove'; ids: string[] }
  /** remove with no value / bare `members` path: clear the whole membership. */
  | { op: 'removeAll' }
  | { op: 'replace'; ids: string[] };

const MEMBER_FILTER = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i;

const memberIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((m) => (isObj(m) ? str(m.value).trim() : str(m).trim()))
    .filter(Boolean);
};

/** Parse a SCIM Group PatchOp into an ordered list of membership operations.
 *  Non-member operations (a displayName rename, say) are ignored - this wave is
 *  membership only. */
export function parseGroupPatch(body: unknown): { ops: MemberOp[] } | { error: string } {
  if (!isObj(body) || !Array.isArray(body.Operations)) return { error: 'a PatchOp needs an Operations array' };
  const ops: MemberOp[] = [];
  for (const raw of body.Operations) {
    if (!isObj(raw)) continue;
    const op = str(raw.op).toLowerCase();
    const path = str(raw.path).trim();
    const filter = MEMBER_FILTER.exec(path);
    if (filter) {
      // `members[value eq "X"]` - Okta's remove-one form (and, rarely, add-one).
      const id = filter[1] as string;
      if (op === 'remove') ops.push({ op: 'remove', ids: [id] });
      else if (op === 'add' || op === 'replace') ops.push({ op: 'add', ids: [id] });
      continue;
    }
    if (path.toLowerCase() !== 'members' && path !== '') continue; // not a membership op
    const ids = memberIds(raw.value);
    if (op === 'add') ops.push({ op: 'add', ids });
    else if (op === 'replace') ops.push({ op: 'replace', ids });
    else if (op === 'remove') ops.push(ids.length ? { op: 'remove', ids } : { op: 'removeAll' });
  }
  return { ops };
}

/** Fold a list of membership operations over the current member id set, in
 *  order, into the target set. Pure, so the route can diff target vs current
 *  and write only the users that actually changed. */
export function applyMemberOps(current: string[], ops: MemberOp[]): string[] {
  let set = new Set(current);
  for (const op of ops) {
    if (op.op === 'add') for (const id of op.ids) set.add(id);
    else if (op.op === 'remove') for (const id of op.ids) set.delete(id);
    else if (op.op === 'removeAll') set = new Set();
    else if (op.op === 'replace') set = new Set(op.ids);
  }
  return [...set];
}

// ── parsing: filter (existence checks before create) ──────────────────────────

/** The one filter shape IdPs send before a create: `userName eq "x"` or
 *  `externalId eq "x"`. Anything else returns null and the route lists all (the
 *  spec allows ignoring an unsupported filter, and the sets here are small). */
export function parseScimFilter(filter: string | null | undefined): { attr: 'userName' | 'externalId'; value: string } | null {
  if (!filter) return null;
  const m = /^\s*(userName|externalId)\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
  if (!m) return null;
  const attr = (m[1] as string).toLowerCase() === 'username' ? 'userName' : 'externalId';
  return { attr, value: m[2] as string };
}
