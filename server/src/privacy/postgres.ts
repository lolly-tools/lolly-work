// SPDX-License-Identifier: MPL-2.0
import { roleFromGroups, type RoleGroups } from '../rbac/evaluate.ts';
import { LastOwnerError, subjectRow, type SubjectCategory, type SubjectStore } from './subject.ts';

interface QueryResult { rows: Record<string, unknown>[]; rowCount: number | null }
interface Client { query(sql: string, values?: unknown[]): Promise<QueryResult>; release(): void }
interface Pool { query(sql: string, values?: unknown[]): Promise<QueryResult>; connect(): Promise<Client> }
const iso = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;
const afterNumber = (value: string): string => !value ? '0' : /^\d{1,19}$/.test(value) ? value : (() => { throw new Error('Invalid numeric continuation.'); })();

export async function guardLastOwner(client: Pick<Client, 'query'>, userId: string, roleGroups: RoleGroups): Promise<void> {
  await client.query("set local statement_timeout = '10s'");
  await client.query("set local lock_timeout = '5s'");
  await client.query('lock table users in share row exclusive mode');
  const target = (await client.query('select groups, disabled_at from users where id = $1', [userId])).rows[0];
  if (!target || target.disabled_at || roleFromGroups(target.groups as string[], roleGroups) !== 'owner') return;
  const other = await client.query('select id from users where id <> $1 and disabled_at is null and groups ?| $2::text[] limit 1', [userId, roleGroups.owner ?? ['owner']]);
  if (!other.rows.length) throw new LastOwnerError();
}

export function createPostgresSubjects(pool: Pool, roles: () => RoleGroups): SubjectStore {
  return {
    async subjectRows(userId, category, after, limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 201) throw new Error('Invalid page size.');
      const subject = category === 'credentials' || category === 'audit' ? `user:${userId}` : userId;
      const query = (sql: string, a = after) => pool.query(sql, [subject, a, limit]);
      const rows = (await (category === 'identities' ? query('select identity_sub, idp, email, email_verified, linked_at, last_login_at from user_identities where user_id = $1 and identity_sub > $2 collate "C" order by identity_sub collate "C" limit $3')
        : category === 'projects' ? query('select project_id, role, added_at from project_members where user_id = $1 and project_id > $2 collate "C" order by project_id collate "C" limit $3')
        : category === 'credentials' ? query('select id, label, role, created_at, expires_at, last_used_at, revoked_at from api_tokens where created_by = $1 and id > $2 collate "C" order by id collate "C" limit $3', after)
        : category === 'links' ? query('select id, kind, exp, created_at, revoked_at from links where created_by = $1 and id > $2 collate "C" order by id collate "C" limit $3')
        : category === 'fleet' ? query('select install_id, first_seen_at, last_seen_at from fleet_installs where user_id_last_seen = $1 and install_id > $2 collate "C" order by install_id collate "C" limit $3')
        : category === 'telemetry' ? query('select id, at, event, attrs from telemetry_events where user_id = $1 and id > $2::bigint order by id limit $3', afterNumber(after))
        : query('select seq, at, action, prev_hash, hash from audit_log where (actor = $1 or subject = $1) and seq > $2::bigint order by seq limit $3', afterNumber(after)))).rows;
      return rows.map(r => {
        if (category === 'identities') return subjectRow(String(r.identity_sub), { identitySub: r.identity_sub, idp: r.idp, email: r.email, emailVerified: r.email_verified, linkedAt: iso(r.linked_at), lastLoginAt: iso(r.last_login_at) });
        if (category === 'projects') return subjectRow(String(r.project_id), { projectId: r.project_id, role: r.role, addedAt: iso(r.added_at) });
        if (category === 'credentials') return subjectRow(String(r.id), { id: r.id, label: r.label, role: r.role, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at) });
        if (category === 'links') return subjectRow(String(r.id), { id: r.id, kind: r.kind, expiresAt: new Date(Number(r.exp) * 1000).toISOString(), createdAt: iso(r.created_at), revokedAt: iso(r.revoked_at) });
        if (category === 'fleet') return subjectRow(String(r.install_id), { installId: r.install_id, firstSeenAt: iso(r.first_seen_at), lastSeenAt: iso(r.last_seen_at) });
        if (category === 'telemetry') return subjectRow(String(r.id), { at: iso(r.at), event: r.event, attrs: r.attrs });
        return subjectRow(String(r.seq), { sourceSeq: Number(r.seq), at: iso(r.at), action: r.action, sourceHash: r.hash, sourcePrevHash: r.prev_hash });
      });
    },
    async offboardUser(userId, actorId, at, limit) {
      if (userId === actorId) return { status: 'self' };
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid offboarding bound.');
      const client = await pool.connect();
      try {
        await client.query('begin');
        await guardLastOwner(client, userId, roles());
        const target = (await client.query('select email from users where id = $1', [userId])).rows[0];
        if (!target) { await client.query('rollback'); return { status: 'not-found' }; }
        await client.query('lock table api_tokens, links, password_links in share row exclusive mode');
        const tokens = (await client.query('select id from api_tokens where created_by = $1 and revoked_at is null limit $2', [`user:${userId}`, limit + 1])).rows;
        const links = (await client.query('select id from links where created_by = $1 and revoked_at is null limit $2', [userId, limit + 1])).rows;
        const passwords = (await client.query('select token_hash from password_links where used_at is null and email in (select lower(email) from users where id = $1 union select lower(email) from user_identities where user_id = $1) limit $2', [userId, limit + 1])).rows;
        if (tokens.length > limit || links.length > limit || passwords.length > limit) { await client.query('rollback'); return { status: 'limit' }; }
        const updated = await client.query('update users set disabled_at = $2, session_epoch = session_epoch + 1 where id = $1 returning session_epoch', [userId, at]);
        const t = await client.query('update api_tokens set revoked_at = $2 where id = any($1::text[]) and revoked_at is null', [tokens.map(r => r.id), at]);
        const l = await client.query('update links set revoked_at = $2 where id = any($1::text[]) and revoked_at is null', [links.map(r => r.id), at]);
        const p = await client.query('delete from password_links where token_hash = any($1::text[])', [passwords.map(r => r.token_hash)]);
        await client.query('commit');
        return { status: 'disabled', sessionEpoch: Number(updated.rows[0]!.session_epoch), credentialsRevoked: t.rowCount ?? 0, linksRevoked: l.rowCount ?? 0, passwordLinksRevoked: p.rowCount ?? 0 };
      } catch (error) {
        await client.query('rollback');
        if (error instanceof LastOwnerError) return { status: 'last-owner' };
        throw error;
      } finally { client.release(); }
    },
  };
}
