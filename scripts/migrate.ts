/**
 * Explicit migration runner - the infra path for HA deploys where the server
 * runs with LW_AUTO_MIGRATE=false and refuses to start on a pending schema.
 *
 *   npm run migrate           apply pending migrations
 *   npm run migrate:status     report pending migrations (exit 1 if any), no DDL
 *
 * Reuses server/src/store/migrate.ts so there is one implementation of the SQL
 * and the ordering. Needs DATABASE_URL to point at the target database.
 */
import { fileURLToPath } from 'node:url';
import { runMigrations, pendingMigrations } from '../server/src/store/migrate.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('migrate: DATABASE_URL is not set — point it at the target database.');
  process.exit(1);
}
const dir = fileURLToPath(new URL('../migrations', import.meta.url));
const check = process.argv.includes('--check') || process.argv.includes('--status');

try {
  if (check) {
    const pending = await pendingMigrations(url, dir);
    if (pending.length) {
      console.error(`pending (${pending.length}): ${pending.join(', ')}`);
      process.exit(1);
    }
    console.log('schema current');
  } else {
    const applied = await runMigrations(url, dir);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'nothing to apply (schema current)');
  }
} catch (err) {
  console.error(`migrate: ${(err as Error).message}`);
  process.exit(1);
}
