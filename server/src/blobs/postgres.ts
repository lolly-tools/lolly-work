/**
 * Postgres BlobStore driver - the zero-moving-parts default (plans/26,
 * plans/27). One row per blob in `instance_blobs` (migration 0015): the
 * content as `bytea`, plus size/checksum/content_type. `pg` is imported lazily,
 * exactly like the record store, and this holds its OWN small pool - the blob
 * seam lives beside `Store`, not inside it, so the two never share a driver.
 * A blob is buffered whole on every write and read, which keeps the driver
 * trivial and correct; the S3 driver is the path for media-sized estates that
 * outgrow PG bytea (docs/configuration.md lists both drivers' limits).
 */
import { BlobLimitError, bufferToStream, readPutBody, type BlobStore } from './types.ts';
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

export async function createPostgresBlobStore(databaseUrl: string): Promise<BlobStore & { close(): Promise<void> }> {
  const { default: pg } = await import('pg');
  // A small pool: blob traffic is admin-materialization + serving, not the
  // record store's request-path volume, so it needn't compete for connections.
  const pool: PgPool = guardPool(new pg.Pool(pgPoolOptions(databaseUrl, { max: 4 })), 'blob') as unknown as PgPool;

  return {
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
