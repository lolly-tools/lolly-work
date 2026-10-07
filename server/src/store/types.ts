import type { CommentThread } from '@lolly-tools/core/canvas-review-v1';
import type { CanvasCheckpoint, CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { createHash, randomInt } from 'node:crypto';
import { canonicalJson } from '../lib/crypto.ts';
/**
 * Storage interface - the seam that keeps deploy targets honest (plans/01):
 * memory (dev/tests) now, Postgres next; the Vercel trial and the Helm chart
 * must run the same code against different drivers. Everything async so the
 * Postgres driver slots in without touching callers.
 */
import type { Grant, RoleGroups } from '../rbac/evaluate.ts';
import type { ToolOverlay } from '../policy/overlay.ts';
import type { FlagGovernance } from '../policy/feature-flags.ts';
import type { InjectableRecord } from '../injectables/types.ts';
import type { LinkRecord } from '../links/sign.ts';
import type { AuditAnchor, AuditEvent, AuditEventBody } from '../audit/chain.ts';
import type { AuditFilter } from '../audit/filter.ts';
import type { StoredEvent } from '../telemetry/ingest.ts';
import type { Message } from '../inbox/target.ts';
import type { ClientInfo } from '../fleet/client-header.ts';
import type { Approval, ApprovalState, Chain } from '../approvals/engine.ts';
import type { LifecycleRow } from '../catalog/lifecycle.ts';
import type { CredentialRow } from '../catalog/credentials.ts';
import type { InstanceAssetRecord } from '../catalog/instance-assets.ts';
import type { AssetMetaRecord, CatalogFieldDef } from '../catalog/asset-meta.ts';
import type { CollectionRecord } from '../catalog/collections.ts';
import type { AssetVersionRecord } from '../catalog/versions.ts';
import type { ProviderRecord, ProviderState } from '../catalog/providers/types.ts';
import type { DeliveryRecord } from '../delivery/types.ts';
import type { PasskeyStore } from '../iam/passkeys/types.ts';
import type { RenderStore } from '../renders/types.ts';
import type { ProjectFileLimits, ProjectFileRecord, ProjectFileReservation } from '../projects/files.ts';
import type { ProjectAccess } from '../rbac/project-access.ts';
import { sha256Hex } from '../lib/crypto.ts';

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
   *  downstream reads this. Derived - never set directly. */
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

/** A local group definition (the registry). IdP groups are NOT registered -
 *  they're discovered from users' idpGroups. */
export interface LocalGroupRecord {
  name: string;
  description?: string;
  createdAt: string;
}

/** An invitation (plans/74 W-ID-2): one email address that may sign in while
 *  `idp.admission` is set, and the local groups that person joins on their
 *  first admitted sign-in. "Active" means not revoked: pending (no
 *  `acceptedAt`) or accepted. An accepted invitation keeps admitting its
 *  email until it is revoked; `expiresAt` bounds acceptance only. */
export interface InvitationRecord {
  id: string;
  /** Lowercased; the store lowercases again on write. */
  email: string;
  /** Local group names (the /api/v1/groups slug rule). */
  groups: string[];
  /** 'user:<id>' (or a service principal) who invited. */
  invitedBy: string;
  createdAt: string;
  expiresAt?: string;
  acceptedAt?: string;
  acceptedUserId?: string;
  revokedAt?: string;
  /** Projects this person joins when the invitation is accepted (plans/74,
   *  "Invite from inside Lolly"). Absent or empty for an invitation that only
   *  admits and groups. */
  projects?: InvitationProject[];
  /** Which route wrote the row (migration 0040): 'console' (the console and
   *  `lw invite add`, the default), 'project' (an in-app project invite) or
   *  'request' (an approved join or switch request, migration 0043). Only a
   *  project-made invitation is withdrawn when its last project is taken off
   *  it; a console invitation stays for an admin to revoke. */
  createdVia?: 'console' | 'project' | 'request';
  /** Signed into every invite link for this row (migration 0043; 1 on a new
   *  row). "New link" raises it, which ends every link copied before. */
  linkVersion: number;
  /** The first time someone started a sign-in from the invite page. A GET of
   *  the page never sets it, so a link preview does not count. */
  openedAt?: string;
  /** The invite page may set a password for the address, once, while it has
   *  none. Absent means false. */
  passwordSetup?: boolean;
}

/** What `createInvitation` takes: the store starts every row at link
 *  version 1, not yet opened. */
export type NewInvitationRecord = Omit<InvitationRecord, 'linkVersion' | 'openedAt'>;

/** One project an invitation carries, and the role the person gets on it. */
export interface InvitationProject {
  projectId: string;
  role: ProjectMemberRole;
  /** 'user:<id>' who put this project on the invitation, or last raised its
   *  role. Acceptance re-checks that person's standing on the project before
   *  applying the entry. Absent on older rows: the invitation's `invitedBy`. */
  invitedBy?: string;
}

/** One sign-in linked to one user (plans/74, "One person, many sign-ins";
 *  migration 0039). `identitySub` is the namespaced IdP subject the callback
 *  builds (`<idp id>:<sub>` for an additional IdP, the raw sub for primary,
 *  `proxy:<user>` for the proxy). A user's own `users.sub` is one of these and
 *  stays the session cookie's subject whichever sign-in was used. */
export interface UserIdentityRecord {
  identitySub: string;
  userId: string;
  /** The IdP id: 'primary', an `idp.additional` id, 'proxy' or 'dev'. */
  idp: string;
  /** Lowercased; absent when the sign-in carried no address. */
  email?: string;
  /** Whether the IdP vouched for `email` at the latest sign-in or link.
   *  Rows backfilled by the migration start false. */
  emailVerified: boolean;
  /** The IdP groups this sign-in asserted at its latest sign-in (with any
   *  bootstrap owner group it earned). Each IdP speaks only for its own;
   *  iam/identities.ts `standingGroups` combines them. Absent on a write
   *  keeps the stored value; a new row starts with none. */
  groups?: string[];
  linkedAt: string;
  lastLoginAt?: string;
}

/** One email and password sign-in (plans/74; migration 0042). Keyed by the
 *  lowercased email; `id` is stable across resets and names the sign-in's
 *  subject (`password:<id>`). `hash` is the scrypt string iam/password.ts
 *  writes, never the password. */
export interface PasswordCredentialRecord {
  id: string;
  /** Lowercased; the store lowercases again on write. */
  email: string;
  hash: string;
  createdAt: string;
  /** When the hash last changed (set, reset or rehash). */
  updatedAt: string;
  /** Sign-in attempts since the last success or lock. An attempt is counted
   *  before its password is checked (`reservePasswordAttempt`). */
  failedCount: number;
  /** Sign-in is refused until this instant. */
  lockedUntil?: string;
  /** Whether the hash was set from a link an owner (or the operator, through
   *  scripts/password-link.ts) issued. A password set from an admin's link
   *  never signs anyone in as an owner. */
  ownerIssued: boolean;
}

/** What `reservePasswordAttempt` found for an address. */
export type PasswordAttempt =
  | { status: 'none' }
  /** Locked at that instant; nothing was counted. */
  | { status: 'locked'; credential: PasswordCredentialRecord }
  /** One attempt counted. `locks` is set when this attempt reached the limit
   *  and locked the credential: if its password is wrong, that is the lockout. */
  | { status: 'reserved'; credential: PasswordCredentialRecord; locks: boolean };

/** A one-time link that sets a password (plans/74; migration 0042). Only the
 *  sha256 hex of the token is stored; the token itself is shown once. */
export interface PasswordLinkRecord {
  tokenHash: string;
  /** Lowercased. */
  email: string;
  purpose: 'setup' | 'reset';
  /** 'user:<id>' who issued it, or 'operator' for scripts/password-link.ts. */
  createdBy?: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

/** What an access request asks for (migration 0044): a project (also "ask to
 *  edit" from a viewer), to join the workspace, or to use the signed-in
 *  account for someone else's invitation. 'invite' is reserved (a manager
 *  asking an admin to invite an address). */
export type AccessRequestKind = 'project' | 'join' | 'switch' | 'invite';
export type AccessRequestStatus = 'open' | 'approved' | 'declined' | 'withdrawn' | 'superseded' | 'expired';
/** Every status but 'open': how a request was answered or closed. */
export type AccessRequestOutcome = Exclude<AccessRequestStatus, 'open'>;

/** One "ask" (plans/75 G13; migration 0044). The email always comes from a
 *  sign-in the server just verified, never from a form field. One open row
 *  per (kind, email, project, invitation). */
export interface AccessRequestRecord {
  /** 'req_' + randomId(10). */
  id: string;
  kind: AccessRequestKind;
  status: AccessRequestStatus;
  /** Verified, lowercased. */
  email: string;
  /** The requester's account, when they have one. */
  userId?: string;
  /** join and switch: the namespaced IdP subject that proved the email. */
  identitySub?: string;
  /** The idp id ('primary', 'github', 'email', ...). */
  idp?: string;
  /** Display name from the sign-in, at most 120 characters. */
  name?: string;
  projectId?: string;
  /** The session link the request came from. */
  viaSessionId?: string;
  /** switch: the invitation whose link was used. */
  invitationId?: string;
  /** What was asked for. */
  role?: ProjectMemberRole;
  /** project: the requester's access when they asked. */
  currentRole?: ProjectAccess;
  /** At most 280 characters, stored raw, always rendered as text. */
  note?: string;
  /** Kind 'invite' only: 'user:<id>' of the member who typed the address. */
  requestedBy?: string;
  createdAt: string;
  /** createdAt + policy.requests.ttlDays. */
  expiresAt: string;
  answeredAt?: string;
  /** 'user:<id>', or the principal that closed it. */
  answeredBy?: string;
  answerRole?: ProjectMemberRole;
  resultInvitationId?: string;
}

/** `listAccessRequests`. 'open' is status open and unexpired at `now`, oldest
 *  first. 'answered' is every other row, an open one past its expiry
 *  included (read back as 'expired'), newest answer first. */
export interface AccessRequestQuery {
  status: 'open' | 'answered';
  now: string;
  kinds?: AccessRequestKind[];
  projectIds?: string[];
  userId?: string;
  email?: string;
  invitationId?: string;
  /** 'answered' only: `coalesce(answeredAt, expiresAt) >= answeredSince`. */
  answeredSince?: string;
  /** Default 200. */
  limit?: number;
}

/** How `answerAccessRequest` and `closeAccessRequests` close a row. */
export interface AccessRequestAnswer {
  status: AccessRequestOutcome;
  at: string;
  by?: string;
  role?: ProjectMemberRole;
  resultInvitationId?: string;
}

/** Which live open rows `closeAccessRequests` closes. `roleAtMost` keeps
 *  only rows asking for that role or less. */
export interface AccessRequestMatch {
  kind?: AccessRequestKind;
  projectId?: string;
  userId?: string;
  email?: string;
  invitationId?: string;
  roleAtMost?: ProjectMemberRole;
}

/** `countAccessRequests`, which feeds the caps. Counts rows of the kind
 *  created at or after `since`; `openOnly` counts only live open rows. */
export interface AccessRequestCount {
  kind: AccessRequestKind;
  email?: string;
  invitationId?: string;
  since?: string;
  openOnly?: boolean;
  now: string;
}

/** A SCIM provisioning bearer token (plans/31 §8). One per IdP connector; the
 *  opaque secret is shown once at mint and stored only as `tokenHash`. */
export interface ScimTokenRecord {
  id: string;
  /** The operator's label for the IdP connector this token authorizes. */
  idp: string;
  /** sha256 hex of the opaque secret - never the secret itself. */
  tokenHash: string;
  /** 'user:<id>' who minted it. */
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Set on revoke; a revoked token is kept so its trail survives. */
  revokedAt?: string;
}

/** A service token (plans/35 wave 2) - automation identity, the SCIM-token
 *  pattern generalized. Presenting the secret resolves to a synthetic
 *  principal carrying `role` (no groups), so CI drives the action-gated API
 *  without a person's session cookie in a secret store. */
export interface ApiTokenRecord {
  id: string;
  /** Operator label ("ci", "governance-sync") - names the automation, never a person. */
  label: string;
  /** The role the synthetic principal carries; the evaluator owns the vocabulary. */
  role: string;
  /** sha256 hex of the opaque secret - never the secret itself. */
  tokenHash: string;
  /** 'user:<id>' who minted it. */
  createdBy: string;
  createdAt: string;
  lastUsedAt?: string;
  /** Set on revoke; a revoked token is kept so its trail survives. */
  revokedAt?: string;
}

export type AutomationJobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
/** Durable automation job metadata. Result bytes live in BlobStore; this row
 * only holds the reference and lifecycle needed to recover across processes. */
export interface AutomationJobRecord {
  id: string;
  principal: string;
  verb: string;
  request: Record<string, unknown>;
  state: AutomationJobState;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  resultRef?: string;
  resultMime?: string;
  /** SHA-256 of the immutable result bytes. Provider ETags are not content
   * digests (multipart S3 in particular), so consumers bind to this value. */
  resultSha256?: string;
  error?: string;
  callbackUrl?: string;
  callbackFailed?: boolean;
  progress?: { done: number; total: number };
  idempotencyKey?: string;
  /** Higher values drain first within this process; bounded to 0..9. */
  priority: number;
  attempt: number;
  leaseOwner?: string;
  leaseUntil?: string;
  leaseToken?: number;
}

/** The upsert input carries the IdP-authoritative groups as `groups`; the store
 *  reinterprets them as idpGroups, preserves stored localGroups, and derives the
 *  effective union + role. So callers never construct the split themselves. */
export type UserUpsert = Omit<UserRecord, 'id' | 'createdAt' | 'lastSeenAt' | 'idpGroups' | 'localGroups' | 'sessionEpoch'>;

/** Effective membership: idp first, then any local groups not already present - 
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

/** One registered install - a device that spoke `install/<id>` on an
 *  AUTHENTICATED request (plans/34 wave 3). The row is bookkeeping under the
 *  enrollment covenant: it rides traffic the person already makes (no
 *  heartbeat), it is never authorization, and forgetting it is a row delete -
 *  there is no remote action. The next signed-in request from the same device
 *  re-registers it, which is correct, not a bug. */
export interface InstallRow {
  installId: string;
  info: ClientInfo;
  /** Operator-set display name; absent until someone names it in the console. */
  name?: string;
  /** The member last seen using this install - a pointer for the fleet table,
   *  never a login binding. */
  userIdLastSeen?: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** One device sign-in code pair (plans/35 wave 5). `userPayload` is the
 *  approving person's session shape - written at approve, consumed once at
 *  claim. Rows die at expiry; drivers prune opportunistically. */
export interface DeviceCodeRecord {
  deviceCode: string;
  userCode: string;
  clientTag?: string;
  status: 'pending' | 'approved' | 'denied';
  userPayload?: Record<string, unknown>;
  createdAt: string;
  expiresAt: string;
}

export type DeviceClaimResult =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; userPayload: Record<string, unknown> };

/** A team/personal project - a folder over sessions (plans/08 §2). Visibility is
 *  'private' (owner-only) or a set of groups that may see it; membership is the
 *  RBAC layer, not per-project ACLs. */
export interface ProjectRecord {
  id: string;
  name: string;
  visibility: 'private' | { groups: string[] };
  ownerId: string;
  createdAt: string;
  archivedAt?: string;
  /** The last rename, visibility or archive change, and who made it. Absent
   *  on a project nobody has changed since it was created. */
  updatedAt?: string;
  updatedBy?: string;
}

/** Shared organisation of a project's documents and files; access is inherited. */
export interface ProjectFolderRecord {
  id: string; projectId: string; parentId: string | null; name: string;
  createdAt: string; createdBy: string;
  items: Array<{ kind: 'session' | 'file'; ref: string }>;
}

/** A named collaborator whose bearer grants access to one document only. */
export interface DocumentAgentRecord {
  id: string; sessionId: string; projectId: string; userId: string; createdBy: string;
  label: string; role: 'viewer' | 'editor'; tokenHash: string;
  createdAt: string; expiresAt: string; revokedAt?: string;
  /** Internal room projection of a project invitation, never accepted from a client. */
  projectAgentId?: string;
}

/** One member delegates their current access to a named agent in one project. */
export type ProjectAgentRecord = Omit<DocumentAgentRecord, 'sessionId' | 'projectAgentId'>;

/** A person's explicit role on one project (plans/74, migration 0040). The
 *  project's owner never has one. viewer reads, editor also writes sessions,
 *  manager also renames, shares, archives and manages the people. */
export type ProjectMemberRole = 'viewer' | 'editor' | 'manager';
export const PROJECT_MEMBER_ROLES: readonly ProjectMemberRole[] = ['viewer', 'editor', 'manager'];
export interface ProjectMemberRecord {
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  /** 'user:<id>' (or a principal) who added the row. */
  addedBy: string;
  addedAt: string;
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

/** One committed edit to a session - a bounded, restorable history entry. */
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

/** A session as a listing shows it: every field but the document itself. */
export type SessionSummary = Omit<SessionRecord, 'inputs'>;

/** Live (untombstoned) sessions in one project: how many, and the newest edit. */
export interface ProjectSessionStats {
  projectId: string;
  count: number;
  updatedAt: string;
  /** Who made that newest edit (the session's `updatedBy`). */
  updatedBy?: string;
}

export interface CollabReceipt {
  id: string;
  digest: string;
  accepted: boolean;
  revision: number;
}
export interface CollabCommit {
  sessionId: string;
  owner: string;
  principal: string;
  expectedRev: number;
  inputs: Record<string, unknown>;
  /** Required for the first commit after a normal session save; periodic thereafter. */
  checkpoint?: CanvasCheckpoint;
  /** Accepted novel operations only. An empty array still advances the recovery chain;
   *  the room sends a batch with none through `commitCollabReceipts` instead. */
  ops: CanvasOp[];
  receipts: Omit<CollabReceipt, 'revision'>[];
  actor: string;
  updatedBy: string;
}
/** The receipts of a batch whose every operation was refused. */
export type CollabReceiptCommit = Pick<CollabCommit, 'sessionId' | 'owner' | 'principal' | 'expectedRev' | 'receipts'>;

/**
 * A live collab room's document, mid-flight (plans/14 §6, migrations/0010_collab.sql).
 *
 * Stored AS SESSION INPUTS, not as a CRDT update log: the room document and
 * `SessionRecord.inputs` are the same information in two shapes, so a snapshot is
 * "what this session would be if the room quiesced right now". One row per
 * session, replaced (never appended to), and deleted by the quiesce that writes
 * the real revision - so a row that outlives a process restart is precisely the
 * signal "a crash lost this room's quiesce".
 */
export interface CollabSnapshot {
  sessionId: string;
  /** The room's converged document, merged over the stored inputs the document
   *  cannot express (a `file` input, a nested object - rooms.ts `unsynced`). */
  inputs: Record<string, unknown>;
  /** The `SessionRecord.rev` this snapshot was taken against. Recovery replays it
   *  only while the stored session is still at that rev; a higher rev means an
   *  ordinary PUT superseded the room. */
  baseRev: number;
  /** Accepted ops behind this snapshot. Zero ⇒ nothing to recover. */
  ops: number;
  updatedAt: string;
}

// Session versions (plan 76 M4 R2, migration 0053). A version is a meaningful
// state of a document, kept apart from the 20-row revision window. Its content
// is stored once per document and digest, so repeated states cost no extra bytes.

/** auto: written after a pause in live editing. close: when a live room closes.
 *  save: a REST save. named: a person saved it with a name. restore: the state a
 *  restore produced. before: the state a restore replaced, paired with its
 *  restore row. */
export type SessionVersionKind = 'auto' | 'close' | 'save' | 'named' | 'restore' | 'before';
export const SESSION_VERSION_KINDS: readonly SessionVersionKind[] = ['auto', 'close', 'save', 'named', 'restore', 'before'];
/** Who edited a version, and how many accepted edits each made. Guests are
 *  counted together as one entry with the id 'guest'; no link id is stored. */
export interface SessionVersionContributor { id: string; kind: 'user' | 'agent' | 'guest'; edits: number }
export interface SessionVersionSummary {
  id: string; sessionId: string; rev: number; kind: SessionVersionKind; label?: string;
  contributors: SessionVersionContributor[]; createdBy?: string; restoredFrom?: string; beforeId?: string;
  /** Size of the version's content (canonical inputs JSON), shared with any
   *  other version of the same document that has the same content. */
  bytes: number; at: string;
}
export interface SessionVersion extends SessionVersionSummary { inputs: Record<string, unknown>; meta: Record<string, unknown> }
export type SessionVersionWrite = Omit<SessionVersion, 'id' | 'bytes' | 'at'> & { at?: string; requestId?: string };
/** What `putSessionVersion` did. `created: false` means an earlier row answers
 *  the write: the same request id, the same content as the latest version, or an
 *  automatic version skipped for space (the latest version is returned). */
export type SessionVersionPut = { version: SessionVersionSummary; created: boolean } | 'version-limit' | 'version-space';
/** Space caps on version content, counted over distinct contents. */
export interface SessionVersionLimits { sessionMaxBytes: number; instanceMaxBytes: number }

/** The most content one document's versions may hold. */
export const VERSION_SESSION_MAX_BYTES = 100 * 1024 * 1024;
/** The most content the whole instance's versions may hold, unless
 *  `configureVersionLimits` sets another (`policy.versions.maxBytes`). */
export const VERSION_INSTANCE_MAX_BYTES = 1024 * 1024 * 1024;
/** Named versions: per person per document, and per document. */
export const VERSION_NAMED_PER_PERSON = 20;
export const VERSION_NAMED_PER_SESSION = 100;
/** Restore rows kept per document (each with its paired 'before' row). */
export const VERSION_RESTORE_KEEP = 200;
/** auto, close and save rows: the newest this many are kept... */
export const VERSION_RECENT_KEEP = 50;
/** ...and the newest one of each UTC day within this many days... */
export const VERSION_DAILY_DAYS = 30;
/** ...and, whichever rule keeps them, none older than this many days. */
export const VERSION_MAX_AGE_DAYS = 365;
export const VERSION_LABEL_MAX = 120;
/** `listSessionVersions` page size: the default and the most allowed. */
export const VERSION_LIST_DEFAULT = 30;
export const VERSION_LIST_MAX = 100;

const VERSION_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const RECYCLABLE_KINDS: ReadonlySet<SessionVersionKind> = new Set(['auto', 'close', 'save']);
const DAY_MS = 86_400_000;
let lastVersionMs = 0;
let lastVersionSeq = 0;

const base32 = (value: number, length: number): string => {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = VERSION_ID_ALPHABET[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
};

/** The caps `configureVersionLimits` sets: each given field, or its default. */
export function resolveVersionLimits(limits: Partial<SessionVersionLimits>): SessionVersionLimits {
  const pick = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('version limits must be whole numbers above zero');
    return value;
  };
  return { sessionMaxBytes: pick(limits.sessionMaxBytes, VERSION_SESSION_MAX_BYTES), instanceMaxBytes: pick(limits.instanceMaxBytes, VERSION_INSTANCE_MAX_BYTES) };
}

/** `listSessionVersions`' page size: VERSION_LIST_DEFAULT when not a number,
 *  else the whole part kept between 1 and VERSION_LIST_MAX. */
export function versionListLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(VERSION_LIST_MAX, Math.max(1, Math.floor(limit))) : VERSION_LIST_DEFAULT;
}

/** `ver_` and 16 base32 characters: 10 of time, then 6 that count up within one
 *  millisecond from a random start. Ids made by one process therefore sort in the
 *  order they were made, which breaks ties between versions with the same `at`. */
export function sessionVersionId(now = Date.now()): string {
  if (now > lastVersionMs) {
    lastVersionMs = now;
    lastVersionSeq = randomInt(2 ** 29);
  } else if (++lastVersionSeq >= 2 ** 30) {
    lastVersionMs += 1;
    lastVersionSeq = randomInt(2 ** 29);
  }
  return `ver_${base32(lastVersionMs, 10)}${base32(lastVersionSeq, 6)}`;
}

/** The digest and size of a version's content: sha256 and byte length of the
 *  canonical (key-sorted) JSON of the inputs. */
export function sessionVersionContent(inputs: Record<string, unknown>): { digest: string; bytes: number } {
  const json = canonicalJson(inputs);
  return { digest: createHash('sha256').update(json).digest('hex'), bytes: Buffer.byteLength(json) };
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A version write in the shape both drivers store, or a thrown error for a
 *  write the database would refuse. Contributors keep only their known fields,
 *  and a guest is always stored as the one id 'guest'. */
export function normalizeSessionVersionWrite(v: SessionVersionWrite, now = new Date()): SessionVersionWrite & { at: string } {
  if (typeof v.sessionId !== 'string' || !v.sessionId) throw new TypeError('version-session');
  if (!SESSION_VERSION_KINDS.includes(v.kind)) throw new TypeError('version-kind');
  if (!Number.isSafeInteger(v.rev) || v.rev < 0) throw new TypeError('version-rev');
  if (v.label !== undefined && (typeof v.label !== 'string' || [...v.label].length < 1 || [...v.label].length > VERSION_LABEL_MAX)) throw new TypeError('version-label');
  if (!plainObject(v.inputs) || !plainObject(v.meta) || !Array.isArray(v.contributors)) throw new TypeError('version-shape');
  for (const ref of [v.createdBy, v.restoredFrom, v.beforeId, v.requestId]) if (ref !== undefined && (typeof ref !== 'string' || !ref)) throw new TypeError('version-reference');
  const at = v.at === undefined ? now : new Date(v.at);
  if (!Number.isFinite(at.getTime())) throw new TypeError('version-at');
  const contributors = v.contributors.flatMap((c): SessionVersionContributor[] => {
    if (!plainObject(c) || !['user', 'agent', 'guest'].includes(c.kind as string) || typeof c.id !== 'string' || !c.id) return [];
    const edits = Number.isSafeInteger(c.edits) && (c.edits as number) >= 0 ? c.edits as number : 0;
    return [{ id: c.kind === 'guest' ? 'guest' : c.id, kind: c.kind as SessionVersionContributor['kind'], edits }];
  });
  return {
    sessionId: v.sessionId, rev: v.rev, kind: v.kind, inputs: v.inputs, meta: v.meta, contributors,
    ...(v.label !== undefined ? { label: v.label } : {}),
    ...(v.createdBy !== undefined ? { createdBy: v.createdBy } : {}),
    ...(v.restoredFrom !== undefined ? { restoredFrom: v.restoredFrom } : {}),
    ...(v.beforeId !== undefined ? { beforeId: v.beforeId } : {}),
    ...(v.requestId !== undefined ? { requestId: v.requestId } : {}),
    at: at.toISOString(),
  };
}

/** The facts the version rules read about one stored row. */
export interface SessionVersionRow {
  id: string; sessionId: string; kind: SessionVersionKind; digest: string; at: string;
  createdBy?: string; requestId?: string; beforeId?: string;
}
/** Newest first: by `at`, then by id. */
export const newestVersionFirst = (a: Pick<SessionVersionRow, 'id' | 'at'>, b: Pick<SessionVersionRow, 'id' | 'at'>): number =>
  a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;

/**
 * The rows the retention rules remove from one document's versions, judged at
 * `refIso` (the time of the write being made). auto, close and save rows older
 * than VERSION_MAX_AGE_DAYS go; younger ones stay while they are among the newest
 * VERSION_RECENT_KEEP or are the newest of their UTC day within VERSION_DAILY_DAYS.
 * Restore rows beyond the newest VERSION_RESTORE_KEEP go with their 'before' rows.
 * Named and 'before' rows are never chosen by these rules, nor is `keepId`.
 */
export function versionRetentionDrops(rows: SessionVersionRow[], refIso: string, keepId?: string): string[] {
  const ref = Date.parse(refIso);
  const oldest = new Date(ref - VERSION_MAX_AGE_DAYS * DAY_MS).toISOString();
  const dayFloor = new Date(ref - VERSION_DAILY_DAYS * DAY_MS).toISOString().slice(0, 10);
  const drops = new Set<string>();
  const days = new Set<string>();
  rows.filter((r) => RECYCLABLE_KINDS.has(r.kind)).sort(newestVersionFirst).forEach((r, i) => {
    const day = r.at.slice(0, 10);
    const dailyKeep = !days.has(day) && day >= dayFloor;
    days.add(day);
    if (r.at < oldest || (i >= VERSION_RECENT_KEEP && !dailyKeep)) drops.add(r.id);
  });
  rows.filter((r) => r.kind === 'restore').sort(newestVersionFirst).slice(VERSION_RESTORE_KEEP).forEach((r) => {
    drops.add(r.id);
    if (r.beforeId) drops.add(r.beforeId);
  });
  drops.delete(keepId ?? '');
  return [...drops];
}

/**
 * The oldest auto, close and save rows to remove so that at least `need` bytes of
 * content are freed. Content is shared, so a content's bytes count as freed only
 * when no remaining row uses it. `rows` are every row whose content is counted
 * (any kind); rows in `exclude` are treated as already gone. Null when even
 * removing every such row would not free enough.
 */
export function versionEvictionPlan(rows: SessionVersionRow[], bytesOf: (sessionId: string, digest: string) => number,
  need: number, exclude: ReadonlySet<string>): string[] | null {
  if (need <= 0) return [];
  const key = (r: SessionVersionRow): string => `${r.sessionId} ${r.digest}`;
  const users = new Map<string, number>();
  for (const r of rows) if (!exclude.has(r.id)) users.set(key(r), (users.get(key(r)) ?? 0) + 1);
  const drops: string[] = [];
  let freed = 0;
  for (const r of rows.filter((x) => RECYCLABLE_KINDS.has(x.kind) && !exclude.has(x.id)).sort(newestVersionFirst).reverse()) {
    drops.push(r.id);
    const left = (users.get(key(r)) ?? 1) - 1;
    users.set(key(r), left);
    if (left === 0) freed += bytesOf(r.sessionId, r.digest);
    if (freed >= need) return drops;
  }
  return null;
}

/** What a driver does with one version write, decided by `planSessionVersionPut`.
 *  `return`: answer with that existing row (`created: false`). `skip`: an
 *  automatic version that does not fit; answer with the latest row. `insert`:
 *  store the row (and its content when new) and delete `drops`. */
export type SessionVersionPutPlan =
  | { action: 'return'; id: string }
  | { action: 'refuse'; reason: 'version-limit' | 'version-space' }
  | { action: 'skip' }
  | { action: 'insert'; contentIsNew: boolean; drops: string[] };

/** What the planner reads. `rows` and `contents` (digest to bytes) are the
 *  document's own; the instance totals are read only when new content is near a cap. */
export interface SessionVersionPutState {
  rows: SessionVersionRow[];
  contents: ReadonlyMap<string, number>;
  instanceBytes(): Promise<number>;
  instanceRows(): Promise<{ rows: SessionVersionRow[]; contents: ReadonlyMap<string, number> }>;
}

/**
 * The version rules, shared by both drivers, which call it with the document's
 * rows read under their write lock and then apply the plan in the same
 * transaction. In order: a repeated request id answers with its row; an auto,
 * close or save write whose content equals the latest version's answers with that
 * version; the named limits; then retention, and for new content the space caps,
 * which first remove the oldest auto, close and save rows (of this document, then
 * of the instance) and otherwise refuse a named, restore or before write and skip
 * an automatic one.
 */
export async function planSessionVersionPut(w: SessionVersionWrite & { at: string }, newId: string,
  content: { digest: string; bytes: number }, state: SessionVersionPutState, limits: SessionVersionLimits): Promise<SessionVersionPutPlan> {
  if (w.requestId !== undefined) {
    const same = state.rows.find((r) => r.requestId === w.requestId && r.kind === w.kind && r.createdBy === w.createdBy);
    if (same) return { action: 'return', id: same.id };
  }
  const recyclable = RECYCLABLE_KINDS.has(w.kind);
  const latest = [...state.rows].sort(newestVersionFirst)[0];
  if (recyclable && latest?.digest === content.digest) return { action: 'return', id: latest.id };
  if (w.kind === 'named') {
    const named = state.rows.filter((r) => r.kind === 'named');
    if (named.length >= VERSION_NAMED_PER_SESSION || named.filter((r) => r.createdBy === w.createdBy).length >= VERSION_NAMED_PER_PERSON)
      return { action: 'refuse', reason: 'version-limit' };
  }
  const row: SessionVersionRow = { id: newId, sessionId: w.sessionId, kind: w.kind, digest: content.digest, at: w.at,
    ...(w.createdBy !== undefined ? { createdBy: w.createdBy } : {}), ...(w.requestId !== undefined ? { requestId: w.requestId } : {}),
    ...(w.beforeId !== undefined ? { beforeId: w.beforeId } : {}) };
  const drops = new Set(versionRetentionDrops([...state.rows, row], w.at, newId));
  const contentIsNew = !state.contents.has(content.digest);
  if (!contentIsNew) return { action: 'insert', contentIsNew, drops: [...drops] };

  const over = (): SessionVersionPutPlan => recyclable ? { action: 'skip' } : { action: 'refuse', reason: 'version-space' };
  const sessionTotal = [...state.contents.values()].reduce((a, b) => a + b, 0);
  const sessionKept = (): number => {
    const live = new Set(state.rows.filter((r) => !drops.has(r.id)).map((r) => r.digest));
    return [...state.contents].reduce((sum, [digest, bytes]) => sum + (live.has(digest) ? bytes : 0), 0);
  };
  const sessionNeed = sessionKept() + content.bytes - limits.sessionMaxBytes;
  if (sessionNeed > 0) {
    const plan = versionEvictionPlan(state.rows, (_s, digest) => state.contents.get(digest) ?? 0, sessionNeed, drops);
    if (!plan) return over();
    for (const id of plan) drops.add(id);
  }
  // Only this document's rows have been dropped so far, so the instance has lost
  // exactly what this document has.
  const instanceNeed = (await state.instanceBytes()) - (sessionTotal - sessionKept()) + content.bytes - limits.instanceMaxBytes;
  if (instanceNeed > 0) {
    const instance = await state.instanceRows();
    const plan = versionEvictionPlan(instance.rows, (s, digest) => instance.contents.get(`${s} ${digest}`) ?? 0, instanceNeed, drops);
    if (!plan) return over();
    for (const id of plan) drops.add(id);
  }
  return { action: 'insert', contentIsNew, drops: [...drops] };
}

/**
 * One per-group catalog-submit quota counter (plans/31 section 3). `scope` is a
 * group name, or '*' for a submitter who belongs to no group at all. A
 * submission is charged to every group its submitter is in, so extra
 * memberships can only ever tighten a member's budget.
 */
export interface SubmitQuotaRow {
  scope: string;
  bytes: number;
  count: number;
  updatedAt: string;
}

/** One person's read state for one document's comments (plan 76 M4, migration
 *  0051). `reads` maps a thread id to the time it was last read; a message
 *  older than its thread's read time, or older than `floorAt`, counts as read.
 *  Private to the person. */
export interface CommentReadState { reads: Record<string, string>; floorAt: string }

/** One inbox notice per person per thread (migration 0052). It holds ids and a
 *  count only: the inbox builds the title, excerpt and names when it is read. */
export interface CommentNotice {
  id: string; userId: string; threadId: string; sessionId: string; projectId: string;
  kind: 'mention' | 'reply'; actorId: string; messageId: string; count: number; createdAt: string;
}
/** A notice write. `at` becomes `createdAt`; `mentioned` makes the row a
 *  mention, and a mention row stays one. */
export type CommentNoticeWrite = Omit<CommentNotice, 'id' | 'count' | 'createdAt'> & { at: string; mentioned: boolean };

/** The highest `count` a notice reaches; later updates keep it there. */
export const COMMENT_NOTICE_COUNT_MAX = 1000;
/** How many notices `listCommentNotices` returns when no limit is given. */
export const COMMENT_NOTICE_LIST_LIMIT = 200;

/** The id of a person's notice for a thread: `cn_` and the first 24 hex
 *  characters of sha256(`<userId> <threadId>`). Both drivers derive it, so a
 *  retried write updates the same row. */
export function commentNoticeId(userId: string, threadId: string): string {
  return `cn_${sha256Hex(`${userId} ${threadId}`).slice(0, 24)}`;
}
/** `listCommentNotices`' row limit: the default when absent or not a number. */
export function noticeListLimit(limit: number | undefined): number {
  return typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : COMMENT_NOTICE_LIST_LIMIT;
}
/** `pruneCommentNotices`' keep count. A count that is not a whole number of
 *  zero or more is refused, so a bad argument never deletes a whole inbox. */
export function noticeKeepCount(keep: number): number {
  if (!Number.isSafeInteger(keep) || keep < 0) throw new RangeError('keep must be a whole number of zero or more');
  return keep;
}

export interface Store extends RenderStore, PasskeyStore {
  getCommentThread(id: string): Promise<CommentThread | null>;
  listCommentThreads(sessionId: string): Promise<CommentThread[]>;
  createCommentThread(thread: CommentThread): Promise<'created' | 'exists' | 'limit'>;
  casCommentThread(thread: CommentThread, expectedRevision: number): Promise<boolean>;
  /** The threads with these ids, in the order first given; unknown ids are
   *  skipped. One read, for the inbox. */
  getCommentThreadsByIds(ids: string[]): Promise<CommentThread[]>;

  // Comment reads and inbox notices (plan 76 M4, migrations 0051 and 0052).
  /** The person's read times for this document's threads. The first call for
   *  a (person, document) pair records the floor at the current time; later
   *  calls return that floor unchanged. An unknown person or document records
   *  nothing and reports the current time as the floor. */
  readCommentState(userId: string, sessionId: string): Promise<CommentReadState>;
  /** Mark threads read: each read time becomes the later of the stored one and
   *  `at` (never later than now). Threads that are not in this document, and
   *  entries with an invalid time, are ignored. */
  markCommentsRead(userId: string, sessionId: string, entries: { threadId: string; at: string }[]): Promise<void>;
  /** Insert or update the person's notice for the thread. An update with a new
   *  `messageId` adds one to `count` (up to COMMENT_NOTICE_COUNT_MAX) and moves
   *  the notice to `at` when that is later; a retry with the same `messageId`
   *  leaves the count as it is. `kind` becomes 'mention' when `mentioned` is
   *  true or the row is already a mention. Throws when the person, thread,
   *  document or project does not exist. */
  upsertCommentNotice(n: CommentNoticeWrite): Promise<'created' | 'updated'>;
  /** The person's notices, newest first (then by id), at most `limit`
   *  (default COMMENT_NOTICE_LIST_LIMIT). */
  listCommentNotices(userId: string, limit?: number): Promise<CommentNotice[]>;
  /** Delete the person's notices that match any of the given ids, threads or
   *  documents. Only that person's rows; with nothing given, nothing goes.
   *  Returns how many went. */
  deleteCommentNotices(userId: string, by: { ids?: string[]; threadIds?: string[]; sessionIds?: string[] }): Promise<number>;
  /** Notices whose newest event this actor caused at or after `sinceIso`. The
   *  database backstop for the in-memory per-actor cap. */
  countNoticesByActorSince(actorId: string, sinceIso: string): Promise<number>;
  /** Delete the person's notices beyond the newest `keep` and those older than
   *  `olderThanIso`. Returns how many went. */
  pruneCommentNotices(userId: string, keep: number, olderThanIso: string): Promise<number>;
  /** Record that these people were told about a mention in this message, and
   *  return only those never recorded before, in the order given. Unknown
   *  people and an unknown thread are skipped. */
  recordMentionSends(threadId: string, messageId: string, userIds: string[], at: string): Promise<string[]>;
  /** Forget that these people were told about a mention in this message, for
   *  sends recorded by a write that then wrote them no notice (over a cap,
   *  refused, or failed), so a later edit of the message can still tell them.
   *  Returns how many went. */
  forgetMentionSends(threadId: string, messageId: string, userIds: string[]): Promise<number>;

  configureRoleGroups(mapping: RoleGroups): void;
  readonly storageKind: 'memory' | 'postgres';
  readonly brandPersistence: 'durable' | 'ephemeral';
  getBrandState(): Promise<import('../brand/state.ts').BrandState>;
  /** Commit state and its audit event together, or return null on a stale revision. */
  casBrandState(expected: number, next: Omit<import('../brand/state.ts').BrandState, 'revision'>,
    audit: AuditEventBody): Promise<import('../brand/state.ts').BrandState | null>;
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
  /** Every user row carrying this email, compared case-insensitively. Subs
   *  are namespaced per IdP and email is not unique, so one person can hold
   *  several rows; admission reads them all (plans/74: a disabled row refuses
   *  every other sign-in with the same address). */
  findUsersByEmail(email: string): Promise<UserRecord[]>;
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

  // SCIM provisioning tokens (plans/31 §8). One bearer per IdP connector, stored
  // hashed; the secret is shown once at mint and never recoverable.
  putScimToken(rec: ScimTokenRecord): Promise<void>;
  listScimTokens(): Promise<ScimTokenRecord[]>;
  /** The token whose secret hashes to this, or null - the SCIM auth lookup. A
   *  revoked token is still RETURNED (its `revokedAt` is set); the caller
   *  refuses it, so revocation reads as one fact in one place. */
  findScimTokenByHash(tokenHash: string): Promise<ScimTokenRecord | null>;
  /** Stamp last-used after a token authenticates a request. */
  touchScimToken(id: string, at: string): Promise<void>;
  /** Set `revokedAt`; returns false when there is no such live token to revoke. */
  revokeScimToken(id: string, at: string): Promise<boolean>;

  // Invitations (plans/74 W-ID-2). One active (unrevoked) row per email.
  /** Insert unless the email already has an active invitation, in which case
   *  that one is returned with `created: false`. A pending one that has expired
   *  by `rec.createdAt` is revoked at that instant first, so a fresh invitation
   *  can replace it. */
  createInvitation(rec: NewInvitationRecord): Promise<{ invitation: InvitationRecord; created: boolean }>;
  /** Every invitation, newest first, revoked ones included. */
  listInvitations(): Promise<InvitationRecord[]>;
  getInvitation(id: string): Promise<InvitationRecord | null>;
  /** The active (unrevoked) invitation for this email, pending or accepted,
   *  expired or not: the caller decides what an expired one means. */
  findActiveInvitation(email: string): Promise<InvitationRecord | null>;
  /** Revoke an active invitation; returns the revoked row, or null when there
   *  was no active one with this id. With `pendingOnly`, an accepted row is
   *  left alone too (null), so a revoke racing an acceptance never undoes it. */
  revokeInvitation(id: string, at: string, opts?: { pendingOnly?: boolean }): Promise<InvitationRecord | null>;
  /** The invitations still waiting for their person (not revoked, not
   *  accepted, not expired at `now`) that carry this project, newest first.
   *  One indexed read, never the whole table. */
  listOpenInvitationsForProject(projectId: string, now: string): Promise<InvitationRecord[]>;
  /** Mark a pending, unexpired, unrevoked invitation accepted by this user at
   *  `at`. Exactly once: returns null when another sign-in got there first or
   *  the row is no longer pending. */
  acceptInvitation(id: string, userId: string, at: string): Promise<InvitationRecord | null>;
  /** Replace the projects a PENDING invitation carries (not revoked, not
   *  accepted). Returns the updated row, or null when there is no such
   *  pending invitation. The caller merges; the store stores. */
  setInvitationProjects(id: string, projects: InvitationProject[]): Promise<InvitationRecord | null>;
  /** Take one project off a PENDING invitation (not revoked, not accepted)
   *  that carries it, in one atomic step. With `revokeWhenEmpty`, an
   *  invitation left with no projects and no groups is revoked at `at` in
   *  the same step. Returns the row as written (`revokedAt` set when it was
   *  revoked), or null when no pending invitation with this id carries the
   *  project. */
  dropInvitationProject(id: string, projectId: string, at: string, opts?: { revokeWhenEmpty?: boolean }): Promise<InvitationRecord | null>;
  /** "New link" (migration 0043): raise `linkVersion` by one and clear
   *  `openedAt` on an active (unrevoked), unaccepted row, so every link
   *  copied before stops working. Returns the new row, or null. */
  rotateInvitationLink(id: string): Promise<InvitationRecord | null>;
  /** Set `openedAt` once, on an unrevoked row: true only for the call that
   *  set it, so the first start from the invite page is audited once. */
  markInvitationOpened(id: string, at: string): Promise<boolean>;
  /** Turn the one-link password setup on or off for an active, unaccepted
   *  row. Returns the updated row, or null. */
  setInvitationPasswordSetup(id: string, on: boolean): Promise<InvitationRecord | null>;
  /** The invitations a project's people panel lists: not revoked, not
   *  accepted, carrying the project, and either pending at `now` (no expiry,
   *  or one after `now`) or expired after `expiredSince`. Newest first.
   *  `listOpenInvitationsForProject` stays for its own callers. */
  listProjectInvitations(projectId: string, q: { now: string; expiredSince: string }): Promise<InvitationRecord[]>;
  /** The newest unrevoked invitation this account accepted, or null. */
  findInvitationAcceptedBy(userId: string): Promise<InvitationRecord | null>;

  // Access requests (plans/75 G13; migration 0044). One open row per
  // (kind, email, project, invitation); a row past its expiry reads as
  // expired and is never answered.
  /** File a request. In one step, an open row for the same key whose expiry
   *  has passed by `now` is marked 'expired', then the row is inserted unless
   *  a live open one exists. Returns the live open row either way; `created`
   *  is true only when this call inserted it. */
  createAccessRequest(rec: AccessRequestRecord, now: string): Promise<{ request: AccessRequestRecord; created: boolean }>;
  getAccessRequest(id: string): Promise<AccessRequestRecord | null>;
  listAccessRequests(q: AccessRequestQuery): Promise<AccessRequestRecord[]>;
  /** Answer one live open request (open and unexpired at `now`). Exactly one
   *  of two racing calls gets the row; the other gets null, as does a row
   *  that is already answered or expired. */
  answerAccessRequest(id: string, a: AccessRequestAnswer, now: string): Promise<AccessRequestRecord | null>;
  /** Close every live open request that matches (used for 'superseded'),
   *  returning the rows as written. */
  closeAccessRequests(q: AccessRequestMatch, a: AccessRequestAnswer, now: string): Promise<AccessRequestRecord[]>;
  countAccessRequests(q: AccessRequestCount): Promise<number>;

  // Linked sign-ins (plans/74, "One person, many sign-ins"; migration 0039).
  /** The user this sign-in is linked to, or null. */
  getUserByIdentity(identitySub: string): Promise<UserRecord | null>;
  /** Insert the link, or refresh an existing link to the SAME user (email,
   *  emailVerified, idp and lastLoginAt are updated; linkedAt is kept).
   *  Returns null, writing nothing, when the identity belongs to another user
   *  (a link row, or that user's own `users.sub`) or the user does not exist. */
  linkIdentity(rec: UserIdentityRecord): Promise<{ identity: UserIdentityRecord; created: boolean } | null>;
  /** Every sign-in linked to this user, oldest link first. */
  listIdentities(userId: string): Promise<UserIdentityRecord[]>;
  /** Remove one link of this user's; false when there was no such row. The
   *  "never the last one" rule is the caller's. */
  unlinkIdentity(userId: string, identitySub: string): Promise<boolean>;
  /** Users holding at least one VERIFIED identity with this email, compared
   *  lowercased, each user once. Sign-in links by email only when exactly
   *  one comes back. */
  findUsersByVerifiedEmail(email: string): Promise<UserRecord[]>;

  // Email and password sign-in (plans/74; migration 0042). Emails are
  // compared lowercased.
  getPasswordCredential(email: string): Promise<PasswordCredentialRecord | null>;
  /** Insert the credential for `rec.email`, or replace the hash of the one
   *  already there (keeping its id and createdAt). Either way the failure
   *  count and any lock are cleared, and `ownerIssued` is set as given.
   *  Returns the row as stored. */
  putPasswordCredential(rec: { id: string; email: string; hash: string; at: string; ownerIssued: boolean }): Promise<PasswordCredentialRecord>;
  /** Replace the hash only while it is still `oldHash` (a rehash after a
   *  successful sign-in must not undo a reset made meanwhile). True when it
   *  was replaced. */
  rehashPasswordCredential(email: string, oldHash: string, newHash: string, at: string): Promise<boolean>;
  /**
   * Count one sign-in attempt BEFORE its password is checked, in one atomic
   * step, so a burst of parallel guesses cannot all read "not locked". A
   * locked credential (locked_until after `at`) is left as it is, so guesses
   * during a lock neither count nor renew it. The attempt that brings the
   * count to `maxFailures` locks the credential until `at + lockMs` and
   * starts the count again from zero; that attempt is still checked. A
   * success clears everything (`clearPasswordFailures`).
   */
  reservePasswordAttempt(email: string, at: string, opts: { maxFailures: number; lockMs: number }): Promise<PasswordAttempt>;
  /** Clear the attempt count and any lock: a successful sign-in, or an admin's unlock. */
  clearPasswordFailures(email: string): Promise<void>;
  /** Remove a credential by id, with the unused links for its email (removing
   *  the sign-in, plans/74). Returns the removed row, or null. */
  deletePasswordCredential(id: string): Promise<PasswordCredentialRecord | null>;
  /** Remove the unused links for an email ("Disable access"). Returns how many went. */
  revokePasswordLinks(email: string): Promise<number>;
  /** Store a new link. Earlier unused links for the same email are removed
   *  in the same step, so only the newest one works, even when two are
   *  issued at once; expired rows are pruned on the way. */
  createPasswordLink(rec: PasswordLinkRecord): Promise<void>;
  /** The link with this token hash when it is unused and unexpired at `at`, else null. */
  findLivePasswordLink(tokenHash: string, at: string): Promise<PasswordLinkRecord | null>;
  /** Mark the link used at `at`, exactly once: null when it is already used,
   *  expired or unknown, so two racing uses cannot both succeed. */
  consumePasswordLink(tokenHash: string, at: string): Promise<PasswordLinkRecord | null>;

  // Service tokens (plans/35 wave 2) - same contract shapes as the SCIM set.
  putApiToken(rec: ApiTokenRecord): Promise<void>;
  listApiTokens(): Promise<ApiTokenRecord[]>;
  findApiTokenByHash(tokenHash: string): Promise<ApiTokenRecord | null>;
  touchApiToken(id: string, at: string): Promise<void>;
  revokeApiToken(id: string, at: string): Promise<boolean>;

  // Durable automation jobs (plans/39 and 40). All reads are principal-scoped
  // except the runner claim, which atomically leases the oldest queued job.
  putAutomationJob(job: AutomationJobRecord): Promise<void>;
  getAutomationJob(id: string, principal: string): Promise<AutomationJobRecord | null>;
  listAutomationJobs(principal: string): Promise<AutomationJobRecord[]>;
  findAutomationJobByIdempotency(principal: string, key: string): Promise<AutomationJobRecord | null>;
  deleteAutomationJob(id: string, principal: string): Promise<boolean>;
  claimAutomationJob(owner: string, verbs: string[], leaseMs: number): Promise<AutomationJobRecord | null>;
  renewAutomationJob(job: AutomationJobRecord, leaseMs: number): Promise<boolean>;
  saveClaimedAutomationJob(job: AutomationJobRecord): Promise<boolean>;

  // Organization delivery history. Reads and idempotency lookup are scoped to
  // the requesting principal; destination credentials never enter this store.
  putDelivery(delivery: DeliveryRecord): Promise<void>;
  getDelivery(id: string, principal: string): Promise<DeliveryRecord | null>;
  listDeliveries(principal: string): Promise<DeliveryRecord[]>;
  findDeliveryByIdempotency(principal: string, key: string): Promise<DeliveryRecord | null>;
  findDeliveryBySourceJob(principal: string, jobId: string): Promise<DeliveryRecord | null>;

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

  // injectables - the governed rail that injects tools / flags / typed resources /
  // declarative chrome into the shell (plans/19). Keyed by id; put is an upsert,
  // delete is a hard purge (routes soft-revoke via put with state:'revoked').
  listInjectables(): Promise<InjectableRecord[]>;
  getInjectable(id: string): Promise<InjectableRecord | null>;
  putInjectable(rec: InjectableRecord): Promise<void>;
  deleteInjectable(id: string): Promise<void>;

  // schema readiness - migration files not yet applied. Read-only (issues no
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
  /** Install the keyed-MAC key (audit/chain.ts deriveAuditMacKey) so every
   *  row appended from now on carries a `mac`. Optional: a demo or test store
   *  may run unkeyed. */
  setAuditMacKey?(key: string): void;
  /** Append only while the log still ends at `expectedTail` (null = empty),
   *  under the same lock as appendAudit; null when another writer came first
   *  and nothing was written. The retired-key boundary (audit/retire.ts) must
   *  directly follow the row it names, so a lost race must write no row. */
  appendAuditIfTail?(expectedTail: { seq: number; hash: string } | null, body: AuditEventBody): Promise<AuditEvent | null>;
  listAudit(): Promise<AuditEvent[]>;
  /** The `limit` newest events with seq < before (before <= 0 ⇒ the newest page), ascending - the console's audit pager. */
  listAuditBefore(before: number, limit: number, filter?: AuditFilter): Promise<AuditEvent[]>;
  countAudit(filter?: AuditFilter): Promise<number>;
  /** Readiness: can the store answer right now? Memory always can; Postgres runs `select 1`. */
  ping(): Promise<boolean>;
  /** Events with seq > after, ascending, at most limit - the SIEM forwarder's
   *  read (plans/35 wave 2), so forwarding never loads the whole log. */
  listAuditAfter(after: number, limit: number): Promise<AuditEvent[]>;
  /** The SIEM delivery cursor: the highest seq confirmed received (0 = none). */
  getSiemCursor(): Promise<number>;
  setSiemCursor(seq: number): Promise<void>;
  /** Retention (plans/35 wave 3). The anchor is written BEFORE a trim deletes
   *  its rows, so verification survives an interruption between the two. */
  getAuditAnchor(): Promise<AuditAnchor | null>;
  setAuditAnchor(anchor: AuditAnchor): Promise<void>;
  /** Delete audit rows with seq <= uptoSeq; returns how many went. */
  trimAudit(uptoSeq: number): Promise<number>;
  /** Delete telemetry events older than beforeIso; returns how many went. */
  trimTelemetry(beforeIso: string): Promise<number>;
  /** Erasure (plans/35 wave 3): drop the id->identity mapping from stored
   *  telemetry - events stay, attribution goes. Returns how many were scrubbed. */
  scrubTelemetryUser(userId: string): Promise<number>;
  /** Erasure: delete the user row itself. False when the id is unknown. */
  deleteUser(id: string): Promise<boolean>;
  /** Counts the relational references that prevent deleting the identity row.
   * This is an account-erasure preview, not a full personal-data inventory. */
  previewUserErasure(id: string): Promise<{ references: Record<'projects' | 'sessions' | 'links' | 'approvals' | 'messageAcks' | 'projectFiles', number>; telemetryEvents: number }>;
  /** Atomic identity deletion + telemetry de-attribution. Referential blocks
   * leave BOTH untouched; callers must never imply shared content was erased.
   * The email's invitations, password credential and password links go with
   * the account unless another account still carries that email. The
   * credentials the account's own password sign-ins name go with it
   * whatever their address, with their addresses' unused links. So do the
   * account's access requests, and the requests for the email when no other
   * account carries it. */
  eraseUserAccount(id: string): Promise<{ status: 'erased'; scrubbed: number } | { status: 'referenced' } | { status: 'not-found' }>;

  // Device sign-in codes (plans/35 wave 5) - store-backed so any replica can
  // answer the poll and serverless gains the flow. iam/device-auth.ts owns
  // the semantics; these are its persistence.
  putDeviceCode(rec: DeviceCodeRecord): Promise<void>;
  /** The live PENDING row behind a user code (unexpired), or null. */
  getPendingDeviceCode(userCode: string): Promise<DeviceCodeRecord | null>;
  /** Move a pending, unexpired code to approved/denied. False when there is
   *  no such pending code to settle. */
  settleDeviceCode(userCode: string, status: 'approved' | 'denied', userPayload?: Record<string, unknown>): Promise<boolean>;
  /** The device's poll. Atomic single-read: a settled row is deleted as it is
   *  returned, so a replayed deviceCode reads as expired. */
  claimDeviceCode(deviceCode: string): Promise<DeviceClaimResult>;
  listPendingDeviceCodes(): Promise<DeviceCodeRecord[]>;

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
   * un-notifiable - a 201 that silently reaches nobody. Deliberately NOT folded
   * into `putMessage`: an admin fixing a typo in an announcement must not
   * re-raise it for everyone who already dismissed it.
   */
  clearAck(messageId: string, userId: string): Promise<void>;
  acksFor(userId: string): Promise<Set<string>>;
  ackCounts(): Promise<Map<string, number>>;

  // fleet
  recordClient(info: ClientInfo): Promise<void>;
  fleetSummary(): Promise<FleetRow[]>;
  /** Upsert from an authenticated, install-tagged request: create on first
   *  sight, else refresh info / user / lastSeen. `name` survives the refresh -
   *  the operator set it, the device did not. NEVER called pre-auth (the app
   *  layer resolves the member first; anonymous and guest traffic only ever
   *  feeds the histogram). */
  upsertInstall(installId: string, info: ClientInfo, userId: string): Promise<void>;
  listInstalls(): Promise<InstallRow[]>;
  /** Operator bookkeeping; null clears the name. Returns the updated row, or
   *  null when the id is unknown. */
  renameInstall(installId: string, name: string | null): Promise<InstallRow | null>;
  /** A row delete, nothing more - no remote action exists. Idempotent. */
  forgetInstall(installId: string): Promise<void>;

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
  /** Remove a lifecycle row (the exit's cutover moves it to the inst id). */
  deleteLifecycle(assetId: string): Promise<void>;

  // catalog content-credential detections (plans/27 §4)
  putCredential(row: CredentialRow): Promise<void>;
  getCredential(assetId: string): Promise<CredentialRow | null>;
  listCredentials(): Promise<CredentialRow[]>;
  deleteCredential(assetId: string): Promise<void>;

  // instance assets + catalog aliases (plans/26 §4, plans/27 §5)
  putInstanceAsset(rec: InstanceAssetRecord): Promise<void>;
  getInstanceAsset(id: string): Promise<InstanceAssetRecord | null>;
  listInstanceAssets(): Promise<InstanceAssetRecord[]>;
  deleteInstanceAsset(id: string): Promise<void>;
  putAlias(fromId: string, toId: string): Promise<void>;
  getAlias(fromId: string): Promise<string | null>;
  listAliases(): Promise<Array<{ fromId: string; toId: string }>>;

  // org-defined asset metadata (plans/31 section 4, migrations/0018). The
  // DEFINITIONS are policy - the policy-as-code document exports and applies
  // them, so these three methods are what that commit writes through - and the
  // VALUES are a local overlay keyed by catalog asset id, which is what makes
  // them work uniformly for inst/*, ext/* and pack ids.
  listCatalogFields(): Promise<CatalogFieldDef[]>;
  putCatalogField(def: CatalogFieldDef): Promise<void>;
  /** Remove a DEFINITION. Stored values keyed by it are left alone: the served
   *  bag filters to live definitions, so retiring one hides its values and
   *  re-adding it brings them back, which a cascading delete could never do. */
  deleteCatalogField(id: string): Promise<void>;
  getAssetMeta(assetId: string): Promise<AssetMetaRecord | null>;
  putAssetMeta(rec: AssetMetaRecord): Promise<void>;
  listAssetMeta(): Promise<AssetMetaRecord[]>;
  deleteAssetMeta(assetId: string): Promise<void>;

  // instance asset versions (plans/31 section 6, migrations/0020). Immutable
  // snapshots of one asset's format set, keyed (assetId, version). The HEAD is
  // `headVersion` on the instance-asset record rather than a flag here, so a
  // rollback is one record write and two heads are unrepresentable.
  listAssetVersions(assetId: string): Promise<AssetVersionRecord[]>;
  getAssetVersion(assetId: string, version: number): Promise<AssetVersionRecord | null>;
  putAssetVersion(rec: AssetVersionRecord): Promise<void>;
  /** Unknown (assetId, version) is a no-op. Numbers are never reused after a
   *  delete: a bearer may hold a ?v=N URL, and handing them different bytes
   *  under the same number would be worse than a 404. */
  deleteAssetVersion(assetId: string, version: number): Promise<void>;

  // catalog collections (plans/31 section 5, migrations/0019). A named, ordered
  // set of catalog asset ids with group visibility. Members are ids, never
  // rows: a member may be an inst/*, ext/* or pack asset, and the order is the
  // curator's, so the whole record rides as one document.
  listCollections(): Promise<CollectionRecord[]>;
  getCollection(id: string): Promise<CollectionRecord | null>;
  putCollection(rec: CollectionRecord): Promise<void>;
  /** Unknown id is a no-op. Deleting a collection never touches its members:
   *  it was a list of names, and the assets it named are ordinary catalog
   *  assets that were never owned by it. */
  deleteCollection(id: string): Promise<void>;

  // catalog submit quota (plans/31 section 3, migrations/0017). Counters are
  // cumulative for everything that was KEPT - a returned submission still spent
  // the bytes it was stored with - and the only negative delta is a charge
  // being released because the submission it was made for was refused.
  /**
   * Add to a scope's counters and return the row AFTER the add, creating it when
   * absent. ONE statement on purpose: two concurrent submissions must not both
   * read the same pre-value and lose one of the two charges, which is exactly
   * how a quota gets walked past. The returned row is also what ENFORCES the
   * cap: submit charges first and reads the post-add value, so a separate
   * earlier read can never be the thing a concurrent submission slips past.
   * Negative deltas are legal for exactly one caller - releasing a charge whose
   * submission was then refused.
   */
  addSubmitQuota(scope: string, bytes: number, count: number): Promise<SubmitQuotaRow>;
  getSubmitQuota(scope: string): Promise<SubmitQuotaRow | null>;
  listSubmitQuota(): Promise<SubmitQuotaRow[]>;

  // catalog providers (plans/17). Config, credential, and state move through
  // separate methods so the write-only credential path and the sync path can
  // never clobber each other: putProvider upserts config fields ONLY,
  // preserving any stored credential and runtime state on update.
  /** Metadata-only reads keep the potentially large fragment in its existing
   *  federation cache; credentials and governance are still read fresh. */
  listProviders(options?: { includeFragment?: boolean }): Promise<ProviderRecord[]>;
  getProvider(id: string, options?: { includeFragment?: boolean }): Promise<ProviderRecord | null>;
  putProvider(rec: ProviderRecord): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  /** null clears the stored credential. */
  putProviderCredential(
    id: string,
    cred: { ciphertext: Uint8Array; fingerprint: string; updatedAt: string; expiresAt?: string } | null,
  ): Promise<void>;
  putProviderState(id: string, state: ProviderState): Promise<void>;

  // projects + sessions (plans/08)
  putProject(project: ProjectRecord): Promise<void>;
  getProject(id: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  putProjectFolder(folder: ProjectFolderRecord): Promise<void>;
  listProjectFolders(projectId: string): Promise<ProjectFolderRecord[]>;
  /** Remove a container, moving its contents and child folders to its parent. */
  /** Moves a folder within its project, refusing cycles and foreign parents. */
  moveProjectFolder(projectId: string, folderId: string, parentId: string | null): Promise<'moved' | 'missing' | 'invalid'>;
  deleteProjectFolder(projectId: string, folderId: string): Promise<boolean>;
  assignProjectFolderItem(projectId: string, folderId: string | null, kind: 'session' | 'file', ref: string): Promise<void>;

  // shared project files (plans/74, migration 0041). Budgets and the pending
  // limits count ready files and unfinished uploads that have not expired; an
  // expired upload counts for nothing and is swept (projects/files.ts). A
  // budget counts each file at `projectFileCharge` (its size plus a fixed
  // overhead); the pending limits count declared sizes.
  /** Insert an unfinished upload when the project budget, the instance budget
   *  and the uploader's pending limits all still allow it. Atomic across every
   *  project, so parallel reservations in two projects cannot both pass the
   *  instance budget. */
  reserveProjectFile(file: ProjectFileRecord, limits: ProjectFileLimits): Promise<ProjectFileReservation>;
  getProjectFile(id: string): Promise<ProjectFileRecord | null>;
  /** Ready files of one project, newest first (createdAt desc, then id). */
  listProjectFiles(projectId: string): Promise<ProjectFileRecord[]>;
  /** Unfinished uploads, earliest expiry first, filtered before applying the limit. */
  listUnfinishedProjectFiles(filter: { createdBy?: string; projectId?: string; expiredBy?: string; activeAt?: string }, limit: number): Promise<ProjectFileRecord[]>;
  /** The bytes the budgets see right now, for one project and the instance. */
  projectFileUsage(projectId: string): Promise<{ projectBytes: number; instanceBytes: number }>;
  /** Move an unfinished upload's expiry out to `expiresAt`, never earlier.
   *  False when the file is gone or its upload has expired; true for a ready
   *  file, which keeps no expiry. */
  touchProjectFile(id: string, expiresAt: string): Promise<boolean>;
  /** Mark ready. False when unknown, or when an unfinished upload has expired. */
  completeProjectFile(id: string): Promise<boolean>;
  /** The row only; the caller deletes the parts first. False when unknown. */
  deleteProjectFile(id: string): Promise<boolean>;
  /** Live sessions of the project whose inputs mention the file's asset id
   *  (`user/team/<fileId>`), without their inputs. */
  listSessionsUsingProjectFile(projectId: string, fileId: string): Promise<SessionSummary[]>;

  // project members (plans/74, migration 0040)
  /** Every explicit member of one project, oldest first. */
  listProjectMembers(projectId: string): Promise<ProjectMemberRecord[]>;
  getProjectMember(projectId: string, userId: string): Promise<ProjectMemberRecord | null>;
  /** Stores a delegated credential; at most 16 live document and project keys per creator. */
  createDocumentAgent(record: DocumentAgentRecord): Promise<boolean>;
  getDocumentAgent(id: string): Promise<DocumentAgentRecord | null>;
  findDocumentAgentByHash(hash: string): Promise<DocumentAgentRecord | null>;
  listDocumentAgents(sessionId: string): Promise<DocumentAgentRecord[]>;
  /** Invalidates the credential without changing the inviter's account or membership. */
  revokeDocumentAgent(id: string, at: string): Promise<void>;
  createProjectAgent(record: ProjectAgentRecord): Promise<boolean>;
  getProjectAgent(id: string): Promise<ProjectAgentRecord | null>;
  findProjectAgentByHash(hash: string): Promise<ProjectAgentRecord | null>;
  listProjectAgents(projectId: string): Promise<ProjectAgentRecord[]>;
  revokeProjectAgent(id: string, at: string): Promise<void>;
  /** Creation and its retry receipt commit together; retries never replace an edited session. */
  createAgentSession(session: SessionRecord, agentId: string, requestId: string, digest: string): Promise<'created' | 'replayed' | 'conflict' | 'refused'>;
  /** Every project this user is an explicit member of: one read for a list. */
  listUserProjectMemberships(userId: string): Promise<ProjectMemberRecord[]>;
  /** Insert, or change the role of an existing row. `addedBy`/`addedAt` of an
   *  existing row are kept: they record who first added the person. */
  putProjectMember(rec: ProjectMemberRecord): Promise<void>;
  /** Change the role of an EXISTING row only; returns the updated row, or
   *  null (writing nothing) when there is no such row. Never inserts, so a
   *  role change racing a removal cannot put the person back. */
  updateProjectMemberRole(projectId: string, userId: string, role: ProjectMemberRole): Promise<ProjectMemberRecord | null>;
  /** False when there was no such row. */
  deleteProjectMember(projectId: string, userId: string): Promise<boolean>;
  /** The users with these ids, in no particular order; unknown ids are
   *  skipped. One read for a list that names several people. */
  getUsersByIds(ids: string[]): Promise<UserRecord[]>;
  putSession(session: SessionRecord): Promise<void>;
  /**
   * Compare-and-set on `rev`: writes `next` only if the stored row is still at
   * `expectedRev` and is NOT tombstoned. Returns false when it is not, having
   * written nothing.
   *
   * This is the write a concurrent editor needs and `putSession` cannot be. A
   * read-modify-write over `putSession` has an await between the read and the
   * write, so two writers both read rev 5 and both write rev 6 - the second
   * silently discarding the first, and `session_revisions` (whose PK is
   * `(session_id, rev)`) keeping only one of the two, so history and
   * `sessions.inputs` end up disagreeing. The tombstone exclusion is part of the
   * contract rather than a caller's job: `putSession` writes `deleted_at` from the
   * record it is handed, so a record read BEFORE a DELETE resurrects the session
   * when written after it. A CAS never resurrects and never touches `deleted_at`.
   *
   * It is also false while a live room holds the session's collab lease, whatever
   * the rev. `collabLeaseActive` tells that refusal from a revision conflict.
   */
  casSession(next: SessionRecord, expectedRev: number): Promise<boolean>;
  /** Returns the record even when tombstoned (deletedAt set) so callers choose
   *  the response (404 vs 410); null only when the id is unknown. */
  getSession(id: string): Promise<SessionRecord | null>;
  /** Excludes tombstoned sessions. */
  listSessions(projectId: string): Promise<SessionRecord[]>;
  /** `listSessions` without `inputs`, for listings: a session holds a whole
   *  tool document (up to 4 MiB), and a list row never shows one. */
  listSessionSummaries(projectId: string): Promise<SessionSummary[]>;
  /** Live-session count and newest `updatedAt` per project, computed without
   *  reading any session's inputs. A project with no live session has no
   *  entry. `projectId` narrows the answer to that one project. */
  projectSessionStats(projectId?: string): Promise<ProjectSessionStats[]>;
  /** Excludes tombstoned sessions; both filters optional (none = all). */
  listSessionsFiltered(filter: { projectId?: string; toolId?: string }): Promise<SessionRecord[]>;
  appendSessionRevision(rev: SessionRevision): Promise<void>;
  /** Newest-first, bounded to SESSION_REVISION_LIMIT. */
  listSessionRevisions(sessionId: string): Promise<SessionRevision[]>;

  // Durable collaboration (0035/0036); the older input-only snapshots follow.
  claimCollab(sessionId: string, owner: string, ttlMs: number): Promise<boolean>;
  releaseCollab(sessionId: string, owner: string): Promise<void>;
  /** True while a room holds the session's collab lease, so `putSession` throws
   *  `collab-active` and `casSession` refuses. False for an unknown id. */
  collabLeaseActive(sessionId: string): Promise<boolean>;
  getCollabCheckpoint(sessionId: string): Promise<{ revision: number; headRevision: number; checkpoint: CanvasCheckpoint } | null>;
  getCollabJournal(sessionId: string, afterRevision: number): Promise<{ revision: number; ops: CanvasOp[] }[]>;
  getCollabReceipts(sessionId: string, principal: string, ids: string[]): Promise<CollabReceipt[]>;
  /** Atomically compare owner + revision, save projection, journal/checkpoint and
   * receipts. A checkpoint compacts its covered journal. It writes no
   * `session_revisions` row: live history is kept as session versions, and the
   * room's quiesce appends one revision. */
  commitCollab(batch: CollabCommit): Promise<number>;
  /** Store the receipts of a batch that accepted nothing, fenced like `commitCollab`
   * (owner, live lease, `expectedRev`, not deleted). Each receipt records `expectedRev`.
   * The session row, journal, checkpoint and history are not changed, so a refused
   * batch adds no revision. Throws when a receipt is marked accepted. */
  commitCollabReceipts(batch: CollabReceiptCommit): Promise<void>;
  putCollabSnapshot(snap: CollabSnapshot): Promise<void>;
  getCollabSnapshot(sessionId: string): Promise<CollabSnapshot | null>;
  /** Unknown id is a no-op. */
  deleteCollabSnapshot(sessionId: string): Promise<void>;

  // Session versions (plan 76 M4 R2, migration 0053).
  /** Set the space caps; a field left out goes back to its default
   *  (VERSION_SESSION_MAX_BYTES, VERSION_INSTANCE_MAX_BYTES). Throws on a value
   *  that is not a whole number above zero. */
  configureVersionLimits(limits: Partial<SessionVersionLimits>): void;
  /**
   * Write a version, applying every rule of `planSessionVersionPut` in one
   * transaction. Idempotent on (session, createdBy, kind, requestId). Returns
   * 'version-limit' for a named version past VERSION_NAMED_PER_PERSON or
   * VERSION_NAMED_PER_SESSION, and 'version-space' for a named, restore or before
   * version that does not fit; an automatic one that does not fit answers with the
   * latest version (`created: false`), or 'version-space' when there is none.
   * Throws `session-gone` for an unknown or deleted session, `version-reference`
   * when `restoredFrom` or `beforeId` is not a version of the same session, and a
   * TypeError for a write the schema refuses (kind, label, rev, shape).
   */
  putSessionVersion(v: SessionVersionWrite): Promise<SessionVersionPut>;
  /** Newest first (by `at`, then id), at most `limit` (1 to VERSION_LIST_MAX).
   *  `before` is a version id: the page starts after it. An id that is not a
   *  version of this session gives an empty page. */
  listSessionVersions(sessionId: string, opts: { before?: string; limit: number }): Promise<SessionVersionSummary[]>;
  /** With its inputs and meta; null when the id is not a version of this session. */
  getSessionVersion(sessionId: string, id: string): Promise<SessionVersion | null>;
  /** Delete one version, and its pair: a restore row's 'before' row, or the
   *  restore rows of a 'before' row. False when it is not a version of this session. */
  deleteSessionVersion(sessionId: string, id: string): Promise<boolean>;
  /** Delete every version and content of the session; returns how many versions went. */
  deleteSessionVersions(sessionId: string): Promise<number>;
}
