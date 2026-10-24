/**
 * Explicit migration runner - the infra path for HA deploys where the server
 * runs with LW_AUTO_MIGRATE=false and refuses to start on a pending schema.
 *
 *   pnpm run migrate                  apply pending migrations
 *   pnpm run migrate:status            report pending migrations (exit 1 if any), no DDL
 *   pnpm run migrate:status -- --json  the same as JSON, with the pending set's manifest
 *
 * LW_MIGRATE_EXPECT (none, a.sql,b.sql or sha256:<manifest>) makes the apply
 * refuse unless the pending set is exactly that; see server/src/store/migrate.ts.
 *
 * Reuses server/src/store/migrate.ts so there is one implementation of the SQL
 * and the ordering. Needs DATABASE_URL to point at the target database.
 */
import { fileURLToPath } from 'node:url';
import { describeMigrations, runMigrations, pendingMigrations } from '../server/src/store/migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('migrate: DATABASE_URL is not set — point it at the target database.');
  process.exit(1);
}
const dir = fileURLToPath(new URL('../migrations', import.meta.url));
const check = process.argv.includes('--check') || process.argv.includes('--status');
const json = process.argv.includes('--json');

try {
  if (check) {
    const pending = await pendingMigrations(url, dir);
    if (json) {
      const { files, manifest } = await describeMigrations(pending, dir);
      console.log(JSON.stringify({ current: pending.length === 0, pending: files, manifest }));
      if (pending.length) process.exit(1);
    } else if (pending.length) {
      console.error(`pending (${pending.length}): ${pending.join(', ')}`);
      process.exit(1);
    } else console.log('schema current');
  } else {
    const applied = await runMigrations(url, dir);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply (schema current)');
  }
} catch (err) {
  console.error(`migrate: ${(err as Error).message}`);
  process.exit(1);
}
