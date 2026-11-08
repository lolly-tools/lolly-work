// SPDX-License-Identifier: MPL-2.0
/**
 * Blob storage limits. The Postgres blob store reads them from here, and so does the
 * Limits and quotas panel, which must not load the store to show them.
 */

/** The largest blob this driver stores. `pg` reads `bytea` back as hex text,
 *  twice the stored size, and PostgreSQL refuses to build a value over 1 GiB,
 *  so a blob much past 512 MiB could be written but never read. A read also
 *  holds several copies of the blob in this process while it decodes. */
export const POSTGRES_BLOB_MAX_BYTES = 500 * 1024 * 1024;
