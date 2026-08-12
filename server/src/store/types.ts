/**
 * Storage interface — the seam that keeps deploy targets honest (plans/01):
 * memory (dev/tests) now, Postgres next; the Vercel trial and the Helm chart
 * must run the same code against different drivers. Everything async so the
 * Postgres driver slots in without touching callers.
 */
import type { Grant } from '../rbac/evaluate.ts';
import type { ToolOverlay } from '../policy/overlay.ts';
import type { FlagGovernance } from '../policy/feature-flags.ts';
import type { InjectableRecord } from '../injectables/types.ts';
import type { LinkRecord } from '../links/sign.ts';
import type { AuditEvent, AuditEventBody } from '../audit/chain.ts';
import type { StoredEvent } from '../telemetry/ingest.ts';
import type { Message } from '../inbox/target.ts';
import type { ClientInfo } from '../fleet/client-header.ts';
import type { Approval, ApprovalState, Chain } from '../approvals/engine.ts';
import type { LifecycleRow } from '../catalog/lifecycle.ts';
import type { ProviderRecord, ProviderState } from '../catalog/providers/types.ts';

export interface UserRecord {
  id: string;
  sub: string;
  email: string;
  firstname?: string;
  lastname?: string;
  title?: string;
  /** IdP-authoritative groups, re-synced (clobbered) on every login. */
  idpGroups: string[];
  /** Console-editable groups; login-DURABLE (never touched by OIDC re-sync). */
  localGroups: string[];
  /** Effective membership = unique(idpGroups ∪ localGroups); everything
   *  downstream reads this. Derived — never set directly. */
  groups: string[];
  role: string;
  telemetryConsent?: boolean;
  disabledAt?: string;
  /** Pre-expiry revocation counter: session tokens embed the epoch at mint,
   *  and a token older than the current epoch is refused. Bumped by
   *  bumpSessionEpoch and by setUserDisabled when disabling. */
  sessionEpoch: number;
  createdAt: string;
  lastSeenAt: string;
}

/** A local group definition (the registry). IdP groups are NOT registered —
 *  they're discovered from users' idpGroups. */
export interface LocalGroupRecord {
  name: string;
  description?: string;
  createdAt: string;
}

/** The upsert input carries the IdP-authoritative groups as `groups`; the store
 *  reinterprets them as idpGroups, preserves stored localGroups, and derives the
 *  effective union + role. So callers never construct the split themselves. */
export type UserUpsert = Omit<UserRecord, 'id' | 'createdAt' | 'lastSeenAt' | 'idpGroups' | 'localGroups' | 'sessionEpoch'>;

/** Effective membership: idp first, then any local groups not already present —
 *  deduped, stable order. Empty strings dropped. */
export function effectiveGroups(idpGroups: string[], localGroups: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of [...idpGroups, ...localGroups]) {
    if (!g || seen.has(g)) continue;
    seen.add(g);
    out.push(g);
  }
  return out;
}

