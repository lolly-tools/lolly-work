// SPDX-License-Identifier: MPL-2.0
/** Scoped uploads in Postgres (migration 0075). SQL owns the clock: an upload
 *  counts while `expires_at > now()`, the same rule as the memory store. */
import { UPLOAD_OVERHEAD_BYTES, type UploadRecord, type UploadStore } from './scoped.ts';

interface DatabaseClient { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>; release(): void }
interface Database { query: DatabaseClient['query']; connect(): Promise<DatabaseClient> }

/** One lock for every reservation: the instance budget spans owners, so a
 *  per-owner lock would let two owners both pass it. Distinct from every
 *  other advisory lock key (tests/project-files.test.ts checks). */
const UPLOADS_LOCK_KEY = 0x1011_0010;

const uploadFromRow = (r: Record<string, unknown>): UploadRecord => ({
  id: r.id as string, scope: r.scope as UploadRecord['scope'], owner: r.owner as string, name: r.name as string,
  size: Number(r.size), checksum: r.checksum as string, contentType: r.content_type as string, parts: r.parts as UploadRecord['parts'],
  createdAt: new Date(r.created_at as string).toISOString(), expiresAt: new Date(r.expires_at as string).toISOString(), ready: r.ready === true,
  // A file reference's own fields (migration 0076), absent on the other scopes.
  ...(r.role ? { role: r.role as NonNullable<UploadRecord['role']> } : {}),
  ...(r.derived_from ? { derivedFrom: r.derived_from as NonNullable<UploadRecord['derivedFrom']> } : {}),
  ...(r.report ? { report: r.report as NonNullable<UploadRecord['report']> } : {}),
});

export function createPostgresUploadStore(pool: Database): UploadStore {
  return {
    async reserveUpload(upload, limits) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock($1)', [UPLOADS_LOCK_KEY]);
        const { rows } = await client.query(
          `select coalesce(sum(size + $2) filter (where owner = $1), 0) as owner_used, coalesce(sum(size + $2), 0) as instance_used,
             count(*) filter (where owner = $1 and not ready) as pending
           from uploads where expires_at > now()`, [upload.owner, UPLOAD_OVERHEAD_BYTES]);
        const row = rows[0]!;
        const charge = upload.size + UPLOAD_OVERHEAD_BYTES;
        const refusal = Number(row.pending) >= limits.maxPending ? 'pending'
          : Number(row.owner_used) + charge > limits.ownerBudgetBytes ? 'owner-budget'
          : Number(row.instance_used) + charge > limits.instanceBudgetBytes ? 'instance-budget' : null;
        if (refusal) { await client.query('rollback'); return refusal; }
        const inserted = await client.query(
          `insert into uploads (id, scope, owner, name, size, checksum, content_type, parts, created_at, expires_at, ready, role, derived_from, report)
           values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,false,$11,$12::jsonb,$13::jsonb) on conflict (id) do nothing returning id`,
          [upload.id, upload.scope, upload.owner, upload.name, upload.size, upload.checksum, upload.contentType,
           JSON.stringify(upload.parts), upload.createdAt, upload.expiresAt, upload.role ?? null,
           upload.derivedFrom ? JSON.stringify(upload.derivedFrom) : null, upload.report ? JSON.stringify(upload.report) : null]);
        await client.query('commit');
        return inserted.rows.length === 1 ? 'reserved' : 'refused';
      } catch (error) { await client.query('rollback'); throw error; }
      finally { client.release(); }
    },
    async getUpload(id) {
      const { rows } = await pool.query('select * from uploads where id = $1', [id]);
      return rows[0] ? uploadFromRow(rows[0]) : null;
    },
    async listUploads(owner, limit, filter = {}) {
      const { rows } = await pool.query(
        `select * from uploads where owner = $1 and expires_at > now()
           and ($3::text is null or scope = $3) and ($4::boolean is null or ready = $4)
           and ($5::timestamptz is null or created_at < $5 or (created_at = $5 and id collate "C" > $6))
           order by created_at desc, id collate "C" limit $2`,
        [owner, limit, filter.scope ?? null, filter.ready ?? null, filter.before?.createdAt ?? null, filter.before?.id ?? null]);
      return rows.map(uploadFromRow);
    },
    async listUploadsToRemove(filter, limit) {
      const { rows } = await pool.query(
        `select * from uploads where ($1::text is null or owner = $1) and ($2::timestamptz is null or expires_at <= $2)
           order by expires_at, id collate "C" limit $3`, [filter.owner ?? null, filter.expiredBy ?? null, limit]);
      return rows.map(uploadFromRow);
    },
    async uploadUsage(owner) {
      const { rows } = await pool.query(
        `select coalesce(sum(size + $2) filter (where owner = $1), 0) as owner_used, coalesce(sum(size + $2), 0) as instance_used
           from uploads where expires_at > now()`, [owner, UPLOAD_OVERHEAD_BYTES]);
      return { ownerBytes: Number(rows[0]?.owner_used ?? 0), instanceBytes: Number(rows[0]?.instance_used ?? 0) };
    },
    async touchUpload(id, expiresAt) {
      const { rows } = await pool.query(
        `update uploads set expires_at = case when ready then expires_at else greatest(expires_at, $2::timestamptz) end
           where id = $1 and expires_at > now() returning id`, [id, expiresAt]);
      return rows.length === 1;
    },
    async completeUpload(id, expiresAt) {
      const { rows } = await pool.query(
        `update uploads set expires_at = case when ready then expires_at else $2::timestamptz end, ready = true
           where id = $1 and expires_at > now() returning id`, [id, expiresAt]);
      return rows.length === 1;
    },
    async deleteUpload(id) {
      const { rowCount } = await pool.query('delete from uploads where id = $1', [id]);
      return (rowCount ?? 0) > 0;
    },
  };
}
