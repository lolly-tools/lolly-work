/**
 * Postgres BlobStore driver - the zero-moving-parts default (plans/26 §2,
 * plans/27 §5). One row per blob in `instance_blobs` (migration 0015): the
 * content as `bytea`, plus size/checksum/content_type. `pg` is imported lazily,
 * exactly like the record store, and this holds its OWN small pool - the blob
 * seam lives beside `Store`, not inside it, so the two never share a driver.
 * A blob is buffered whole (admin-triggered materialization, one at a time),
 * which keeps the driver trivial and correct; the S3 driver is the path for
 * media-sized estates that outgrow PG bytea.
 */
import { createHash } from 'node:crypto';
import { bufferToStream, readBlobBody, type BlobStat, type BlobStore } from './types.ts';

interface PgPool {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}

export async function createPostgresBlobStore(databaseUrl: string): Promise<BlobStore & { close(): Promise<void> }> {
  const { default: pg } = await import('pg');
  // A small pool: blob traffic is admin-materialization + serving, not the
  // record store's request-path volume, so it needn't compete for connections.
  const pool: PgPool = new pg.Pool({ connectionString: databaseUrl, max: 4 }) as unknown as PgPool;

  return {
    async put(blobId, body, contentType) {
      const content = await readBlobBody(body);
      const checksum = createHash('sha256').update(content).digest('hex');
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
      return {
        body: bufferToStream(content),
        stat: { blobId: r.blob_id as string, size: Number(r.size), checksum: r.checksum as string, contentType: r.content_type as string },
      };
    },
    async delete(blobId) {
      await pool.query('delete from instance_blobs where blob_id = $1', [blobId]);
    },
    async close() {
      await pool.end();
    },
  };
}
