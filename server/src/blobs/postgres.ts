/**
 * Postgres BlobStore driver - the zero-moving-parts default (plans/26,
 * plans/27). One row per blob in `instance_blobs` (migration 0015): the
 * content as `bytea`, plus size/checksum/content_type. `pg` is imported lazily,
 * exactly like the record store, and this holds its OWN small pool - the blob
 * seam lives beside `Store`, not inside it, so the two never share a driver.
 * A blob is buffered whole on every write and read, which keeps the driver
 * trivial and correct; the S3 driver is the path for media-sized estates that
 * outgrow PG bytea (docs/configuration.md lists both drivers' limits).
 *
 * Usage (plan 80 section 10): bytes read from `bytea` are tallied per UTC
 * month in `instance_blob_months` (migration 0073), so the offload trigger's
 * monthly figure survives restarts and sums every replica. Reads add to an
 * in-memory delta that is written at most once a minute, when usage is asked
 * for, and at shutdown, rather than one extra write per read.
 */
import { BlobLimitError, bufferToStream, readPutBody, usageMonth, type BlobStore, type UsageNoticeKind } from './types.ts';
import { guardPool, pgPoolOptions } from '../store/pg-options.ts';

/** The largest blob this driver stores. `pg` reads `bytea` back as hex text,
 *  twice the stored size, and PostgreSQL refuses to build a value over 1 GiB,
 *  so a blob much past 512 MiB could be written but never read. A read also
 *  holds several copies of the blob in this process while it decodes. */
export const POSTGRES_BLOB_MAX_BYTES = 500 * 1024 * 1024;

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

/** How long reads may sit in memory before a read writes the tally. */
const READ_FLUSH_MS = 60_000;
/** How long one total of stored bytes is reused, so a scrape every few seconds
 *  does not sum the table every time. */
const STORED_MEMO_MS = 60_000;
/** The notice columns by kind: fixed names, never built from input. */
const NOTICE_COLUMN: Record<UsageNoticeKind, string> = { stored: 'stored_notice_at', read: 'read_notice_at' };

export async function createPostgresBlobStore(databaseUrl: string): Promise<BlobStore & { close(): Promise<void> }> {
  const { default: pg } = await import('pg');
  // A small pool: blob traffic is admin-materialization + serving, not the
  // record store's request-path volume, so it needn't compete for connections.
  const pool: PgPool = guardPool(new pg.Pool(pgPoolOptions(databaseUrl, { max: 4 })), 'blob') as unknown as PgPool;

  let readBytesTotal = 0;
  const pending = new Map<string, number>();
  let lastFlush = Date.now();
  let stored: { at: number; bytes: number } | null = null;

  // Each month's delta is written on its own; a failed write puts that delta
  // and the unwritten ones back, so a retry never counts a byte twice.
  const flushReads = async (): Promise<void> => {
    lastFlush = Date.now();
    const batch = [...pending];
    pending.clear();
    for (let i = 0; i < batch.length; i++) {
      const [month, bytes] = batch[i]!;
      try {
        await pool.query(
          `insert into instance_blob_months (month, read_bytes) values ($1, $2)
           on conflict (month) do update set read_bytes = instance_blob_months.read_bytes + excluded.read_bytes`,
          [month, bytes],
        );
      } catch (err) {
        for (const [m, b] of batch.slice(i)) pending.set(m, (pending.get(m) ?? 0) + b);
        throw err;
      }
    }
  };
  const noteRead = (bytes: number): void => {
    readBytesTotal += bytes;
    const month = usageMonth();
    pending.set(month, (pending.get(month) ?? 0) + bytes);
    if (Date.now() - lastFlush >= READ_FLUSH_MS) {
      void flushReads().catch((err: Error) => console.error(`[lolly-work] blob read tally not written: ${err.message}`));
    }
  };

  return {
    driver: 'pg',
    async put(blobId, body, contentType, declared) {
      const { content, checksum } = await readPutBody(body, declared, POSTGRES_BLOB_MAX_BYTES).catch((error: unknown) => {
        throw error instanceof BlobLimitError
          ? new BlobLimitError('the pg blob driver stores at most 500 MiB per blob; use blobs.driver "s3" for larger files')
          : error;
      });
      await pool.query(
        `insert into instance_blobs (blob_id, content, size, checksum, content_type)
         values ($1, $2, $3, $4, $5)
         on conflict (blob_id) do update set content = excluded.content, size = excluded.size,
           checksum = excluded.checksum, content_type = excluded.content_type`,
        [blobId, content, content.length, checksum, contentType],
      );
      return { blobId, size: content.length, checksum, contentType };
    },
    async head(blobId) {
      const { rows } = await pool.query('select blob_id, size, checksum, content_type from instance_blobs where blob_id = $1', [blobId]);
      const r = rows[0];
      return r ? { blobId: r.blob_id as string, size: Number(r.size), checksum: r.checksum as string, contentType: r.content_type as string } : null;
    },
    async get(blobId) {
      const { rows } = await pool.query('select blob_id, content, size, checksum, content_type from instance_blobs where blob_id = $1', [blobId]);
      const r = rows[0];
      if (!r) return null;
      const content = r.content as Buffer;
      // The whole value has left the database by now, whether or not the
      // caller reads the stream to the end.
      noteRead(content.length);
      return {
        body: bufferToStream(content),
        stat: { blobId: r.blob_id as string, size: Number(r.size), checksum: r.checksum as string, contentType: r.content_type as string },
      };
    },
    async delete(blobId) {
      await pool.query('delete from instance_blobs where blob_id = $1', [blobId]);
    },
    async usage() {
      await flushReads();
      const month = usageMonth();
      if (!stored || Date.now() - stored.at >= STORED_MEMO_MS) {
        const { rows } = await pool.query('select coalesce(sum(size), 0)::bigint as bytes from instance_blobs');
        stored = { at: Date.now(), bytes: Number(rows[0]?.bytes ?? 0) };
      }
      const { rows } = await pool.query('select read_bytes from instance_blob_months where month = $1', [month]);
      return { driver: 'pg', storedBytes: stored.bytes, readBytesTotal, month, monthReadBytes: Number(rows[0]?.read_bytes ?? 0) };
    },
    async claimUsageNotice(month, kind) {
      const column = NOTICE_COLUMN[kind];
      await pool.query('insert into instance_blob_months (month) values ($1) on conflict (month) do nothing', [month]);
      const { rowCount } = await pool.query(
        `update instance_blob_months set ${column} = now() where month = $1 and ${column} is null`,
        [month],
      );
      return rowCount === 1;
    },
    async flushUsage() {
      await flushReads();
    },
    async close() {
      await flushReads().catch((err: Error) => console.error(`[lolly-work] blob read tally not written: ${err.message}`));
      await pool.end();
    },
  };
}
