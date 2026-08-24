/**
 * Postgres Store driver - binds the Store seam to migrations/0001_init.sql.
 *
 * `pg` is imported lazily so the server (and the whole test suite) still runs
 * with zero runtime deps when DATABASE_URL is unset - the memory driver stays
 * the default. Audit appends serialize on a pg advisory lock so the hash
 * chain never forks under concurrent writers.
 */
import { randomId } from '../lib/crypto.ts';
import { nextEvent, type AuditEvent, type AuditEventBody } from '../audit/chain.ts';
import { clientBucket, type ClientInfo } from '../fleet/client-header.ts';
import { eligibleForCurrentStep, type Approval, type Chain } from '../approvals/engine.ts';
import { roleFromGroups, type Grant } from '../rbac/evaluate.ts';
import type { ToolOverlay } from '../policy/overlay.ts';
import type { FlagGovernance } from '../policy/feature-flags.ts';
import type { InjectableRecord } from '../injectables/types.ts';
import { pendingAgainst } from './migrate.ts';
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
import {
  SESSION_REVISION_LIMIT, effectiveGroups,
  type ApiTokenRecord, type CollabSnapshot, type FleetRow, type InstallRow, type ListUsersPageOpts, type LocalGroupRecord, type ProjectRecord,
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

// Appends a `column = $n` clause + its bound value - shared by the two
// filtered list queries below so the param-numbering logic lives in one place.
const addClause = (clauses: string[], values: unknown[], column: string, value: unknown): void => {
  values.push(value);
  clauses.push(`${column} = $${values.length}`);
};

export async function createPostgresStore(databaseUrl: string): Promise<Store & { close(): Promise<void> }> {
  const { default: pg } = await import('pg');
  const pool: PgPool = new pg.Pool({ connectionString: databaseUrl }) as unknown as PgPool;

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
      role: r.role as string,
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
  const projectFromRow = (r: Record<string, unknown>): ProjectRecord => ({
    id: r.id as string,
    name: r.name as string,
    visibility: r.visibility === 'private' ? 'private' : (r.visibility as { groups: string[] }),
    ownerId: r.owner_id as string,
    createdAt: new Date(r.created_at as string).toISOString(),
    ...(r.archived_at ? { archivedAt: new Date(r.archived_at as string).toISOString() } : {}),
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
    async upsertUserBySub(user) {
      // Incoming groups are IdP-authoritative; preserve any stored localGroups
      // and derive the effective union + role in JS (mirrors the memory driver).
      const idpGroups = [...new Set(user.groups.filter(Boolean))];
      const { rows: existing } = await pool.query('select local_groups from users where sub = $1', [user.sub]);
      const local = (existing[0]?.local_groups as string[]) ?? [];
      const groups = effectiveGroups(idpGroups, local);
      const role = roleFromGroups(groups);
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
      // name = first + last + email, concatenated once for both filter and sort.
      const nameExpr = `lower(coalesce(firstname, '') || ' ' || coalesce(lastname, '') || ' ' || email)`;
      if (opts.q?.trim()) clauses.push(`${nameExpr} like ${bind('%' + opts.q.trim().toLowerCase() + '%')}`);
      // Jump-to-letter - matched against the trimmed name key (a user without a
      // firstname would otherwise lead with the concatenation's space).
      if (opts.prefix === '#') clauses.push(`ltrim(${nameExpr}) !~ '^[a-z]'`);
      else if (opts.prefix) clauses.push(`ltrim(${nameExpr}) like ${bind(opts.prefix + '%')}`);
      if (opts.role) clauses.push(`role = ${bind(opts.role)}`);
      if (opts.group) clauses.push(`jsonb_exists(groups, ${bind(opts.group)})`);
      if (opts.status === 'active') clauses.push('disabled_at is null');
      else if (opts.status === 'disabled') clauses.push('disabled_at is not null');
      const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
      const sortExpr = opts.sort === 'email' ? 'lower(email)'
        : opts.sort === 'role' ? 'role'
        : opts.sort === 'lastSeen' ? 'last_seen_at'
        : nameExpr;
      const dir = opts.dir === 'desc' ? 'desc' : 'asc';
      const { rows: countRows } = await pool.query(`select count(*)::int as n from users ${where}`, values);
      const total = Number(countRows[0]?.n ?? 0);
      const limit = bind(opts.limit);
      const offset = bind(opts.offset);
      const { rows } = await pool.query(
        `select * from users ${where} order by ${sortExpr} ${dir}, id asc limit ${limit} offset ${offset}`,
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
        [userId, JSON.stringify(local), JSON.stringify(groups), roleFromGroups(groups)],
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
          [r.id as string, JSON.stringify(local), JSON.stringify(groups), roleFromGroups(groups)],
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

    async appendAudit(body: AuditEventBody) {
      const client = await pool.connect();
      try {
        await client.query('begin');
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
            }
          : null;
        const evt = nextEvent(tail, body);
        await client.query(
          `insert into audit_log (seq, at, actor, action, subject, payload, prev_hash, hash)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
          [evt.seq, evt.at, evt.actor, evt.action, evt.subject,
           evt.payload ? JSON.stringify(evt.payload) : null, evt.prevHash, evt.hash],
        );
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
        `update catalog_providers set credential_ciphertext = $2, credential_fingerprint = $3, credential_updated_at = $4
         where id = $1`,
        cred
          ? [id, Buffer.from(cred.ciphertext), cred.fingerprint, cred.updatedAt]
          : [id, null, null, null],
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
        `insert into projects (id, name, visibility, owner_id, created_at, archived_at)
         values ($1, $2, $3::jsonb, $4, $5, $6)
         on conflict (id) do update set
           name = excluded.name, visibility = excluded.visibility, archived_at = excluded.archived_at`,
        [project.id, project.name, JSON.stringify(project.visibility), project.ownerId,
         project.createdAt, project.archivedAt ?? null],
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
    async putSession(session) {
      await pool.query(
        `insert into sessions (id, project_id, tool_id, tool_version, inputs, meta,
           created_by, updated_by, rev, updated_at, deleted_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11)
         on conflict (id) do update set
           inputs = excluded.inputs, meta = excluded.meta, updated_by = excluded.updated_by,
           rev = excluded.rev, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at`,
        [session.id, session.projectId, session.toolId, session.toolVersion,
         JSON.stringify(session.inputs), JSON.stringify(session.meta), session.createdBy,
         session.updatedBy, session.rev, session.updatedAt, session.deletedAt ?? null],
      );
    },
    async casSession(next, expectedRev) {
      // One statement, so the compare and the set cannot be separated by anything.
      // `deleted_at` is deliberately NOT in the SET list and `is null` is in the
      // WHERE: a CAS can neither tombstone nor resurrect.
      const res = await pool.query(
        `update sessions set inputs = $2::jsonb, meta = $3::jsonb, updated_by = $4,
            rev = $5, updated_at = $6
          where id = $1 and rev = $7 and deleted_at is null`,
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

    // live collab rooms (migrations/0010_collab.sql). One row per session,
    // REPLACED on each cadence hit - no update log, so nothing to compact.
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
