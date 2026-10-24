// SPDX-License-Identifier: MPL-2.0
// Restore rehearsal, migrate step. Runs in the NEW Work image with only
// DATABASE_URL, LW_MIGRATE_EXPECT and NODE_ENV in its environment, the same
// environment the live migrate Job gets. It runs the image's own runner
// (scripts/migrate.ts) against the restored copy and records when it ended,
// so the verify step can time the last file.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROGRAMS = process.env.REHEARSAL_PROGRAMS ?? '/programs';
const APP = process.env.REHEARSAL_APP ?? '/app';
const EVIDENCE = process.env.REHEARSAL_EVIDENCE ?? '/evidence';

const out = value => process.stdout.write(JSON.stringify({ step: 'migrate', ...value }) + '\n');
const fail = (reason, extra = {}) => { out({ status: 'FAILED', reason, ...extra }); process.exit(1); };

const pending = JSON.parse(readFileSync(join(PROGRAMS, 'pending.json'), 'utf8'));
const budget = Number(readFileSync(join(PROGRAMS, 'lock-budget-seconds'), 'utf8').trim());
const { DATABASE_URL, LW_MIGRATE_EXPECT } = process.env;
if (!DATABASE_URL || !LW_MIGRATE_EXPECT) fail('DATABASE_URL and LW_MIGRATE_EXPECT are required');

// An image whose runner predates LW_MIGRATE_EXPECT would ignore it.
let runner = '';
try {
  runner = readFileSync(join(APP, 'server/src/store/migrate.ts'), 'utf8');
} catch {
  fail('the image has no migration runner');
}
if (!runner.includes('LW_MIGRATE_EXPECT')) fail('MIGRATE_EXPECT_UNSUPPORTED: the new image predates LW_MIGRATE_EXPECT');

// The image must carry exactly the files that were classified and approved.
for (const { name, sha256 } of pending) {
  let bytes;
  try {
    bytes = readFileSync(join(APP, 'migrations', name));
  } catch {
    fail(`IMAGE_FILE_MISMATCH: the image has no ${name}`);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) fail(`IMAGE_FILE_MISMATCH: the image's ${name} differs`);
}

const startedAt = new Date();
const run = spawnSync(process.execPath, [join(APP, 'scripts/migrate.ts')], {
  cwd: APP, encoding: 'utf8', maxBuffer: 1 << 20,
  timeout: (budget * Math.max(pending.length, 1) + 120) * 1000,
  env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', DATABASE_URL, LW_MIGRATE_EXPECT,
    NODE_ENV: process.env.NODE_ENV ?? 'production' },
});
const endedAt = new Date();
writeFileSync(join(EVIDENCE, 'migrate-ended-at'), endedAt.toISOString() + '\n', { flag: 'wx', mode: 0o600 });

const stdout = run.stdout ?? '';
const stderr = run.stderr ?? '';
const applied = /^applied: (.+)$/m.exec(stdout)?.[1]?.split(', ') ?? [];
const result = {
  startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), exitCode: run.status, signal: run.signal,
  applied, stdout: stdout.slice(-2048), stderr: stderr.slice(-2048),
};
if (run.error || run.status !== 0) {
  // A file cut off at the lock budget shows here only as a dropped connection;
  // the driver confirms it from the PostgreSQL sidecar's log.
  fail(/LW_MIGRATE_EXPECT refused/.test(stderr) ? 'MIGRATE_REFUSED' : 'MIGRATE_FAILED', result);
}
const wanted = pending.map(file => file.name).sort();
if (JSON.stringify([...applied].sort()) !== JSON.stringify(wanted)) fail('MIGRATE_FAILED: the runner applied a different set', result);
out({ status: 'APPLIED', ...result });
