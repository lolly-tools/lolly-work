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

import {
  assertExpectedPending, describeMigrations, migrationDatabaseUrl, migrationManifest, parseMigrateExpect,
  readMigrationFiles, runMigrations,
} from '../server/src/store/migrate.ts';

test('LW_MIGRATE_EXPECT parses to a names list, a manifest, or nothing', () => {
  assert.equal(parseMigrateExpect(undefined), null, 'unset keeps the runner as it was');
  assert.deepEqual(parseMigrateExpect('none'), { kind: 'names', names: [] });
  assert.deepEqual(parseMigrateExpect(' 0002_b.sql, 0001_a.sql '), { kind: 'names', names: ['0002_b.sql', '0001_a.sql'] });
  assert.deepEqual(parseMigrateExpect('sha256:' + 'a'.repeat(64)), { kind: 'manifest', sha256: 'a'.repeat(64) });
  for (const bad of ['', '  ', 'sha256:' + 'A'.repeat(64), 'sha256:abc', '0001_a.sql,', '../0001_a.sql', 'a/b.sql',
    '0001_a', '0001_a.sql,0001_a.sql', 'all', 'NONE']) {
    assert.throws(() => parseMigrateExpect(bad), /LW_MIGRATE_EXPECT/, JSON.stringify(bad));
  }
});

test('the manifest hash binds names and contents, in file-name order', () => {
  // The same vector is checked by deploy/preview's Python copy of this function.
  const files = [{ name: '0002_b.sql', sha256: 'b'.repeat(64) }, { name: '0001_a.sql', sha256: 'a'.repeat(64) }];
  assert.equal(migrationManifest(files), 'sha256:1cc3157ffa8c6643215d3e0aaafda8169a39da8775fd024c428c1aa69def7fe1');
  assert.equal(migrationManifest([]), 'sha256:82dd7937e974dabb4422978e047da44cb3ab19ab94b3486ea3336adf6c424735');
  assert.notEqual(migrationManifest([{ name: '0001_a.sql', sha256: 'c'.repeat(64) }, files[0]!]), migrationManifest(files));
});

test('the expectation must equal the pending set exactly', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lw-expect-'));
  try {
    await writeFile(join(dir, '0001_a.sql'), 'create table a (id int);');
    await writeFile(join(dir, '0002_b.sql'), 'create table b (id int);');
    const pending = ['0001_a.sql', '0002_b.sql'];
    await assertExpectedPending({ kind: 'names', names: ['0002_b.sql', '0001_a.sql'] }, pending, dir);
    await assert.rejects(assertExpectedPending({ kind: 'names', names: ['0001_a.sql'] }, pending, dir),
      /pending but not expected: 0002_b\.sql/);
    await assert.rejects(assertExpectedPending({ kind: 'names', names: [...pending, '0003_c.sql'] }, pending, dir),
      /expected but not pending: 0003_c\.sql/);
    await assert.rejects(assertExpectedPending({ kind: 'names', names: [] }, pending, dir), /Nothing was applied/);
    await assertExpectedPending({ kind: 'names', names: [] }, [], dir);
    const { manifest, files } = await describeMigrations(pending, dir);
    assert.equal(files.length, 2);
    await assertExpectedPending({ kind: 'manifest', sha256: manifest.slice(7) }, pending, dir);
    await assert.rejects(assertExpectedPending({ kind: 'manifest', sha256: manifest.slice(7) }, ['0001_a.sql'], dir), /manifest/);
    // Same names, different bytes: the manifest refuses.
    await writeFile(join(dir, '0002_b.sql'), 'create table b (id int); drop table a;');
    await assert.rejects(assertExpectedPending({ kind: 'manifest', sha256: manifest.slice(7) }, pending, dir), /not the expected/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed LW_MIGRATE_EXPECT refuses before any connection is opened', async () => {
  // The URL points nowhere; the parse error must come first.
  await assert.rejects(runMigrations('postgres://127.0.0.1:1/none', './migrations', { LW_MIGRATE_EXPECT: '' }), /set but empty/);
  await assert.rejects(runMigrations('postgres://127.0.0.1:1/none', './migrations', { LW_MIGRATE_EXPECT: 'everything' }), /LW_MIGRATE_EXPECT must be/);
});

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

test('LW_MIGRATE_EXPECT: the runner applies exactly the expected set and refuses any other', { skip }, async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'lw-migrate-expect-'));
  try {
    await writeFile(join(dir, '0001_ok.sql'), 'create table expect_a (id int);');
    await writeFile(join(dir, '0002_next.sql'), 'create table expect_b (id int);');
    await withEmptySchema(async (admin) => {
      const nothingApplied = async () => {
        const { rows } = await admin.query("select to_regclass('public.schema_migrations') as ledger, to_regclass('public.expect_a') as a");
        assert.equal(rows[0].ledger, null, 'no ledger table was created');
        assert.equal(rows[0].a, null, 'no migration ran');
      };
      await assert.rejects(runMigrations(pgUrl!, dir, { LW_MIGRATE_EXPECT: '0001_ok.sql' }), /pending but not expected: 0002_next\.sql/);
      await nothingApplied();
      await assert.rejects(runMigrations(pgUrl!, dir, { LW_MIGRATE_EXPECT: 'sha256:' + '0'.repeat(64) }), /not the expected/);
      await nothingApplied();
      const { manifest } = await describeMigrations(['0001_ok.sql', '0002_next.sql'], dir);
      assert.deepEqual(await runMigrations(pgUrl!, dir, { LW_MIGRATE_EXPECT: manifest }), ['0001_ok.sql', '0002_next.sql']);
      assert.deepEqual(await runMigrations(pgUrl!, dir, { LW_MIGRATE_EXPECT: 'none' }), [], 'nothing pending matches none');
      await assert.rejects(runMigrations(pgUrl!, dir, { LW_MIGRATE_EXPECT: manifest }), /not the expected/,
        'a reused expectation refuses once its files are applied');
      await writeFile(join(dir, '0003_more.sql'), 'create table expect_c (id int);');
      assert.deepEqual(await runMigrations(pgUrl!, dir, {}), ['0003_more.sql'], 'unset applies whatever is pending, as before');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
