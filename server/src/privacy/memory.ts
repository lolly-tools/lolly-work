// SPDX-License-Identifier: MPL-2.0
import type { ApiTokenRecord, InstallRow, PasswordLinkRecord, ProjectMemberRecord, UserIdentityRecord, UserRecord } from '../store/types.ts';
import type { LinkRecord } from '../links/sign.ts';
import type { AuditEvent } from '../audit/chain.ts';
import type { StoredEvent } from '../telemetry/ingest.ts';
import { roleFromGroups, type RoleGroups } from '../rbac/evaluate.ts';
import { subjectRow, type SubjectStore } from './subject.ts';

interface Data {
  users: Map<string, UserRecord>; identities: Map<string, UserIdentityRecord>; projectMembers: Map<string, ProjectMemberRecord>;
  apiTokens: Map<string, ApiTokenRecord>; links: Map<string, LinkRecord>; passwordLinks: Map<string, PasswordLinkRecord>;
  events: StoredEvent[]; installs: Map<string, InstallRow>; audit: AuditEvent[]; roles(): RoleGroups;
}

export function createMemorySubjects(data: Data): SubjectStore {
  const telemetryIds = new WeakMap<StoredEvent, number>();
  let telemetryHead = 0;
  return {
    async subjectRows(userId, category, after, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 201) throw new Error('Invalid page size.');
      const { identities, projectMembers, apiTokens, links, installs, events, audit } = data;
      const numeric = category === 'audit' || category === 'telemetry';
      if (numeric && after && !/^\d{1,19}$/.test(after)) throw new Error('Invalid numeric continuation.');
      for (const event of events) if (!telemetryIds.has(event)) telemetryIds.set(event, ++telemetryHead);
      const rows = category === 'identities' ? [...identities.values()].filter(r => r.userId === userId).map(r => subjectRow(r.identitySub, {
        identitySub: r.identitySub, idp: r.idp, email: r.email ?? null, emailVerified: r.emailVerified, linkedAt: r.linkedAt, lastLoginAt: r.lastLoginAt ?? null }))
        : category === 'projects' ? [...projectMembers.values()].filter(r => r.userId === userId).map(r => subjectRow(r.projectId, { projectId: r.projectId, role: r.role, addedAt: r.addedAt }))
        : category === 'credentials' ? [...apiTokens.values()].filter(r => r.createdBy === `user:${userId}`).map(r => subjectRow(r.id, {
          id: r.id, label: r.label, role: r.role, createdAt: r.createdAt, expiresAt: r.expiresAt ?? null, lastUsedAt: r.lastUsedAt ?? null, revokedAt: r.revokedAt ?? null }))
        : category === 'links' ? [...links.values()].filter(r => r.createdBy === userId).map(r => subjectRow(r.id, {
          id: r.id, kind: r.kind, expiresAt: new Date(r.exp * 1000).toISOString(), createdAt: r.createdAt, revokedAt: r.revokedAt ?? null }))
        : category === 'fleet' ? [...installs.values()].filter(r => r.userIdLastSeen === userId).map(r => subjectRow(r.installId, {
          installId: r.installId, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt }))
        : category === 'telemetry' ? events.filter(r => r.userId === userId).map(r => subjectRow(String(telemetryIds.get(r)), { at: r.at, event: r.event, attrs: r.attrs }))
        : audit.filter(r => r.actor === `user:${userId}` || r.subject === `user:${userId}`).map(r => subjectRow(String(r.seq), {
          sourceSeq: r.seq, at: r.at, action: r.action, sourceHash: r.hash, sourcePrevHash: r.prevHash }));
      return rows.filter(r => numeric ? BigInt(r.key) > BigInt(after || '0') : r.key > after)
        .sort((a, b) => numeric ? Number(BigInt(a.key) - BigInt(b.key)) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0).slice(0, limit);
    },
    async offboardUser(userId, actorId, at, limit) {
      if (userId === actorId) return { status: 'self' };
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid offboarding bound.');
      const { users, identities, apiTokens, links, passwordLinks } = data;
      const target = [...users.values()].find(u => u.id === userId);
      if (!target) return { status: 'not-found' };
      if (!target.disabledAt && roleFromGroups(target.groups, data.roles()) === 'owner'
        && ![...users.values()].some(u => u.id !== userId && !u.disabledAt && roleFromGroups(u.groups, data.roles()) === 'owner')) return { status: 'last-owner' };
      const tokens = [...apiTokens.values()].filter(r => r.createdBy === `user:${userId}` && !r.revokedAt);
      const issued = [...links.values()].filter(r => r.createdBy === userId && !r.revokedAt);
      const emails = new Set([target.email.toLowerCase(), ...[...identities.values()].filter(r => r.userId === userId && r.email).map(r => r.email!.toLowerCase())]);
      const passwords = [...passwordLinks.values()].filter(r => emails.has(r.email) && !r.usedAt);
      if (tokens.length > limit || issued.length > limit || passwords.length > limit) return { status: 'limit' };
      const sessionEpoch = target.sessionEpoch + 1;
      users.set(target.sub, { ...target, disabledAt: at, sessionEpoch });
      for (const r of tokens) apiTokens.set(r.id, { ...r, revokedAt: at });
      for (const r of issued) links.set(r.id, { ...r, revokedAt: at });
      for (const r of passwords) passwordLinks.delete(r.tokenHash);
      return { status: 'disabled', sessionEpoch, credentialsRevoked: tokens.length, linksRevoked: issued.length, passwordLinksRevoked: passwords.length };
    },
  };
}
