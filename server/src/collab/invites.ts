// SPDX-License-Identifier: LicenseRef-Lolly-Work-Proprietary
/**
 * Live-collab invites - who may be invited, and the inbox message that invites
 * them (OSS plans/100 §7 item 9, lolly-work plans/14 §6).
 *
 * TWO RULES LIVE HERE, both pure so the HTTP routes stay thin and the tests can
 * hit them without a server:
 *
 * 1. **Eligibility is the gateway's join gate, minus the admin bypass.** The
 *    invite autocomplete is the approvals `GET /api/v1/approvals/approvers`
 *    precedent one surface over: it reveals only people who could ALREADY reach
 *    the thing (there: an approver designated for that chain step; here: a
 *    member the ws gateway would admit to that session's room), never the wider
 *    directory. A member with no visibility of the project is not "an invite
 *    away" from the room - inviting them would mint a join that `admit()`
 *    refuses at the socket, which is precisely what plans/100 §7 item 9 forbids
 *    ("an invite can never mint a broken join"; widening access is a share-grant
 *    flow first).
 *
 *    The rule is therefore expressed as `mayJoinSession`, over the same shared
 *    predicates the gateway gates on - `isProjectMember` + `mayJoinCollab` - plus
 *    the per-USER half the gateway gets for free from `resolveMember` (a disabled
 *    account authenticates as nobody, so it can never join, so it must never be
 *    offered). There is no second copy of project visibility here.
 *
 *    **`isProjectMember`, deliberately, not `canSeeProject`.** The approver
 *    precedent's discipline is not "show whoever could reach it" - it is that the
 *    revealed set is ADMIN-AUTHORED (a chain step's approver groups). Here the
 *    project is caller-authored, and `canSeeProject` is true for every admin and
 *    owner on every project, so eligibility over it hands any member a directory
 *    of the instance's privileged accounts: mint a project (private, or shared to
 *    a group nobody holds), create a session, open the autocomplete, and the only
 *    rows are the admins - ids and display names that `GET /api/v1/users` refuses
 *    a member outright. Membership-based eligibility keeps the set the caller's
 *    own team: an admin who is genuinely in the project's group is offered like
 *    anybody else; one who is merely an admin is not offered, and cannot be
 *    invited by guessing either - the POST validates the SAME predicate, so a
 *    201-vs-400 probe cannot answer the question the search refuses to.
 *
 *    Admins lose nothing by this: they can already open any room the gateway
 *    governs. What they stop being is a discovery surface.
 *
 * 2. **The invite is a message, not a new delivery mechanism.** It rides
 *    `store.putMessage` with `audience.users = [invitee]` - the same per-user
 *    targeting approvals already use for nominees (plans/10 §2). `inviteMessageId`
 *    is DERIVED from `(session, invitee)` rather than random, which is the whole
 *    of the idempotence story: `putMessage` is an upsert by id in both drivers,
 *    so re-inviting the same person to the same session rewrites one row instead
 *    of stacking a second notification.
 *
 * NOTHING HERE READS THE STORE. The routes fetch and pass records in, so both
 * rules are testable as data → data, and neither can quietly grow a query.
 */
import { sha256Hex } from '../lib/crypto.ts';
import { displayName } from '../iam/member.ts';
import { isProjectMember } from '../rbac/project-access.ts';
import { mayJoinCollab, type Grant, type Role } from '../rbac/evaluate.ts';
import type { Message } from '../inbox/target.ts';
import type { ProjectRecord, SessionRecord, UserRecord } from '../store/types.ts';

/** Rows one autocomplete response may carry. The approver search is unbounded
 *  because a chain step's approver groups are small by construction; "everyone
 *  who can see this project" is not, so this one is capped. A prefix is how you
 *  find the 21st person, not a longer page. */
export const INVITEE_LIMIT = 20;

/** Longest `q` considered. Beyond this nothing can match a real display name,
 *  and the cap keeps an untrusted query from driving per-user work. */
export const MAX_QUERY_CHARS = 64;

/** What the autocomplete returns per person: an id to invite and a name to show.
 *  No email - matching the approver search's disclosure exactly. Being invitable
 *  is not a reason to hand a colleague's address to whoever typed two letters. */
export interface Invitee {
  id: string;
  name: string;
}

/**
 * The per-user half of the ws gateway's room-join gate (`gateway.ts` `admit`),
 * for a session whose project has already been resolved.
 *
 * The session-level half - the session exists and is not tombstoned - is a
 * property of the request, not of the candidate, so the route checks it once
 * rather than once per user.
 *
 * `grants` is passed in rather than read, like everything else here. It is what
 * makes `collab.join` real on this surface too: an operator who denies the
 * action to a group has switched rooms off for them, and offering them an invite
 * would be offering a door the gateway now refuses (`admit` gate 3).
 */
export function mayJoinSession(user: UserRecord, project: ProjectRecord, grants: Grant[]): boolean {
  if (user.disabledAt) return false; // resolveMember refuses the cookie outright
  // The admin/owner bypass is excluded ON PURPOSE - see rule 1 in this file's
  // header, and `isProjectMember`'s own note.
  if (!isProjectMember(user, project)) return false;
  return mayJoinCollab({ userId: user.id, groups: user.groups, role: user.role as Role }, grants);
}

