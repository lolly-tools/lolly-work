import { randomId } from '../lib/crypto.ts';
import type { AutomationCallbackOutcome, AutomationCallbackState } from '../store/types.ts';
import type { RenderOutputExpiry, RenderRecord, RenderStore } from './types.ts';
import { appendFinishedCallbacks, createPostgresBatchStore, FINISHED_RENDER_COLUMNS, inTransaction, type FinishedRenderRow, type RenderDatabase } from './batch-postgres.ts';

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

const expiryFromRow = (row: Record<string, unknown>): RenderOutputExpiry => ({
  id: row.id as string, ref: row.ref as string, toolId: row.tool_id as string, format: row.format as string,
});

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
      // Most passes find nothing exhausted, so the cheap read decides whether a
      // transaction is needed. Exhausting a render settles it, and it may owe a callback.
      const exhaustedWhere = `attempt>=max_attempts and ((state='running' and lease_until<=clock_timestamp()) or (state='queued' and available_at<=clock_timestamp()))`;
      const { rows: due } = await pool.query(`select exists (select 1 from renders where ${exhaustedWhere}) as due`);
      if (due[0]?.due) {
        await inTransaction(pool, async (db) => {
          const { rows: finished } = await db.query(`update renders set state='failed', finished_at=clock_timestamp(), updated_at=clock_timestamp(),
            lease_token=null, lease_until=null,
            error='{"code":"ATTEMPTS_EXHAUSTED","message":"render exhausted its attempts before completion"}'::jsonb
            where ${exhaustedWhere} returning ${FINISHED_RENDER_COLUMNS}`);
          await appendFinishedCallbacks(db, finished as unknown as FinishedRenderRow[]);
        });
      }
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
      return inTransaction(pool, async (db) => {
        if (outcome.state === 'succeeded') {
          const { rows } = await db.query(
            `update renders set state='succeeded',output=$3::jsonb,error=null,lease_token=null,lease_until=null,
               finished_at=clock_timestamp(),updated_at=clock_timestamp()
             where id=$1 and lease_token=$2 and state='running' and lease_until>clock_timestamp() returning ${FINISHED_RENDER_COLUMNS}`,
            [id, token, JSON.stringify(outcome.output)]);
          await appendFinishedCallbacks(db, rows as unknown as FinishedRenderRow[]);
          return rows.length === 1;
        }
        const { rows } = await db.query(
          `update renders set
             state=case when $4::integer is not null and attempt<max_attempts then 'queued' else 'failed' end,
             finished_at=case when $4::integer is not null and attempt<max_attempts then null else clock_timestamp() end,
             available_at=clock_timestamp()+(coalesce($4,0) * interval '1 millisecond'),
             error=$3::jsonb,lease_token=null,lease_until=null,updated_at=clock_timestamp()
           where id=$1 and lease_token=$2 and state='running' and lease_until>clock_timestamp() returning state, ${FINISHED_RENDER_COLUMNS}`,
          [id, token, JSON.stringify(outcome.error), outcome.retryAfterMs ?? null]);
        // A failure that will be retried has not finished.
        await appendFinishedCallbacks(db, rows.filter((row) => row.state === 'failed') as unknown as FinishedRenderRow[]);
        return rows.length === 1;
      });
    },
    async renderQueue() {
      // state='queued' implies the partial index renders_claim's predicate, so
      // this reads only live work, never the retained history.
      const { rows } = await pool.query(
        `select request->>'toolId' as tool_id, count(*)::integer as queued,
           min(available_at) filter (where available_at<=clock_timestamp()) as oldest
         from renders where state='queued' group by 1 order by 1`);
      return rows.map((r: Record<string, unknown>) => ({ toolId: String(r.tool_id), queued: Number(r.queued),
        oldestClaimableAt: r.oldest ? new Date(r.oldest as string).toISOString() : null }));
    },
    async cancelRender(id, principal) {
      const cancelled = await inTransaction(pool, async (db) => {
        const { rows } = await db.query(
          `update renders set state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=null,lease_until=null
           where id=$1 and principal=$2 and state in ('queued','running') returning *, request->>'callbackUrl' as callback_url`, [id, principal]);
        await appendFinishedCallbacks(db, rows as unknown as FinishedRenderRow[]);
        return rows[0] ?? null;
      });
      if (cancelled) return renderFromRow(cancelled);
      return this.getRender(id, principal);
    },
    async expireRenderOutputs(cutoff, expiredAt, limit) {
      const { rows } = await pool.query(
        `update renders r set output=r.output || jsonb_build_object('expiredAt',$2::text), updated_at=clock_timestamp()
         from (select id from renders where state='succeeded' and not (output ? 'purgedAt') and not (output ? 'expiredAt') and finished_at<$1::timestamptz
           and not exists (select 1 from deliveries d where d.source_render_id=renders.id)
           order by finished_at,id for update skip locked limit $3) due
         where r.id=due.id returning r.id, r.output->>'ref' as ref, r.request->>'toolId' as tool_id, r.request->>'format' as format`,
        [cutoff, expiredAt, limit]);
      return rows.map(expiryFromRow);
    },
    async renderOutputsToPurge(markedBefore, limit) {
      await pool.query(
        `update renders r set output=r.output - 'expiredAt', updated_at=clock_timestamp()
         where r.state='succeeded' and not (r.output ? 'purgedAt') and r.output ? 'expiredAt'
           and exists (select 1 from deliveries d where d.source_render_id=r.id)`);
      const { rows } = await pool.query(
        `select id, output->>'ref' as ref, request->>'toolId' as tool_id, request->>'format' as format from renders
         where state='succeeded' and not (output ? 'purgedAt') and output ? 'expiredAt' and (output->>'expiredAt')::timestamptz<$1::timestamptz
           and not exists (select 1 from deliveries d where d.source_render_id=renders.id)
         order by finished_at,id limit $2`, [markedBefore, limit]);
      return rows.map(expiryFromRow);
    },
    async markRenderOutputPurged(id) {
      await pool.query(`update renders set output=output || jsonb_build_object('purgedAt',$2::text), updated_at=clock_timestamp()
        where id=$1 and state='succeeded'`, [id, new Date().toISOString()]);
    },
    async renderCallbackSummary(id) {
      const { rows } = await pool.query('select * from automation_callbacks where render_id=$1 or render_batch_id=$1', [id]);
      const c = rows[0];
      if (!c) return null;
      return {
        id: c.id as string, state: c.state as AutomationCallbackState, attempts: Number(c.attempt ?? 0),
        ...(c.last_outcome ? { lastOutcome: c.last_outcome as AutomationCallbackOutcome } : {}),
        ...(c.last_status !== null && c.last_status !== undefined ? { lastStatus: Number(c.last_status) } : {}),
        ...(c.state === 'pending' ? { nextAttemptAt: new Date(c.next_attempt_at as string).toISOString() } : {}),
      };
    },
  };
}
