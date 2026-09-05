import { randomId } from '../lib/crypto.ts';
import type { RenderRecord, RenderStore } from './types.ts';
import { createPostgresBatchStore, type RenderDatabase } from './batch-postgres.ts';

export function renderFromRow(r: Record<string, unknown>): RenderRecord {
  return {
    id: r.id as string, principal: r.principal as string,
    request: r.request as RenderRecord['request'], requestHash: r.request_hash as string,
    state: r.state as RenderRecord['state'], attempt: Number(r.attempt),
    createdAt: new Date(r.created_at as string).toISOString(), updatedAt: new Date(r.updated_at as string).toISOString(),
    availableAt: new Date(r.available_at as string).toISOString(),
    ...(r.idempotency_key != null ? { idempotencyKey: r.idempotency_key as string } : {}),
    ...(r.retry_of ? { retryOf: r.retry_of as string } : {}),
    ...(r.finished_at ? { finishedAt: new Date(r.finished_at as string).toISOString() } : {}),
    ...(r.lease_token ? { leaseToken: r.lease_token as string, leaseUntil: new Date(r.lease_until as string).toISOString() } : {}),
    ...(r.output ? { output: r.output as RenderRecord['output'] } : {}),
    ...(r.error ? { error: r.error as RenderRecord['error'] } : {}),
  };
}

/** SQL owns the lease clock and the compare-and-set; replicas share no JS locks. */
export function createPostgresRenderStore(pool: RenderDatabase): RenderStore {
  return {
    ...createPostgresBatchStore(pool, renderFromRow),
    async insertRender(r) {
      const { rows } = await pool.query(
        `insert into renders(id,principal,request,request_hash,idempotency_key,retry_of,state,priority,max_attempts)
         values($1,$2,$3::jsonb,$4,$5,$6,'queued',$7,$8)
         on conflict(principal,idempotency_key) do nothing returning *`,
        [r.id, r.principal, JSON.stringify(r.request), r.requestHash, r.idempotencyKey ?? null, r.retryOf ?? null, r.request.priority, r.request.maxAttempts]);
      if (rows[0]) return { record: renderFromRow(rows[0]), reused: false };
      const existing = await pool.query('select * from renders where principal=$1 and idempotency_key=$2', [r.principal, r.idempotencyKey]);
      if (!existing.rows[0]) throw new Error('render idempotency record disappeared');
      return { record: renderFromRow(existing.rows[0]), reused: true };
    },
    async getRender(id, principal) {
      const { rows } = await pool.query('select * from renders where id=$1 and principal=$2', [id, principal]);
      return rows[0] ? renderFromRow(rows[0]) : null;
    },
    async listRenders(principal, limit, offset) {
      const { rows } = await pool.query('select * from renders where principal=$1 order by created_at desc,id desc limit $2 offset $3', [principal, limit, offset]);
      return rows.map(renderFromRow);
    },
    async claimRender(leaseMs) {
      await pool.query(`update renders set state='failed', finished_at=clock_timestamp(), updated_at=clock_timestamp(),
        lease_token=null, lease_until=null,
        error='{"code":"ATTEMPTS_EXHAUSTED","message":"render exhausted its attempts before completion"}'::jsonb
        where attempt>=max_attempts and ((state='running' and lease_until<=clock_timestamp()) or (state='queued' and available_at<=clock_timestamp()))`);
      const { rows } = await pool.query(
        `with candidate as (
           select id from renders where attempt<max_attempts and
             ((state='queued' and available_at<=clock_timestamp()) or (state='running' and lease_until<=clock_timestamp()))
           order by priority desc,created_at,id for update skip locked limit 1
         ) update renders r set state='running', attempt=r.attempt+1, lease_token=$1,
           lease_until=clock_timestamp()+($2 * interval '1 millisecond'), updated_at=clock_timestamp(), error=null
         from candidate c where r.id=c.id returning r.*`, [randomId(16), leaseMs]);
      return rows[0] ? renderFromRow(rows[0]) : null;
    },
    async heartbeatRender(id, token, leaseMs) {
      const { rowCount } = await pool.query(
        `update renders set lease_until=clock_timestamp()+($3 * interval '1 millisecond'), updated_at=clock_timestamp()
         where id=$1 and lease_token=$2 and state='running' and lease_until>clock_timestamp()`, [id, token, leaseMs]);
      return rowCount === 1;
    },
    async settleRender(id, token, outcome) {
      if (outcome.state === 'succeeded') {
        const { rowCount } = await pool.query(
          `update renders set state='succeeded',output=$3::jsonb,error=null,lease_token=null,lease_until=null,
             finished_at=clock_timestamp(),updated_at=clock_timestamp()
           where id=$1 and lease_token=$2 and state='running' and lease_until>clock_timestamp()`,
          [id, token, JSON.stringify(outcome.output)]);
        return rowCount === 1;
      }
      const { rowCount } = await pool.query(
        `update renders set
           state=case when $4::integer is not null and attempt<max_attempts then 'queued' else 'failed' end,
           finished_at=case when $4::integer is not null and attempt<max_attempts then null else clock_timestamp() end,
           available_at=clock_timestamp()+(coalesce($4,0) * interval '1 millisecond'),
           error=$3::jsonb,lease_token=null,lease_until=null,updated_at=clock_timestamp()
         where id=$1 and lease_token=$2 and state='running' and lease_until>clock_timestamp()`,
        [id, token, JSON.stringify(outcome.error), outcome.retryAfterMs ?? null]);
      return rowCount === 1;
    },
    async cancelRender(id, principal) {
      const { rows } = await pool.query(
        `update renders set state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=null,lease_until=null
         where id=$1 and principal=$2 and state in ('queued','running') returning *`, [id, principal]);
      if (rows[0]) return renderFromRow(rows[0]);
      return this.getRender(id, principal);
    },
  };
}
