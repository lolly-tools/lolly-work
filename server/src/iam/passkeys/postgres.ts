// SPDX-License-Identifier: MPL-2.0
interface DatabaseClient { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>; release(): void }
interface Database { query: DatabaseClient['query']; connect(): Promise<DatabaseClient> }
import type { PasskeyChallenge, PasskeyRecord, PasskeyStore } from './types.ts';
const keyFrom = (r: Record<string, unknown>): PasskeyRecord => ({
  id: r.id as string, userId: r.user_id as string, publicKey: r.public_key as string, counter: Number(r.counter),
  transports: r.transports as string[], label: r.label as string, backedUp: r.backed_up as boolean,
  deviceType: r.device_type as PasskeyRecord['deviceType'], createdAt: new Date(r.created_at as string).toISOString(),
  ...(r.last_used_at ? { lastUsedAt: new Date(r.last_used_at as string).toISOString() } : {}),
});
export function createPostgresPasskeys(pool: Database): PasskeyStore {
  async function withUser(id: string, epoch: number, run: (client: DatabaseClient) => Promise<boolean>) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const { rows } = await c.query('select id from users where id=$1 and disabled_at is null and session_epoch=$2 for update', [id, epoch]);
      const result = !!rows[0] && await run(c);
      await c.query('commit'); return result;
    } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
  }
  return {
    async putPasskeyChallenge(r) {
      const c = await pool.connect();
      try {
        await c.query('begin'); await c.query('select pg_advisory_xact_lock(871133)');
        await c.query('delete from passkey_challenges where expires_at<=clock_timestamp()');
        const result = await c.query(`insert into passkey_challenges (id,nonce_hash,user_id,expires_at,payload)
          select $1,$2,$3,$4,$5::jsonb where (select count(*) from passkey_challenges)<5000 on conflict do nothing`,
          [r.id, r.nonceHash, r.userId ?? null, r.expiresAt, JSON.stringify(r)]);
        await c.query('commit'); return result.rowCount === 1;
      } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
    },
    async consumePasskeyChallenge(id, nonceHash) {
      const { rows } = await pool.query(`delete from passkey_challenges where id=$1 and nonce_hash=$2
        returning payload,expires_at>clock_timestamp() as live`, [id, nonceHash]);
      return rows[0]?.live ? rows[0].payload as PasskeyChallenge : null;
    },
    async listPasskeys(userId) { const { rows } = await pool.query('select * from passkeys where user_id=$1 order by created_at,id', [userId]); return rows.map(keyFrom); },
    async getPasskey(id) { const { rows } = await pool.query('select * from passkeys where id=$1', [id]); return rows[0] ? keyFrom(rows[0]) : null; },
    async registerPasskey(r, epoch) {
      return withUser(r.userId, epoch, async c => {
        const result = await c.query(`insert into passkeys (id,user_id,public_key,counter,transports,label,backed_up,device_type,created_at)
          select $1,$2,$3,$4,$5,$6,$7,$8,$9 where (select count(*) from passkeys where user_id=$2)<10 on conflict do nothing`,
          [r.id,r.userId,r.publicKey,r.counter,r.transports,r.label,r.backedUp,r.deviceType,r.createdAt]);
        return result.rowCount === 1;
      });
    },
    async advancePasskey(expected, nextCounter, backedUp, epoch) {
      const {id,counter}=expected;
      return withUser(expected.userId, epoch, async c => {
        const result = await c.query(`update passkeys set counter=$3,backed_up=$4,last_used_at=clock_timestamp()
          where id=$1 and counter=$2 and (($2=0 and $3=0) or $3>$2) and user_id=$5 and public_key=$6 and created_at=$7`, [id,counter,nextCounter,backedUp,expected.userId,expected.publicKey,expected.createdAt]);
        return result.rowCount === 1;
      });
    },
    async removePasskey(id, userId, epoch) {
      return withUser(userId, epoch, async c => { const r = await c.query('delete from passkeys where id=$1 and user_id=$2', [id,userId]); return r.rowCount === 1; });
    },
  };
}