export interface ListUsersPageOpts {
  q?: string;
  /** Jump-to-letter: 'a'–'z' keeps people whose display name starts with that
   *  letter; '#' keeps names starting with anything else (digits, CJK, …). */
  prefix?: string;
  role?: string;
  group?: string;
  status?: 'active' | 'disabled';
  sort?: 'name' | 'email' | 'role' | 'lastSeen';
  dir?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export interface FleetRow {
  bucket: string;
  info: ClientInfo;
  count: number;
  lastSeenAt: string;
}

/** A team/personal project — a folder over sessions (plans/08 §2). Visibility is
 *  'private' (owner-only) or a set of groups that may see it; membership is the
 *  RBAC layer, not per-project ACLs. */
export interface ProjectRecord {
  id: string;
  name: string;
  visibility: 'private' | { groups: string[] };
  ownerId: string;
  createdAt: string;
  archivedAt?: string;
}

/** A saved tool session synced to the server: the client's
 *  {toolId, toolVersion, inputs, meta} record plus server bookkeeping
 *  (rev for optimistic CAS, updatedBy, tombstone). */
export interface SessionRecord {
  id: string;
  projectId: string;
  toolId: string;
  toolVersion: string;
  inputs: Record<string, unknown>;
  meta: Record<string, unknown>;
  createdBy: string;
  updatedBy: string;
  rev: number;
  updatedAt: string;
  deletedAt?: string;
}

/** One committed edit to a session — a bounded, restorable history entry. */
export interface SessionRevision {
  sessionId: string;
  rev: number;
  inputs: Record<string, unknown>;
  meta: Record<string, unknown>;
  actor: string;
  at: string;
}

/** How many revisions a driver keeps per session (newest wins). Sessions are
 *  bytes-small; this bounds unbounded history growth (plans/08 §2). */
export const SESSION_REVISION_LIMIT = 20;

/**
 * A live collab room's document, mid-flight (plans/14 §6, migrations/0010_collab.sql).
 *
 * Stored AS SESSION INPUTS, not as a CRDT update log: the room document and
 * `SessionRecord.inputs` are the same information in two shapes, so a snapshot is
 * "what this session would be if the room quiesced right now". One row per
 * session, replaced (never appended to), and deleted by the quiesce that writes
 * the real revision — so a row that outlives a process restart is precisely the
 * signal "a crash lost this room's quiesce".
 */
export interface CollabSnapshot {
  sessionId: string;
  /** The room's converged document, merged over the stored inputs the document
   *  cannot express (a `file` input, a nested object — rooms.ts `unsynced`). */
  inputs: Record<string, unknown>;
  /** The `SessionRecord.rev` this snapshot was taken against. Recovery replays it
   *  only while the stored session is still at that rev; a higher rev means an
   *  ordinary PUT superseded the room. */
  baseRev: number;
  /** Accepted ops behind this snapshot. Zero ⇒ nothing to recover. */
  ops: number;
  updatedAt: string;
}

export interface Store {
  // users
  upsertUserBySub(user: UserUpsert): Promise<UserRecord>;
  getUserBySub(sub: string): Promise<UserRecord | null>;
  /** By internal id, the shape every stored REFERENCE to a user uses
   *  (`LinkRecord.createdBy`, `SessionRecord.updatedBy`, a grant's `user:<id>`
   *  principal). `getUserBySub` answers the cookie; this answers a row.
   *
   *  It exists because a `listUsers()` scan is fine ONCE per request and ruinous
   *  per gesture: the collab gateway re-checks a guest's inviter on every ops
   *  message and every keepalive (`collab/guests.ts` `inviterStanding`), which
   *  over a full users table would be a select-all per keystroke-commit. */
  getUser(id: string): Promise<UserRecord | null>;
  setTelemetryConsent(userId: string, consent: boolean): Promise<void>;
  listUsers(): Promise<UserRecord[]>;
  /** Paginated/filtered/sorted list for the console People view (~2500 users).
   *  q matches name/email substring (case-insensitive); group matches effective
   *  membership. total is the full match count before limit/offset. */
  listUsersPage(opts: ListUsersPageOpts): Promise<{ rows: UserRecord[]; total: number }>;
  /** Replace a user's localGroups (idpGroups untouched); recomputes the
   *  effective union + role. Returns the updated record, or null if unknown. */
  setLocalGroups(userId: string, localGroups: string[]): Promise<UserRecord | null>;
  /** Set (ISO string) or clear (null) disabledAt. Disabling also bumps
   *  sessionEpoch (disable = lockout AND revocation); clearing does not.
   *  Returns updated record or null. */
  setUserDisabled(userId: string, disabledAt: string | null): Promise<UserRecord | null>;
  /** Increment sessionEpoch, killing every session token minted before the
   *  bump on its next request. Returns updated record or null. */
  bumpSessionEpoch(userId: string): Promise<UserRecord | null>;

  // local group registry (console-editable group definitions)
  listLocalGroups(): Promise<LocalGroupRecord[]>;
  putLocalGroup(group: LocalGroupRecord): Promise<void>;
  /** Delete the definition AND strip the group from every user's localGroups
   *  (recomputing their effective union + role). */
  deleteLocalGroup(name: string): Promise<void>;

  // rbac / policy. Grants are identified by their full tuple (no exposed id):
  // put is idempotent on the exact tuple, delete removes every exact match.
  listGrants(): Promise<Grant[]>;
  putGrant(grant: Grant): Promise<void>;
  deleteGrant(grant: Grant): Promise<void>;
  listOverlays(): Promise<Map<string, ToolOverlay>>;
  putOverlay(overlay: ToolOverlay): Promise<void>;
  /** Remove a tool's overlay (policy-as-code prune). Unknown id is a no-op. */
  deleteOverlay(toolId: string): Promise<void>;

  // feature-flag governance (control-plane defaults + visibility for the shell's
  // per-user flags). Keyed by flag id; putting a record with no opinion clears it.
  listFlagGovernance(): Promise<Map<string, FlagGovernance>>;
  putFlagGovernance(rec: FlagGovernance): Promise<void>;

  // injectables — the governed rail that injects tools / flags / typed resources /
  // declarative chrome into the shell (plans/19). Keyed by id; put is an upsert,
  // delete is a hard purge (routes soft-revoke via put with state:'revoked').
  listInjectables(): Promise<InjectableRecord[]>;
  getInjectable(id: string): Promise<InjectableRecord | null>;
  putInjectable(rec: InjectableRecord): Promise<void>;
  deleteInjectable(id: string): Promise<void>;

  // schema readiness — migration files not yet applied. Read-only (issues no
  // DDL). Memory is always current ([]); postgres compares migrations/*.sql to
  // the schema_migrations table.
  pendingMigrations(): Promise<string[]>;

  // links
  putLink(link: LinkRecord): Promise<void>;
  getLink(id: string): Promise<LinkRecord | null>;
  revokeLink(id: string, at: string): Promise<void>;
  listLinksBy(createdBy: string): Promise<LinkRecord[]>;
  listAllLinks(): Promise<LinkRecord[]>;

  // audit
  appendAudit(body: AuditEventBody): Promise<AuditEvent>;
  listAudit(): Promise<AuditEvent[]>;