/**
 * Autocomplete matching: case-insensitive prefix on the display name OR on any
 * word within it, so "eng" finds "Alice Eng" and "al" finds "Alice Eng".
 *
 * Deliberately NOT a substring search. A substring match over a name turns an
 * eligible-principals list into a directory probe - type "a" and enumerate; the
 * prefix rule means a caller has to already know roughly who they are looking
 * for, which is what an invite box is for. An empty query matches everything:
 * the box opens with the (capped) list of people who could join.
 */
export function matchesQuery(name: string, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = name.toLowerCase();
  if (hay.startsWith(needle)) return true;
  return hay.split(/\s+/).some((word) => word.startsWith(needle));
}

/** Trim + bound an untrusted `q` into what `matchesQuery` should see. */
export function normalizeQuery(raw: string | null | undefined): string {
  return (raw ?? '').trim().slice(0, MAX_QUERY_CHARS);
}

/**
 * The eligible principals for one session's room, filtered by `q`, capped, and
 * sorted by display name so the same query gives the same page.
 *
 * `truncated` reports that the cap bit - the client shows "keep typing" rather
 * than pretending it saw everyone.
 */
export function eligibleInvitees(opts: {
  users: UserRecord[];
  project: ProjectRecord;
  /** The instance's grants - `mayJoinSession` needs them for `collab.join`. */
  grants: Grant[];
  /** Excluded from the results: you are already in the room you are inviting to. */
  callerId: string;
  q?: string;
  limit?: number;
}): { invitees: Invitee[]; truncated: boolean } {
  const q = normalizeQuery(opts.q);
  const limit = Math.max(1, Math.min(opts.limit ?? INVITEE_LIMIT, INVITEE_LIMIT));
  const matched = opts.users
    .filter((u) => u.id !== opts.callerId && mayJoinSession(u, opts.project, opts.grants))
    .map((u) => ({ id: u.id, name: displayName(u) }))
    .filter((row) => matchesQuery(row.name, q))
    .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1
      : a.name.toLowerCase() > b.name.toLowerCase() ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { invitees: matched.slice(0, limit), truncated: matched.length > limit };
}

/**
 * The stable message id for "X is invited to session S".
 *
 * Hashed rather than concatenated so the id is fixed-width whatever the two ids
 * are, and carries no structure a reader is tempted to parse. What matters is
 * only that it is a pure function of the pair: `putMessage` upserts by id in
 * BOTH drivers (memory replaces the map entry, postgres `on conflict (id) do
 * update`), so a second invite to the same person for the same session refreshes
 * the pending one - one inbox row, with the latest inviter and label on it.
 */
export function inviteMessageId(sessionId: string, inviteeId: string): string {
  return `msg_collab_${sha256Hex(`${sessionId} ${inviteeId}`).slice(0, 24)}`;
}

/** Longest session label / composed title the invite copy may carry. `meta` is
 *  client-supplied and `PUT /api/v1/sessions/:id` caps nothing inside it, so a
 *  megabyte label would otherwise become a megabyte inbox title. The console's
 *  own message route slices titles to 200 for the same reason. */
export const MAX_LABEL_CHARS = 120;
export const MAX_TITLE_CHARS = 200;

/** A session's human label for the invite copy, falling back to the tool id - 
 *  the same `meta.label` the projects/sessions routes surface, bounded. */
export function sessionLabel(session: SessionRecord): string {
  const label = session.meta?.['label'];
  return typeof label === 'string' && label.trim()
    ? label.trim().slice(0, MAX_LABEL_CHARS)
    : session.toolId;
}

/**
 * Build the invite message.
 *
 * `data` carries the machine-readable payload and `cta.url` the human one. The
 * split is deliberate: there is no shell route today that opens a team session
 * by id (the Projects view resolves the session and rewrites the hash to
 * `#/tool/<toolId>?…`), so the SERVER must not pretend to know the deep link.
 * `cta.url` therefore reuses the one session-deep-link shape the product already
 * has - the console's `/t/<toolId>?session=<id>` (console/app.js `actSessionObj`)
 * - and `data.sessionId` is what a collab-aware shell actually joins on, exactly
 * as plans/100 §7 item 9 asks. `toolId`/`toolVersion` ride along so the shell can
 * start loading the tool while the ws handshake completes (§7 item 11).
 */
export function buildInviteMessage(opts: {
  sessionId: string;
  projectId: string;
  toolId: string;
  toolVersion: string;
  inviteeId: string;
  inviterName: string;
  label: string;
  /** Base URL of the Lolly app: '' when it is served same-origin. */
  appBase: string;
}): Message {
  const joinPath = `${opts.appBase}/t/${encodeURIComponent(opts.toolId)}?session=${encodeURIComponent(opts.sessionId)}`;
  return {
    id: inviteMessageId(opts.sessionId, opts.inviteeId),
    kind: 'collab',
    severity: 'action',
    audience: { users: [opts.inviteeId] },
    title: `${opts.inviterName} invited you to edit ${opts.label} together`.slice(0, MAX_TITLE_CHARS),
    cta: { label: 'Open', url: joinPath },
    data: {
      kind: 'collab-invite',
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      toolId: opts.toolId,
      toolVersion: opts.toolVersion,
    },
    dismissible: true,
  };
}
