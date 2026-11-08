// SPDX-License-Identifier: MPL-2.0
/**
 * Database connection and migration limits. The pool options and the migration runner
 * read them from here, and so does the Limits and quotas panel, which must not load the
 * migration runner to show them.
 */

export const PG_CONNECT_TIMEOUT_MS = 15_000;
export const PG_IDLE_TIMEOUT_MS = 30_000;

// Bounds for the migration session, set with SET LOCAL inside each transaction
// (a pooler drops session-level SET). Waiting for another replica's migration
// gives up after LOCK_TIMEOUT with an error instead of hanging; one statement
// of a migration may run for STATEMENT_TIMEOUT.
export const MIGRATION_LOCK_TIMEOUT = '20s';
export const MIGRATION_STATEMENT_TIMEOUT = '120s';
