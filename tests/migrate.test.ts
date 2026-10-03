// SPDX-License-Identifier: MPL-2.0
/**
 * The migration runner (server/src/store/migrate.ts) after the lolly.ing boot
 * hang of 2026-10-03: migrations run over the direct database URL when one is
 * given, the lock is a transaction lock (so a transaction pooler cannot keep it
 * after the client leaves), and a session lock leaked under the old key does
 * not block a boot. The Postgres cases need LW_TEST_DATABASE_URL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrationDatabaseUrl, readMigrationFiles, runMigrations } from '../server/src/store/migrate.ts';

test('migrations prefer DATABASE_URL_UNPOOLED and fall back to DATABASE_URL', () => {
  assert.equal(migrationDatabaseUrl({ DATABASE_URL: 'postgres://pooled', DATABASE_URL_UNPOOLED: 'postgres://direct' }), 'postgres://direct');
  assert.equal(migrationDatabaseUrl({ DATABASE_URL: 'postgres://only' }), 'postgres://only');
  assert.equal(migrationDatabaseUrl({ DATABASE_URL: ' postgres://only ', DATABASE_URL_UNPOOLED: '  ' }), 'postgres://only');
  assert.equal(migrationDatabaseUrl({}), undefined);
});

const pgUrl = process.env.LW_TEST_DATABASE_URL;
const skip = !pgUrl && 'set LW_TEST_DATABASE_URL to run';

/** A fresh `public` schema under the suites' shared lock (tests/pg-test-schema.ts
 *  SUITE_LOCK_KEY), held for the whole body. */
async function withEmptySchema(body: (admin: import('pg').Client) => Promise<void>): Promise<void> {
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  try {
    await admin.query('select pg_advisory_lock($1)', [0x1011_0003]);
    await admin.query('drop schema public cascade; create schema public;');
    await body(admin);
  } finally {
    await admin.end();
  }
}

test('two boots migrating at once apply every file exactly once', { skip }, async () => {
  await withEmptySchema(async (admin) => {
    const files = await readMigrationFiles();
    const [a, b] = await Promise.all([runMigrations(pgUrl!), runMigrations(pgUrl!)]);
    assert.deepEqual([...a, ...b].sort(), files, 'each file applied by exactly one of them');
    const { rows } = await admin.query('select count(*)::int as n from schema_migrations');
    assert.equal(rows[0].n, files.length);
    assert.deepEqual(await runMigrations(pgUrl!), [], 'a current schema applies nothing');
  });
});

test('a session lock leaked under the old migration key does not block a boot', { skip }, async () => {
  await withEmptySchema(async () => {
    const { default: pg } = await import('pg');
    // What a transaction pooler left behind: a server connection still holding
    // the session-level lock the old runner took (0x1011_0002).
    const leak = new pg.Client({ connectionString: pgUrl });
    await leak.connect();
    try {
      await leak.query('select pg_advisory_lock($1)', [0x1011_0002]);
      const started = Date.now();
      const applied = await runMigrations(pgUrl!);
      assert.equal(applied.length, (await readMigrationFiles()).length);
      assert.ok(Date.now() - started < 15_000, 'no wait on the leaked lock');
    } finally {
      await leak.end();
    }
  });
});

test('no migration lock outlives the runner', { skip }, async () => {
  await withEmptySchema(async (admin) => {
    await runMigrations(pgUrl!);
    const { rows } = await admin.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = $1", [0x1011_0004]);
    assert.equal(rows[0].n, 0);
  });
});

test('a migration that fails is rolled back and named', { skip }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lw-migrate-'));
  try {
    await writeFile(join(dir, '0001_ok.sql'), 'create table migrate_ok (id int);');
    await writeFile(join(dir, '0002_bad.sql'), 'create table migrate_bad (id int); select * from no_such_table;');
    await withEmptySchema(async (admin) => {
      await assert.rejects(runMigrations(pgUrl!, dir), /migration 0002_bad\.sql failed/);
      const { rows } = await admin.query("select to_regclass('public.migrate_ok') as ok, to_regclass('public.migrate_bad') as bad");
      assert.ok(rows[0].ok, 'the good file stays applied');
      assert.equal(rows[0].bad, null, 'the failed file left nothing behind');
      assert.deepEqual((await admin.query('select name from schema_migrations')).rows.map((r) => r.name), ['0001_ok.sql']);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
