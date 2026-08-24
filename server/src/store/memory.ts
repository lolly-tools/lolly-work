/**
 * In-memory Store - dev, tests, and the evaluation container's default.
 * Postgres driver lands beside this (migrations/0001_init.sql is the schema).
 */
import { randomId } from '../lib/crypto.ts';
import { nextEvent, type AuditAnchor, type AuditEvent, type AuditEventBody } from '../audit/chain.ts';
import { clientBucket, type ClientInfo } from '../fleet/client-header.ts';
import { eligibleForCurrentStep, type Approval, type Chain } from '../approvals/engine.ts';
import { roleFromGroups, type Grant } from '../rbac/evaluate.ts';
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
import { sortCollections, type CollectionRecord } from '../catalog/collections.ts';
import type { AssetVersionRecord } from '../catalog/versions.ts';
import type { ProviderRecord } from '../catalog/providers/types.ts';
import {
  SESSION_REVISION_LIMIT, effectiveGroups,
  type ApiTokenRecord, type CollabSnapshot, type DeviceCodeRecord, type FleetRow, type InstallRow, type LocalGroupRecord, type ProjectRecord, type ScimTokenRecord,
  type SessionRecord, type SessionRevision, type Store, type SubmitQuotaRow, type UserRecord,
} from './types.ts';

// Grants have no exposed id - they're identified by their full tuple.
const sameGrant = (a: Grant, b: Grant): boolean =>
  a.principal === b.principal && a.action === b.action && a.resource === b.resource && a.effect === b.effect;

export function createMemoryStore(seed?: { grants?: Grant[]; overlays?: ToolOverlay[]; messages?: Message[]; flagGovernance?: FlagGovernance[]; injectables?: InjectableRecord[] }): Store {
  const users = new Map<string, UserRecord>(); // by sub
  const localGroups = new Map<string, LocalGroupRecord>(); // registry, by name
  const scimTokens = new Map<string, ScimTokenRecord>(); // SCIM provisioning bearers, by id
  const apiTokens = new Map<string, ApiTokenRecord>(); // service tokens (plans/35), by id
  let siemCursor = 0; // highest audit seq confirmed delivered to the SIEM receiver
  let auditAnchor: AuditAnchor | null = null; // retention trim boundary (plans/35 wave 3)
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
  const assetMeta = new Map<string, AssetMetaRecord>();
  const collections = new Map<string, CollectionRecord>();
  /** `${assetId} ${version}` (space-joined) - the composite key migration 0020 makes a
   *  primary key. One flat map keeps the memory driver's shape as close to the
   *  SQL one as a Map allows. */
  const assetVersions = new Map<string, AssetVersionRecord>();
  const providers = new Map<string, ProviderRecord>();
  const projects = new Map<string, ProjectRecord>();
  const sessions = new Map<string, SessionRecord>();
  const sessionRevisions = new Map<string, SessionRevision[]>(); // sessionId -> ascending by rev
  const collabSnapshots = new Map<string, CollabSnapshot>(); // sessionId -> the live room's doc

  return {
    async upsertUserBySub(user) {
      const now = new Date().toISOString();
      const existing = users.get(user.sub);
      // Incoming groups are the IdP-authoritative set; local groups are durable.
      const idpGroups = [...new Set(user.groups.filter(Boolean))];
      const local = existing?.localGroups ?? [];
      const groups = effectiveGroups(idpGroups, local);
      const role = roleFromGroups(groups); // derived on the effective union
      const next: UserRecord = existing
        ? { ...existing, ...user, idpGroups, localGroups: local, groups, role, lastSeenAt: now }
        : { ...user, id: randomId(8), idpGroups, localGroups: local, groups, role, sessionEpoch: 0, createdAt: now, lastSeenAt: now };
      users.set(user.sub, next);
      return next;
    },
    async getUserBySub(sub) {
      return users.get(sub) ?? null;
    },
    async getUser(id) {
      for (const u of users.values()) if (u.id === id) return u;
      return null;
    },
    async setTelemetryConsent(userId, consent) {
      for (const u of users.values()) {
        if (u.id === userId) users.set(u.sub, { ...u, telemetryConsent: consent });
      }
    },
    async listUsers() {
      return [...users.values()];
    },
    async listUsersPage(opts) {
      let rows = [...users.values()];
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
        const next: UserRecord = { ...u, localGroups: localGroupsNext, groups, role: roleFromGroups(groups) };
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
        return next;
      }
      return null;
    },
    async bumpSessionEpoch(userId) {
      for (const u of users.values()) {
        if (u.id !== userId) continue;
        const next: UserRecord = { ...u, sessionEpoch: u.sessionEpoch + 1 };
        users.set(u.sub, next);
        return next;
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
        users.set(u.sub, { ...u, localGroups: local, groups, role: roleFromGroups(groups) });
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

    async appendAudit(body: AuditEventBody) {
      const evt = nextEvent(audit[audit.length - 1] ?? null, body);
      audit.push(evt);
      return evt;
    },
    async listAudit() {
      return [...audit];
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
          return true;
        }
      }
      return false;
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

    async listProviders() {
      return [...providers.values()];
    },
    async getProvider(id) {
      return providers.get(id) ?? null;
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
      const { credentialCiphertext: _c, credentialFingerprint: _f, credentialUpdatedAt: _u, ...rest } = p;
      providers.set(id, cred
        ? { ...rest, credentialCiphertext: cred.ciphertext, credentialFingerprint: cred.fingerprint, credentialUpdatedAt: cred.updatedAt }
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
    async putSession(session) {
      sessions.set(session.id, session);
    },
    async casSession(next, expectedRev) {
      const cur = sessions.get(next.id);
      if (!cur || cur.rev !== expectedRev || cur.deletedAt) return false;
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

    // live collab rooms (plans/14 §6). Replace-in-place, exactly one row per
    // session - there is no update log here or in Postgres. `inputs` is cloned so
    // this driver round-trips like jsonb does: a caller that later mutates the
    // object it handed us must not reach back into the store.
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
  };
}
