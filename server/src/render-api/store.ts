// SPDX-License-Identifier: MPL-2.0
/** Records of vendor requests, in memory and in Postgres. The renders live in the render store. */
import type { RenderDatabase } from '../renders/batch-postgres.ts';
import type { RenderApiRecord, RenderApiSource, RenderApiStore } from './types.ts';

export function createMemoryRenderApiStore(): RenderApiStore {
  const records = new Map<string, RenderApiRecord>();
  let seq = 0;
  const clone = structuredClone;
  return {
    async insertRenderApiRecord(record) {
      if (record.idempotencyKey !== undefined) {
        const existing = [...records.values()].find((item) => item.principal === record.principal && item.idempotencyKey === record.idempotencyKey);
        if (existing) return { record: clone(existing), reused: true };
      }
      const saved: RenderApiRecord = { ...clone(record), seq: ++seq };
      records.set(saved.id, saved);
      return { record: clone(saved), reused: false };
    },
    async setRenderApiRenders(id, renders) {
      const record = records.get(id);
      if (record) record.renders = clone(renders);
    },
    async getRenderApiRecord(id) {
      const record = records.get(id);
      return record ? clone(record) : null;
    },
    async getRenderApiRecordBySeq(value) {
      const record = [...records.values()].find((item) => item.seq === value);
      return record ? clone(record) : null;
    },
    async listRenderApiRecords(principal, source, limit, offset) {
      return [...records.values()].filter((item) => item.principal === principal && item.source === source)
        .sort((a, b) => b.seq - a.seq).slice(offset, offset + limit).map((item) => clone(item));
    },
    async deleteRenderApiRecord(id, principal) {
      const record = records.get(id);
      if (!record || record.principal !== principal) return null;
      records.delete(id);
      return record;
    },
  };
}

function fromRow(row: Record<string, unknown>): RenderApiRecord {
  return {
    id: row.id as string, seq: Number(row.seq), source: row.source as RenderApiSource, template: row.template as string,
    principal: row.principal as string, formats: row.formats as string[], renders: row.renders as Record<string, string>,
    metadata: row.metadata ?? null, echo: row.echo as Record<string, unknown>,
    ...(row.webhook_url ? { webhookUrl: row.webhook_url as string } : {}),
    ...(row.filename ? { filename: row.filename as string } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key as string } : {}),
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

export function createPostgresRenderApiStore(pool: RenderDatabase): RenderApiStore {
  return {
    async insertRenderApiRecord(record) {
      const inserted = await pool.query(
        `insert into render_api_records (id, source, template, principal, formats, renders, metadata, echo, webhook_url, filename, idempotency_key, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
         on conflict (principal, idempotency_key) do nothing
         returning *`,
        [record.id, record.source, record.template, record.principal, JSON.stringify(record.formats), JSON.stringify(record.renders),
          record.metadata === undefined || record.metadata === null ? null : JSON.stringify(record.metadata), JSON.stringify(record.echo),
          record.webhookUrl ?? null, record.filename ?? null, record.idempotencyKey ?? null, record.createdAt],
      );
      if (inserted.rows[0]) return { record: fromRow(inserted.rows[0]), reused: false };
      const existing = await pool.query('select * from render_api_records where principal = $1 and idempotency_key = $2', [record.principal, record.idempotencyKey]);
      return { record: fromRow(existing.rows[0]!), reused: true };
    },
    async setRenderApiRenders(id, renders) {
      await pool.query('update render_api_records set renders = $2::jsonb where id = $1', [id, JSON.stringify(renders)]);
    },
    async getRenderApiRecord(id) {
      const { rows } = await pool.query('select * from render_api_records where id = $1', [id]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async getRenderApiRecordBySeq(seq) {
      const { rows } = await pool.query('select * from render_api_records where seq = $1', [seq]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async listRenderApiRecords(principal, source, limit, offset) {
      const { rows } = await pool.query(
        'select * from render_api_records where principal = $1 and source = $2 order by seq desc limit $3 offset $4',
        [principal, source, limit, offset],
      );
      return rows.map(fromRow);
    },
    async deleteRenderApiRecord(id, principal) {
      const { rows } = await pool.query('delete from render_api_records where id = $1 and principal = $2 returning *', [id, principal]);
      return rows[0] ? fromRow(rows[0]) : null;
    },
  };
}
