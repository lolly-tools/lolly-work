// SPDX-License-Identifier: MPL-2.0
import { sessionLogoutKeys, type OidcLogoutStore } from './oidc-logout.ts';
interface Client { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>; release(): void }
interface Database { query: Client['query']; connect(): Promise<Client> }
export function createPostgresOidcLogout(pool: Database): OidcLogoutStore {
  return {
    async recordOidcLogout(e) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query("delete from oidc_logout_events where issued_at < extract(epoch from clock_timestamp()) - 600");
        await c.query("delete from oidc_logout_targets where issued_at < extract(epoch from clock_timestamp()) - 2678400");
        const inserted = await c.query('insert into oidc_logout_events (key,issued_at) values ($1,$2) on conflict do nothing', [e.replayKey,e.iat]);
        if (inserted.rowCount === 1) await c.query(`insert into oidc_logout_targets (key,issued_at) values ($1,$2)
          on conflict (key) do update set issued_at=greatest(oidc_logout_targets.issued_at,excluded.issued_at)`, [e.targetKey,e.iat]);
        await c.query('commit');
        return inserted.rowCount === 1;
      } catch (err) { await c.query('rollback'); throw err; } finally { c.release(); }
    },
    async oidcSessionRevoked(s) {
      const r = await pool.query('select 1 from oidc_logout_targets where key=any($1::text[]) limit 1', [sessionLogoutKeys(s)]);
      return r.rows.length > 0;
    },
    async localSessionRevoked(key) {
      const r = await pool.query('select 1 from oidc_logout_targets where key=$1 and issued_at > extract(epoch from clock_timestamp()) - 2678400', [key]);
      return r.rows.length > 0;
    },
  };
}
