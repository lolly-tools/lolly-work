import type { CanvasCheckpoint, CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { auditWhere } from '../audit/filter.ts';
import { projectFileAssetId, PROJECT_FILE_OVERHEAD_BYTES, type ProjectFileRecord } from '../projects/files.ts';
/**
 * Postgres Store driver - binds the Store seam to migrations/0001_init.sql.
 *
 * `pg` is imported lazily so the server (and the whole test suite) still runs
 * with zero runtime deps when DATABASE_URL is unset - the memory driver stays
 * the default. Audit appends serialize on a pg advisory lock so the hash
 * chain never forks under concurrent writers.
 */
import { randomId } from '../lib/crypto.ts';
import { nextEvent, type AuditAnchor, type AuditEvent, type AuditEventBody } from '../audit/chain.ts';
import { clientBucket, type ClientInfo } from '../fleet/client-header.ts';
import { eligibleForCurrentStep, type Approval, type Chain } from '../approvals/engine.ts';
import { roleFromGroups, type Grant, type RoleGroups } from '../rbac/evaluate.ts';
import type { ToolOverlay } from '../policy/overlay.ts';
import type { FlagGovernance } from '../policy/feature-flags.ts';
import type { InjectableRecord } from '../injectables/types.ts';
import { pendingAgainst } from './migrate.ts';
import { guardPool, pgPoolOptions } from './pg-options.ts';
import type { LinkRecord } from '../links/sign.ts';
import type { StoredEvent } from '../telemetry/ingest.ts';
import type { Message } from '../inbox/target.ts';
import type { LifecycleRow, OnExpiry } from '../catalog/lifecycle.ts';
import type { CredentialRow } from '../catalog/credentials.ts';
import type { InstanceAssetRecord } from '../catalog/instance-assets.ts';
import type { AssetMetaRecord, CatalogFieldDef } from '../catalog/asset-meta.ts';
import { sortCollections, type CollectionRecord } from '../catalog/collections.ts';
import type { AssetVersionRecord } from '../catalog/versions.ts';
import type { ProviderFragment, ProviderKind, ProviderRecord } from '../catalog/providers/types.ts';
import type { DeliveryRecord } from '../delivery/types.ts';
import { createPostgresRenderStore } from '../renders/postgres.ts';
import {
  SESSION_REVISION_LIMIT, effectiveGroups,
  type ApiTokenRecord, type AutomationJobRecord, type CollabSnapshot, type DeviceCodeRecord, type FleetRow, type InstallRow, type InvitationRecord, type ListUsersPageOpts, type LocalGroupRecord, type PasswordAttempt, type PasswordCredentialRecord, type PasswordLinkRecord, type ProjectMemberRecord, type ProjectRecord, type UserIdentityRecord,
  type ScimTokenRecord, type SessionRecord, type SessionRevision, type Store, type SubmitQuotaRow, type UserRecord,
} from './types.ts';

/** One api_tokens row → record (plans/35 wave 2). */
function apiTokenFromRow(r: Record<string, unknown>): ApiTokenRecord {
  return {
    id: r.id as string,
    label: r.label as string,
    role: r.role as string,
    tokenHash: r.token_hash as string,
    createdBy: r.created_by as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    ...(r.last_used_at ? { lastUsedAt: new Date(r.last_used_at as string).toISOString() } : {}),
    ...(r.revoked_at ? { revokedAt: new Date(r.revoked_at as string).toISOString() } : {}),
  };
}

/** An invitation's projects as stored: only the known keys. */
function invitationProjectsJson(list: NonNullable<InvitationRecord['projects']>): NonNullable<InvitationRecord['projects']> {
  return list.map((p) => ({ projectId: p.projectId, role: p.role, ...(p.invitedBy ? { invitedBy: p.invitedBy } : {}) }));
}

/** One invitations row -> record (plans/74 W-ID-2). */
function invitationFromRow(r: Record<string, unknown>): InvitationRecord {
  const iso = (v: unknown): string => new Date(v as string).toISOString();
  return {
    id: r.id as string,
    email: r.email as string,
    groups: (r.groups as string[]) ?? [],
    invitedBy: r.invited_by as string,
    createdAt: iso(r.created_at),
    ...(r.expires_at ? { expiresAt: iso(r.expires_at) } : {}),
    ...(r.accepted_at ? { acceptedAt: iso(r.accepted_at) } : {}),
    ...(r.accepted_user_id ? { acceptedUserId: r.accepted_user_id as string } : {}),
    ...(r.revoked_at ? { revokedAt: iso(r.revoked_at) } : {}),
    projects: Array.isArray(r.projects) ? (r.projects as NonNullable<InvitationRecord['projects']>) : [],
    // Only the non-default is carried, so a console row reads the same from both drivers.
    ...(r.created_via === 'project' ? { createdVia: 'project' as const } : {}),
  };
}

function automationJobFromRow(r: Record<string, unknown>): AutomationJobRecord {
  return {
    id: r.id as string, principal: r.principal as string, verb: r.verb as string,
    request: (r.request as Record<string, unknown>) ?? {}, state: r.state as AutomationJobRecord['state'],
    leaseOwner: r.lease_owner as string | undefined, leaseToken: Number(r.lease_token ?? 0),
    ...(r.lease_until ? { leaseUntil: new Date(r.lease_until as string).toISOString() } : {}),
    createdAt: new Date(r.created_at as string).toISOString(), updatedAt: new Date(r.updated_at as string).toISOString(),
    ...(r.finished_at ? { finishedAt: new Date(r.finished_at as string).toISOString() } : {}),
    ...(r.result_ref ? { resultRef: r.result_ref as string } : {}), ...(r.result_mime ? { resultMime: r.result_mime as string } : {}),
    ...(r.result_sha256 ? { resultSha256: r.result_sha256 as string } : {}),
    ...(r.error ? { error: r.error as string } : {}), ...(r.callback_url ? { callbackUrl: r.callback_url as string } : {}),
    ...(r.callback_failed ? { callbackFailed: true } : {}), ...(r.progress ? { progress: r.progress as { done: number; total: number } } : {}),
    ...(r.idempotency_key ? { idempotencyKey: r.idempotency_key as string } : {}), priority: Number(r.priority ?? 0), attempt: Number(r.attempt ?? 0),
  };
}

function deliveryFromRow(r: Record<string, unknown>): DeliveryRecord {
  return {
    id: r.id as string,
    principal: r.principal as string,
    destinationId: r.destination_id as string,
    destinationVersion: r.destination_version as string,
    name: r.name as string,
    format: r.format as string,
    contentType: r.content_type as string,
    size: Number(r.size),
    sha256: r.sha256 as string,
    requestHash: r.request_hash as string,
    sourceRef: r.source_ref as string,
    ...(r.source_job_id ? { sourceJobId: r.source_job_id as string } : {}),
    state: r.state as DeliveryRecord['state'],
    attempt: Number(r.attempt ?? 0),
    ...(r.approval_id ? { approvalId: r.approval_id as string } : {}),
    ...(r.idempotency_key ? { idempotencyKey: r.idempotency_key as string } : {}),
    ...(r.remote_id ? { remoteId: r.remote_id as string } : {}),
    ...(r.url ? { url: r.url as string } : {}),
    ...(r.delivered_sha256 ? { deliveredSha256: r.delivered_sha256 as string } : {}),
    ...(r.transformation ? { transformation: r.transformation as DeliveryRecord['transformation'] } : {}),
    ...(r.error ? { error: r.error as string } : {}),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    ...(r.delivered_at ? { deliveredAt: new Date(r.delivered_at as string).toISOString() } : {}),
  };
}

/** One device_codes row → record (plans/35 wave 5). */
function deviceCodeFromRow(r: Record<string, unknown>): DeviceCodeRecord {
  return {
    deviceCode: r.device_code as string,
    userCode: r.user_code as string,
    ...(r.client_tag ? { clientTag: r.client_tag as string } : {}),
    status: r.status as DeviceCodeRecord['status'],
    ...(r.user_payload ? { userPayload: r.user_payload as Record<string, unknown> } : {}),
    createdAt: new Date(r.created_at as string).toISOString(),
    expiresAt: new Date(r.expires_at as string).toISOString(),
  };
}

/** One fleet_installs row → record (plans/34 wave 3). */
function installRow(r: Record<string, unknown>): InstallRow {
  return {
    installId: r.install_id as string,
    info: r.info as InstallRow['info'],
    ...(r.name ? { name: r.name as string } : {}),
    ...(r.user_id_last_seen ? { userIdLastSeen: r.user_id_last_seen as string } : {}),
    firstSeenAt: new Date(r.first_seen_at as string).toISOString(),
    lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
  };
}

/** One scim_tokens row → record. `token_hash` never leaves the DB in cleartext;
 *  the opaque secret it hashes was returned once at mint and is unrecoverable. */
function scimTokenFromRow(r: Record<string, unknown>): ScimTokenRecord {
  return {
    id: r.id as string,
    idp: r.idp as string,
    tokenHash: r.token_hash as string,
    createdBy: r.created_by as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    ...(r.last_used_at ? { lastUsedAt: new Date(r.last_used_at as string).toISOString() } : {}),
    ...(r.revoked_at ? { revokedAt: new Date(r.revoked_at as string).toISOString() } : {}),
  };
}

// Minimal structural type for pg.Pool - keeps `pg` out of the type graph
// so typecheck works without the dep resolved.
interface PgPool {
  /** `rowCount` is how a conditional UPDATE reports whether it matched - the CAS
   *  in `casSession` has no other way to tell "wrote" from "the row moved". */
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
interface PgClient {
  /** `rowCount` is how a conditional UPDATE reports whether it matched - the CAS
   *  in `casSession` has no other way to tell "wrote" from "the row moved". */
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(): void;
}

const AUDIT_LOCK_KEY = 0x1011_0001;
/** Serializes project-file reservations (plans/74); distinct from the audit
 *  key above, the test suites' 0x1011_0003, and migrate.ts's 0x1011_0004 (and
 *  its former 0x1011_0002), so a reservation never waits on a migration. */
const PROJECT_FILES_LOCK_KEY = 0x1011_0005;
/** The first half of the two-key lock that issues one password link per
 *  address at a time (plans/74); the second half is the address's hashtext.
 *  Two-key locks live apart from the one-key locks above, and the value is
 *  distinct from them anyway. */
const PASSWORD_LINK_LOCK_KEY = 0x1011_0006;

// Appends a `column = $n` clause + its bound value - shared by the two
// filtered list queries below so the param-numbering logic lives in one place.
const addClause = (clauses: string[], values: unknown[], column: string, value: unknown): void => {
  values.push(value);
  clauses.push(`${column} = $${values.length}`);
};

export async function createPostgresStore(databaseUrl: string): Promise<Store & { close(): Promise<void> }> {
  let roleGroups: RoleGroups = {};
  let auditMacKey: string | undefined;
  const { default: pg } = await import('pg');
  const pool: PgPool = guardPool(new pg.Pool(pgPoolOptions(databaseUrl)), 'store') as unknown as PgPool;

  const appendAuditInTransaction = async (client: PgClient, body: AuditEventBody): Promise<AuditEvent> => {
    await client.query('select pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);
    const { rows } = await client.query('select * from audit_log order by seq desc limit 1');
    const tailRow = rows[0];
    const tail: AuditEvent | null = tailRow
      ? {
          seq: Number(tailRow.seq),
          at: new Date(tailRow.at as string).toISOString(),
          actor: tailRow.actor as string,
          action: tailRow.action as string,
          subject: tailRow.subject as string,
          ...(tailRow.payload ? { payload: tailRow.payload as Record<string, unknown> } : {}),
          prevHash: tailRow.prev_hash as string,
          hash: tailRow.hash as string,
          ...(tailRow.mac ? { mac: tailRow.mac as string } : {}),
        }
      : null;
    const evt = nextEvent(tail, body, auditMacKey);
    await client.query(
      `insert into audit_log (seq, at, actor, action, subject, payload, prev_hash, hash, mac)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [evt.seq, evt.at, evt.actor, evt.action, evt.subject,
       evt.payload ? JSON.stringify(evt.payload) : null, evt.prevHash, evt.hash, evt.mac ?? null],
    );
    return evt;
  };

  const userFromRow = (r: Record<string, unknown>): UserRecord => {
    const groups = (r.groups as string[]) ?? [];
    return {
      id: r.id as string,
      sub: r.sub as string,
      email: r.email as string,
      ...(r.firstname ? { firstname: r.firstname as string } : {}),
      ...(r.lastname ? { lastname: r.lastname as string } : {}),
      ...(r.title ? { title: r.title as string } : {}),
      // Backfill: a row predating the split mirrors idpGroups from groups.
      idpGroups: (r.idp_groups as string[]) ?? groups,
      localGroups: (r.local_groups as string[]) ?? [],
      groups,
      role: roleFromGroups(groups, roleGroups),
      ...(r.telemetry_consent !== null && r.telemetry_consent !== undefined ? { telemetryConsent: r.telemetry_consent as boolean } : {}),
      ...(r.disabled_at ? { disabledAt: new Date(r.disabled_at as string).toISOString() } : {}),
      // A row predating the epoch column reads as 0 - matches the migration default.
      sessionEpoch: Number(r.session_epoch ?? 0),
      createdAt: new Date(r.created_at as string).toISOString(),
      lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
    };
  };

  const getLinkById = async (id: string): Promise<LinkRecord | null> => {
    const { rows } = await pool.query('select * from links where id = $1', [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id as string,
      kind: r.kind as LinkRecord['kind'],
      target: r.target as LinkRecord['target'],
      exp: Number(r.exp),
      createdBy: r.created_by as string,
      createdAt: new Date(r.created_at as string).toISOString(),
      ...(r.pw_hash ? { pwHash: r.pw_hash as string } : {}),
      ...(r.project_id ? { projectId: r.project_id as string } : {}),
      ...(r.revoked_at ? { revokedAt: new Date(r.revoked_at as string).toISOString() } : {}),
    };
  };

  const lifecycleFromRow = (r: Record<string, unknown>): LifecycleRow => ({
    assetId: r.asset_id as string,
    ...(r.valid_from ? { validFrom: new Date(r.valid_from as string).toISOString() } : {}),
    ...(r.valid_until ? { validUntil: new Date(r.valid_until as string).toISOString() } : {}),
    ...(r.revoked_at ? { revokedAt: new Date(r.revoked_at as string).toISOString() } : {}),
    onExpiry: r.on_expiry as OnExpiry,
    ...(r.hold ? { hold: r.hold as LifecycleRow['hold'] } : {}),
  });

  const credentialFromRow = (r: Record<string, unknown>): CredentialRow => ({
    assetId: r.asset_id as string,
    status: r.status as CredentialRow['status'],
    ...(r.container ? { container: r.container as string } : {}),
    sniffedAt: new Date(r.sniffed_at as string).toISOString(),
    ...(r.source_updated_at ? { sourceUpdatedAt: new Date(r.source_updated_at as string).toISOString() } : {}),
  });

  // `bytes` is a bigint column, which pg hands back as a string to keep large
  // values exact; Number() is right here because a byte counter never leaves
  // the safe-integer range without an estate no BlobStore driver could hold.
  const submitQuotaFromRow = (r: Record<string, unknown>): SubmitQuotaRow => ({
    scope: r.scope as string,
    bytes: Number(r.bytes),
    count: Number(r.count),
    updatedAt: new Date(r.updated_at as string).toISOString(),
  });

  const injectableFromRow = (r: Record<string, unknown>): InjectableRecord => ({
    id: r.id as string,
    kind: r.kind as InjectableRecord['kind'],
    title: r.title as string,
    payload: r.payload as Record<string, unknown>,
    groups: r.groups as string[],
    state: r.state as InjectableRecord['state'],
    version: Number(r.version),
    createdBy: r.created_by as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    ...(r.revoked_at ? { revokedAt: new Date(r.revoked_at as string).toISOString() } : {}),
  });

  const providerFromRow = (r: Record<string, unknown>): ProviderRecord => ({
    id: r.id as string,
    kind: r.kind as ProviderKind,
    label: r.label as string,
    managedBy: r.managed_by as 'db' | 'config',
    enabled: r.enabled as boolean,
    options: (r.options as Record<string, unknown>) ?? {},
    mapping: (r.mapping as ProviderRecord['mapping']) ?? {},
    exposure: (r.exposure as ProviderRecord['exposure']) ?? {},
    sync: (r.sync as ProviderRecord['sync']) ?? {},
    ...(r.credential_ciphertext ? { credentialCiphertext: r.credential_ciphertext as Uint8Array } : {}),
    ...(r.credential_fingerprint ? { credentialFingerprint: r.credential_fingerprint as string } : {}),
    ...(r.credential_updated_at ? { credentialUpdatedAt: new Date(r.credential_updated_at as string).toISOString() } : {}),
    ...(r.credential_expires_at ? { credentialExpiresAt: new Date(r.credential_expires_at as string).toISOString() } : {}),
    ...(r.created_by ? { createdBy: r.created_by as string } : {}),
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    state: {
      ...(r.last_sync_at ? { lastSyncAt: new Date(r.last_sync_at as string).toISOString() } : {}),
      ...(r.last_error ? { lastError: r.last_error as string } : {}),
      assetCount: Number(r.asset_count ?? 0),
      ...(r.index_json ? { fragment: r.index_json as ProviderFragment } : {}),
    },
  });

  // visibility rides as jsonb: the string "private" or a { groups: [...] } object.
  const projectFileFromRow = (r: Record<string, unknown>): ProjectFileRecord => ({
    id: r.id as string, projectId: r.project_id as string, name: r.name as string,
    size: Number(r.size), checksum: r.checksum as string, contentType: r.content_type as string,
    parts: r.parts as ProjectFileRecord['parts'], asset: r.asset as Record<string, unknown>,
    createdBy: r.created_by as string, createdAt: new Date(r.created_at as string).toISOString(),
    expiresAt: new Date(r.expires_at as string).toISOString(), ready: r.ready === true,
  });
  const projectFromRow = (r: Record<string, unknown>): ProjectRecord => ({
    id: r.id as string,
    name: r.name as string,
    visibility: r.visibility === 'private' ? 'private' : (r.visibility as { groups: string[] }),
    ownerId: r.owner_id as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    ...(r.archived_at ? { archivedAt: new Date(r.archived_at as string).toISOString() } : {}),
    ...(r.updated_at ? { updatedAt: new Date(r.updated_at as string).toISOString() } : {}),
    ...(r.updated_by ? { updatedBy: r.updated_by as string } : {}),
  });

  const identityFromRow = (r: Record<string, unknown>): UserIdentityRecord => ({
    identitySub: r.identity_sub as string,
    userId: r.user_id as string,
    idp: r.idp as string,
    ...(r.email ? { email: r.email as string } : {}),
    emailVerified: r.email_verified === true,
    groups: Array.isArray(r.groups) ? (r.groups as string[]) : [],
    linkedAt: new Date(r.linked_at as string).toISOString(),
    ...(r.last_login_at ? { lastLoginAt: new Date(r.last_login_at as string).toISOString() } : {}),
  });

  // Email and password sign-in (migration 0042).
  const passwordCredentialFromRow = (r: Record<string, unknown>): PasswordCredentialRecord => ({
    id: r.id as string,
    email: r.email as string,
    hash: r.hash as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    failedCount: Number(r.failed_count ?? 0),
    ...(r.locked_until ? { lockedUntil: new Date(r.locked_until as string).toISOString() } : {}),
    ownerIssued: r.owner_issued === true,
  });
  const passwordLinkFromRow = (r: Record<string, unknown>): PasswordLinkRecord => ({
    tokenHash: r.token_hash as string,
    email: r.email as string,
    purpose: r.purpose as PasswordLinkRecord['purpose'],
    ...(r.created_by ? { createdBy: r.created_by as string } : {}),
    createdAt: new Date(r.created_at as string).toISOString(),
    expiresAt: new Date(r.expires_at as string).toISOString(),
    ...(r.used_at ? { usedAt: new Date(r.used_at as string).toISOString() } : {}),
  });

  const projectMemberFromRow = (r: Record<string, unknown>): ProjectMemberRecord => ({
    projectId: r.project_id as string,
    userId: r.user_id as string,
    role: r.role as ProjectMemberRecord['role'],
    addedBy: r.added_by as string,
    addedAt: new Date(r.added_at as string).toISOString(),
  });

  const sessionFromRow = (r: Record<string, unknown>): SessionRecord => ({
    id: r.id as string,
    projectId: r.project_id as string,
    toolId: r.tool_id as string,
    toolVersion: r.tool_version as string,
    inputs: (r.inputs as Record<string, unknown>) ?? {},
    meta: (r.meta as Record<string, unknown>) ?? {},
    createdBy: r.created_by as string,
    updatedBy: r.updated_by as string,
    rev: Number(r.rev),
    updatedAt: new Date(r.updated_at as string).toISOString(),
    ...(r.deleted_at ? { deletedAt: new Date(r.deleted_at as string).toISOString() } : {}),
  });

  return {
    configureRoleGroups(mapping) { roleGroups = structuredClone(mapping); },
    ...createPostgresRenderStore(pool),
    storageKind: 'postgres',
    brandPersistence: 'durable',
    async getBrandState() {
      const { rows } = await pool.query('select revision, state from brand_state where singleton = true');
      if (!rows[0]) throw new Error('Brand state is missing; run database migrations');
      return { ...(rows[0].state as Omit<import('../brand/state.ts').BrandState, 'revision'>), revision: Number(rows[0].revision) };
    },
    async casBrandState(expected, next, body) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query(
          'update brand_state set revision = revision + 1, state = $2::jsonb where singleton = true and revision = $1 returning revision',
          [expected, JSON.stringify(next)],
        );
        if (!rows[0]) { await client.query('rollback'); return null; }
        await appendAuditInTransaction(client, body);
        await client.query('commit');
        return { ...structuredClone(next), revision: Number(rows[0].revision) };
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
    async upsertUserBySub(user) {
      // Incoming groups are IdP-authoritative; preserve any stored localGroups
      // and derive the effective union + role in JS (mirrors the memory driver).
      const idpGroups = [...new Set(user.groups.filter(Boolean))];
      const { rows: existing } = await pool.query('select local_groups from users where sub = $1', [user.sub]);
      const local = (existing[0]?.local_groups as string[]) ?? [];
      const groups = effectiveGroups(idpGroups, local);
      const role = roleFromGroups(groups, roleGroups);
      const { rows } = await pool.query(
        `insert into users (id, sub, email, firstname, lastname, title, idp_groups, local_groups, groups, role)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
         on conflict (sub) do update set
           email = excluded.email, firstname = excluded.firstname, lastname = excluded.lastname,
           title = excluded.title, idp_groups = excluded.idp_groups, groups = excluded.groups,
           role = excluded.role, last_seen_at = now()
         returning *`,
        [randomId(8), user.sub, user.email, user.firstname ?? null, user.lastname ?? null,
         user.title ?? null, JSON.stringify(idpGroups), JSON.stringify(local), JSON.stringify(groups), role],
      );
      return userFromRow(rows[0] as Record<string, unknown>);
    },
    async getUserBySub(sub) {
      const { rows } = await pool.query('select * from users where sub = $1', [sub]);
      return rows[0] ? userFromRow(rows[0]) : null;
    },
    async getUser(id) {
      const { rows } = await pool.query('select * from users where id = $1', [id]);
      return rows[0] ? userFromRow(rows[0]) : null;
    },
    async findUsersByEmail(email) {
      const e = email.trim().toLowerCase();
      if (!e) return [];
      const { rows } = await pool.query('select * from users where lower(trim(email)) = $1 order by created_at', [e]);
      return rows.map(userFromRow);
    },
    async setTelemetryConsent(userId, consent) {
      await pool.query('update users set telemetry_consent = $2 where id = $1', [userId, consent]);
    },
    async listUsers() {
      const { rows } = await pool.query('select * from users order by last_seen_at desc');
      return rows.map(userFromRow);
    },
    async listUsersPage(opts: ListUsersPageOpts) {
      const clauses: string[] = [];
      const values: unknown[] = [];
      const bind = (v: unknown): string => { values.push(v); return `$${values.length}`; };
      const roleExpr = 'case ' + (['owner', 'admin', 'approver', 'author', 'member', 'viewer'] as const).map(role => {
        const names = roleGroups[role] ?? (['owner', 'admin', 'approver', 'author'].includes(role) ? [role] : []);
        return `when jsonb_exists_any(groups, ${bind(names)}::text[]) then '${role}'`;
      }).join(' ') + " else 'member' end";
      const source = `(select *, ${roleExpr} as effective_role from users) mapped_users`;
      // name = first + last + email, concatenated once for both filter and sort.
      const nameExpr = `lower(coalesce(firstname, '') || ' ' || coalesce(lastname, '') || ' ' || email)`;
      if (opts.q?.trim()) clauses.push(`${nameExpr} like ${bind('%' + opts.q.trim().toLowerCase() + '%')}`);
      // Jump-to-letter - matched against the trimmed name key (a user without a
      // firstname would otherwise lead with the concatenation's space).
      if (opts.prefix === '#') clauses.push(`ltrim(${nameExpr}) !~ '^[a-z]'`);
      else if (opts.prefix) clauses.push(`ltrim(${nameExpr}) like ${bind(opts.prefix + '%')}`);
      if (opts.role) clauses.push(`effective_role = ${bind(opts.role)}`);
      if (opts.group) clauses.push(`jsonb_exists(groups, ${bind(opts.group)})`);
      if (opts.status === 'active') clauses.push('disabled_at is null');
      else if (opts.status === 'disabled') clauses.push('disabled_at is not null');
      const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
      const sortExpr = opts.sort === 'email' ? 'lower(email)'
        : opts.sort === 'role' ? 'effective_role'
        : opts.sort === 'lastSeen' ? 'last_seen_at'
        : nameExpr;
      const dir = opts.dir === 'desc' ? 'desc' : 'asc';
      const { rows: countRows } = await pool.query(`select count(*)::int as n from ${source} ${where}`, values);
      const total = Number(countRows[0]?.n ?? 0);
      const limit = bind(opts.limit);
      const offset = bind(opts.offset);
      const { rows } = await pool.query(
        `select * from ${source} ${where} order by ${sortExpr} ${dir}, id asc limit ${limit} offset ${offset}`,
        values,
      );
      return { rows: rows.map(userFromRow), total };
    },
    async setLocalGroups(userId, localGroups) {
      const { rows: existing } = await pool.query('select idp_groups from users where id = $1', [userId]);
      if (!existing[0]) return null;
      const idpGroups = (existing[0].idp_groups as string[]) ?? [];
      const local = [...new Set(localGroups.filter(Boolean))];
      const groups = effectiveGroups(idpGroups, local);
      const { rows } = await pool.query(
        'update users set local_groups = $2::jsonb, groups = $3::jsonb, role = $4 where id = $1 returning *',
        [userId, JSON.stringify(local), JSON.stringify(groups), roleFromGroups(groups, roleGroups)],
      );
      return rows[0] ? userFromRow(rows[0]) : null;
    },
    async setUserDisabled(userId, disabledAt) {
      // Disabling is also a revocation: any live session dies on its next request.
      const { rows } = disabledAt
        ? await pool.query('update users set disabled_at = $2, session_epoch = session_epoch + 1 where id = $1 returning *', [userId, disabledAt])
        : await pool.query('update users set disabled_at = null where id = $1 returning *', [userId]);
      return rows[0] ? userFromRow(rows[0]) : null;
    },
    async bumpSessionEpoch(userId) {
      const { rows } = await pool.query('update users set session_epoch = session_epoch + 1 where id = $1 returning *', [userId]);
      return rows[0] ? userFromRow(rows[0]) : null;
    },

    async listLocalGroups() {
      const { rows } = await pool.query('select name, description, created_at from local_groups order by name');
      return rows.map((r) => ({
        name: r.name as string,
        ...(r.description ? { description: r.description as string } : {}),
        createdAt: new Date(r.created_at as string).toISOString(),
      })) as LocalGroupRecord[];
    },
    async putLocalGroup(group) {
      await pool.query(
        `insert into local_groups (name, description, created_at) values ($1, $2, $3)
         on conflict (name) do update set description = excluded.description`,
        [group.name, group.description ?? null, group.createdAt],
      );
    },
    async deleteLocalGroup(name) {
      await pool.query('delete from local_groups where name = $1', [name]);
      // Strip from every member carrying it, recomputing their union + role.
      const { rows } = await pool.query(
        'select id, idp_groups, local_groups from users where jsonb_exists(local_groups, $1)', [name],
      );
      for (const r of rows) {
        const local = ((r.local_groups as string[]) ?? []).filter((g) => g !== name);
        const groups = effectiveGroups((r.idp_groups as string[]) ?? [], local);
        await pool.query(
          'update users set local_groups = $2::jsonb, groups = $3::jsonb, role = $4 where id = $1',
          [r.id as string, JSON.stringify(local), JSON.stringify(groups), roleFromGroups(groups, roleGroups)],
        );
      }
    },

    async putScimToken(rec) {
      await pool.query(
        `insert into scim_tokens (id, idp, token_hash, created_by, created_at, last_used_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update set idp = excluded.idp, last_used_at = excluded.last_used_at, revoked_at = excluded.revoked_at`,
        [rec.id, rec.idp, rec.tokenHash, rec.createdBy, rec.createdAt, rec.lastUsedAt ?? null, rec.revokedAt ?? null],
      );
    },
    async listScimTokens() {
      const { rows } = await pool.query('select * from scim_tokens order by created_at desc');
      return rows.map(scimTokenFromRow);
    },
    async findScimTokenByHash(tokenHash) {
      const { rows } = await pool.query('select * from scim_tokens where token_hash = $1', [tokenHash]);
      return rows[0] ? scimTokenFromRow(rows[0]) : null;
    },
    async touchScimToken(id, at) {
      await pool.query('update scim_tokens set last_used_at = $2 where id = $1', [id, at]);
    },
    async revokeScimToken(id, at) {
      const { rowCount } = await pool.query(
        'update scim_tokens set revoked_at = $2 where id = $1 and revoked_at is null', [id, at],
      );
      return (rowCount ?? 0) > 0;
    },

    // Service tokens (plans/35 wave 2) - the SCIM block's shapes, one row kind over.
    async putApiToken(rec) {
      await pool.query(
        `insert into api_tokens (id, label, role, token_hash, created_by, created_at, last_used_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set label = excluded.label, last_used_at = excluded.last_used_at, revoked_at = excluded.revoked_at`,
        [rec.id, rec.label, rec.role, rec.tokenHash, rec.createdBy, rec.createdAt, rec.lastUsedAt ?? null, rec.revokedAt ?? null],
      );
    },
    async listApiTokens() {
      const { rows } = await pool.query('select * from api_tokens order by created_at desc');
      return rows.map(apiTokenFromRow);
    },
    async findApiTokenByHash(tokenHash) {
      const { rows } = await pool.query('select * from api_tokens where token_hash = $1', [tokenHash]);
      return rows[0] ? apiTokenFromRow(rows[0]) : null;
    },
    async touchApiToken(id, at) {
      await pool.query('update api_tokens set last_used_at = $2 where id = $1', [id, at]);
    },
    async revokeApiToken(id, at) {
      const { rowCount } = await pool.query(
        'update api_tokens set revoked_at = $2 where id = $1 and revoked_at is null', [id, at],
      );
      return (rowCount ?? 0) > 0;
    },

    // Invitations (plans/74 W-ID-2). The partial unique index on email (where
    // revoked_at is null) is the one-active-per-email rule; the transaction
    // below only decides whether an expired pending row makes way first.
    async createInvitation(rec) {
      const email = rec.email.trim().toLowerCase();
      const groups = JSON.stringify([...new Set(rec.groups)]);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows: active } = await client.query(
          'select * from invitations where email = $1 and revoked_at is null for update', [email],
        );
        const existing = active[0];
        if (existing) {
          const lapsed = !existing.accepted_at && existing.expires_at
            && new Date(existing.expires_at as string).getTime() <= Date.parse(rec.createdAt);
          if (!lapsed) {
            await client.query('commit');
            return { invitation: invitationFromRow(existing), created: false };
          }
          await client.query('update invitations set revoked_at = $2 where id = $1', [existing.id, rec.createdAt]);
        }
        // A concurrent insert for the same email conflicts on the partial index;
        // that caller's row is then the active one, and this call returns
        // that row with created false.
        const { rows } = await client.query(
          `insert into invitations (id, email, groups, invited_by, created_at, expires_at, projects, created_via)
           values ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8)
           on conflict (email) where revoked_at is null do nothing
           returning *`,
          [rec.id, email, groups, rec.invitedBy, rec.createdAt, rec.expiresAt ?? null, JSON.stringify(invitationProjectsJson(rec.projects ?? [])),
            rec.createdVia ?? 'console'],
        );
        if (rows[0]) {
          await client.query('commit');
          return { invitation: invitationFromRow(rows[0]), created: true };
        }
        const { rows: raced } = await client.query(
          'select * from invitations where email = $1 and revoked_at is null', [email],
        );
        await client.query('commit');
        if (!raced[0]) throw new Error('invitation insert conflicted but no active row was found');
        return { invitation: invitationFromRow(raced[0]), created: false };
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async listInvitations() {
      const { rows } = await pool.query('select * from invitations order by created_at desc, id desc');
      return rows.map(invitationFromRow);
    },
    async getInvitation(id) {
      const { rows } = await pool.query('select * from invitations where id = $1', [id]);
      return rows[0] ? invitationFromRow(rows[0]) : null;
    },
    async findActiveInvitation(email) {
      const { rows } = await pool.query(
        'select * from invitations where email = $1 and revoked_at is null', [email.trim().toLowerCase()],
      );
      return rows[0] ? invitationFromRow(rows[0]) : null;
    },
    async revokeInvitation(id, at, opts) {
      const { rows } = await pool.query(
        `update invitations set revoked_at = $2 where id = $1 and revoked_at is null${opts?.pendingOnly ? ' and accepted_at is null' : ''} returning *`,
        [id, at],
      );
      return rows[0] ? invitationFromRow(rows[0]) : null;
    },
    async listOpenInvitationsForProject(projectId, now) {
      // jsonb containment rides the partial GIN index from migration 0040.
      const { rows } = await pool.query(
        `select * from invitations
         where revoked_at is null and accepted_at is null and (expires_at is null or expires_at > $2)
           and projects @> jsonb_build_array(jsonb_build_object('projectId', $1::text))
         order by created_at desc, id desc`,
        [projectId, now],
      );
      return rows.map(invitationFromRow);
    },
    async acceptInvitation(id, userId, at) {
      const { rows } = await pool.query(
        `update invitations set accepted_at = $3, accepted_user_id = $2
         where id = $1 and revoked_at is null and accepted_at is null and (expires_at is null or expires_at > $3)
         returning *`,
        [id, userId, at],
      );
      return rows[0] ? invitationFromRow(rows[0]) : null;
    },
    async setInvitationProjects(id, list) {
      const { rows } = await pool.query(
        `update invitations set projects = $2::jsonb
         where id = $1 and revoked_at is null and accepted_at is null
         returning *`,
        [id, JSON.stringify(invitationProjectsJson(list))],
      );
      return rows[0] ? invitationFromRow(rows[0]) : null;
    },
    async dropInvitationProject(id, projectId, at, opts) {
      // One statement over the row's own column, so a project added to the
      // same invitation meanwhile is kept, never overwritten. SET reads the
      // row as it was before this update, so both expressions see one list.
      const { rows } = await pool.query(
        `update invitations set
           projects = coalesce((select jsonb_agg(e order by n) from jsonb_array_elements(projects) with ordinality as t(e, n)
                                where e->>'projectId' <> $2), '[]'::jsonb),
           revoked_at = case
             when $4::boolean and groups = '[]'::jsonb
               and not exists (select 1 from jsonb_array_elements(projects) as e where e->>'projectId' <> $2)
             then $3::timestamptz else revoked_at end
         where id = $1 and revoked_at is null and accepted_at is null
           and projects @> jsonb_build_array(jsonb_build_object('projectId', $2::text))
         returning *`,
        [id, projectId, at, !!opts?.revokeWhenEmpty],
      );
      return rows[0] ? invitationFromRow(rows[0]) : null;
    },

    // Linked sign-ins (migration 0039).
    async getUserByIdentity(identitySub) {
      const { rows } = await pool.query(
        'select u.* from user_identities i join users u on u.id = i.user_id where i.identity_sub = $1', [identitySub],
      );
      return rows[0] ? userFromRow(rows[0]) : null;
    },
    async linkIdentity(rec) {
      // One statement: the insert happens only for a known user and a sub no
      // other user was created with, and the update only when the row is
      // already this user's. Anything else returns no row and writes nothing.
      const email = rec.email?.trim().toLowerCase() || null;
      const { rows } = await pool.query(
        `insert into user_identities (identity_sub, user_id, idp, email, email_verified, linked_at, last_login_at, groups)
         select $1, $2, $3, $4, $5, $6, $7, coalesce($8::jsonb, '[]'::jsonb)
         where exists (select 1 from users where id = $2)
           and not exists (select 1 from users where sub = $1 and id <> $2)
         on conflict (identity_sub) do update set
           idp = excluded.idp, email = excluded.email, email_verified = excluded.email_verified,
           last_login_at = coalesce(excluded.last_login_at, user_identities.last_login_at),
           groups = coalesce($8::jsonb, user_identities.groups)
         where user_identities.user_id = excluded.user_id
         returning *, (xmax = 0) as inserted`,
        [rec.identitySub, rec.userId, rec.idp, email, rec.emailVerified === true, rec.linkedAt, rec.lastLoginAt ?? null,
          rec.groups === undefined ? null : JSON.stringify([...new Set(rec.groups.filter(Boolean))])],
      );
      const row = rows[0];
      return row ? { identity: identityFromRow(row), created: row.inserted === true } : null;
    },
    async listIdentities(userId) {
      const { rows } = await pool.query(
        'select * from user_identities where user_id = $1 order by linked_at, identity_sub', [userId],
      );
      return rows.map(identityFromRow);
    },
    async unlinkIdentity(userId, identitySub) {
      const { rowCount } = await pool.query(
        'delete from user_identities where user_id = $1 and identity_sub = $2', [userId, identitySub],
      );
      return (rowCount ?? 0) > 0;
    },
    async findUsersByVerifiedEmail(email) {
      const e = email.trim().toLowerCase();
      if (!e) return [];
      const { rows } = await pool.query(
        `select u.* from users u
         where exists (select 1 from user_identities i where i.user_id = u.id and i.email_verified and lower(i.email) = $1)
         order by u.created_at`,
        [e],
      );
      return rows.map(userFromRow);
    },

    // Email and password sign-in (migration 0042). Each write is one
    // statement (or one transaction), so the attempt counter and a link's
    // single use hold across replicas.
    async getPasswordCredential(email) {
      const { rows } = await pool.query('select * from password_credentials where email = $1', [email.trim().toLowerCase()]);
      return rows[0] ? passwordCredentialFromRow(rows[0]) : null;
    },
    async putPasswordCredential(rec) {
      const { rows } = await pool.query(
        `insert into password_credentials (id, email, hash, created_at, updated_at, failed_count, locked_until, owner_issued)
         values ($1, $2, $3, $4, $4, 0, null, $5)
         on conflict (email) do update set hash = excluded.hash, updated_at = excluded.updated_at,
           failed_count = 0, locked_until = null, owner_issued = excluded.owner_issued
         returning *`,
        [rec.id, rec.email.trim().toLowerCase(), rec.hash, rec.at, rec.ownerIssued],
      );
      return passwordCredentialFromRow(rows[0]!);
    },
    async rehashPasswordCredential(email, oldHash, newHash, at) {
      const { rowCount } = await pool.query(
        'update password_credentials set hash = $3, updated_at = $4 where email = $1 and hash = $2',
        [email.trim().toLowerCase(), oldHash, newHash, at],
      );
      return (rowCount ?? 0) > 0;
    },
    async reservePasswordAttempt(email, at, opts): Promise<PasswordAttempt> {
      const key = email.trim().toLowerCase();
      // SET reads the row as it was, so both expressions see the old count.
      // Two racing attempts serialise on the row lock, and the second one
      // re-reads the WHERE against the first one's write, so it sees a lock
      // the first one set.
      const { rows } = await pool.query(
        `update password_credentials set
           failed_count = case when failed_count + 1 >= $3 then 0 else failed_count + 1 end,
           locked_until = case when failed_count + 1 >= $3
             then $2::timestamptz + ($4 * interval '1 millisecond') else null end
         where email = $1 and (locked_until is null or locked_until <= $2::timestamptz)
         returning *`,
        [key, at, opts.maxFailures, opts.lockMs],
      );
      if (rows[0]) {
        const credential = passwordCredentialFromRow(rows[0]);
        return { status: 'reserved', credential, locks: !!credential.lockedUntil && Date.parse(credential.lockedUntil) > Date.parse(at) };
      }
      const held = await pool.query('select * from password_credentials where email = $1', [key]);
      return held.rows[0] ? { status: 'locked', credential: passwordCredentialFromRow(held.rows[0]) } : { status: 'none' };
    },
    async clearPasswordFailures(email) {
      await pool.query(
        `update password_credentials set failed_count = 0, locked_until = null
         where email = $1 and (failed_count <> 0 or locked_until is not null)`,
        [email.trim().toLowerCase()],
      );
    },
    async deletePasswordCredential(id) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query('delete from password_credentials where id = $1 returning *', [id]);
        if (rows[0]) await client.query('delete from password_links where email = $1 and used_at is null', [rows[0].email]);
        await client.query('commit');
        return rows[0] ? passwordCredentialFromRow(rows[0]) : null;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async revokePasswordLinks(email) {
      const { rowCount } = await pool.query('delete from password_links where email = $1 and used_at is null', [email.trim().toLowerCase()]);
      return rowCount ?? 0;
    },
    async createPasswordLink(rec) {
      const email = rec.email.trim().toLowerCase();
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Two links issued for one address at once would each delete before
        // the other inserts and leave both live: one at a time per address.
        await client.query('select pg_advisory_xact_lock($1, hashtext($2))', [PASSWORD_LINK_LOCK_KEY, email]);
        await client.query(
          'delete from password_links where (email = $1 and used_at is null) or expires_at <= $2', [email, rec.createdAt],
        );
        await client.query(
          `insert into password_links (token_hash, email, purpose, created_by, created_at, expires_at)
           values ($1, $2, $3, $4, $5, $6)`,
          [rec.tokenHash, email, rec.purpose, rec.createdBy ?? null, rec.createdAt, rec.expiresAt],
        );
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async findLivePasswordLink(tokenHash, at) {
      const { rows } = await pool.query(
        'select * from password_links where token_hash = $1 and used_at is null and expires_at > $2', [tokenHash, at],
      );
      return rows[0] ? passwordLinkFromRow(rows[0]) : null;
    },
    async consumePasswordLink(tokenHash, at) {
      const { rows } = await pool.query(
        `update password_links set used_at = $2
         where token_hash = $1 and used_at is null and expires_at > $2
         returning *`,
        [tokenHash, at],
      );
      return rows[0] ? passwordLinkFromRow(rows[0]) : null;
    },

    async claimAutomationJob(owner, verbs, leaseMs) {
      const { rows } = await pool.query(
        `update automation_jobs j set state='running', lease_owner=$1, lease_until=now()+($3 * interval '1 millisecond'), lease_token=j.lease_token+1, attempt=j.attempt+1, updated_at=now()
         from (select id from automation_jobs where verb=any($2::text[]) and (state='queued' or (state='running' and (lease_until is null or lease_until < now())))
           order by priority desc, created_at for update skip locked limit 1) candidate
         where j.id=candidate.id returning j.*`, [owner, verbs, leaseMs]);
      return rows[0] ? automationJobFromRow(rows[0]) : null;
    },
    async renewAutomationJob(job, leaseMs) {
      const { rowCount } = await pool.query(`update automation_jobs set lease_until=now()+($4 * interval '1 millisecond') where id=$1 and lease_owner=$2 and lease_token=$3 and state='running' and lease_until > now()`, [job.id, job.leaseOwner, job.leaseToken, leaseMs]);
      return (rowCount ?? 0) > 0;
    },
    async saveClaimedAutomationJob(job) {
      const { rowCount } = await pool.query(
        `update automation_jobs set state=$4, updated_at=now(), finished_at=$5, result_ref=$6, result_mime=$7, result_sha256=$8, error=$9, progress=$10::jsonb, callback_failed=$11
         where id=$1 and lease_owner=$2 and lease_token=$3 and ((state='running' and lease_until > now()) or (state=$4 and state in ('done','failed')))`,
        [job.id, job.leaseOwner, job.leaseToken, job.state, job.finishedAt ?? null, job.resultRef ?? null, job.resultMime ?? null, job.resultSha256 ?? null, job.error ?? null, job.progress ? JSON.stringify(job.progress) : null, job.callbackFailed ?? false]);
      return (rowCount ?? 0) > 0;
    },
    async putAutomationJob(job) {
      await pool.query(
        `insert into automation_jobs (id, principal, verb, request, state, created_at, updated_at, finished_at, result_ref, result_mime, result_sha256, error, callback_url, callback_failed, progress, idempotency_key, priority, attempt)
         values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)
         on conflict (id) do update set state=excluded.state, updated_at=excluded.updated_at, finished_at=excluded.finished_at, result_ref=excluded.result_ref, result_mime=excluded.result_mime, result_sha256=excluded.result_sha256, error=excluded.error, callback_failed=excluded.callback_failed, progress=excluded.progress, priority=excluded.priority, attempt=excluded.attempt`,
        [job.id, job.principal, job.verb, JSON.stringify(job.request), job.state, job.createdAt, job.updatedAt, job.finishedAt ?? null, job.resultRef ?? null, job.resultMime ?? null, job.resultSha256 ?? null, job.error ?? null, job.callbackUrl ?? null, job.callbackFailed ?? false, job.progress ? JSON.stringify(job.progress) : null, job.idempotencyKey ?? null, job.priority, job.attempt],
      );
    },
    async getAutomationJob(id, principal) {
      const { rows } = await pool.query('select * from automation_jobs where id=$1 and principal=$2', [id, principal]);
      return rows[0] ? automationJobFromRow(rows[0]) : null;
    },
    async listAutomationJobs(principal) {
      const { rows } = await pool.query('select * from automation_jobs where principal=$1 order by created_at desc', [principal]);
      return rows.map(automationJobFromRow);
    },
    async findAutomationJobByIdempotency(principal, key) {
      const { rows } = await pool.query('select * from automation_jobs where principal=$1 and idempotency_key=$2', [principal, key]);
      return rows[0] ? automationJobFromRow(rows[0]) : null;
    },
    async deleteAutomationJob(id, principal) {
      const { rowCount } = await pool.query(
        `delete from automation_jobs
         where id=$1 and principal=$2
           and not exists (select 1 from deliveries where source_job_id=$1)`,
        [id, principal],
      );
      return (rowCount ?? 0) > 0;
    },

    async putDelivery(delivery) {
      await pool.query(
        `insert into deliveries (
           id, principal, destination_id, destination_version, name, format,
           content_type, size, sha256, request_hash, source_ref, source_job_id, state, attempt,
           approval_id, idempotency_key, remote_id, url, delivered_sha256, transformation,
           error, created_at, updated_at, delivered_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         on conflict (id) do update set
           state=excluded.state, attempt=excluded.attempt, remote_id=excluded.remote_id,
           url=excluded.url, delivered_sha256=excluded.delivered_sha256,
           transformation=excluded.transformation, error=excluded.error,
           updated_at=excluded.updated_at, delivered_at=excluded.delivered_at`,
        [
          delivery.id, delivery.principal, delivery.destinationId, delivery.destinationVersion,
          delivery.name, delivery.format, delivery.contentType, delivery.size, delivery.sha256,
          delivery.requestHash, delivery.sourceRef, delivery.sourceJobId ?? null, delivery.state, delivery.attempt,
          delivery.approvalId ?? null, delivery.idempotencyKey ?? null, delivery.remoteId ?? null, delivery.url ?? null,
          delivery.deliveredSha256 ?? null, delivery.transformation ?? null, delivery.error ?? null,
          delivery.createdAt, delivery.updatedAt, delivery.deliveredAt ?? null,
        ],
      );
    },
    async getDelivery(id, principal) {
      const { rows } = await pool.query('select * from deliveries where id=$1 and principal=$2', [id, principal]);
      return rows[0] ? deliveryFromRow(rows[0]) : null;
    },
    async listDeliveries(principal) {
      const { rows } = await pool.query('select * from deliveries where principal=$1 order by created_at desc', [principal]);
      return rows.map(deliveryFromRow);
    },
    async findDeliveryByIdempotency(principal, key) {
      const { rows } = await pool.query('select * from deliveries where principal=$1 and idempotency_key=$2', [principal, key]);
      return rows[0] ? deliveryFromRow(rows[0]) : null;
    },
    async findDeliveryBySourceJob(principal, jobId) {
      const { rows } = await pool.query(
        'select * from deliveries where principal=$1 and source_job_id=$2 order by created_at desc limit 1',
        [principal, jobId],
      );
      return rows[0] ? deliveryFromRow(rows[0]) : null;
    },

    async listGrants() {
      const { rows } = await pool.query('select principal, action, resource, effect from grants');
      return rows as unknown as Grant[];
    },
    async putGrant(grant) {
      // Idempotent on the exact tuple (the table has no unique constraint).
      await pool.query(
        `insert into grants (principal, action, resource, effect)
         select $1, $2, $3, $4
         where not exists (
           select 1 from grants where principal = $1 and action = $2 and resource = $3 and effect = $4)`,
        [grant.principal, grant.action, grant.resource, grant.effect],
      );
    },
    async deleteGrant(grant) {
      await pool.query(
        'delete from grants where principal = $1 and action = $2 and resource = $3 and effect = $4',
        [grant.principal, grant.action, grant.resource, grant.effect],
      );
    },
    async listOverlays() {
      const { rows } = await pool.query('select tool_id, overlay from tools_policy where state = $1', ['published']);
      return new Map(rows.map((r) => [r.tool_id as string, r.overlay as ToolOverlay]));
    },
    async putOverlay(overlay) {
      await pool.query(
        `insert into tools_policy (tool_id, overlay, version) values ($1, $2::jsonb, $3)
         on conflict (tool_id) do update set overlay = excluded.overlay, version = excluded.version`,
        [overlay.toolId, JSON.stringify(overlay), overlay.version],
      );
    },
    async deleteOverlay(toolId) {
      await pool.query('delete from tools_policy where tool_id = $1', [toolId]);
    },
    async listFlagGovernance() {
      const { rows } = await pool.query('select flag_id, governance from feature_flags');
      return new Map(rows.map((r) => [r.flag_id as string, r.governance as FlagGovernance]));
    },
    async putFlagGovernance(rec) {
      if (rec.default === undefined && rec.visibility === undefined) {
        await pool.query('delete from feature_flags where flag_id = $1', [rec.id]);
        return;
      }
      await pool.query(
        `insert into feature_flags (flag_id, governance) values ($1, $2::jsonb)
         on conflict (flag_id) do update set governance = excluded.governance`,
        [rec.id, JSON.stringify(rec)],
      );
    },
    async listInjectables() {
      const { rows } = await pool.query('select * from injectables');
      return rows.map(injectableFromRow);
    },
    async getInjectable(id) {
      const { rows } = await pool.query('select * from injectables where id = $1', [id]);
      return rows[0] ? injectableFromRow(rows[0]) : null;
    },
    async putInjectable(rec) {
      // created_at is written only on insert - on conflict preserves the original,
      // matching putProvider; updated_at + version move with each replace.
      await pool.query(
        `insert into injectables (id, kind, title, payload, groups, state, version, created_by, created_at, updated_at, revoked_at)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)
         on conflict (id) do update set kind = excluded.kind, title = excluded.title,
           payload = excluded.payload, groups = excluded.groups, state = excluded.state,
           version = excluded.version, updated_at = excluded.updated_at, revoked_at = excluded.revoked_at`,
        [rec.id, rec.kind, rec.title, JSON.stringify(rec.payload), JSON.stringify(rec.groups),
         rec.state, rec.version, rec.createdBy, rec.createdAt, rec.updatedAt, rec.revokedAt ?? null],
      );
    },
    async deleteInjectable(id) {
      await pool.query('delete from injectables where id = $1', [id]);
    },

    async putLink(link) {
      await pool.query(
        `insert into links (id, kind, target, exp, pw_hash, project_id, created_by, created_at)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
        [link.id, link.kind, JSON.stringify(link.target), link.exp, link.pwHash ?? null,
         link.projectId ?? null, link.createdBy, link.createdAt],
      );
    },
    getLink: getLinkById,
    async revokeLink(id, at) {
      await pool.query('update links set revoked_at = $2 where id = $1', [id, at]);
    },
    async listLinksBy(createdBy) {
      const { rows } = await pool.query('select id from links where created_by = $1', [createdBy]);
      const links = await Promise.all(rows.map((r) => getLinkById(r.id as string)));
      return links.filter((l): l is LinkRecord => l !== null);
    },
    async listAllLinks() {
      const { rows } = await pool.query('select id from links order by created_at desc');
      const links = await Promise.all(rows.map((r) => getLinkById(r.id as string)));
      return links.filter((l): l is LinkRecord => l !== null);
    },

    setAuditMacKey(key: string) {
      auditMacKey = key;
    },
    async appendAudit(body: AuditEventBody) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const evt = await appendAuditInTransaction(client, body);
        await client.query('commit');
        return evt;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async appendAuditIfTail(expectedTail, body) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // The same lock appendAuditInTransaction takes (advisory locks are
        // re-entrant within a session), held from this read to the insert.
        await client.query('select pg_advisory_xact_lock($1)', [AUDIT_LOCK_KEY]);
        const { rows } = await client.query('select seq, hash from audit_log order by seq desc limit 1');
        const tail = rows[0] ? { seq: Number(rows[0].seq), hash: rows[0].hash as string } : null;
        if (tail?.seq !== expectedTail?.seq || tail?.hash !== expectedTail?.hash) {
          await client.query('rollback');
          return null;
        }
        const evt = await appendAuditInTransaction(client, body);
        await client.query('commit');
        return evt;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async listAuditAfter(after, limit) {
      const { rows } = await pool.query('select * from audit_log where seq > $1 order by seq asc limit $2', [after, limit]);
      return rows.map((r) => ({
        seq: Number(r.seq),
        at: new Date(r.at as string).toISOString(),
        actor: r.actor as string,
        action: r.action as string,
        subject: r.subject as string,
        ...(r.payload ? { payload: r.payload as Record<string, unknown> } : {}),
        prevHash: r.prev_hash as string,
        hash: r.hash as string,
        ...(r.mac ? { mac: r.mac as string } : {}),
      }));
    },
    async getSiemCursor() {
      const { rows } = await pool.query('select seq from siem_cursor where id = 1');
      return rows[0] ? Number(rows[0].seq) : 0;
    },
    async setSiemCursor(seq) {
      await pool.query(
        `insert into siem_cursor (id, seq) values (1, $1)
         on conflict (id) do update set seq = $1, updated_at = now()`,
        [seq],
      );
    },
    async getAuditAnchor() {
      const { rows } = await pool.query('select seq, hash from audit_anchor where id = 1');
      return rows[0] ? { seq: Number(rows[0].seq), hash: rows[0].hash as string } : null;
    },
    async setAuditAnchor(anchor) {
      await pool.query(
        `insert into audit_anchor (id, seq, hash) values (1, $1, $2)
         on conflict (id) do update set seq = $1, hash = $2, updated_at = now()`,
        [anchor.seq, anchor.hash],
      );
    },
    async trimAudit(uptoSeq) {
      // The append-only trigger (0034) lets a delete through only when the
      // transaction announces itself as the retention trim.
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query("set local lolly_work.audit_trim = 'on'");
        const { rowCount } = await client.query('delete from audit_log where seq <= $1', [uptoSeq]);
        await client.query('commit');
        return rowCount ?? 0;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async trimTelemetry(beforeIso) {
      const { rowCount } = await pool.query('delete from telemetry_events where at < $1', [beforeIso]);
      return rowCount ?? 0;
    },
    async scrubTelemetryUser(userId) {
      const { rowCount } = await pool.query('update telemetry_events set user_id = null where user_id = $1', [userId]);
      return rowCount ?? 0;
    },
    async deleteUser(id) {
      const { rowCount } = await pool.query('delete from users where id = $1', [id]);
      return (rowCount ?? 0) > 0;
    },

    async previewUserErasure(id) {
      const { rows } = await pool.query(`select
        (select count(*) from projects where owner_id = $1) as projects,
        (select count(*) from sessions where created_by = $1 or updated_by = $1) as sessions,
        (select count(*) from links where created_by = $1) as links,
        (select count(*) from approvals where created_by = $1) as approvals,
        (select count(*) from message_acks where user_id = $1) as acks,
        (select count(*) from project_files where created_by = $1 and ready) as project_files,
        (select count(*) from telemetry_events where user_id = $1) as telemetry`, [id]);
      const row = rows[0]!;
      return { references: {
        projects: Number(row.projects), sessions: Number(row.sessions), links: Number(row.links),
        approvals: Number(row.approvals), messageAcks: Number(row.acks), projectFiles: Number(row.project_files),
      }, telemetryEvents: Number(row.telemetry) };
    },
    async eraseUserAccount(id) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // Delete first: FK checks also cover references created concurrently
        // after the preview. Never cascade shared records to make erasure pass.
        // The credentials this account's own password sign-ins name, read
        // before the delete below cascades its identity rows away.
        const ownPasswords = await client.query(
          `select c.id, c.email from password_credentials c
             join user_identities i on i.identity_sub = 'password:' || c.id
            where i.user_id = $1`,
          [id],
        );
        const deleted = await client.query('delete from users where id = $1 returning email', [id]);
        if (!deleted.rowCount) { await client.query('rollback'); return { status: 'not-found' }; }
        const scrubbed = await client.query('update telemetry_events set user_id = null where user_id = $1', [id]);
        // Invitations hold the email, and an accepted one keeps admitting it:
        // the rows this account accepted go with it, and other rows for the
        // address go too unless another account still carries that email.
        const erasedEmail = String(deleted.rows[0]?.email ?? '').trim().toLowerCase();
        await client.query(
          `delete from invitations where accepted_user_id = $1
             or (email = $2 and not exists (select 1 from users where lower(trim(email)) = $2))`,
          [id, erasedEmail],
        );
        // A password for the address would sign the person straight back in,
        // and so would one the account's own password sign-ins name under
        // another address.
        for (const table of ['password_credentials', 'password_links']) {
          await client.query(
            `delete from ${table} where email = $1 and not exists (select 1 from users where lower(trim(email)) = $1)`,
            [erasedEmail],
          );
        }
        for (const row of ownPasswords.rows) {
          await client.query('delete from password_credentials where id = $1', [row.id]);
          await client.query('delete from password_links where email = $1', [row.email]);
        }
        await client.query('commit');
        return { status: 'erased', scrubbed: scrubbed.rowCount ?? 0 };
      } catch (error) {
        await client.query('rollback');
        if ((error as { code?: string }).code === '23503') return { status: 'referenced' };
        throw error;
      } finally { client.release(); }
    },

    // Device sign-in codes (plans/35 wave 5). Prune rides the writes; the
    // claim's single-read is DELETE ... RETURNING, atomic across replicas.
    async putDeviceCode(rec) {
      await pool.query('delete from device_codes where expires_at <= now()');
      await pool.query(
        `insert into device_codes (device_code, user_code, client_tag, status, user_payload, created_at, expires_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [rec.deviceCode, rec.userCode, rec.clientTag ?? null, rec.status, rec.userPayload ? JSON.stringify(rec.userPayload) : null, rec.createdAt, rec.expiresAt],
      );
    },
    async getPendingDeviceCode(userCode) {
      const { rows } = await pool.query(
        "select * from device_codes where user_code = $1 and status = 'pending' and expires_at > now()", [userCode],
      );
      return rows[0] ? deviceCodeFromRow(rows[0]) : null;
    },
    async settleDeviceCode(userCode, status, userPayload) {
      const { rowCount } = await pool.query(
        `update device_codes set status = $2, user_payload = coalesce($3::jsonb, user_payload)
         where user_code = $1 and status = 'pending' and expires_at > now()`,
        [userCode, status, userPayload ? JSON.stringify(userPayload) : null],
      );
      return (rowCount ?? 0) > 0;
    },
    async claimDeviceCode(deviceCode) {
      const { rows: pending } = await pool.query(
        "select status from device_codes where device_code = $1 and expires_at > now()", [deviceCode],
      );
      if (!pending[0]) return { status: 'expired' };
      if (pending[0].status === 'pending') return { status: 'pending' };
      const { rows } = await pool.query(
        "delete from device_codes where device_code = $1 and status <> 'pending' returning status, user_payload", [deviceCode],
      );
      const r = rows[0];
      if (!r) return { status: 'expired' }; // a concurrent claim won the single read
      if (r.status === 'approved' && r.user_payload) return { status: 'approved', userPayload: r.user_payload as Record<string, unknown> };
      return { status: 'denied' };
    },
    async listPendingDeviceCodes() {
      const { rows } = await pool.query(
        "select * from device_codes where status = 'pending' and expires_at > now() order by created_at asc",
      );
      return rows.map(deviceCodeFromRow);
    },
    async listAuditBefore(before, limit, filter) {
      const { sql, values } = auditWhere(before, filter);
      values.push(limit);
      const { rows } = await pool.query(`select * from (select * from audit_log ${sql} order by seq desc limit $${values.length}) p order by seq asc`, values);
      return rows.map((r) => ({
        seq: Number(r.seq),
        at: new Date(r.at as string).toISOString(),
        actor: r.actor as string,
        action: r.action as string,
        subject: r.subject as string,
        ...(r.payload ? { payload: r.payload as Record<string, unknown> } : {}),
        prevHash: r.prev_hash as string,
        hash: r.hash as string,
        ...(r.mac ? { mac: r.mac as string } : {}),
      }));
    },
    async countAudit(filter) {
      const { sql, values } = auditWhere(0, filter);
      const { rows } = await pool.query(`select count(*)::int as n from audit_log ${sql}`, values);
      return Number(rows[0]?.n ?? 0);
    },
    async ping() {
      try { await pool.query('select 1'); return true; } catch { return false; }
    },
    async listAudit() {
      const { rows } = await pool.query('select * from audit_log order by seq asc');
      return rows.map((r) => ({
        seq: Number(r.seq),
        at: new Date(r.at as string).toISOString(),
        actor: r.actor as string,
        action: r.action as string,
        subject: r.subject as string,
        ...(r.payload ? { payload: r.payload as Record<string, unknown> } : {}),
        prevHash: r.prev_hash as string,
        hash: r.hash as string,
        ...(r.mac ? { mac: r.mac as string } : {}),
      }));
    },

    async putEvents(events) {
      for (const e of events) {
        await pool.query(
          'insert into telemetry_events (at, user_id, event, attrs) values ($1, $2, $3, $4::jsonb)',
          [e.at, e.userId ?? null, e.event, JSON.stringify(e.attrs)],
        );
      }
    },
    async listEvents() {
      const { rows } = await pool.query('select at, user_id, event, attrs from telemetry_events order by id asc');
      return rows.map((r) => ({
        event: r.event as string,
        at: new Date(r.at as string).toISOString(),
        ...(r.user_id ? { userId: r.user_id as string } : {}),
        attrs: (r.attrs as Record<string, string>) ?? {},
      })) as StoredEvent[];
    },

    async listMessages() {
      const { rows } = await pool.query('select * from messages');
      return rows.map((r) => ({
        id: r.id as string,
        kind: r.kind as Message['kind'],
        severity: r.severity as Message['severity'],
        audience: r.audience as Message['audience'],
        title: r.title as string,
        ...(r.body ? { body: r.body as string } : {}),
        ...(r.cta ? { cta: r.cta as Message['cta'] } : {}),
        ...(r.data ? { data: r.data as Message['data'] } : {}),
        ...(r.starts_at ? { startsAt: new Date(r.starts_at as string).toISOString() } : {}),
        ...(r.ends_at ? { endsAt: new Date(r.ends_at as string).toISOString() } : {}),
        dismissible: r.dismissible as boolean,
      })) as Message[];
    },
    async putMessage(msg) {
      // Every column the record carries is in the SET list, because the memory
      // driver's `putMessage` is a whole-record replace and the two must agree
      // (tests/store-conformance.ts). `kind`, `cta` and `dismissible` were the
      // three that were not, which a re-put makes visible: a collab invite's
      // `cta.url` is built from `instance.appUrl`, so an instance that moved
      // would keep serving the old link on Postgres and the new one in memory.
      await pool.query(
        `insert into messages (id, kind, severity, audience, title, body, cta, data, starts_at, ends_at, dismissible)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11)
         on conflict (id) do update set kind = excluded.kind, title = excluded.title, body = excluded.body,
           audience = excluded.audience, severity = excluded.severity, cta = excluded.cta,
           data = excluded.data, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
           dismissible = excluded.dismissible`,
        [msg.id, msg.kind, msg.severity, JSON.stringify(msg.audience), msg.title, msg.body ?? null,
         msg.cta ? JSON.stringify(msg.cta) : null, msg.data ? JSON.stringify(msg.data) : null,
         msg.startsAt ?? null, msg.endsAt ?? null, msg.dismissible ?? true],
      );
    },
    async ackMessage(messageId, userId) {
      await pool.query(
        'insert into message_acks (message_id, user_id) values ($1, $2) on conflict do nothing',
        [messageId, userId],
      );
    },
    async clearAck(messageId, userId) {
      await pool.query('delete from message_acks where message_id = $1 and user_id = $2', [messageId, userId]);
    },
    async acksFor(userId) {
      const { rows } = await pool.query('select message_id from message_acks where user_id = $1', [userId]);
      return new Set(rows.map((r) => r.message_id as string));
    },
    async ackCounts() {
      const { rows } = await pool.query('select message_id, count(*) as n from message_acks group by message_id');
      return new Map(rows.map((r) => [r.message_id as string, Number(r.n)]));
    },

    async recordClient(info: ClientInfo) {
      await pool.query(
        `insert into fleet_clients (bucket, info, count) values ($1, $2::jsonb, 1)
         on conflict (bucket) do update set count = fleet_clients.count + 1, last_seen_at = now()`,
        [clientBucket(info), JSON.stringify(info)],
      );
    },
    async fleetSummary() {
      const { rows } = await pool.query('select * from fleet_clients order by count desc');
      return rows.map((r) => ({
        bucket: r.bucket as string,
        info: r.info as ClientInfo,
        count: Number(r.count),
        lastSeenAt: new Date(r.last_seen_at as string).toISOString(),
      })) as FleetRow[];
    },
    // The install registry (plans/34 wave 3). `name` deliberately survives the
    // device's own refresh - the operator set it, the device did not.
    async upsertInstall(installId, info, userId) {
      await pool.query(
        `insert into fleet_installs (install_id, info, user_id_last_seen) values ($1, $2::jsonb, $3)
         on conflict (install_id) do update set info = $2::jsonb, user_id_last_seen = $3, last_seen_at = now()`,
        [installId, JSON.stringify(info), userId],
      );
    },
    async listInstalls() {
      const { rows } = await pool.query('select * from fleet_installs order by last_seen_at desc');
      return rows.map((r) => installRow(r));
    },
    async renameInstall(installId, name) {
      const { rows } = await pool.query(
        'update fleet_installs set name = $2 where install_id = $1 returning *',
        [installId, name],
      );
      return rows[0] ? installRow(rows[0]) : null;
    },
    async forgetInstall(installId) {
      await pool.query('delete from fleet_installs where install_id = $1', [installId]);
    },

    // Chains + approvals ride as jsonb docs; scalar columns are lifted out only
    // for the cheap inbox/mine query paths (created_by, state). eligibleGroups
    // is applied in JS through the same engine predicate the memory driver uses.
    async putChain(chain) {
      await pool.query(
        `insert into chains (id, name, spec) values ($1, $2, $3::jsonb)
         on conflict (id) do update set name = excluded.name, spec = excluded.spec`,
        [chain.id, chain.name, JSON.stringify(chain)],
      );
    },
    async getChain(id) {
      const { rows } = await pool.query('select spec from chains where id = $1', [id]);
      return rows[0] ? (rows[0].spec as Chain) : null;
    },
    async listChains() {
      const { rows } = await pool.query('select spec from chains order by id');
      return rows.map((r) => r.spec as Chain);
    },
    async deleteChain(id) {
      await pool.query('delete from chains where id = $1', [id]);
    },
    async putApproval(approval) {
      await pool.query(
        `insert into approvals (id, state, step_index, created_by, created_at, doc)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (id) do update set state = excluded.state, step_index = excluded.step_index, doc = excluded.doc`,
        [approval.id, approval.state, approval.stepIndex, approval.createdBy, approval.createdAt, JSON.stringify(approval)],
      );
    },
    async getApproval(id) {
      const { rows } = await pool.query('select doc from approvals where id = $1', [id]);
      return rows[0] ? (rows[0].doc as Approval) : null;
    },
    async listApprovals(filter) {
      const clauses: string[] = [];
      const values: unknown[] = [];
      if (filter?.createdBy) addClause(clauses, values, 'created_by', filter.createdBy);
      if (filter?.state) addClause(clauses, values, 'state', filter.state);
      const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
      const { rows } = await pool.query(`select doc from approvals ${where} order by created_at desc`, values);
      let out = rows.map((r) => r.doc as Approval);
      if (filter?.eligibleGroups) {
        const groups = filter.eligibleGroups;
        out = out.filter((a) => eligibleForCurrentStep(a, groups));
      }
      return out;
    },

    async putLifecycle(row) {
      await pool.query(
        `insert into catalog_lifecycle (asset_id, valid_from, valid_until, revoked_at, on_expiry, hold)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (asset_id) do update set valid_from = excluded.valid_from, valid_until = excluded.valid_until,
           revoked_at = excluded.revoked_at, on_expiry = excluded.on_expiry, hold = excluded.hold`,
        [row.assetId, row.validFrom ?? null, row.validUntil ?? null, row.revokedAt ?? null, row.onExpiry, row.hold ? JSON.stringify(row.hold) : null],
      );
    },
    async getLifecycle(assetId) {
      const { rows } = await pool.query('select * from catalog_lifecycle where asset_id = $1', [assetId]);
      return rows[0] ? lifecycleFromRow(rows[0]) : null;
    },
    async listLifecycle() {
      const { rows } = await pool.query('select * from catalog_lifecycle');
      return rows.map(lifecycleFromRow);
    },
    async deleteLifecycle(assetId) {
      await pool.query('delete from catalog_lifecycle where asset_id = $1', [assetId]);
    },
    async putCredential(row) {
      await pool.query(
        `insert into catalog_credentials (asset_id, status, container, sniffed_at, source_updated_at)
         values ($1, $2, $3, $4, $5)
         on conflict (asset_id) do update set status = excluded.status, container = excluded.container,
           sniffed_at = excluded.sniffed_at, source_updated_at = excluded.source_updated_at`,
        [row.assetId, row.status, row.container ?? null, row.sniffedAt, row.sourceUpdatedAt ?? null],
      );
    },
    async getCredential(assetId) {
      const { rows } = await pool.query('select * from catalog_credentials where asset_id = $1', [assetId]);
      return rows[0] ? credentialFromRow(rows[0]) : null;
    },
    async listCredentials() {
      const { rows } = await pool.query('select * from catalog_credentials');
      return rows.map(credentialFromRow);
    },
    async deleteCredential(assetId) {
      await pool.query('delete from catalog_credentials where asset_id = $1', [assetId]);
    },

    async putInstanceAsset(rec) {
      await pool.query(
        `insert into instance_assets (id, record) values ($1, $2::jsonb)
         on conflict (id) do update set record = excluded.record`,
        [rec.id, JSON.stringify(rec)],
      );
    },
    async getInstanceAsset(id) {
      const { rows } = await pool.query('select record from instance_assets where id = $1', [id]);
      return rows[0] ? (rows[0].record as InstanceAssetRecord) : null;
    },
    async listInstanceAssets() {
      const { rows } = await pool.query('select record from instance_assets');
      return rows.map((r) => r.record as InstanceAssetRecord);
    },
    async deleteInstanceAsset(id) {
      await pool.query('delete from instance_assets where id = $1', [id]);
    },
    async putAlias(fromId, toId) {
      await pool.query(
        'insert into catalog_aliases (from_id, to_id) values ($1, $2) on conflict (from_id) do update set to_id = excluded.to_id',
        [fromId, toId],
      );
    },
    async getAlias(fromId) {
      const { rows } = await pool.query('select to_id from catalog_aliases where from_id = $1', [fromId]);
      return rows[0] ? (rows[0].to_id as string) : null;
    },
    async listAliases() {
      const { rows } = await pool.query('select from_id, to_id from catalog_aliases');
      return rows.map((r) => ({ fromId: r.from_id as string, toId: r.to_id as string }));
    },

    // Org-defined asset metadata (migrations/0018). Definitions come from the
    // policy document, values are an overlay keyed by catalog asset id - and
    // that id may name a pack file or a federated asset, so neither table
    // carries a foreign key into instance_assets.
    async listCatalogFields() {
      const { rows } = await pool.query('select def from catalog_field_defs order by id asc');
      return rows.map((r) => r.def as CatalogFieldDef);
    },
    async putCatalogField(def) {
      await pool.query(
        `insert into catalog_field_defs (id, def) values ($1, $2::jsonb)
         on conflict (id) do update set def = excluded.def`,
        [def.id, JSON.stringify(def)],
      );
    },
    async deleteCatalogField(id) {
      await pool.query('delete from catalog_field_defs where id = $1', [id]);
    },
    async getAssetMeta(assetId) {
      const { rows } = await pool.query('select record from catalog_asset_meta where asset_id = $1', [assetId]);
      return rows[0] ? (rows[0].record as AssetMetaRecord) : null;
    },
    async putAssetMeta(rec) {
      await pool.query(
        `insert into catalog_asset_meta (asset_id, record, updated_at) values ($1, $2::jsonb, now())
         on conflict (asset_id) do update set record = excluded.record, updated_at = now()`,
        [rec.assetId, JSON.stringify(rec)],
      );
    },
    async listAssetMeta() {
      const { rows } = await pool.query('select record from catalog_asset_meta');
      return rows.map((r) => r.record as AssetMetaRecord);
    },
    async deleteAssetMeta(assetId) {
      await pool.query('delete from catalog_asset_meta where asset_id = $1', [assetId]);
    },

    // Collections (migrations/0019). The record rides whole as jsonb because
    // the MEMBER ORDER is the curator's and half of what a collection is; a
    // join table would sort it away and could not reference a pack or federated
    // id in the first place.
    async listCollections() {
      const { rows } = await pool.query('select record from catalog_collections');
      return sortCollections(rows.map((r) => r.record as CollectionRecord));
    },
    async getCollection(id) {
      const { rows } = await pool.query('select record from catalog_collections where id = $1', [id]);
      return rows[0] ? (rows[0].record as CollectionRecord) : null;
    },
    async putCollection(rec) {
      await pool.query(
        `insert into catalog_collections (id, record, updated_at) values ($1, $2::jsonb, now())
         on conflict (id) do update set record = excluded.record, updated_at = now()`,
        [rec.id, JSON.stringify(rec)],
      );
    },
    async deleteCollection(id) {
      await pool.query('delete from catalog_collections where id = $1', [id]);
    },

    // Instance asset versions (migrations/0020). Immutable snapshots keyed
    // (asset_id, version); the head is `headVersion` on the instance-asset
    // record, so nothing here has to be flipped when the served version moves.
    async listAssetVersions(assetId) {
      const { rows } = await pool.query(
        'select record from catalog_asset_versions where asset_id = $1 order by version asc', [assetId],
      );
      return rows.map((r) => r.record as AssetVersionRecord);
    },
    async getAssetVersion(assetId, version) {
      const { rows } = await pool.query(
        'select record from catalog_asset_versions where asset_id = $1 and version = $2', [assetId, version],
      );
      return rows[0] ? (rows[0].record as AssetVersionRecord) : null;
    },
    async putAssetVersion(rec) {
      await pool.query(
        `insert into catalog_asset_versions (asset_id, version, record) values ($1, $2, $3::jsonb)
         on conflict (asset_id, version) do update set record = excluded.record`,
        [rec.assetId, rec.version, JSON.stringify(rec)],
      );
    },
    async deleteAssetVersion(assetId, version) {
      await pool.query('delete from catalog_asset_versions where asset_id = $1 and version = $2', [assetId, version]);
    },

    // Submit quota (migrations/0017). The add is a single upsert-increment so
    // concurrent submissions serialize on the row rather than on a read the
    // application did earlier.
    async addSubmitQuota(scope, bytes, count) {
      const { rows } = await pool.query(
        `insert into catalog_submit_quota (scope, bytes, count, updated_at) values ($1, $2, $3, now())
         on conflict (scope) do update set bytes = catalog_submit_quota.bytes + excluded.bytes,
           count = catalog_submit_quota.count + excluded.count, updated_at = now()
         returning scope, bytes, count, updated_at`,
        [scope, bytes, count],
      );
      return submitQuotaFromRow(rows[0] as Record<string, unknown>);
    },
    async getSubmitQuota(scope) {
      const { rows } = await pool.query('select scope, bytes, count, updated_at from catalog_submit_quota where scope = $1', [scope]);
      return rows[0] ? submitQuotaFromRow(rows[0]) : null;
    },
    async listSubmitQuota() {
      const { rows } = await pool.query('select scope, bytes, count, updated_at from catalog_submit_quota');
      return rows.map(submitQuotaFromRow);
    },

    // catalog providers (migrations/0005_catalog_providers.sql). putProvider
    // touches config columns only; credential_* and state columns have their
    // own methods so the paths can't clobber each other.
    async listProviders() {
      const { rows } = await pool.query('select * from catalog_providers order by created_at asc');
      return rows.map(providerFromRow);
    },
    async getProvider(id) {
      const { rows } = await pool.query('select * from catalog_providers where id = $1', [id]);
      return rows[0] ? providerFromRow(rows[0]) : null;
    },
    async putProvider(rec) {
      await pool.query(
        `insert into catalog_providers (id, kind, label, managed_by, enabled, options, mapping, exposure, sync, created_by, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12)
         on conflict (id) do update set
           kind = excluded.kind, label = excluded.label, managed_by = excluded.managed_by,
           enabled = excluded.enabled, options = excluded.options, mapping = excluded.mapping,
           exposure = excluded.exposure, sync = excluded.sync, updated_at = excluded.updated_at`,
        [rec.id, rec.kind, rec.label, rec.managedBy, rec.enabled,
         JSON.stringify(rec.options), JSON.stringify(rec.mapping), JSON.stringify(rec.exposure),
         JSON.stringify(rec.sync), rec.createdBy ?? null, rec.createdAt, rec.updatedAt],
      );
    },
    async deleteProvider(id) {
      await pool.query('delete from catalog_providers where id = $1', [id]);
    },
    async putProviderCredential(id, cred) {
      await pool.query(
        `update catalog_providers set credential_ciphertext = $2, credential_fingerprint = $3, credential_updated_at = $4,
           credential_expires_at = $5
         where id = $1`,
        cred
          ? [id, Buffer.from(cred.ciphertext), cred.fingerprint, cred.updatedAt, cred.expiresAt ?? null]
          : [id, null, null, null, null],
      );
    },
    async putProviderState(id, state) {
      await pool.query(
        `update catalog_providers set last_sync_at = $2, last_error = $3, asset_count = $4, index_json = $5::jsonb
         where id = $1`,
        [id, state.lastSyncAt ?? null, state.lastError ?? null, state.assetCount,
         state.fragment ? JSON.stringify(state.fragment) : null],
      );
    },

    // projects + sessions (migrations/0004_sessions.sql)
    async putProject(project) {
      await pool.query(
        `insert into projects (id, name, visibility, owner_id, created_at, archived_at, updated_at, updated_by)
         values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
         on conflict (id) do update set
           name = excluded.name, visibility = excluded.visibility,
           owner_id = excluded.owner_id, archived_at = excluded.archived_at,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        [project.id, project.name, JSON.stringify(project.visibility), project.ownerId,
         project.createdAt, project.archivedAt ?? null, project.updatedAt ?? null, project.updatedBy ?? null],
      );
    },
    async getProject(id) {
      const { rows } = await pool.query('select * from projects where id = $1', [id]);
      return rows[0] ? projectFromRow(rows[0]) : null;
    },
    async listProjects() {
      const { rows } = await pool.query('select * from projects order by created_at desc');
      return rows.map(projectFromRow);
    },
    // Budgets count ready files and unfinished uploads that have not expired
    // (`ready or expires_at > now()`), the same rule as the memory store.
    async reserveProjectFile(file, limits) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        // One lock for every reservation: the instance budget spans projects,
        // and a per-project row lock would let two projects both pass it.
        await client.query('select pg_advisory_xact_lock($1)', [PROJECT_FILES_LOCK_KEY]);
        const project = await client.query('select id from projects where id = $1', [file.projectId]);
        if (!project.rows.length) { await client.query('rollback'); return 'refused'; }
        const { rows } = await client.query(
          `select coalesce(sum(size + $3) filter (where project_id = $1), 0) as project_used, coalesce(sum(size + $3), 0) as instance_used,
             count(*) filter (where not ready and created_by = $2) as pending,
             coalesce(sum(size) filter (where not ready and created_by = $2), 0) as pending_bytes
           from project_files where ready or expires_at > now()`, [file.projectId, file.createdBy, PROJECT_FILE_OVERHEAD_BYTES]);
        const row = rows[0]!;
        const charge = file.size + PROJECT_FILE_OVERHEAD_BYTES;
        const refusal = Number(row.pending) >= limits.maxPending || Number(row.pending_bytes) + file.size > limits.maxPendingBytes ? 'pending'
          : Number(row.project_used) + charge > limits.projectBudgetBytes ? 'project-budget'
          : Number(row.instance_used) + charge > limits.instanceBudgetBytes ? 'instance-budget' : null;
        if (refusal) { await client.query('rollback'); return refusal; }
        const inserted = await client.query(
          `insert into project_files (id, project_id, name, size, checksum, content_type, parts, asset, created_by, created_at, expires_at, ready)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,false) on conflict (id) do nothing returning id`,
          [file.id, file.projectId, file.name, file.size, file.checksum, file.contentType,
           JSON.stringify(file.parts), JSON.stringify(file.asset), file.createdBy, file.createdAt, file.expiresAt]);
        await client.query('commit');
        return inserted.rows.length === 1 ? 'reserved' : 'refused';
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
    async getProjectFile(id) {
      const { rows } = await pool.query('select * from project_files where id = $1', [id]);
      return rows[0] ? projectFileFromRow(rows[0]) : null;
    },
    async listProjectFiles(projectId) {
      const { rows } = await pool.query('select * from project_files where project_id = $1 and ready order by created_at desc, id collate "C"', [projectId]);
      return rows.map(projectFileFromRow);
    },
    async listUnfinishedProjectFiles(filter, limit) {
      const { rows } = await pool.query(
        `select * from project_files where not ready and ($1::text is null or created_by = $1)
           and ($2::timestamptz is null or expires_at <= $2) order by expires_at, id collate "C" limit $3`,
        [filter.createdBy ?? null, filter.expiredBy ?? null, limit]);
      return rows.map(projectFileFromRow);
    },
    async projectFileUsage(projectId) {
      const { rows } = await pool.query(
        `select coalesce(sum(size + $2) filter (where project_id = $1), 0) as project_used, coalesce(sum(size + $2), 0) as instance_used
           from project_files where ready or expires_at > now()`, [projectId, PROJECT_FILE_OVERHEAD_BYTES]);
      return { projectBytes: Number(rows[0]?.project_used ?? 0), instanceBytes: Number(rows[0]?.instance_used ?? 0) };
    },
    async touchProjectFile(id, expiresAt) {
      const { rows } = await pool.query(
        `update project_files set expires_at = case when ready then expires_at else greatest(expires_at, $2::timestamptz) end
           where id = $1 and (ready or expires_at > now()) returning id`, [id, expiresAt]);
      return rows.length === 1;
    },
    async completeProjectFile(id) {
      const { rows } = await pool.query('update project_files set ready = true where id = $1 and (ready or expires_at > now()) returning id', [id]);
      return rows.length === 1;
    },
    async deleteProjectFile(id) {
      const { rowCount } = await pool.query('delete from project_files where id = $1', [id]);
      return (rowCount ?? 0) > 0;
    },
    async listSessionsUsingProjectFile(projectId, fileId) {
      // The match runs in the database, so no session document leaves it.
      const { rows } = await pool.query(
        `select id, project_id, tool_id, tool_version, meta, created_by, updated_by, rev, updated_at, deleted_at
           from sessions where project_id = $1 and deleted_at is null and strpos(inputs::text, $2) > 0 order by updated_at desc, id collate "C"`,
        [projectId, projectFileAssetId(fileId)]);
      return rows.map((r) => {
        const { inputs: _inputs, ...summary } = sessionFromRow(r);
        return summary;
      });
    },
    async listProjectMembers(projectId) {
      const { rows } = await pool.query(
        'select * from project_members where project_id = $1 order by added_at, user_id', [projectId],
      );
      return rows.map(projectMemberFromRow);
    },
    async getProjectMember(projectId, userId) {
      const { rows } = await pool.query(
        'select * from project_members where project_id = $1 and user_id = $2', [projectId, userId],
      );
      return rows[0] ? projectMemberFromRow(rows[0]) : null;
    },
    async listUserProjectMemberships(userId) {
      const { rows } = await pool.query('select * from project_members where user_id = $1', [userId]);
      return rows.map(projectMemberFromRow);
    },
    async putProjectMember(rec) {
      await pool.query(
        `insert into project_members (project_id, user_id, role, added_by, added_at)
         values ($1, $2, $3, $4, $5)
         on conflict (project_id, user_id) do update set role = excluded.role`,
        [rec.projectId, rec.userId, rec.role, rec.addedBy, rec.addedAt],
      );
    },
    async updateProjectMemberRole(projectId, userId, role) {
      const { rows } = await pool.query(
        'update project_members set role = $3 where project_id = $1 and user_id = $2 returning *', [projectId, userId, role],
      );
      return rows[0] ? projectMemberFromRow(rows[0]) : null;
    },
    async deleteProjectMember(projectId, userId) {
      const { rowCount } = await pool.query(
        'delete from project_members where project_id = $1 and user_id = $2', [projectId, userId],
      );
      return (rowCount ?? 0) > 0;
    },
    async getUsersByIds(ids) {
      const unique = [...new Set(ids)];
      if (!unique.length) return [];
      const { rows } = await pool.query('select * from users where id = any($1::text[])', [unique]);
      return rows.map(userFromRow);
    },
    async putSession(session) {
      const result = await pool.query(
        `insert into sessions (id, project_id, tool_id, tool_version, inputs, meta,
           created_by, updated_by, rev, updated_at, deleted_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)
         on conflict (id) do update set
           inputs = excluded.inputs, meta = excluded.meta, updated_by = excluded.updated_by,
           rev = excluded.rev, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at
           where sessions.collab_lease_until is null or sessions.collab_lease_until <= clock_timestamp()`,
        [session.id, session.projectId, session.toolId, session.toolVersion,
         JSON.stringify(session.inputs), JSON.stringify(session.meta), session.createdBy,
         session.updatedBy, session.rev, session.updatedAt, session.deletedAt ?? null],
      );
      if (result.rowCount === 0) throw new Error('collab-active');
    },
    async casSession(next, expectedRev) {
      // One statement, so the compare and the set cannot be separated by anything.
      // `deleted_at` is deliberately NOT in the SET list and `is null` is in the
      // WHERE: a CAS can neither tombstone nor resurrect.
      const res = await pool.query(
        `update sessions set inputs = $2::jsonb, meta = $3::jsonb, updated_by = $4,
            rev = $5, updated_at = $6
          where id = $1 and rev = $7 and deleted_at is null
            and (collab_lease_until is null or collab_lease_until <= clock_timestamp())`,
        [next.id, JSON.stringify(next.inputs), JSON.stringify(next.meta), next.updatedBy,
         next.rev, next.updatedAt, expectedRev],
      );
      return res.rowCount === 1;
    },
    async getSession(id) {
      const { rows } = await pool.query('select * from sessions where id = $1', [id]);
      return rows[0] ? sessionFromRow(rows[0]) : null;
    },
    async listSessions(projectId) {
      const { rows } = await pool.query(
        'select * from sessions where project_id = $1 and deleted_at is null order by updated_at desc',
        [projectId],
      );
      return rows.map(sessionFromRow);
    },
    async listSessionSummaries(projectId) {
      // Every column but inputs: a listing must not pull each stored document.
      const { rows } = await pool.query(
        `select id, project_id, tool_id, tool_version, meta, created_by, updated_by, rev, updated_at, deleted_at
           from sessions where project_id = $1 and deleted_at is null order by updated_at desc`,
        [projectId],
      );
      return rows.map((r) => {
        const { inputs: _inputs, ...summary } = sessionFromRow(r);
        return summary;
      });
    },
    async projectSessionStats(projectId) {
      const { rows } = await pool.query(
        `select project_id, count(*) as count, max(updated_at) as updated_at,
                (array_agg(updated_by order by updated_at desc, id desc))[1] as updated_by
           from sessions
          where deleted_at is null and ($1::text is null or project_id = $1) group by project_id`,
        [projectId ?? null],
      );
      return rows.map((r) => ({
        projectId: r.project_id as string,
        count: Number(r.count),
        updatedAt: new Date(r.updated_at as string).toISOString(),
        ...(r.updated_by ? { updatedBy: r.updated_by as string } : {}),
      }));
    },
    async listSessionsFiltered(filter) {
      const clauses = ['deleted_at is null'];
      const values: unknown[] = [];
      if (filter.projectId !== undefined) addClause(clauses, values, 'project_id', filter.projectId);
      if (filter.toolId !== undefined) addClause(clauses, values, 'tool_id', filter.toolId);
      const { rows } = await pool.query(
        `select * from sessions where ${clauses.join(' and ')} order by updated_at desc`, values,
      );
      return rows.map(sessionFromRow);
    },
    async appendSessionRevision(rev) {
      // Idempotent on (session_id, rev): a replayed op yields one revision.
      await pool.query(
        `insert into session_revisions (session_id, rev, inputs, meta, actor, at)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
         on conflict (session_id, rev) do nothing`,
        [rev.sessionId, rev.rev, JSON.stringify(rev.inputs), JSON.stringify(rev.meta), rev.actor, rev.at],
      );
      // Keep the bound on disk, not only on read: every REST save appends a
      // whole document, so without this the table grows by one row per PUT
      // for ever. Same prune as commitCollab. A failed prune leaves extra rows
      // that the next save removes, so the two statements need no transaction.
      await pool.query(
        `delete from session_revisions where session_id = $1 and rev not in
          (select rev from session_revisions where session_id = $1 order by rev desc limit $2)`,
        [rev.sessionId, SESSION_REVISION_LIMIT],
      );
    },
    async listSessionRevisions(sessionId) {
      const { rows } = await pool.query(
        'select * from session_revisions where session_id = $1 order by rev desc limit $2',
        [sessionId, SESSION_REVISION_LIMIT],
      );
      return rows.map((r) => ({
        sessionId: r.session_id as string,
        rev: Number(r.rev),
        inputs: (r.inputs as Record<string, unknown>) ?? {},
        meta: (r.meta as Record<string, unknown>) ?? {},
        actor: r.actor as string,
        at: new Date(r.at as string).toISOString(),
      })) as SessionRevision[];
    },

    // Durable room ownership, convergence checkpoints, journal and receipts.
    async claimCollab(sessionId, owner, ttlMs) {
      const result = await pool.query(`update sessions set collab_owner=$2,
        collab_lease_until=clock_timestamp()+($3 * interval '1 millisecond')
        where id=$1 and deleted_at is null and (collab_owner=$2 or collab_lease_until is null or collab_lease_until<=clock_timestamp())`, [sessionId, owner, ttlMs]);
      return result.rowCount === 1;
    },
    async releaseCollab(sessionId, owner) {
      await pool.query('update sessions set collab_owner=null, collab_lease_until=null where id=$1 and collab_owner=$2', [sessionId, owner]);
    },
    async collabLeaseActive(sessionId) {
      // The same clock and predicate `casSession` and `putSession` refuse on.
      const { rows } = await pool.query('select 1 from sessions where id=$1 and collab_lease_until>clock_timestamp()', [sessionId]);
      return rows.length === 1;
    },
    async getCollabCheckpoint(sessionId) {
      const { rows } = await pool.query('select revision, head_revision, checkpoint from collab_checkpoints where session_id=$1', [sessionId]);
      return rows[0] ? { revision: Number(rows[0].revision), headRevision: Number(rows[0].head_revision), checkpoint: rows[0].checkpoint as CanvasCheckpoint } : null;
    },
    async getCollabJournal(sessionId, afterRevision) {
      const { rows } = await pool.query('select revision, ops from collab_journal where session_id=$1 and revision>$2 order by revision', [sessionId, afterRevision]);
      return rows.map(row => ({ revision: Number(row.revision), ops: row.ops as CanvasOp[] }));
    },
    async getCollabReceipts(sessionId, principal, ids) {
      const { rows } = await pool.query('select id, digest, accepted, revision from collab_receipts where session_id=$1 and principal=$2 and id=any($3::text[])', [sessionId, principal, ids]);
      return rows.map(r => ({ id: r.id as string, digest: r.digest as string, accepted: r.accepted as boolean, revision: Number(r.revision) }));
    },
    async commitCollab(batch) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const locked = await client.query(`select rev, meta from sessions where id=$1 and rev=$2 and deleted_at is null
          and collab_owner=$3 and collab_lease_until>clock_timestamp() for update`, [batch.sessionId, batch.expectedRev, batch.owner]);
        if (!locked.rows[0]) throw new Error('collab-owner-conflict');
        const rev = batch.expectedRev + 1, at = new Date().toISOString();
        await client.query('update sessions set inputs=$2::jsonb, rev=$3, updated_at=$4, updated_by=$5 where id=$1',
          [batch.sessionId, JSON.stringify(batch.inputs), rev, at, batch.updatedBy]);
        if (batch.checkpoint) {
          await client.query(`insert into collab_checkpoints(session_id,revision,head_revision,checkpoint) values($1,$2,$2,$3::jsonb)
            on conflict(session_id) do update set revision=excluded.revision, head_revision=excluded.head_revision, checkpoint=excluded.checkpoint`,
          [batch.sessionId, rev, JSON.stringify(batch.checkpoint)]);
          await client.query('delete from collab_journal where session_id=$1 and revision<=$2', [batch.sessionId, rev]);
        } else {
          const advanced = await client.query('update collab_checkpoints set head_revision=$2 where session_id=$1 and head_revision=$3',
            [batch.sessionId, rev, batch.expectedRev]);
          if (advanced.rowCount !== 1) throw new Error('collab-checkpoint-required');
          await client.query('insert into collab_journal(session_id,revision,ops) values($1,$2,$3::jsonb)', [batch.sessionId, rev, JSON.stringify(batch.ops)]);
        }
        for (const r of batch.receipts) await client.query(`insert into collab_receipts(session_id,principal,id,digest,accepted,revision) values($1,$2,$3,$4,$5,$6)`,
          [batch.sessionId, batch.principal, r.id, r.digest, r.accepted, rev]);
        await client.query('insert into session_revisions(session_id,rev,inputs,meta,actor,at) values($1,$2,$3::jsonb,$4::jsonb,$5,$6)',
          [batch.sessionId, rev, JSON.stringify(batch.inputs), JSON.stringify(locked.rows[0].meta), batch.actor, at]);
        await client.query(`delete from session_revisions where session_id=$1 and rev not in
          (select rev from session_revisions where session_id=$1 order by rev desc limit $2)`, [batch.sessionId, SESSION_REVISION_LIMIT]);
        await client.query('commit');
        return rev;
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
    async commitCollabReceipts(batch) {
      if (batch.receipts.some(r => r.accepted)) throw new Error('collab-accepted-receipt-needs-commit');
      const client = await pool.connect();
      try {
        await client.query('begin');
        // The commitCollab fence, holding the row lock until the receipts are in,
        // and writing nothing to the session row itself.
        const locked = await client.query(`select 1 from sessions where id=$1 and rev=$2 and deleted_at is null
          and collab_owner=$3 and collab_lease_until>clock_timestamp() for update`, [batch.sessionId, batch.expectedRev, batch.owner]);
        if (!locked.rows[0]) throw new Error('collab-owner-conflict');
        for (const r of batch.receipts) await client.query(`insert into collab_receipts(session_id,principal,id,digest,accepted,revision) values($1,$2,$3,$4,$5,$6)`,
          [batch.sessionId, batch.principal, r.id, r.digest, r.accepted, batch.expectedRev]);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },

    async putCollabSnapshot(snap) {
      await pool.query(
        `insert into collab_room_snapshots (session_id, inputs, base_rev, ops, updated_at)
         values ($1, $2::jsonb, $3, $4, $5)
         on conflict (session_id) do update set
           inputs = excluded.inputs, base_rev = excluded.base_rev,
           ops = excluded.ops, updated_at = excluded.updated_at`,
        [snap.sessionId, JSON.stringify(snap.inputs), snap.baseRev, snap.ops, snap.updatedAt],
      );
    },
    async getCollabSnapshot(sessionId) {
      const { rows } = await pool.query('select * from collab_room_snapshots where session_id = $1', [sessionId]);
      const r = rows[0];
      if (!r) return null;
      return {
        sessionId: r.session_id as string,
        inputs: (r.inputs as Record<string, unknown>) ?? {},
        baseRev: Number(r.base_rev),
        ops: Number(r.ops),
        updatedAt: new Date(r.updated_at as string).toISOString(),
      } satisfies CollabSnapshot;
    },
    async deleteCollabSnapshot(sessionId) {
      await pool.query('delete from collab_room_snapshots where session_id = $1', [sessionId]);
    },

    async pendingMigrations() {
      return pendingAgainst(pool); // read-only; safe on a pending schema
    },
    async close() {
      await pool.end();
    },
  };
}