  // telemetry
  putEvents(events: StoredEvent[]): Promise<void>;
  listEvents(): Promise<StoredEvent[]>;

  // inbox
  listMessages(): Promise<Message[]>;
  putMessage(msg: Message): Promise<void>;
  ackMessage(messageId: string, userId: string): Promise<void>;
  /**
   * Undo one ack, so a re-put of the SAME message id is delivered again.
   * Unknown pair is a no-op.
   *
   * Needed because message ids are sometimes derived rather than random: a
   * collab invite's id is `sha256(session, invitee)` (collab/invites.ts) so that
   * re-inviting refreshes one inbox row instead of stacking a second. Delivery
   * filters acked ids unconditionally (inbox/target.ts `targetedMessages`), so
   * with acks append-only the first dismissal would make that pair permanently
   * un-notifiable — a 201 that silently reaches nobody. Deliberately NOT folded
   * into `putMessage`: an admin fixing a typo in an announcement must not
   * re-raise it for everyone who already dismissed it.
   */
  clearAck(messageId: string, userId: string): Promise<void>;
  acksFor(userId: string): Promise<Set<string>>;
  ackCounts(): Promise<Map<string, number>>;

  // fleet
  recordClient(info: ClientInfo): Promise<void>;
  fleetSummary(): Promise<FleetRow[]>;

  // approvals
  putChain(chain: Chain): Promise<void>;
  getChain(id: string): Promise<Chain | null>;
  listChains(): Promise<Chain[]>;
  /** Remove a chain DEFINITION (policy-as-code prune). Safe: in-flight approvals
   *  carry a chain snapshot, so they're unaffected. Unknown id is a no-op. */
  deleteChain(id: string): Promise<void>;
  putApproval(approval: Approval): Promise<void>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(filter?: { createdBy?: string; eligibleGroups?: string[]; state?: ApprovalState }): Promise<Approval[]>;

  // catalog lifecycle
  putLifecycle(row: LifecycleRow): Promise<void>;
  getLifecycle(assetId: string): Promise<LifecycleRow | null>;
  listLifecycle(): Promise<LifecycleRow[]>;

  // catalog providers (plans/17). Config, credential, and state move through
  // separate methods so the write-only credential path and the sync path can
  // never clobber each other: putProvider upserts config fields ONLY,
  // preserving any stored credential and runtime state on update.
  listProviders(): Promise<ProviderRecord[]>;
  getProvider(id: string): Promise<ProviderRecord | null>;
  putProvider(rec: ProviderRecord): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  /** null clears the stored credential. */
  putProviderCredential(
    id: string,
    cred: { ciphertext: Uint8Array; fingerprint: string; updatedAt: string } | null,
  ): Promise<void>;
  putProviderState(id: string, state: ProviderState): Promise<void>;

  // projects + sessions (plans/08)
  putProject(project: ProjectRecord): Promise<void>;
  getProject(id: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  putSession(session: SessionRecord): Promise<void>;
  /**
   * Compare-and-set on `rev`: writes `next` only if the stored row is still at
   * `expectedRev` and is NOT tombstoned. Returns false when it is not, having
   * written nothing.
   *
   * This is the write a concurrent editor needs and `putSession` cannot be. A
   * read-modify-write over `putSession` has an await between the read and the
   * write, so two writers both read rev 5 and both write rev 6 — the second
   * silently discarding the first, and `session_revisions` (whose PK is
   * `(session_id, rev)`) keeping only one of the two, so history and
   * `sessions.inputs` end up disagreeing. The tombstone exclusion is part of the
   * contract rather than a caller's job: `putSession` writes `deleted_at` from the
   * record it is handed, so a record read BEFORE a DELETE resurrects the session
   * when written after it. A CAS never resurrects and never touches `deleted_at`.
   */
  casSession(next: SessionRecord, expectedRev: number): Promise<boolean>;
  /** Returns the record even when tombstoned (deletedAt set) so callers choose
   *  the response (404 vs 410); null only when the id is unknown. */
  getSession(id: string): Promise<SessionRecord | null>;
  /** Excludes tombstoned sessions. */
  listSessions(projectId: string): Promise<SessionRecord[]>;
  /** Excludes tombstoned sessions; both filters optional (none = all). */
  listSessionsFiltered(filter: { projectId?: string; toolId?: string }): Promise<SessionRecord[]>;
  appendSessionRevision(rev: SessionRevision): Promise<void>;
  /** Newest-first, bounded to SESSION_REVISION_LIMIT. */
  listSessionRevisions(sessionId: string): Promise<SessionRevision[]>;

  // live collab rooms (plans/14 §6). At most one snapshot per session; put is an
  // upsert that REPLACES the previous one (no update log to compact), and the
  // quiesce that lands the room as a session revision deletes it.
  putCollabSnapshot(snap: CollabSnapshot): Promise<void>;
  getCollabSnapshot(sessionId: string): Promise<CollabSnapshot | null>;
  /** Unknown id is a no-op. */
  deleteCollabSnapshot(sessionId: string): Promise<void>;
}
