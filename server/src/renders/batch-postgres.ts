import type { RenderBatchRecord, RenderRecord, RenderStore } from './types.ts';

interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export interface RenderDatabase extends Queryable { connect(): Promise<Queryable & { release(): void }> }

type BatchStore = Pick<RenderStore, 'insertRenderBatch' | 'getRenderBatch' | 'listRenderBatches' | 'cancelRenderBatch'>;

/** No parent counter to drift: one statement snapshots the parent and all child states. */
export function createPostgresBatchStore(pool: RenderDatabase, renderFromRow: (row: Record<string, unknown>) => RenderRecord): BatchStore {
  const fromRow = (row: Record<string, unknown>): RenderBatchRecord => ({
    id: row.id as string, principal: row.principal as string,
    request: row.request as RenderBatchRecord['request'], requestHash: row.request_hash as string,
    createdAt: new Date(row.created_at as string).toISOString(),
    ...(row.idempotency_key != null ? { idempotencyKey: row.idempotency_key as string } : {}),
    ...(row.retry_of ? { retryOf: row.retry_of as string } : {}),
    rows: (row.children as { key: string; render: Record<string, unknown> }[]).map((child) => ({
      key: child.key, render: renderFromRow(child.render),
    })),
  });
  const children = `(select jsonb_agg(jsonb_build_object('key',m.row_key,'render',to_jsonb(r)) order by m.position)
    from render_batch_rows m join renders r on r.id=m.render_id and r.principal=m.principal
    where m.batch_id=b.id) as children`;
  const get = async (db: Queryable, id: string, principal: string): Promise<RenderBatchRecord | null> => {
    const { rows } = await db.query(`select b.*,${children} from render_batches b where b.id=$1 and b.principal=$2`, [id, principal]);
    return rows[0] ? fromRow(rows[0]) : null;
  };
  const transaction = async <T>(body: (db: Queryable) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      const result = await body(client);
      await client.query('commit');
      return result;
    } catch (error) { await client.query('rollback').catch(() => {}); throw error; }
    finally { client.release(); }
  };
  return {
    async insertRenderBatch(batch) {
      return transaction(async (db) => {
        const inserted = await db.query(`insert into render_batches(id,principal,request,request_hash,idempotency_key,retry_of)
          values($1,$2,$3::jsonb,$4,$5,$6) on conflict(principal,idempotency_key) do nothing returning id`,
          [batch.id, batch.principal, JSON.stringify(batch.request), batch.requestHash, batch.idempotencyKey ?? null, batch.retryOf ?? null]);
        if (!inserted.rows.length) {
          const existing = await db.query('select id from render_batches where principal=$1 and idempotency_key=$2', [batch.principal, batch.idempotencyKey]);
          if (!existing.rows[0]) throw new Error('batch idempotency record disappeared');
          return { record: (await get(db, existing.rows[0].id as string, batch.principal))!, reused: true };
        }
        if (!batch.rows.length || batch.rows.length > 200) throw new Error('invalid batch size');
        if (batch.rows.some(({ render }) => render.principal !== batch.principal ||
          (render.state !== 'succeeded' && (render.state !== 'queued' || render.idempotencyKey !== undefined)))) throw new Error('invalid batch membership');
        const reusedIds = batch.rows.filter(({ render }) => render.state === 'succeeded').map(({ render }) => render.id);
        if (reusedIds.length) {
          const existing = await db.query("select id from renders where principal=$1 and state='succeeded' and id=any($2::text[])", [batch.principal, reusedIds]);
          if (existing.rows.length !== reusedIds.length) throw new Error('successful child not found');
        }
        const fresh = batch.rows.filter(({ render }) => render.state === 'queued').map(({ render }) => ({
          id: render.id, request: render.request, request_hash: render.requestHash, retry_of: render.retryOf ?? null,
          priority: render.request.priority, max_attempts: render.request.maxAttempts,
        }));
        await db.query(`insert into renders(id,principal,request,request_hash,retry_of,state,priority,max_attempts)
          select c.id,$1,c.request,c.request_hash,c.retry_of,'queued',c.priority,c.max_attempts
          from jsonb_to_recordset($2::jsonb) as c(id text,request jsonb,request_hash text,retry_of text,priority integer,max_attempts integer)`,
          [batch.principal, JSON.stringify(fresh)]);
        await db.query(`insert into render_batch_rows(batch_id,principal,row_key,position,render_id)
          select $1,$2,m.key,m.position,m.render_id
          from jsonb_to_recordset($3::jsonb) as m(key text,position integer,render_id text)`,
          [batch.id, batch.principal, JSON.stringify(batch.rows.map(({ key, render }, position) => ({ key, position, render_id: render.id })))]);
        return { record: (await get(db, batch.id, batch.principal))!, reused: false };
      });
    },
    getRenderBatch: (id, principal) => get(pool, id, principal),
    async listRenderBatches(principal, limit, offset) {
      const { rows } = await pool.query(`select b.*,${children} from
        (select * from render_batches where principal=$1 order by created_at desc,id desc limit $2 offset $3) b
        order by b.created_at desc,b.id desc`, [principal, limit, offset]);
      return rows.map(fromRow);
    },
    async cancelRenderBatch(id, principal) {
      return transaction(async (db) => {
        await db.query(`update renders r set state='cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=null,lease_until=null
          from render_batch_rows m where m.batch_id=$1 and m.principal=$2 and r.id=m.render_id and r.principal=m.principal
          and r.state in ('queued','running')`, [id, principal]);
        return get(db, id, principal);
      });
    },
  };
}
