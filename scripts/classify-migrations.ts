// SPDX-License-Identifier: MPL-2.0
/**
 * Classify migration files as `additive` or `maintenance` with the allowlist in
 * server/src/store/migration-classifier.ts. It reads files only; it never
 * connects to a database.
 *
 *   node scripts/classify-migrations.ts                       every file, one line each
 *   node scripts/classify-migrations.ts --only a.sql,b.sql    only these files (for example the pending set)
 *   node scripts/classify-migrations.ts --json                JSON for a build manifest or a deploy tool
 *   node scripts/classify-migrations.ts --fail-on-maintenance exit 2 when any listed file is maintenance
 *   node scripts/classify-migrations.ts --dir <path>          another migrations directory
 *
 * With --only, the JSON also carries the manifest hash of those files, the
 * value LW_MIGRATE_EXPECT accepts to bind the runner to exactly them.
 */
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyMigrations } from '../server/src/store/migration-classifier.ts';
import { migrationManifest } from '../server/src/store/migrate.ts';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    only: { type: 'string' },
    json: { type: 'boolean', default: false },
    'fail-on-maintenance': { type: 'boolean', default: false },
  },
  strict: true,
});

const dir = values.dir ?? fileURLToPath(new URL('../migrations', import.meta.url));
const only = values.only === undefined ? undefined
  : values.only.trim() === 'none' ? [] : values.only.split(',').map(name => name.trim()).filter(Boolean);

try {
  const verdicts = await classifyMigrations(dir, only);
  const maintenance = verdicts.filter(v => v.class === 'maintenance');
  if (values.json) {
    const body = {
      version: 1,
      migrations: verdicts.map(({ name, sha256, class: cls, reasons, statements }) => ({ name, sha256, class: cls, reasons, statements })),
      ...(only ? { manifest: migrationManifest(verdicts) } : {}),
    };
    process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  } else {
    for (const v of verdicts) {
      console.log(`${v.class.padEnd(11)} ${v.name}`);
      for (const reason of v.reasons) console.log(`            ${reason}`);
    }
    console.log(`${verdicts.length - maintenance.length} additive, ${maintenance.length} maintenance`);
    if (only) console.log(`manifest ${migrationManifest(verdicts)}`);
  }
  if (values['fail-on-maintenance'] && maintenance.length) process.exit(2);
} catch (err) {
  console.error(`classify-migrations: ${(err as Error).message}`);
  process.exit(1);
}
