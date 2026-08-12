/**
 * Gated-Postgres bootstrap, shared by every suite that needs a real database.
 *
 * `node --test` runs test FILES IN PARALLEL, and each pg suite starts by dropping
 * and recreating `public` — so the moment there is more than one of them, they
 * tear each other's schema down mid-test. A pg advisory lock makes the whole
 * drop → migrate → run → teardown sequence mutually exclusive, across files and
 * across processes (two developers pointed at the same disposable database).
 * Held on its own session and released by `end()`, exactly like the migration
 * runner's lock.
 */
import { runMigrations } from '../server/src/store/migrate.ts';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import type { Store } from '../server/src/store/types.ts';

/** Distinct from postgres.ts's AUDIT_LOCK_KEY (0x1011_0001) and migrate.ts's
 *  MIGRATE_LOCK_KEY (0x1011_0002), so no suite can deadlock against the code it
 *  is testing. */
const SUITE_LOCK_KEY = 0x1011_0003;

/** Run `body` against a freshly migrated Postgres store, alone. */
export async function withFreshPostgres(url: string, body: (store: Store) => Promise<void>): Promise<void> {
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  try {
    await admin.query('select pg_advisory_lock($1)', [SUITE_LOCK_KEY]);
    await admin.query('drop schema public cascade; create schema public;');
    await runMigrations(url);
    const store = await createPostgresStore(url);
    try {
      await body(store);
    } finally {
      await store.close();
    }
  } finally {
    await admin.end(); // ends the session, releasing the advisory lock
  }
}
