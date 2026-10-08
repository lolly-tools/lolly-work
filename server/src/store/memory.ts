import { COMMENT_THREAD_LIMIT, type CommentThread } from '@lolly-tools/core/canvas-review-v1';
import type { CanvasCheckpoint, CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { matchesAudit } from '../audit/filter.ts';
import { activeProjectFile, projectFileAssetId, projectFileCharge, type ProjectFileRecord } from '../projects/files.ts';
import { initialBrandState } from '../brand/state.ts';
import type { CollabReceipt } from './types.ts';
import type { ProjectFolderRecord } from './types.ts';
import type { DocumentAgentRecord, ProjectAgentRecord } from './types.ts';
import {
  newestVersionFirst, normalizeSessionVersionWrite, planSessionVersionPut, resolveVersionLimits, sessionVersionContent, sessionVersionId, versionListLimit,
  type SessionVersion, type SessionVersionLimits, type SessionVersionPut, type SessionVersionRow, type SessionVersionSummary,
} from './types.ts';
import type { ProjectUserStateRecord, ShareGroupRecord } from './types.ts';
/**
 * In-memory Store - dev, tests, and the evaluation container's default.
 * Postgres driver lands beside this (migrations/0001_init.sql is the schema).
 */
import { randomId } from '../lib/crypto.ts';
import { nextEvent, type AuditAnchor, type AuditEvent, type AuditEventBody } from '../audit/chain.ts';
import { clientBucket, type ClientInfo } from '../fleet/client-header.ts';
import { eligibleForCurrentStep, type Approval, type Chain } from '../approvals/engine.ts';
import { roleFromGroups, type Grant, type RoleGroups } from '../rbac/evaluate.ts';
import type { ToolOverlay } from '../policy/overlay.ts';
import type { FlagGovernance } from '../policy/feature-flags.ts';
import type { InjectableRecord } from '../injectables/types.ts';
import type { LinkRecord } from '../links/sign.ts';
import type { StoredEvent } from '../telemetry/ingest.ts';
import type { Message } from '../inbox/target.ts';
import type { LifecycleRow } from '../catalog/lifecycle.ts';
import type { CredentialRow } from '../catalog/credentials.ts';
import type { InstanceAssetRecord } from '../catalog/instance-assets.ts';
import { sortFields, type AssetMetaRecord, type CatalogFieldDef } from '../catalog/asset-meta.ts';
import type { CatalogTagRule } from '../catalog/tag-rules.ts';
import { sortCollections, type CollectionRecord } from '../catalog/collections.ts';
import type { AssetVersionRecord } from '../catalog/versions.ts';
import type { ProviderRecord } from '../catalog/providers/types.ts';
import type { DeliveryRecord } from '../delivery/types.ts';
import { createMemoryPasskeys } from '../iam/passkeys/memory.ts';
import { createMemoryRenderStore } from '../renders/memory.ts';
import {
  COMMENT_NOTICE_COUNT_MAX, SESSION_REVISION_LIMIT, commentNoticeId, effectiveGroups, noticeKeepCount, noticeListLimit,
  type CommentNotice,
  type AccessRequestAnswer, type AccessRequestMatch, type AccessRequestRecord,
  type ApiTokenRecord, type AutomationJobRecord, type CollabSnapshot, type DeviceCodeRecord, type FleetRow, type InstallRow, type InvitationRecord, type LocalGroupRecord, type NewInvitationRecord, type PasswordAttempt, type PasswordCredentialRecord, type PasswordLinkRecord, type ProjectMemberRecord, type ProjectRecord, type ScimTokenRecord, type UserIdentityRecord,
  type SessionRecord, type SessionRevision, type Store, type SubmitQuotaRow, type UserRecord,
} from './types.ts';

// Grants have no exposed id - they're identified by their full tuple.
const sameGrant = (a: Grant, b: Grant): boolean =>
  a.principal === b.principal && a.action === b.action && a.resource === b.resource && a.effect === b.effect;

export function createMemoryStore(seed?: { grants?: Grant[]; overlays?: ToolOverlay[]; messages?: Message[]; flagGovernance?: FlagGovernance[]; injectables?: InjectableRecord[] }): Store {
  let roleGroups: RoleGroups = {};
  const mapped = (user: UserRecord): UserRecord => ({ ...user, role: roleFromGroups(user.groups, roleGroups) });
  let brandState = initialBrandState();
  const users = new Map<string, UserRecord>(); // by sub
  const localGroups = new Map<string, LocalGroupRecord>(); // registry, by name
  const shareGroups = new Map<string, ShareGroupRecord>(); // user-made groups (0060), by id
  const projectUserState = new Map<string, ProjectUserStateRecord>(); // per-person project view (0061)
  const scimTokens = new Map<string, ScimTokenRecord>(); // SCIM provisioning bearers, by id
  const apiTokens = new Map<string, ApiTokenRecord>(); // service tokens (plans/35), by id
  const documentAgents = new Map<string, DocumentAgentRecord>();
  const projectAgents = new Map<string, ProjectAgentRecord>();
  const agentCreations = new Map<string, { digest: string; sessionId: string }>();
  const invitations = new Map<string, InvitationRecord>(); // plans/74 W-ID-2, by id
  const identities = new Map<string, UserIdentityRecord>(); // plans/74 linked sign-ins, by identitySub
  const passwordCredentials = new Map<string, PasswordCredentialRecord>(); // plans/74, by lowercased email
  const passwordLinks = new Map<string, PasswordLinkRecord>(); // plans/74, by token hash
  const accessRequests = new Map<string, AccessRequestRecord>(); // plans/75 G13, by id
  const userById = (id: string): UserRecord | undefined => {
    for (const u of users.values()) if (u.id === id) return u;
    return undefined;
  };
  /** A share group as Postgres would return it after an erasure: an owner
   *  whose account is gone reads as null and gone managers drop out. */
  const liveShareGroup = (g: ShareGroupRecord): ShareGroupRecord => ({
    ...structuredClone(g),
    ownerId: g.ownerId && userById(g.ownerId) ? g.ownerId : null,
    managers: g.managers.filter((m) => userById(m)),
  });
  const passkeys = createMemoryPasskeys(userById);
  const copyInvitation = (r: InvitationRecord): InvitationRecord => ({
    ...r, groups: [...r.groups], projects: (r.projects ?? []).map((p) => ({ ...p })),
  });
  const activeInvitation = (email: string): InvitationRecord | undefined => {
    const e = email.trim().toLowerCase();
    for (const r of invitations.values()) if (r.email === e && !r.revokedAt) return r;
    return undefined;
  };
  const newestFirst = (a: InvitationRecord, b: InvitationRecord): number =>
    (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1);
  // Access requests (migration 0044). A row is "live open" while its status
  // is open and its expiry is after `now`; the key is the partial unique
  // index's (kind, email, project, invitation).
  const REQUEST_ROLE_RANK: Record<string, number> = { viewer: 1, commenter: 2, editor: 3, manager: 4 };
  const liveOpen = (r: AccessRequestRecord, now: string): boolean =>
    r.status === 'open' && Date.parse(r.expiresAt) > Date.parse(now);
  const requestKey = (r: Pick<AccessRequestRecord, 'kind' | 'email' | 'projectId' | 'invitationId'>): string =>
    `${r.kind}\n${r.email}\n${r.projectId ?? ''}\n${r.invitationId ?? ''}`;
  const requestMatches = (r: AccessRequestRecord, q: AccessRequestMatch): boolean =>
    (!q.kind || r.kind === q.kind) && (!q.projectId || r.projectId === q.projectId)
    && (!q.userId || r.userId === q.userId) && (!q.email || r.email === q.email.trim().toLowerCase())
    && (!q.invitationId || r.invitationId === q.invitationId)
    && (!q.roleAtMost || (!!r.role && REQUEST_ROLE_RANK[r.role]! <= REQUEST_ROLE_RANK[q.roleAtMost]!));
  const copyRequest = (r: AccessRequestRecord): AccessRequestRecord => ({ ...r });
  const answerRequest = (r: AccessRequestRecord, a: AccessRequestAnswer): AccessRequestRecord => {
    const next: AccessRequestRecord = {
      ...r, status: a.status, answeredAt: a.at,
      ...(a.by ? { answeredBy: a.by } : {}), ...(a.role ? { answerRole: a.role } : {}),
      ...(a.resultInvitationId ? { resultInvitationId: a.resultInvitationId } : {}),
    };
    accessRequests.set(r.id, next);
    return copyRequest(next);
  };
  /** Postgres cascades a request away with its user, project or invitation. */
  const dropRequestsWhere = (gone: (r: AccessRequestRecord) => boolean): void => {
    for (const [k, r] of accessRequests) if (gone(r)) accessRequests.delete(k);
  };
  const automationJobs = new Map<string, AutomationJobRecord>();
  const deliveries = new Map<string, DeliveryRecord>();
  let siemCursor = 0; // highest audit seq confirmed delivered to the SIEM receiver
  let auditAnchor: AuditAnchor | null = null; // retention trim boundary (plans/35 wave 3)
  let auditMacKey: string | undefined;
  const deviceCodes = new Map<string, DeviceCodeRecord>(); // device sign-in codes, by deviceCode
  const pruneDeviceCodes = (): void => {
    const now = new Date().toISOString();
    for (const [k, r] of deviceCodes) if (r.expiresAt <= now) deviceCodes.delete(k);
  };
  const grants: Grant[] = [...(seed?.grants ?? [])];
  const overlays = new Map<string, ToolOverlay>((seed?.overlays ?? []).map((o) => [o.toolId, o]));
  const flagGovernance = new Map<string, FlagGovernance>((seed?.flagGovernance ?? []).map((g) => [g.id, g]));
  const injectables = new Map<string, InjectableRecord>((seed?.injectables ?? []).map((r) => [r.id, r]));
  const links = new Map<string, LinkRecord>();
  const audit: AuditEvent[] = [];
  const events: StoredEvent[] = [];
  const messages = new Map<string, Message>((seed?.messages ?? []).map((m) => [m.id, m]));
  const acks = new Map<string, Set<string>>(); // userId -> message ids
  const fleet = new Map<string, FleetRow>();
  const installs = new Map<string, InstallRow>();
  const chains = new Map<string, Chain>();
  const approvals = new Map<string, Approval>();
  const lifecycle = new Map<string, LifecycleRow>();
  const credentials = new Map<string, CredentialRow>();
  const instanceAssets = new Map<string, InstanceAssetRecord>();
  const aliases = new Map<string, string>();
  const submitQuota = new Map<string, SubmitQuotaRow>();
  const catalogFields = new Map<string, CatalogFieldDef>();
  const tagRules = new Map<string, CatalogTagRule>();
  const assetMeta = new Map<string, AssetMetaRecord>();
  const collections = new Map<string, CollectionRecord>();
  /** `${assetId} ${version}` (space-joined) - the composite key migration 0020 makes a
   *  primary key. One flat map keeps the memory driver's shape as close to the
   *  SQL one as a Map allows. */
  const assetVersions = new Map<string, AssetVersionRecord>();
  const providers = new Map<string, ProviderRecord>();
  const projects = new Map<string, ProjectRecord>();
  const projectFolders = new Map<string, ProjectFolderRecord>();
  const projectFiles = new Map<string, ProjectFileRecord>();
  // `${projectId} ${userId}` - the composite primary key of migration 0040.
  const projectMembers = new Map<string, ProjectMemberRecord>();
  const memberKey = (projectId: string, userId: string): string => `${projectId} ${userId}`;
  const commentThreads = new Map<string, CommentThread>();
  // Comment reads and notices (migrations 0051, 0052), keyed like their primary keys.
  const commentReads = new Map<string, { userId: string; threadId: string; sessionId: string; readAt: string }>(); // `${userId} ${threadId}`
  const commentReadFloors = new Map<string, string>(); // `${userId} ${sessionId}` -> floor
  const commentNotices = new Map<string, CommentNotice>(); // by id
  const mentionSends = new Map<string, string>(); // JSON [threadId, messageId, userId] -> at
  const noticeOrder = (a: CommentNotice, b: CommentNotice): number =>
    Date.parse(b.createdAt) - Date.parse(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  /** Postgres cascades a person's reads, floors, received notices and mention
   *  sends away with their row; erasure also deletes the notices they caused. */
  const forgetCommentState = (userId: string, asActor: boolean): void => {
    for (const [k, r] of commentReads) if (r.userId === userId) commentReads.delete(k);
    for (const k of commentReadFloors.keys()) if (k.startsWith(`${userId} `)) commentReadFloors.delete(k);
    for (const [k, n] of commentNotices) if (n.userId === userId || (asActor && n.actorId === userId)) commentNotices.delete(k);
    for (const k of mentionSends.keys()) if ((JSON.parse(k) as string[])[2] === userId) mentionSends.delete(k);
  };
  const sessions = new Map<string, SessionRecord>();
  const sessionRevisions = new Map<string, SessionRevision[]>(); // sessionId -> ascending by rev
  const collabOwners = new Map<string, { owner: string; until: number }>();
  const collabCheckpoints = new Map<string, { revision: number; headRevision: number; checkpoint: CanvasCheckpoint }>();
  const collabJournal = new Map<string, { revision: number; ops: CanvasOp[] }[]>();
  const collabReceipts = new Map<string, CollabReceipt>();
  const receiptKey = (session: string, principal: string, id: string): string => JSON.stringify([session, principal, id]);
  const collabSnapshots = new Map<string, CollabSnapshot>(); // sessionId -> the live room's doc

  const erasurePreview = (id: string) => ({
    references: {
      projects: [...projects.values()].filter((p) => p.ownerId === id).length,
      sessions: [...sessions.values()].filter((s) => s.createdBy === id || s.updatedBy === id).length,
      links: [...links.values()].filter((l) => l.createdBy === id).length,
      approvals: [...approvals.values()].filter((a) => a.createdBy === id).length,
      messageAcks: acks.get(id)?.size ?? 0,
      projectFiles: [...projectFiles.values()].filter((f) => f.ready && f.createdBy === id).length,
    },
    telemetryEvents: events.filter((e) => e.userId === id).length,
  });
  // Ready files, and unfinished uploads that have not expired: what the
  // budgets and the pending limit count.
  const liveProjectFiles = (now = Date.now()) => [...projectFiles.values()].filter((f) => activeProjectFile(f, now));

  return {
    configureRoleGroups(mapping) { roleGroups = structuredClone(mapping); },
    storageKind: 'memory',
    ...createMemoryRenderStore(),
    ...passkeys.store,
    brandPersistence: 'ephemeral',
    async getBrandState() { return structuredClone(brandState); },
    async casBrandState(expected, next, body) {
      if (brandState.revision !== expected) return null;
      const updated = structuredClone({ ...next, revision: expected + 1 });
      const event = nextEvent(audit[audit.length - 1] ?? null, body, auditMacKey);
      audit.push(event);
      brandState = updated;
      return structuredClone(brandState);
    },
    async upsertUserBySub(user) {
      const now = new Date().toISOString();
      const existing = users.get(user.sub);
      // Incoming groups are the IdP-authoritative set; local groups are durable.
      const idpGroups = [...new Set(user.groups.filter(Boolean))];
      const local = existing?.localGroups ?? [];
      const groups = effectiveGroups(idpGroups, local);
      const role = roleFromGroups(groups, roleGroups); // derived on the effective union
      const next: UserRecord = existing
        ? { ...existing, ...user, idpGroups, localGroups: local, groups, role, lastSeenAt: now }
        : { ...user, id: randomId(8), idpGroups, localGroups: local, groups, role, sessionEpoch: 0, createdAt: now, lastSeenAt: now };
      users.set(user.sub, next);
      return next;
    },
    async getUserBySub(sub) {
      const user = users.get(sub); return user ? mapped(user) : null;
    },
    async getUser(id) {
      for (const u of users.values()) if (u.id === id) return mapped(u);
      return null;
    },
    async findUsersByEmail(email) {
      const e = email.trim().toLowerCase();
      if (!e) return [];
      return [...users.values()].filter((u) => u.email.trim().toLowerCase() === e).map(mapped);
    },
    async setTelemetryConsent(userId, consent) {
      for (const u of users.values()) {
        if (u.id === userId) users.set(u.sub, { ...u, telemetryConsent: consent });
      }
    },
    async listUsers() {
      return [...users.values()].map(mapped);
    },
    async listUsersPage(opts) {
      let rows = [...users.values()].map(mapped);
      const q = opts.q?.trim().toLowerCase();
      if (q) {
        rows = rows.filter((u) =>
          [u.firstname, u.lastname, u.email].filter(Boolean).join(' ').toLowerCase().includes(q));
      }
      if (opts.prefix) {
        // First letter of the same key the name sort uses (name, else email).
        const first = (u: UserRecord): string =>
          ([u.firstname, u.lastname].filter(Boolean).join(' ').toLowerCase() || u.email.toLowerCase()).charAt(0);
        rows = opts.prefix === '#'
          ? rows.filter((u) => !/[a-z]/.test(first(u)))
          : rows.filter((u) => first(u) === opts.prefix);
      }
      if (opts.role) rows = rows.filter((u) => u.role === opts.role);
      if (opts.group) rows = rows.filter((u) => u.groups.includes(opts.group as string));
      if (opts.status === 'active') rows = rows.filter((u) => !u.disabledAt);
      else if (opts.status === 'disabled') rows = rows.filter((u) => !!u.disabledAt);
      const total = rows.length;
      const key = (u: UserRecord): string => {
        switch (opts.sort) {
          case 'email': return u.email.toLowerCase();
          case 'role': return u.role;
          case 'lastSeen': return u.lastSeenAt;
          default: return [u.firstname, u.lastname].filter(Boolean).join(' ').toLowerCase() || u.email.toLowerCase();
        }
      };
      const sign = opts.dir === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const ka = key(a), kb = key(b);
        if (ka < kb) return -sign;
        if (ka > kb) return sign;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable tiebreak
      });
      return { rows: rows.slice(opts.offset, opts.offset + opts.limit), total };
    },
    async setLocalGroups(userId, local) {
      for (const u of users.values()) {
        if (u.id !== userId) continue;
        const localGroupsNext = [...new Set(local.filter(Boolean))];
        const groups = effectiveGroups(u.idpGroups, localGroupsNext);
        const next: UserRecord = { ...u, localGroups: localGroupsNext, groups, role: roleFromGroups(groups, roleGroups) };
        users.set(u.sub, next);
        return next;
      }
      return null;
    },
    async setUserDisabled(userId, disabledAt) {
      for (const u of users.values()) {
        if (u.id !== userId) continue;
        const next: UserRecord = { ...u };
        // Disabling is also a revocation: any live session dies on its next request.
        if (disabledAt) { next.disabledAt = disabledAt; next.sessionEpoch = u.sessionEpoch + 1; }
        else delete next.disabledAt;
        users.set(u.sub, next);
        return mapped(next);
      }
      return null;
    },
    async bumpSessionEpoch(userId) {
      for (const u of users.values()) {
        if (u.id !== userId) continue;
        const next: UserRecord = { ...u, sessionEpoch: u.sessionEpoch + 1 };
        users.set(u.sub, next);
        return mapped(next);
      }
      return null;
    },

    async listLocalGroups() {
      return [...localGroups.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async putLocalGroup(group) {
      localGroups.set(group.name, group);
    },
    async deleteLocalGroup(name) {
      localGroups.delete(name);
      for (const u of users.values()) {
        if (!u.localGroups.includes(name)) continue;
        const local = u.localGroups.filter((g) => g !== name);
        const groups = effectiveGroups(u.idpGroups, local);
        users.set(u.sub, { ...u, localGroups: local, groups, role: roleFromGroups(groups, roleGroups) });
      }
    },

    async putScimToken(rec) {
      scimTokens.set(rec.id, { ...rec });
    },
    async listScimTokens() {
      return [...scimTokens.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async findScimTokenByHash(tokenHash) {
      for (const t of scimTokens.values()) if (t.tokenHash === tokenHash) return { ...t };
      return null;
    },
    async touchScimToken(id, at) {
      const t = scimTokens.get(id);
      if (t) scimTokens.set(id, { ...t, lastUsedAt: at });
    },
    async revokeScimToken(id, at) {
      const t = scimTokens.get(id);
      if (!t || t.revokedAt) return false;
      scimTokens.set(id, { ...t, revokedAt: at });
      return true;
    },

    async putApiToken(rec) {
      apiTokens.set(rec.id, { ...rec });
    },
    async listApiTokens() {
      return [...apiTokens.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    },
    async findApiTokenByHash(tokenHash) {
      for (const t of apiTokens.values()) if (t.tokenHash === tokenHash) return { ...t };
      return null;
    },
    async touchApiToken(id, at) {
      const t = apiTokens.get(id);
      if (t) apiTokens.set(id, { ...t, lastUsedAt: at });
    },
    async revokeApiToken(id, at) {
      const t = apiTokens.get(id);
      if (!t || t.revokedAt) return false;
      apiTokens.set(id, { ...t, revokedAt: at });
      return true;
    },

    async createInvitation(rec) {
      const email = rec.email.trim().toLowerCase();
      const existing = activeInvitation(email);
      if (existing) {
        const lapsed = !existing.acceptedAt && !!existing.expiresAt && Date.parse(existing.expiresAt) <= Date.parse(rec.createdAt);
        if (!lapsed) return { invitation: copyInvitation(existing), created: false };
        invitations.set(existing.id, { ...existing, revokedAt: rec.createdAt });
      }
      // A new row starts at link version 1, not opened, whatever the caller held.
      const { passwordSetup, openedAt: _opened, linkVersion: _version, ...rest } = rec as NewInvitationRecord & Partial<InvitationRecord>;
      const row: InvitationRecord = {
        ...rest, email, groups: [...new Set(rec.groups)], projects: (rec.projects ?? []).map((p) => ({ ...p })),
        linkVersion: 1, ...(passwordSetup ? { passwordSetup: true } : {}),
      };
      invitations.set(row.id, row);
      return { invitation: copyInvitation(row), created: true };
    },
    async listInvitations() {
      return [...invitations.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
        .map(copyInvitation);
    },
    async getInvitation(id) {
      const r = invitations.get(id);
      return r ? copyInvitation(r) : null;
    },
    async findActiveInvitation(email) {
      const r = activeInvitation(email);
      return r ? copyInvitation(r) : null;
    },
    async revokeInvitation(id, at, opts) {
      const r = invitations.get(id);
      if (!r || r.revokedAt || (opts?.pendingOnly && r.acceptedAt)) return null;
      const next = { ...r, revokedAt: at };
      invitations.set(id, next);
      return copyInvitation(next);
    },
    async listOpenInvitationsForProject(projectId, now) {
      const t = Date.parse(now);
      return [...invitations.values()]
        .filter((r) => !r.revokedAt && !r.acceptedAt && !(r.expiresAt && Date.parse(r.expiresAt) <= t)
          && (r.projects ?? []).some((p) => p.projectId === projectId))
        .sort(newestFirst)
        .map(copyInvitation);
    },
    async listProjectInvitations(projectId, q) {
      const now = Date.parse(q.now);
      const since = Date.parse(q.expiredSince);
      return [...invitations.values()]
        .filter((r) => {
          if (r.revokedAt || r.acceptedAt || !(r.projects ?? []).some((p) => p.projectId === projectId)) return false;
          if (!r.expiresAt) return true;
          const end = Date.parse(r.expiresAt);
          return end > now || end > since;
        })
        .sort(newestFirst)
        .map(copyInvitation);
    },
    async findInvitationAcceptedBy(userId) {
      const rows = [...invitations.values()]
        .filter((r) => !r.revokedAt && r.acceptedUserId === userId)
        .sort((a, b) => (a.acceptedAt! < b.acceptedAt! ? 1 : a.acceptedAt! > b.acceptedAt! ? -1 : newestFirst(a, b)));
      return rows[0] ? copyInvitation(rows[0]) : null;
    },
    async rotateInvitationLink(id) {
      const r = invitations.get(id);
      if (!r || r.revokedAt || r.acceptedAt) return null;
      const { openedAt: _cleared, ...rest } = r;
      const next: InvitationRecord = { ...rest, linkVersion: r.linkVersion + 1 };
      invitations.set(id, next);
      return copyInvitation(next);
    },
    async markInvitationOpened(id, at) {
      const r = invitations.get(id);
      if (!r || r.revokedAt || r.openedAt) return false;
      invitations.set(id, { ...r, openedAt: at });
      return true;
    },
    async setInvitationPasswordSetup(id, on) {
      const r = invitations.get(id);
      if (!r || r.revokedAt || r.acceptedAt) return null;
      const { passwordSetup: _old, ...rest } = r;
      const next: InvitationRecord = { ...rest, ...(on ? { passwordSetup: true } : {}) };
      invitations.set(id, next);
      return copyInvitation(next);
    },
    async acceptInvitation(id, userId, at) {
      const r = invitations.get(id);
      if (!r || r.revokedAt || r.acceptedAt) return null;
      if (r.expiresAt && Date.parse(r.expiresAt) <= Date.parse(at)) return null;
      const next = { ...r, acceptedAt: at, acceptedUserId: userId };
      invitations.set(id, next);
      return copyInvitation(next);
    },
    async setInvitationProjects(id, list) {
      const r = invitations.get(id);
      if (!r || r.revokedAt || r.acceptedAt) return null;
      const next = { ...r, projects: list.map((p) => ({ ...p })) };
      invitations.set(id, next);
      return copyInvitation(next);
    },
    async dropInvitationProject(id, projectId, at, opts) {
      const r = invitations.get(id);
      if (!r || r.revokedAt || r.acceptedAt || !(r.projects ?? []).some((p) => p.projectId === projectId)) return null;
      const projects = (r.projects ?? []).filter((p) => p.projectId !== projectId).map((p) => ({ ...p }));
      const revoke = !!opts?.revokeWhenEmpty && !projects.length && !r.groups.length;
      const next: InvitationRecord = { ...r, projects, ...(revoke ? { revokedAt: at } : {}) };
      invitations.set(id, next);
      return copyInvitation(next);
    },

    // Access requests (migration 0044).
    async createAccessRequest(rec, now) {
      const email = rec.email.trim().toLowerCase();
      const key = requestKey({ ...rec, email });
      for (const [k, r] of accessRequests) {
        if (requestKey(r) !== key || r.status !== 'open') continue;
        if (liveOpen(r, now)) return { request: copyRequest(r), created: false };
        accessRequests.set(k, { ...r, status: 'expired' });
      }
      // Empty optional fields are left off, as the Postgres driver reads them.
      const given = Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      const row: AccessRequestRecord = { ...(given as unknown as AccessRequestRecord), email, status: 'open' };
      accessRequests.set(row.id, row);
      return { request: copyRequest(row), created: true };
    },
    async getAccessRequest(id) {
      const r = accessRequests.get(id);
      return r ? copyRequest(r) : null;
    },
    async listAccessRequests(q) {
      const email = q.email?.trim().toLowerCase();
      const rows = [...accessRequests.values()].filter((r) =>
        (!q.kinds || q.kinds.includes(r.kind)) && (!q.projectIds || (!!r.projectId && q.projectIds.includes(r.projectId)))
        && (!q.userId || r.userId === q.userId) && (!email || r.email === email)
        && (!q.invitationId || r.invitationId === q.invitationId));
      const limit = q.limit ?? 200;
      if (q.status === 'open') {
        return rows.filter((r) => liveOpen(r, q.now))
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
          .slice(0, limit).map(copyRequest);
      }
      const closedAt = (r: AccessRequestRecord): string => r.answeredAt ?? r.expiresAt;
      return rows.filter((r) => !liveOpen(r, q.now))
        .filter((r) => !q.answeredSince || Date.parse(closedAt(r)) >= Date.parse(q.answeredSince))
        .sort((a, b) => (closedAt(a) < closedAt(b) ? 1 : closedAt(a) > closedAt(b) ? -1 : a.id < b.id ? 1 : -1))
        .slice(0, limit)
        .map((r) => (r.status === 'open' ? { ...r, status: 'expired' as const } : copyRequest(r)));
    },
    async answerAccessRequest(id, a, now) {
      const r = accessRequests.get(id);
      return r && liveOpen(r, now) ? answerRequest(r, a) : null;
    },
    async closeAccessRequests(q, a, now) {
      return [...accessRequests.values()]
        .filter((r) => liveOpen(r, now) && requestMatches(r, q))
        .map((r) => answerRequest(r, a));
    },
    async countAccessRequests(q) {
      const email = q.email?.trim().toLowerCase();
      let n = 0;
      for (const r of accessRequests.values()) {
        if (r.kind !== q.kind || (email && r.email !== email) || (q.invitationId && r.invitationId !== q.invitationId)) continue;
        if (q.since && Date.parse(r.createdAt) < Date.parse(q.since)) continue;
        if (q.openOnly && !liveOpen(r, q.now)) continue;
        n++;
      }
      return n;
    },

    async getUserByIdentity(identitySub) {
      const row = identities.get(identitySub);
      const user = row ? userById(row.userId) : undefined;
      return user ? mapped(user) : null;
    },
    async linkIdentity(rec) {
      if (!userById(rec.userId)) return null;
      const prev = identities.get(rec.identitySub);
      if (prev && prev.userId !== rec.userId) return null;
      const owner = users.get(rec.identitySub);
      if (owner && owner.id !== rec.userId) return null;
      const email = rec.email?.trim().toLowerCase();
      const next: UserIdentityRecord = {
        identitySub: rec.identitySub, userId: rec.userId, idp: rec.idp,
        ...(email ? { email } : {}), emailVerified: rec.emailVerified === true,
        groups: [...new Set((rec.groups ?? prev?.groups ?? []).filter(Boolean))],
        linkedAt: prev?.linkedAt ?? rec.linkedAt,
        ...(rec.lastLoginAt ? { lastLoginAt: rec.lastLoginAt } : prev?.lastLoginAt ? { lastLoginAt: prev.lastLoginAt } : {}),
      };
      identities.set(rec.identitySub, next);
      return { identity: { ...next, groups: [...(next.groups ?? [])] }, created: !prev };
    },
    async listIdentities(userId) {
      return [...identities.values()]
        .filter((r) => r.userId === userId)
        .sort((a, b) => (a.linkedAt < b.linkedAt ? -1 : a.linkedAt > b.linkedAt ? 1 : a.identitySub < b.identitySub ? -1 : 1))
        .map((r) => ({ ...r, groups: [...(r.groups ?? [])] }));
    },
    async unlinkIdentity(userId, identitySub) {
      const row = identities.get(identitySub);
      if (!row || row.userId !== userId) return false;
      return identities.delete(identitySub);
    },
    async findUsersByVerifiedEmail(email) {
      const e = email.trim().toLowerCase();
      if (!e) return [];
      const ids = new Set<string>();
      for (const r of identities.values()) if (r.emailVerified && r.email === e) ids.add(r.userId);
      return [...ids].map((id) => userById(id)).filter((u): u is UserRecord => !!u).map(mapped);
    },

    async getPasswordCredential(email) {
      const r = passwordCredentials.get(email.trim().toLowerCase());
      return r ? { ...r } : null;
    },
    async putPasswordCredential(rec) {
      const email = rec.email.trim().toLowerCase();
      const prev = passwordCredentials.get(email);
      const next: PasswordCredentialRecord = {
        id: prev?.id ?? rec.id, email, hash: rec.hash,
        createdAt: prev?.createdAt ?? rec.at, updatedAt: rec.at, failedCount: 0, ownerIssued: rec.ownerIssued,
      };
      passwordCredentials.set(email, next);
      return { ...next };
    },
    async rehashPasswordCredential(email, oldHash, newHash, at) {
      const r = passwordCredentials.get(email.trim().toLowerCase());
      if (!r || r.hash !== oldHash) return false;
      passwordCredentials.set(r.email, { ...r, hash: newHash, updatedAt: at });
      return true;
    },
    async reservePasswordAttempt(email, at, opts): Promise<PasswordAttempt> {
      const r = passwordCredentials.get(email.trim().toLowerCase());
      if (!r) return { status: 'none' };
      if (r.lockedUntil && Date.parse(r.lockedUntil) > Date.parse(at)) return { status: 'locked', credential: { ...r } };
      const { lockedUntil: _expired, ...rest } = r;
      const count = r.failedCount + 1;
      const locks = count >= opts.maxFailures;
      const next: PasswordCredentialRecord = locks
        ? { ...rest, failedCount: 0, lockedUntil: new Date(Date.parse(at) + opts.lockMs).toISOString() }
        : { ...rest, failedCount: count };
      passwordCredentials.set(r.email, next);
      return { status: 'reserved', credential: { ...next }, locks };
    },
    async clearPasswordFailures(email) {
      const r = passwordCredentials.get(email.trim().toLowerCase());
      if (!r || (!r.failedCount && !r.lockedUntil)) return;
      const { lockedUntil: _cleared, ...rest } = r;
      passwordCredentials.set(r.email, { ...rest, failedCount: 0 });
    },
    async deletePasswordCredential(id) {
      const r = [...passwordCredentials.values()].find((c) => c.id === id);
      if (!r) return null;
      passwordCredentials.delete(r.email);
      for (const [k, l] of passwordLinks) if (l.email === r.email && !l.usedAt) passwordLinks.delete(k);
      return { ...r };
    },
    async revokePasswordLinks(email) {
      const e = email.trim().toLowerCase();
      let n = 0;
      for (const [k, l] of passwordLinks) if (l.email === e && !l.usedAt) { passwordLinks.delete(k); n++; }
      return n;
    },
    async createPasswordLink(rec) {
      const email = rec.email.trim().toLowerCase();
      for (const [k, l] of passwordLinks) {
        if ((l.email === email && !l.usedAt) || l.expiresAt <= rec.createdAt) passwordLinks.delete(k);
      }
      passwordLinks.set(rec.tokenHash, { ...rec, email });
    },
    async findLivePasswordLink(tokenHash, at) {
      const l = passwordLinks.get(tokenHash);
      return l && !l.usedAt && Date.parse(l.expiresAt) > Date.parse(at) ? { ...l } : null;
    },
    async consumePasswordLink(tokenHash, at) {
      const l = passwordLinks.get(tokenHash);
      if (!l || l.usedAt || Date.parse(l.expiresAt) <= Date.parse(at)) return null;
      const next = { ...l, usedAt: at };
      passwordLinks.set(tokenHash, next);
      return { ...next };
    },

    async claimAutomationJob(owner, verbs, leaseMs) {
      const now = Date.now();
      const job = [...automationJobs.values()].filter(j => verbs.includes(j.verb) && (j.state === 'queued' || j.state === 'running' && (!j.leaseUntil || Date.parse(j.leaseUntil) < now)))
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return null;
      Object.assign(job, { state: 'running', leaseOwner: owner, leaseUntil: new Date(now + leaseMs).toISOString(), leaseToken: (job.leaseToken ?? 0) + 1, attempt: job.attempt + 1, updatedAt: new Date(now).toISOString() });
      return structuredClone(job);
    },
    async renewAutomationJob(job, leaseMs) {
      const live = automationJobs.get(job.id);
      if (!live || live.state !== 'running' || live.leaseOwner !== job.leaseOwner || live.leaseToken !== job.leaseToken || Date.parse(live.leaseUntil ?? '') <= Date.now()) return false;
      live.leaseUntil = new Date(Date.now() + leaseMs).toISOString(); return true;
    },
    async saveClaimedAutomationJob(job) {
      const live = automationJobs.get(job.id);
      if (!live || live.leaseOwner !== job.leaseOwner || live.leaseToken !== job.leaseToken) return false;
      if (!(live.state === 'running' && Date.parse(live.leaseUntil ?? '') > Date.now() || live.state === job.state && ['done', 'failed'].includes(live.state))) return false;
      automationJobs.set(job.id, { ...structuredClone(job), leaseUntil: live.leaseUntil }); return true;
    },
    async putAutomationJob(job) {
      if (job.idempotencyKey && [...automationJobs.values()].some(existing => existing.id !== job.id && existing.principal === job.principal && existing.idempotencyKey === job.idempotencyKey)) throw new Error('IDEMPOTENCY_KEY_REUSED');
      automationJobs.set(job.id, structuredClone(job));
    },
    async getAutomationJob(id, principal) {
      const job = automationJobs.get(id);
      return job?.principal === principal ? structuredClone(job) : null;
    },
    async listAutomationJobs(principal) {
      return [...automationJobs.values()].filter((job) => job.principal === principal).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((job) => structuredClone(job));
    },
    async findAutomationJobByIdempotency(principal, key) {
      const job = [...automationJobs.values()].find((candidate) => candidate.principal === principal && candidate.idempotencyKey === key);
      return job ? structuredClone(job) : null;
    },
    async deleteAutomationJob(id, principal) {
      const job = automationJobs.get(id);
      if ([...deliveries.values()].some((delivery) => delivery.sourceJobId === id)) return false;
      return Boolean(job?.principal === principal && automationJobs.delete(id));
    },

    async putDelivery(delivery) {
      const existing = deliveries.get(delivery.id);
      // Match Postgres: the identity/export/target tuple is immutable after
      // creation; only execution state and receipt fields advance.
      if (!existing) {
        deliveries.set(delivery.id, structuredClone(delivery));
        return;
      }
      const next: DeliveryRecord = {
        ...existing,
        state: delivery.state,
        attempt: delivery.attempt,
        updatedAt: delivery.updatedAt,
        ...(delivery.remoteId ? { remoteId: delivery.remoteId } : {}),
        ...(delivery.url ? { url: delivery.url } : {}),
        ...(delivery.deliveredSha256 ? { deliveredSha256: delivery.deliveredSha256 } : {}),
        ...(delivery.transformation ? { transformation: delivery.transformation } : {}),
        ...(delivery.deliveredAt ? { deliveredAt: delivery.deliveredAt } : {}),
      };
      if (delivery.error) next.error = delivery.error;
      else delete next.error;
      deliveries.set(delivery.id, structuredClone(next));
    },
    async getDelivery(id, principal) {
      const delivery = deliveries.get(id);
      return delivery?.principal === principal ? structuredClone(delivery) : null;
    },
    async listDeliveries(principal) {
      return [...deliveries.values()]
        .filter((delivery) => delivery.principal === principal)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((delivery) => structuredClone(delivery));
    },
    async findDeliveryByIdempotency(principal, key) {
      const delivery = [...deliveries.values()].find((candidate) =>
        candidate.principal === principal && candidate.idempotencyKey === key);
      return delivery ? structuredClone(delivery) : null;
    },
    async findDeliveryBySourceJob(principal, jobId) {
      const delivery = [...deliveries.values()].find((candidate) =>
        candidate.principal === principal && candidate.sourceJobId === jobId);
      return delivery ? structuredClone(delivery) : null;
    },

    async listGrants() {
      return [...grants];
    },
    async putGrant(grant) {
      if (!grants.some((g) => sameGrant(g, grant))) grants.push({ ...grant });
    },
    async deleteGrant(grant) {
      for (let i = grants.length - 1; i >= 0; i--) {
        if (sameGrant(grants[i] as Grant, grant)) grants.splice(i, 1);
      }
    },
    async listOverlays() {
      return new Map(overlays);
    },
    async putOverlay(overlay) {
      overlays.set(overlay.toolId, overlay);
    },
    async deleteOverlay(toolId) {
      overlays.delete(toolId);
    },
    async listFlagGovernance() {
      return new Map(flagGovernance);
    },
    async putFlagGovernance(rec) {
      // A record with no opinion (no default, not hidden) clears the row - so
      // "reset to inherit + show" leaves no residue and the version is stable.
      if (rec.default === undefined && rec.visibility === undefined) flagGovernance.delete(rec.id);
      else flagGovernance.set(rec.id, rec);
    },
    async listInjectables() {
      return [...injectables.values()];
    },
    async getInjectable(id) {
      return injectables.get(id) ?? null;
    },
    async putInjectable(rec) {
      injectables.set(rec.id, rec);
    },
    async deleteInjectable(id) {
      injectables.delete(id);
    },
    async pendingMigrations() {
      return []; // no schema - the memory store is definitionally always current
    },

    async putLink(link) {
      links.set(link.id, link);
    },
    async getLink(id) {
      return links.get(id) ?? null;
    },
    async revokeLink(id, at) {
      const l = links.get(id);
      if (l) links.set(id, { ...l, revokedAt: at });
    },
    async listLinksBy(createdBy) {
      return [...links.values()].filter((l) => l.createdBy === createdBy);
    },
    async listAllLinks() {
      return [...links.values()];
    },

    setAuditMacKey(key: string) {
      auditMacKey = key;
    },
    async appendAudit(body: AuditEventBody) {
      const evt = nextEvent(audit[audit.length - 1] ?? null, body, auditMacKey);
      audit.push(evt);
      return evt;
    },
    async appendAuditIfTail(expectedTail, body) {
      const tail = audit[audit.length - 1] ?? null;
      if (tail?.seq !== expectedTail?.seq || tail?.hash !== expectedTail?.hash) return null;
      const evt = nextEvent(tail, body, auditMacKey);
      audit.push(evt);
      return evt;
    },
    async listAudit() {
      return [...audit];
    },
    async listAuditBefore(before, limit, filter) {
      const upto = audit.filter(event => (before <= 0 || event.seq < before) && matchesAudit(event, filter));
      return upto.slice(Math.max(0, upto.length - limit));
    },
    async countAudit(filter) {
      return filter ? audit.filter(event => matchesAudit(event, filter)).length : audit.length;
    },
    async ping() {
      return true;
    },
    async listAuditAfter(after, limit) {
      return audit.filter((e) => e.seq > after).slice(0, limit);
    },
    async getSiemCursor() {
      return siemCursor;
    },
    async setSiemCursor(seq) {
      siemCursor = seq;
    },
    async getAuditAnchor() {
      return auditAnchor ? { ...auditAnchor } : null;
    },
    async setAuditAnchor(anchor) {
      auditAnchor = { ...anchor };
    },
    async trimAudit(uptoSeq) {
      const before = audit.length;
      for (let i = audit.length - 1; i >= 0; i--) {
        if ((audit[i] as AuditEvent).seq <= uptoSeq) audit.splice(i, 1);
      }
      return before - audit.length;
    },
    async trimTelemetry(beforeIso) {
      const before = events.length;
      for (let i = events.length - 1; i >= 0; i--) {
        if ((events[i] as StoredEvent).at < beforeIso) events.splice(i, 1);
      }
      return before - events.length;
    },
    async scrubTelemetryUser(userId) {
      let n = 0;
      for (let i = 0; i < events.length; i++) {
        const e = events[i] as StoredEvent;
        if (e.userId === userId) {
          const { userId: _drop, ...rest } = e;
          events[i] = rest;
          n++;
        }
      }
      return n;
    },
    async deleteUser(id) {
      for (const [sub, u] of users) {
        if (u.id === id) {
          users.delete(sub);
          passkeys.forgetUser(id);
          // migration 0040: a membership row goes with its user.
          for (const [k, m] of projectMembers) if (m.userId === id) projectMembers.delete(k);
          // migration 0039: so do its linked sign-ins.
          for (const [k, r] of identities) if (r.userId === id) identities.delete(k);
          // migration 0044: and its access requests.
          dropRequestsWhere((r) => r.userId === id);
          for (const [key, r] of documentAgents) if (r.userId === id || r.createdBy === id) documentAgents.delete(key);
          for (const [key, r] of projectAgents) if (r.createdBy === id) projectAgents.delete(key);
          for (const key of agentCreations.keys()) if (!projectAgents.has(JSON.parse(key)[0])) agentCreations.delete(key);
          forgetCommentState(id, false);
          return true;
        }
      }
      return false;
    },

    async previewUserErasure(id) { return erasurePreview(id); },
    async eraseUserAccount(id) {
      const user = [...users.values()].find((u) => u.id === id);
      if (!user) return { status: 'not-found' };
      if (Object.values(erasurePreview(id).references).some((count) => count > 0)) return { status: 'referenced' };
      // Postgres refuses on its users FK for ANY project_files row, ready or not.
      if ([...projectFiles.values()].some((f) => f.createdBy === id)) return { status: 'referenced' };
      let scrubbed = 0;
      for (let i = 0; i < events.length; i++) {
        const event = events[i]!;
        if (event.userId !== id) continue;
        const { userId: _removed, ...rest } = event;
        events[i] = rest;
        scrubbed++;
      }
      users.delete(user.sub);
      passkeys.forgetUser(id);
      forgetCommentState(id, true);
      for (const [key, r] of documentAgents) if (r.userId === id || r.createdBy === id) documentAgents.delete(key);
      for (const [key, r] of projectAgents) if (r.createdBy === id) projectAgents.delete(key);
      for (const key of agentCreations.keys()) if (!projectAgents.has(JSON.parse(key)[0])) agentCreations.delete(key);
      // Invitations hold the email, and an accepted one keeps admitting it, so
      // the rows this account accepted go with it. Other rows for the address
      // go too unless another account still carries that email.
      const email = user.email.trim().toLowerCase();
      const emailStillUsed = [...users.values()].some((u) => u.email.trim().toLowerCase() === email);
      const goneInvitations = new Set<string>();
      for (const [invId, inv] of invitations) {
        if (inv.acceptedUserId === id || (!emailStillUsed && inv.email === email)) { invitations.delete(invId); goneInvitations.add(invId); }
      }
      // Access requests name the account or its address; a request on an
      // erased invitation goes with it (the foreign key cascades in Postgres).
      dropRequestsWhere((r) => r.userId === id || (!emailStillUsed && r.email === email)
        || (!!r.invitationId && goneInvitations.has(r.invitationId)));
      // A password for the address would sign the person straight back in,
      // and so would one the account's own password sign-ins name under
      // another address.
      const linkedEmails = new Set(!emailStillUsed ? [email] : []);
      for (const r of identities.values()) {
        if (r.userId !== id || !r.identitySub.startsWith('password:')) continue;
        const cred = [...passwordCredentials.values()].find((c) => `password:${c.id}` === r.identitySub);
        if (cred) linkedEmails.add(cred.email);
      }
      for (const e of linkedEmails) {
        passwordCredentials.delete(e);
        for (const [k, l] of passwordLinks) if (l.email === e) passwordLinks.delete(k);
      }
      for (const [k, m] of projectMembers) if (m.userId === id) projectMembers.delete(k);
      for (const [k, r] of identities) if (r.userId === id) identities.delete(k);
      return { status: 'erased', scrubbed };
    },

    async putDeviceCode(rec) {
      pruneDeviceCodes();
      deviceCodes.set(rec.deviceCode, { ...rec });
    },
    async getPendingDeviceCode(userCode) {
      pruneDeviceCodes();
      for (const r of deviceCodes.values()) {
        if (r.userCode === userCode && r.status === 'pending') return { ...r };
      }
      return null;
    },
    async settleDeviceCode(userCode, status, userPayload) {
      pruneDeviceCodes();
      for (const r of deviceCodes.values()) {
        if (r.userCode === userCode && r.status === 'pending') {
          deviceCodes.set(r.deviceCode, { ...r, status, ...(userPayload ? { userPayload } : {}) });
          return true;
        }
      }
      return false;
    },
    async claimDeviceCode(deviceCode) {
      pruneDeviceCodes();
      const r = deviceCodes.get(deviceCode);
      if (!r) return { status: 'expired' };
      if (r.status === 'pending') return { status: 'pending' };
      deviceCodes.delete(deviceCode); // settled rows are single-read
      if (r.status === 'approved' && r.userPayload) return { status: 'approved', userPayload: r.userPayload };
      return { status: 'denied' };
    },
    async listPendingDeviceCodes() {
      pruneDeviceCodes();
      return [...deviceCodes.values()]
        .filter((r) => r.status === 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((r) => ({ ...r }));
    },

    async putEvents(batch) {
      events.push(...batch);
    },
    async listEvents() {
      return [...events];
    },

    async listMessages() {
      return [...messages.values()];
    },
    async putMessage(msg) {
      messages.set(msg.id, msg);
    },
    async ackMessage(messageId, userId) {
      const set = acks.get(userId) ?? new Set<string>();
      set.add(messageId);
      acks.set(userId, set);
    },
    async clearAck(messageId, userId) {
      const set = acks.get(userId);
      if (!set) return;
      set.delete(messageId);
      if (set.size === 0) acks.delete(userId);
    },
    async acksFor(userId) {
      return new Set(acks.get(userId) ?? []);
    },
    async ackCounts() {
      const out = new Map<string, number>();
      for (const set of acks.values()) {
        for (const id of set) out.set(id, (out.get(id) ?? 0) + 1);
      }
      return out;
    },

    async recordClient(info: ClientInfo) {
      const bucket = clientBucket(info);
      const row = fleet.get(bucket);
      const now = new Date().toISOString();
      fleet.set(bucket, row ? { ...row, count: row.count + 1, lastSeenAt: now } : { bucket, info, count: 1, lastSeenAt: now });
    },
    async fleetSummary() {
      return [...fleet.values()];
    },
    async upsertInstall(installId, info, userId) {
      const now = new Date().toISOString();
      const row = installs.get(installId);
      installs.set(installId, row
        ? { ...row, info, userIdLastSeen: userId, lastSeenAt: now }
        : { installId, info, userIdLastSeen: userId, firstSeenAt: now, lastSeenAt: now });
    },
    async listInstalls() {
      return [...installs.values()].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    },
    async renameInstall(installId, name) {
      const row = installs.get(installId);
      if (!row) return null;
      const next = { ...row };
      if (name === null) delete next.name; else next.name = name;
      installs.set(installId, next);
      return next;
    },
    async forgetInstall(installId) {
      installs.delete(installId);
    },

    async putChain(chain) {
      chains.set(chain.id, chain);
    },
    async getChain(id) {
      return chains.get(id) ?? null;
    },
    async listChains() {
      return [...chains.values()];
    },
    async deleteChain(id) {
      chains.delete(id);
    },
    async putApproval(approval) {
      approvals.set(approval.id, approval);
    },
    async getApproval(id) {
      return approvals.get(id) ?? null;
    },
    async listApprovals(filter) {
      let out = [...approvals.values()];
      if (filter?.createdBy) out = out.filter((a) => a.createdBy === filter.createdBy);
      if (filter?.state) out = out.filter((a) => a.state === filter.state);
      if (filter?.eligibleGroups) {
        const groups = filter.eligibleGroups;
        out = out.filter((a) => eligibleForCurrentStep(a, groups));
      }
      return out;
    },

    async putLifecycle(row) {
      lifecycle.set(row.assetId, row);
    },
    async getLifecycle(assetId) {
      return lifecycle.get(assetId) ?? null;
    },
    async listLifecycle() {
      return [...lifecycle.values()];
    },
    async deleteLifecycle(assetId) {
      lifecycle.delete(assetId);
    },

    async putCredential(row) {
      credentials.set(row.assetId, row);
    },
    async getCredential(assetId) {
      return credentials.get(assetId) ?? null;
    },
    async listCredentials() {
      return [...credentials.values()];
    },
    async deleteCredential(assetId) {
      credentials.delete(assetId);
    },

    async putInstanceAsset(rec) {
      instanceAssets.set(rec.id, rec);
    },
    async getInstanceAsset(id) {
      return instanceAssets.get(id) ?? null;
    },
    async listInstanceAssets() {
      return [...instanceAssets.values()];
    },
    async deleteInstanceAsset(id) {
      instanceAssets.delete(id);
    },
    async putAlias(fromId, toId) {
      aliases.set(fromId, toId);
    },
    async getAlias(fromId) {
      return aliases.get(fromId) ?? null;
    },
    async listAliases() {
      return [...aliases.entries()].map(([fromId, toId]) => ({ fromId, toId }));
    },

    async listCatalogFields() {
      return sortFields([...catalogFields.values()]);
    },
    async putCatalogField(def) {
      catalogFields.set(def.id, def);
    },
    async deleteCatalogField(id) {
      catalogFields.delete(id);
    },
    async listCatalogTagRules() {
      return [...tagRules.values()].sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0))
        .map((r) => ({ ...r, hidden: [...r.hidden] }));
    },
    async putCatalogTagRule(rule) {
      tagRules.set(rule.scope, { ...rule, hidden: [...rule.hidden] });
    },
    async deleteCatalogTagRule(scope) {
      tagRules.delete(scope);
    },
    async getAssetMeta(assetId) {
      return assetMeta.get(assetId) ?? null;
    },
    async putAssetMeta(rec) {
      assetMeta.set(rec.assetId, rec);
    },
    async listAssetMeta() {
      return [...assetMeta.values()];
    },
    async deleteAssetMeta(assetId) {
      assetMeta.delete(assetId);
    },

    async listCollections() {
      return sortCollections([...collections.values()]);
    },
    async getCollection(id) {
      return collections.get(id) ?? null;
    },
    async putCollection(rec) {
      collections.set(rec.id, rec);
    },
    async deleteCollection(id) {
      collections.delete(id);
    },

    async listAssetVersions(assetId) {
      return [...assetVersions.values()].filter((v) => v.assetId === assetId).sort((a, b) => a.version - b.version);
    },
    async getAssetVersion(assetId, version) {
      return assetVersions.get(`${assetId} ${version}`) ?? null;
    },
    async putAssetVersion(rec) {
      assetVersions.set(`${rec.assetId} ${rec.version}`, rec);
    },
    async deleteAssetVersion(assetId, version) {
      assetVersions.delete(`${assetId} ${version}`);
    },

    async addSubmitQuota(scope, bytes, count) {
      const prev = submitQuota.get(scope);
      const row = {
        scope,
        bytes: (prev?.bytes ?? 0) + bytes,
        count: (prev?.count ?? 0) + count,
        updatedAt: new Date().toISOString(),
      };
      submitQuota.set(scope, row);
      return row;
    },
    async getSubmitQuota(scope) {
      return submitQuota.get(scope) ?? null;
    },
    async listSubmitQuota() {
      return [...submitQuota.values()];
    },

    async listProviders(options) {
      return [...providers.values()].map(rec => {
        if (options?.includeFragment !== false) return rec;
        const { fragment: _fragment, ...state } = rec.state;
        return { ...rec, state };
      });
    },
    async getProvider(id, options) {
      const rec = providers.get(id);
      if (!rec) return null;
      if (options?.includeFragment !== false) return rec;
      const { fragment: _fragment, ...state } = rec.state;
      return { ...rec, state };
    },
    async putProvider(rec) {
      const prev = providers.get(rec.id);
      // Config fields only: credential + state survive an update untouched.
      providers.set(rec.id, prev
        ? {
            ...rec,
            createdAt: prev.createdAt,
            ...(prev.createdBy ? { createdBy: prev.createdBy } : {}),
            ...(prev.credentialCiphertext ? { credentialCiphertext: prev.credentialCiphertext } : {}),
            ...(prev.credentialFingerprint ? { credentialFingerprint: prev.credentialFingerprint } : {}),
            ...(prev.credentialUpdatedAt ? { credentialUpdatedAt: prev.credentialUpdatedAt } : {}),
            state: prev.state,
          }
        : rec);
    },
    async deleteProvider(id) {
      providers.delete(id);
    },
    async putProviderCredential(id, cred) {
      const p = providers.get(id);
      if (!p) return;
      const { credentialCiphertext: _c, credentialFingerprint: _f, credentialUpdatedAt: _u, credentialExpiresAt: _e, ...rest } = p;
      providers.set(id, cred
        ? {
            ...rest,
            credentialCiphertext: cred.ciphertext, credentialFingerprint: cred.fingerprint, credentialUpdatedAt: cred.updatedAt,
            ...(cred.expiresAt ? { credentialExpiresAt: cred.expiresAt } : {}),
          }
        : rest);
    },
    async putProviderState(id, state) {
      const p = providers.get(id);
      if (p) providers.set(id, { ...p, state });
    },

    async putProject(project) {
      projects.set(project.id, project);
    },
    async getProject(id) {
      return projects.get(id) ?? null;
    },
    async listProjects() {
      return [...projects.values()];
    },
    async putProjectFolder(folder) {
      const old = projectFolders.get(folder.id);
      if (!projects.has(folder.projectId) || old && (old.projectId !== folder.projectId || old.parentId !== folder.parentId)) throw new Error('Invalid folder project');
      if (folder.parentId && projectFolders.get(folder.parentId)?.projectId !== folder.projectId) throw new Error('Invalid folder parent');
      projectFolders.set(folder.id, structuredClone(old ? { ...old, name: folder.name } : { ...folder, items: [] }));
    },
    async listProjectFolders(projectId) {
      return structuredClone([...projectFolders.values()].filter(f => f.projectId === projectId));
    },
    async assignProjectFolderItem(projectId, folderId, kind, ref) {
      if (folderId && projectFolders.get(folderId)?.projectId !== projectId) throw new Error('Invalid folder');
      for (const folder of projectFolders.values()) if (folder.projectId === projectId) folder.items = folder.items.filter(item => item.kind !== kind || item.ref !== ref);
      if (folderId) projectFolders.get(folderId)!.items.push({ kind, ref });
    },
    async moveProjectFolder(projectId, folderId, parentId) {
      const folder = projectFolders.get(folderId);
      if (!folder || folder.projectId !== projectId) return 'missing';
      const seen = new Set([folderId]); let next = parentId;
      while (next) {
        const parent = projectFolders.get(next);
        if (seen.has(next) || !parent || parent.projectId !== projectId) return 'invalid';
        seen.add(next); next = parent.parentId;
      }
      folder.parentId = parentId; return 'moved';
    },
    async deleteProjectFolder(projectId, folderId) {
      const folder = projectFolders.get(folderId);
      if (!folder || folder.projectId !== projectId) return false;
      const parent = folder.parentId && projectFolders.get(folder.parentId);
      if (parent) parent.items.push(...folder.items);
      for (const child of projectFolders.values()) if (child.projectId === projectId && child.parentId === folderId) child.parentId = folder.parentId;
      projectFolders.delete(folderId);
      return true;
    },
    // No await between the checks and the insert, so this is atomic here.
    async reserveProjectFile(file, limits) {
      if (!projects.has(file.projectId) || projectFiles.has(file.id)) return 'refused';
      const live = liveProjectFiles();
      const used = (projectId?: string) => live.filter((f) => !projectId || f.projectId === projectId).reduce((sum, f) => sum + projectFileCharge(f), 0);
      const pending = live.filter((f) => !f.ready && f.createdBy === file.createdBy);
      if (pending.length >= limits.maxPending || pending.reduce((sum, f) => sum + f.size, file.size) > limits.maxPendingBytes) return 'pending';
      if (used(file.projectId) + projectFileCharge(file) > limits.projectBudgetBytes) return 'project-budget';
      if (used() + projectFileCharge(file) > limits.instanceBudgetBytes) return 'instance-budget';
      projectFiles.set(file.id, structuredClone(file));
      return 'reserved';
    },
    async getProjectFile(id) { return structuredClone(projectFiles.get(id) ?? null); },
    async listProjectFiles(projectId) {
      return [...projectFiles.values()].filter((f) => f.projectId === projectId && f.ready)
        .sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((f) => structuredClone(f));
    },
    async listUnfinishedProjectFiles(filter, limit) {
      return [...projectFiles.values()]
        .filter((f) => !f.ready && (!filter.createdBy || f.createdBy === filter.createdBy) && (!filter.projectId || f.projectId === filter.projectId)
          && (!filter.expiredBy || Date.parse(f.expiresAt) <= Date.parse(filter.expiredBy)) && (!filter.activeAt || Date.parse(f.expiresAt) > Date.parse(filter.activeAt)))
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit).map((f) => structuredClone(f));
    },
    async projectFileUsage(projectId) {
      const live = liveProjectFiles();
      return {
        projectBytes: live.filter((f) => f.projectId === projectId).reduce((sum, f) => sum + projectFileCharge(f), 0),
        instanceBytes: live.reduce((sum, f) => sum + projectFileCharge(f), 0),
      };
    },
    async touchProjectFile(id, expiresAt) {
      const f = projectFiles.get(id);
      if (!f || !activeProjectFile(f)) return false;
      if (!f.ready && Date.parse(expiresAt) > Date.parse(f.expiresAt)) f.expiresAt = expiresAt;
      return true;
    },
    async completeProjectFile(id) {
      const f = projectFiles.get(id);
      if (!f || (!f.ready && Date.parse(f.expiresAt) <= Date.now())) return false;
      f.ready = true;
      return true;
    },
    async renameProjectFile(projectId, id, name) {
      const file = projectFiles.get(id);
      if (!file || file.projectId !== projectId || !file.ready) return false;
      file.name = name; return true;
    },
    async deleteProjectFile(id) { return projectFiles.delete(id); },
    async listSessionsUsingProjectFile(projectId, fileId) {
      const needle = projectFileAssetId(fileId);
      return [...sessions.values()]
        .filter((s) => s.projectId === projectId && !s.deletedAt && JSON.stringify(s.inputs).includes(needle))
        .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(({ inputs: _inputs, ...summary }) => structuredClone(summary));
    },
    async listProjectMembers(projectId) {
      return [...projectMembers.values()]
        .filter((m) => m.projectId === projectId)
        .sort((a, b) => (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.userId < b.userId ? -1 : 1))
        .map((m) => ({ ...m }));
    },
    async getProjectMember(projectId, userId) {
      const m = projectMembers.get(memberKey(projectId, userId));
      return m ? { ...m } : null;
    },
    async createDocumentAgent(rec) {
      if (!userById(rec.createdBy) || userById(rec.createdBy)?.disabledAt || !projects.has(rec.projectId) || sessions.get(rec.sessionId)?.deletedAt || sessions.get(rec.sessionId)?.projectId !== rec.projectId
        || documentAgents.has(rec.id) || rec.userId !== rec.createdBy) return false;
      if ([...documentAgents.values(), ...projectAgents.values()].filter(r => r.createdBy === rec.createdBy && !r.revokedAt && r.expiresAt > rec.createdAt).length >= 16) return false;
      if ([...documentAgents.values()].some(r => r.tokenHash === rec.tokenHash)) return false;
      documentAgents.set(rec.id, { ...rec }); return true;
    },
    async getDocumentAgent(id) { const r = documentAgents.get(id); return r ? { ...r } : null; },
    async findDocumentAgentByHash(hash) { const r = [...documentAgents.values()].find(r => r.tokenHash === hash); return r ? { ...r } : null; },
    async listDocumentAgents(sessionId) { return [...documentAgents.values()].filter(r => r.sessionId === sessionId).map(r => ({ ...r })); },
    async revokeDocumentAgent(id, at) {
      const rec = documentAgents.get(id); if (!rec || rec.revokedAt) return;
      rec.revokedAt = at;
    },
    async createProjectAgent(rec) {
      const creator = userById(rec.createdBy);
      if (!creator || creator.disabledAt || !projects.has(rec.projectId) || rec.userId !== rec.createdBy || projectAgents.has(rec.id)) return false;
      const active = [...documentAgents.values(), ...projectAgents.values()].filter(r => r.createdBy === rec.createdBy && !r.revokedAt && r.expiresAt > rec.createdAt);
      if (active.length >= 16 || [...projectAgents.values()].some(r => r.tokenHash === rec.tokenHash)) return false;
      projectAgents.set(rec.id, { ...rec }); return true;
    },
    async getProjectAgent(id) { const rec = projectAgents.get(id); return rec ? { ...rec } : null; },
    async findProjectAgentByHash(hash) { const rec = [...projectAgents.values()].find(r => r.tokenHash === hash); return rec ? { ...rec } : null; },
    async listProjectAgents(projectId) { return [...projectAgents.values()].filter(r => r.projectId === projectId).map(r => ({ ...r })); },
    async revokeProjectAgent(id, at) { const rec = projectAgents.get(id); if (rec && !rec.revokedAt) rec.revokedAt = at; },
    async createAgentSession(session, agentId, requestId, digest) {
      const agent = projectAgents.get(agentId), creator = agent && userById(agent.createdBy);
      if (!agent || agent.revokedAt || agent.expiresAt <= new Date().toISOString() || agent.role !== 'editor' || !creator || creator.disabledAt
        || agent.projectId !== session.projectId || agent.createdBy !== session.createdBy) return 'refused';
      const key = JSON.stringify([agentId, requestId]), previous = agentCreations.get(key);
      if (previous) return previous.digest === digest && previous.sessionId === session.id ? 'replayed' : 'conflict';
      if (sessions.has(session.id)) return 'conflict';
      if ([...agentCreations.keys()].filter(key => JSON.parse(key)[0] === agentId).length >= 1000) return 'refused';
      sessions.set(session.id, structuredClone(session)); agentCreations.set(key, { digest, sessionId: session.id }); return 'created';
    },
    async listUserProjectMemberships(userId) {
      return [...projectMembers.values()].filter((m) => m.userId === userId).map((m) => ({ ...m }));
    },
    async putProjectMember(rec) {
      const k = memberKey(rec.projectId, rec.userId);
      const prev = projectMembers.get(k);
      const next: ProjectMemberRecord = prev ? { ...prev, role: rec.role } : { ...rec };
      if (rec.expiresAt) next.expiresAt = rec.expiresAt; else delete next.expiresAt;
      projectMembers.set(k, next);
    },
    async updateProjectMemberRole(projectId, userId, role) {
      const k = memberKey(projectId, userId);
      const prev = projectMembers.get(k);
      if (!prev) return null;
      const next = { ...prev, role };
      projectMembers.set(k, next);
      return { ...next };
    },
    async deleteProjectMember(projectId, userId) {
      return projectMembers.delete(memberKey(projectId, userId));
    },
    async getUsersByIds(ids) {
      const wanted = new Set(ids);
      return [...users.values()].filter((u) => wanted.has(u.id)).map(mapped);
    },
    async getCommentThread(id) { const thread = commentThreads.get(id); return thread ? structuredClone(thread) : null; },
    async listCommentThreads(sessionId) { return [...commentThreads.values()].filter(thread => thread.sessionId === sessionId).map(thread => structuredClone(thread)); },
    async createCommentThread(thread) {
      if (commentThreads.has(thread.id)) return 'exists';
      if (!sessions.has(thread.sessionId) || sessions.get(thread.sessionId)?.deletedAt) return 'limit';
      if ([...commentThreads.values()].filter(value => value.sessionId === thread.sessionId).length >= COMMENT_THREAD_LIMIT) return 'limit';
      commentThreads.set(thread.id, structuredClone(thread)); return 'created';
    },
    async casCommentThread(thread, expectedRevision) {
      const previous = commentThreads.get(thread.id);
      if (!previous || previous.sessionId !== thread.sessionId || previous.revision !== expectedRevision || sessions.get(thread.sessionId)?.deletedAt) return false;
      commentThreads.set(thread.id, structuredClone(thread)); return true;
    },
    async getCommentThreadsByIds(ids) {
      return [...new Set(ids)].flatMap((id) => { const thread = commentThreads.get(id); return thread ? [structuredClone(thread)] : []; });
    },
    async readCommentState(userId, sessionId) {
      const now = new Date().toISOString(), key = `${userId} ${sessionId}`;
      if (!commentReadFloors.has(key) && userById(userId) && sessions.has(sessionId)) commentReadFloors.set(key, now);
      const reads = [...commentReads.values()].filter((r) => r.userId === userId && r.sessionId === sessionId);
      return { reads: Object.fromEntries(reads.map((r) => [r.threadId, r.readAt])), floorAt: commentReadFloors.get(key) ?? now };
    },
    async markCommentsRead(userId, sessionId, entries) {
      if (!userById(userId)) return;
      const now = Date.now();
      for (const { threadId, at } of entries) {
        const thread = commentThreads.get(threadId), ms = Math.min(Date.parse(at), now);
        if (!thread || thread.sessionId !== sessionId || !Number.isFinite(ms)) continue;
        const key = `${userId} ${threadId}`, prev = commentReads.get(key);
        if (prev && Date.parse(prev.readAt) >= ms) continue;
        commentReads.set(key, { userId, threadId, sessionId, readAt: new Date(ms).toISOString() });
      }
    },
    async upsertCommentNotice(n) {
      const at = new Date(n.at).toISOString();
      if (!userById(n.userId) || !commentThreads.has(n.threadId) || !sessions.has(n.sessionId) || !projects.has(n.projectId))
        throw new Error('comment-notice-reference');
      const id = commentNoticeId(n.userId, n.threadId), prev = commentNotices.get(id);
      const kind = n.mentioned || prev?.kind === 'mention' ? 'mention' : n.kind;
      if (!prev) {
        commentNotices.set(id, { id, userId: n.userId, threadId: n.threadId, sessionId: n.sessionId, projectId: n.projectId,
          kind, actorId: n.actorId, messageId: n.messageId, count: 1, createdAt: at });
        return 'created';
      }
      commentNotices.set(id, prev.messageId === n.messageId ? { ...prev, kind } : {
        ...prev, kind, actorId: n.actorId, messageId: n.messageId, count: Math.min(prev.count + 1, COMMENT_NOTICE_COUNT_MAX),
        createdAt: Date.parse(at) > Date.parse(prev.createdAt) ? at : prev.createdAt,
      });
      return 'updated';
    },
    async listCommentNotices(userId, limit) {
      return [...commentNotices.values()].filter((n) => n.userId === userId).sort(noticeOrder)
        .slice(0, noticeListLimit(limit)).map((n) => ({ ...n }));
    },
    async deleteCommentNotices(userId, by) {
      const ids = new Set(by.ids ?? []), threads = new Set(by.threadIds ?? []), sessionIds = new Set(by.sessionIds ?? []);
      let n = 0;
      for (const [k, row] of commentNotices) {
        if (row.userId !== userId || !(ids.has(row.id) || threads.has(row.threadId) || sessionIds.has(row.sessionId))) continue;
        commentNotices.delete(k); n++;
      }
      return n;
    },
    async countNoticesByActorSince(actorId, sinceIso) {
      const since = Date.parse(new Date(sinceIso).toISOString());
      return [...commentNotices.values()].filter((n) => n.actorId === actorId && Date.parse(n.createdAt) >= since).length;
    },
    async pruneCommentNotices(userId, keep, olderThanIso) {
      const cutoff = Date.parse(new Date(olderThanIso).toISOString()), kept = noticeKeepCount(keep);
      const rows = [...commentNotices.values()].filter((n) => n.userId === userId).sort(noticeOrder);
      let n = 0;
      rows.forEach((row, i) => {
        if (i < kept && Date.parse(row.createdAt) >= cutoff) return;
        commentNotices.delete(row.id); n++;
      });
      return n;
    },
    async recordMentionSends(threadId, messageId, userIds, at) {
      const stamp = new Date(at).toISOString();
      if (!commentThreads.has(threadId)) return [];
      return [...new Set(userIds)].filter((userId) => {
        const key = JSON.stringify([threadId, messageId, userId]);
        if (!userById(userId) || mentionSends.has(key)) return false;
        mentionSends.set(key, stamp); return true;
      });
    },
    async forgetMentionSends(threadId, messageId, userIds) {
      let n = 0;
      for (const userId of new Set(userIds)) if (mentionSends.delete(JSON.stringify([threadId, messageId, userId]))) n++;
      return n;
    },
    async putSession(session) {
      if ((collabOwners.get(session.id)?.until ?? 0) > Date.now()) throw new Error('collab-active');
      sessions.set(session.id, session);
    },
    async casSession(next, expectedRev) {
      const cur = sessions.get(next.id);
      if (!cur || cur.rev !== expectedRev || cur.deletedAt || (collabOwners.get(next.id)?.until ?? 0) > Date.now()) return false;
      // `deletedAt` is carried from the STORED row, never from the candidate: a CAS
      // must not be a way to resurrect a tombstone, whatever the caller's copy says.
      sessions.set(next.id, { ...next, ...(cur.deletedAt ? { deletedAt: cur.deletedAt } : {}) });
      return true;
    },
    async getSession(id) {
      return sessions.get(id) ?? null;
    },
    async listSessions(projectId) {
      return [...sessions.values()].filter((s) => s.projectId === projectId && !s.deletedAt);
    },
    async listSessionSummaries(projectId) {
      return [...sessions.values()]
        .filter((s) => s.projectId === projectId && !s.deletedAt)
        .map(({ inputs: _inputs, ...summary }) => structuredClone(summary));
    },
    async projectSessionStats(projectId) {
      const stats = new Map<string, { projectId: string; count: number; updatedAt: string; updatedBy: string }>();
      for (const s of sessions.values()) {
        if (s.deletedAt || (projectId !== undefined && s.projectId !== projectId)) continue;
        const prev = stats.get(s.projectId);
        if (!prev) stats.set(s.projectId, { projectId: s.projectId, count: 1, updatedAt: s.updatedAt, updatedBy: s.updatedBy });
        else {
          prev.count += 1;
          if (s.updatedAt > prev.updatedAt) { prev.updatedAt = s.updatedAt; prev.updatedBy = s.updatedBy; }
        }
      }
      return [...stats.values()];
    },
    async listSessionsFiltered(filter) {
      return [...sessions.values()].filter((s) =>
        !s.deletedAt &&
        (filter.projectId === undefined || s.projectId === filter.projectId) &&
        (filter.toolId === undefined || s.toolId === filter.toolId));
    },
    async appendSessionRevision(rev) {
      const list = sessionRevisions.get(rev.sessionId) ?? [];
      // Idempotent replay (plans/08 §8): the same op twice yields one revision.
      const next = [...list.filter((r) => r.rev !== rev.rev), rev].sort((a, b) => a.rev - b.rev);
      sessionRevisions.set(rev.sessionId, next.slice(-SESSION_REVISION_LIMIT));
    },
    async listSessionRevisions(sessionId) {
      return [...(sessionRevisions.get(sessionId) ?? [])].sort((a, b) => b.rev - a.rev);
    },

    // Durable room ownership, convergence checkpoints, journal and receipts.
    async claimCollab(sessionId, owner, ttlMs) {
      const session = sessions.get(sessionId), held = collabOwners.get(sessionId);
      if (!session || session.deletedAt || held && held.owner !== owner && held.until > Date.now()) return false;
      collabOwners.set(sessionId, { owner, until: Date.now() + ttlMs }); return true;
    },
    async releaseCollab(sessionId, owner) {
      if (collabOwners.get(sessionId)?.owner === owner) collabOwners.delete(sessionId);
    },
    async collabLeaseActive(sessionId) {
      return sessions.has(sessionId) && (collabOwners.get(sessionId)?.until ?? 0) > Date.now();
    },
    async getCollabCheckpoint(sessionId) { return structuredClone(collabCheckpoints.get(sessionId) ?? null); },
    async getCollabJournal(sessionId, afterRevision) {
      return structuredClone((collabJournal.get(sessionId) ?? []).filter(row => row.revision > afterRevision));
    },
    async getCollabReceipts(sessionId, principal, ids) {
      return ids.flatMap(id => { const r = collabReceipts.get(receiptKey(sessionId, principal, id)); return r ? [structuredClone(r)] : []; });
    },
    async commitCollab(batch) {
      const session = sessions.get(batch.sessionId), held = collabOwners.get(batch.sessionId);
      if (!session || session.deletedAt || session.rev !== batch.expectedRev || held?.owner !== batch.owner || held.until <= Date.now())
        throw new Error('collab-owner-conflict');
      for (const r of batch.receipts) if (collabReceipts.has(receiptKey(batch.sessionId, batch.principal, r.id))) throw new Error('collab-receipt-conflict');
      const rev = session.rev + 1, at = new Date().toISOString();
      const saved = collabCheckpoints.get(session.id);
      if (!batch.checkpoint && saved?.headRevision !== batch.expectedRev) throw new Error('collab-checkpoint-required');
      const inputs = structuredClone(batch.inputs), checkpoint = structuredClone(batch.checkpoint), ops = structuredClone(batch.ops);
      sessions.set(session.id, { ...session, inputs, rev, updatedAt: at, updatedBy: batch.updatedBy });
      if (checkpoint) {
        collabCheckpoints.set(session.id, { revision: rev, headRevision: rev, checkpoint });
        collabJournal.delete(session.id);
      } else {
        collabCheckpoints.set(session.id, { ...saved!, headRevision: rev });
        collabJournal.set(session.id, [...(collabJournal.get(session.id) ?? []), { revision: rev, ops }]);
      }
      for (const r of batch.receipts) collabReceipts.set(receiptKey(session.id, batch.principal, r.id), { ...r, revision: rev });
      return rev;
    },
    async commitCollabReceipts(batch) {
      if (batch.receipts.some(r => r.accepted)) throw new Error('collab-accepted-receipt-needs-commit');
      const session = sessions.get(batch.sessionId), held = collabOwners.get(batch.sessionId);
      if (!session || session.deletedAt || session.rev !== batch.expectedRev || held?.owner !== batch.owner || held.until <= Date.now())
        throw new Error('collab-owner-conflict');
      for (const r of batch.receipts) if (collabReceipts.has(receiptKey(batch.sessionId, batch.principal, r.id))) throw new Error('collab-receipt-conflict');
      for (const r of batch.receipts) collabReceipts.set(receiptKey(session.id, batch.principal, r.id), { ...r, revision: batch.expectedRev });
    },

    async putCollabSnapshot(snap) {
      collabSnapshots.set(snap.sessionId, { ...snap, inputs: structuredClone(snap.inputs) });
    },
    async getCollabSnapshot(sessionId) {
      const row = collabSnapshots.get(sessionId);
      return row ? { ...row, inputs: structuredClone(row.inputs) } : null;
    },
    async deleteCollabSnapshot(sessionId) {
      collabSnapshots.delete(sessionId);
    },

    // The sharing ladder (migration 0060; lolly plan 299 M1).
    async setProjectMemberExpiry(projectId, userId, expiresAt) {
      const k = memberKey(projectId, userId);
      const prev = projectMembers.get(k);
      if (!prev) return null;
      const next: ProjectMemberRecord = { ...prev };
      if (expiresAt) next.expiresAt = expiresAt; else delete next.expiresAt;
      projectMembers.set(k, next);
      return { ...next };
    },
    async listShareGroups() {
      return [...shareGroups.values()].map(liveShareGroup).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1));
    },
    async getShareGroup(id) {
      const g = shareGroups.get(id);
      return g ? liveShareGroup(g) : null;
    },
    async putShareGroup(group) {
      shareGroups.set(group.id, structuredClone(group));
    },
    async deleteShareGroup(id) {
      shareGroups.delete(id);
      for (const u of users.values()) {
        if (u.shareGroups?.includes(id)) users.set(u.sub, { ...u, shareGroups: u.shareGroups.filter((g) => g !== id) });
      }
    },
    async listShareGroupMembers(id) {
      return [...users.values()].filter((u) => u.shareGroups?.includes(id)).map(mapped);
    },
    async setUserShareGroups(userId, ids) {
      const u = userById(userId);
      if (!u) return null;
      const next: UserRecord = { ...u, shareGroups: [...new Set(ids.filter(Boolean))] };
      users.set(u.sub, next);
      return mapped(next);
    },
    async addUserShareGroup(userId, groupId) {
      const u = userById(userId);
      if (!u || !shareGroups.has(groupId)) return null;
      if (u.shareGroups?.includes(groupId)) return mapped(u);
      const next: UserRecord = { ...u, shareGroups: [...(u.shareGroups ?? []), groupId] };
      users.set(u.sub, next);
      return mapped(next);
    },
    async removeUserShareGroup(userId, groupId) {
      const u = userById(userId);
      if (!u) return null;
      const next: UserRecord = { ...u, shareGroups: (u.shareGroups ?? []).filter((g) => g !== groupId) };
      users.set(u.sub, next);
      return mapped(next);
    },
    async listProjectUserState(userId) {
      // Rows go with the person and with the project, as the foreign keys do in Postgres.
      return [...projectUserState.values()]
        .filter((r) => r.userId === userId && userById(userId) && projects.has(r.projectId))
        .map((r) => ({ ...r }));
    },
    async putProjectUserState(userId, projectId, change) {
      const key = `${userId} ${projectId}`;
      const next: ProjectUserStateRecord = { ...(projectUserState.get(key) ?? { userId, projectId }) };
      if (change.listed !== undefined) { if (change.listed) next.listed = change.listed; else delete next.listed; }
      if (change.lastOpenedAt) next.lastOpenedAt = change.lastOpenedAt;
      projectUserState.set(key, next);
      return { ...next };
    },
    ...createMemoryVersions(sessions),
  };
}

type VersionMethods = 'configureVersionLimits' | 'putSessionVersion' | 'listSessionVersions' | 'getSessionVersion' | 'deleteSessionVersion' | 'deleteSessionVersions';

/**
 * Session versions (plan 76 M4 R2): the memory twin of migration 0053's two
 * tables. Writes run one at a time, as the Postgres driver's lock makes them, and
 * the rules are the shared `planSessionVersionPut`.
 */
function createMemoryVersions(sessions: ReadonlyMap<string, SessionRecord>): Pick<Store, VersionMethods> {
  type Stored = Omit<SessionVersion, 'inputs' | 'bytes'> & { digest: string; requestId?: string };
  const versions = new Map<string, Stored>(); // by id
  const contents = new Map<string, { sessionId: string; digest: string; inputs: Record<string, unknown>; bytes: number }>(); // `${sessionId} ${digest}`
  const contentKey = (sessionId: string, digest: string): string => `${sessionId} ${digest}`;
  let limits: SessionVersionLimits = resolveVersionLimits({});
  let writes: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writes.then(work);
    writes = run.catch(() => undefined);
    return run;
  };
  const rowOf = (v: Stored): SessionVersionRow => ({ id: v.id, sessionId: v.sessionId, kind: v.kind, digest: v.digest, at: v.at,
    ...(v.createdBy !== undefined ? { createdBy: v.createdBy } : {}), ...(v.requestId !== undefined ? { requestId: v.requestId } : {}),
    ...(v.beforeId !== undefined ? { beforeId: v.beforeId } : {}) });
  const summary = (v: Stored): SessionVersionSummary => ({
    id: v.id, sessionId: v.sessionId, rev: v.rev, kind: v.kind, ...(v.label !== undefined ? { label: v.label } : {}),
    contributors: structuredClone(v.contributors), ...(v.createdBy !== undefined ? { createdBy: v.createdBy } : {}),
    ...(v.restoredFrom !== undefined ? { restoredFrom: v.restoredFrom } : {}), ...(v.beforeId !== undefined ? { beforeId: v.beforeId } : {}),
    bytes: contents.get(contentKey(v.sessionId, v.digest))?.bytes ?? 0, at: v.at,
  });
  const own = (sessionId: string): Stored[] => [...versions.values()].filter((v) => v.sessionId === sessionId);
  /** Delete versions as Postgres would: references to them become unset, then
   *  the contents no version uses any more go. */
  const drop = (ids: Iterable<string>): number => {
    const gone = new Set(ids), touched = new Set<string>();
    let count = 0;
    for (const id of gone) {
      const v = versions.get(id);
      if (!v) continue;
      touched.add(v.sessionId); versions.delete(id); count++;
    }
    for (const v of versions.values()) {
      if (v.restoredFrom !== undefined && gone.has(v.restoredFrom)) delete v.restoredFrom;
      if (v.beforeId !== undefined && gone.has(v.beforeId)) delete v.beforeId;
    }
    const used = new Set([...versions.values()].map((v) => contentKey(v.sessionId, v.digest)));
    for (const [key, c] of contents) if (touched.has(c.sessionId) && !used.has(key)) contents.delete(key);
    return count;
  };

  return {
    configureVersionLimits(next) { limits = resolveVersionLimits(next); },
    putSessionVersion(input) {
      return serial(async (): Promise<SessionVersionPut> => {
        const w = normalizeSessionVersionWrite(input);
        const session = sessions.get(w.sessionId);
        if (!session || session.deletedAt) throw new Error('session-gone');
        for (const ref of [w.restoredFrom, w.beforeId]) if (ref !== undefined && versions.get(ref)?.sessionId !== w.sessionId) throw new Error('version-reference');
        const content = sessionVersionContent(w.inputs);
        const id = sessionVersionId();
        const mine = own(w.sessionId);
        const plan = await planSessionVersionPut(w, id, content, {
          rows: mine.map(rowOf),
          contents: new Map([...contents.values()].filter((c) => c.sessionId === w.sessionId).map((c) => [c.digest, c.bytes])),
          instanceBytes: async () => [...contents.values()].reduce((sum, c) => sum + c.bytes, 0),
          instanceRows: async () => ({ rows: [...versions.values()].map(rowOf), contents: new Map([...contents].map(([key, c]) => [key, c.bytes])) }),
        }, limits);
        if (plan.action === 'refuse') return plan.reason;
        if (plan.action === 'return') return { version: summary(versions.get(plan.id)!), created: false };
        if (plan.action === 'skip') {
          const latest = mine.sort(newestVersionFirst)[0];
          return latest ? { version: summary(latest), created: false } : 'version-space';
        }
        if (plan.contentIsNew) contents.set(contentKey(w.sessionId, content.digest), { sessionId: w.sessionId, digest: content.digest, inputs: structuredClone(w.inputs), bytes: content.bytes });
        const { inputs: _inputs, keep: _keep, ...fields } = w;
        const stored: Stored = { ...structuredClone(fields), id, digest: content.digest };
        versions.set(id, stored);
        drop(plan.drops);
        return { version: summary(stored), created: true };
      });
    },
    async listSessionVersions(sessionId, opts) {
      const rows = own(sessionId).sort(newestVersionFirst);
      let start = 0;
      if (opts.before !== undefined) {
        start = rows.findIndex((v) => v.id === opts.before) + 1;
        if (start === 0) return [];
      }
      return rows.slice(start, start + versionListLimit(opts.limit)).map(summary);
    },
    async getSessionVersion(sessionId, id) {
      const v = versions.get(id);
      if (!v || v.sessionId !== sessionId) return null;
      const inputs = contents.get(contentKey(sessionId, v.digest))?.inputs ?? {};
      return { ...summary(v), inputs: structuredClone(inputs), meta: structuredClone(v.meta) };
    },
    deleteSessionVersion(sessionId, id) {
      return serial(async () => {
        const v = versions.get(id);
        if (!v || v.sessionId !== sessionId) return false;
        const ids = new Set([id]);
        if (v.beforeId !== undefined) ids.add(v.beforeId);
        for (const r of versions.values()) if (r.sessionId === sessionId && r.beforeId === id) ids.add(r.id);
        drop(ids);
        return true;
      });
    },
    deleteSessionVersions(sessionId) {
      return serial(async () => {
        const count = drop(own(sessionId).map((v) => v.id));
        for (const [key, c] of contents) if (c.sessionId === sessionId) contents.delete(key);
        return count;
      });
    },
  };
}
