/**
 * Migration runner - applies migrations/*.sql in filename order, tracked in a
 * schema_migrations table, each file in its own transaction. Boring by design.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PG_CONNECT_TIMEOUT_MS } from './pg-options.ts';

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// Advisory-lock key for the migration critical section - distinct from
// postgres.ts's AUDIT_LOCK_KEY (0x1011_0001) and the test suites' lock
// (0x1011_0003). It is a transaction-level lock now. The session-level lock the
// runner used to take under 0x1011_0002 is not supported over a transaction
// pooler (Neon's pooled DATABASE_URL): the pooler keeps the server connection,
// and the lock with it, after the client disconnects, and every later boot
// waited for that lock without end (lolly.ing, 2026-10-03). A new key means a
// lock leaked that way by an old runner can never block this one.
const MIGRATE_LOCK_KEY = 0x1011_0004;

// Bounds for the migration session, set with SET LOCAL inside each transaction
// (a pooler drops session-level SET). Waiting for another replica's migration
// gives up after LOCK_TIMEOUT with an error instead of hanging; one statement
// of a migration may run for STATEMENT_TIMEOUT.
const LOCK_TIMEOUT = '20s';
const STATEMENT_TIMEOUT = '120s';

/** The database URL migrations run over: `DATABASE_URL_UNPOOLED` when it is set
 *  (the Neon integration on Vercel sets both, and `DATABASE_URL` is the pooled
 *  one), else `DATABASE_URL`. Neon documents schema migrations as a job for the
 *  direct connection. The store keeps using `DATABASE_URL`. */
export function migrationDatabaseUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.DATABASE_URL_UNPOOLED?.trim() || env.DATABASE_URL?.trim() || undefined;
}

/** The migration files, in apply order. */
export async function readMigrationFiles(dir = './migrations'): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
}

/** Migration files not yet recorded in schema_migrations - READ-ONLY: it issues
 *  no DDL, so it is safe to call against a pending schema (and the boot guard
 *  relies on that). An absent schema_migrations table ⇒ every migration pending. */
export async function pendingAgainst(q: Queryable, dir = './migrations'): Promise<string[]> {
  const files = await readMigrationFiles(dir);
  const { rows } = await q.query("select to_regclass('public.schema_migrations') as t");
  if (!rows[0]?.t) return files; // table absent - nothing applied yet, no DDL issued
  const done = new Set((await q.query('select name from schema_migrations')).rows.map((r) => r.name as string));
  return files.filter((f) => !done.has(f));
}

// ---------------------------------------------------------------------------
// LW_MIGRATE_EXPECT: an optional, reviewed pending set.
//
// Unset, the runner applies whatever is pending (unchanged behaviour). Set, the
// runner refuses before taking its lock or running any DDL unless the pending
// set is exactly the expected one:
//   none                 nothing may be pending
//   a.sql,b.sql          exactly these files (any order; applied in file-name order)
//   sha256:<64 hex>      exactly the files of this manifest, by name AND content
// A set-but-empty value is refused rather than read as "anything".

const MANIFEST_HEADER = 'lolly-work migration manifest v1\n';
const MIGRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.sql$/;

export type MigrateExpectation = { kind: 'names'; names: string[] } | { kind: 'manifest'; sha256: string };

export interface PendingFile {
  name: string;
  /** sha256 of the file bytes, lower-case hex. */
  sha256: string;
}

/** Parse LW_MIGRATE_EXPECT; undefined means no expectation. Throws on a malformed value. */
export function parseMigrateExpect(value: string | undefined): MigrateExpectation | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (!text) throw new Error('LW_MIGRATE_EXPECT is set but empty. Unset it, or set "none" to expect no pending migration.');
  if (text === 'none') return { kind: 'names', names: [] };
  if (text.startsWith('sha256:')) {
    if (!/^sha256:[0-9a-f]{64}$/.test(text)) throw new Error('LW_MIGRATE_EXPECT manifest must be sha256: followed by 64 lower-case hex characters.');
    return { kind: 'manifest', sha256: text.slice('sha256:'.length) };
  }
  const names = text.split(',').map(name => name.trim());
  if (names.some(name => !MIGRATION_NAME.test(name) || name.includes('..'))) {
    throw new Error('LW_MIGRATE_EXPECT must be "none", "sha256:<64 hex>" or a comma-separated list of migration file names.');
  }
  if (new Set(names).size !== names.length) throw new Error('LW_MIGRATE_EXPECT names a migration twice.');
  return { kind: 'names', names };
}

/** The manifest hash of a set of migration files: sha256 over a fixed header and
 *  one `name<TAB>sha256` line per file, in file-name order. */
export function migrationManifest(files: readonly PendingFile[]): string {
  const lines = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(file => `${file.name}\t${file.sha256}\n`).join('');
  return 'sha256:' + createHash('sha256').update(MANIFEST_HEADER + lines).digest('hex');
}

/** Names and content hashes of the given migration files, plus their manifest. */
export async function describeMigrations(names: readonly string[], dir = './migrations'): Promise<{ files: PendingFile[]; manifest: string }> {
  const files: PendingFile[] = [];
  for (const name of names) {
    files.push({ name, sha256: createHash('sha256').update(await readFile(join(dir, name))).digest('hex') });
  }
  return { files, manifest: migrationManifest(files) };
}

/** Refuse unless `pending` is exactly the expected set. For a manifest, returns
 *  each file's verified hash so the caller can run exactly those bytes. */
export async function assertExpectedPending(expect: MigrateExpectation, pending: readonly string[], dir = './migrations'): Promise<Map<string, string> | null> {
  const shown = (names: readonly string[]) => (!names.length ? 'none'
    : names.length <= 10 ? names.join(', ') : `${names.slice(0, 10).join(', ')} and ${names.length - 10} more`);
  if (expect.kind === 'names') {
    const expected = new Set(expect.names);
    const missing = expect.names.filter(name => !pending.includes(name)).sort();
    const unexpected = pending.filter(name => !expected.has(name));
    if (missing.length || unexpected.length) {
      throw new Error(`LW_MIGRATE_EXPECT refused: the pending migrations differ from the expected list `
        + `(expected but not pending: ${shown(missing)}; pending but not expected: ${shown(unexpected)}). Nothing was applied.`);
    }
    return null;
  }
  const { files, manifest } = await describeMigrations(pending, dir);
  if (manifest !== `sha256:${expect.sha256}`) {
    throw new Error(`LW_MIGRATE_EXPECT refused: the pending migrations (${shown(pending)}) have manifest ${manifest}, `
      + `not the expected sha256:${expect.sha256}. Nothing was applied.`);
  }
  return new Map(files.map(file => [file.name, file.sha256]));
}

type MigrationClient = Queryable & { connect(): Promise<void>; end(): Promise<void> };

async function connectClient(databaseUrl: string): Promise<MigrationClient> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS }) as unknown as MigrationClient;
  await client.connect();
  return client;
}

/** Read-only pending-migration check over its own short-lived connection - the
 *  boot guard (LW_AUTO_MIGRATE=false) and `lw migrate --check` use this. */
export async function pendingMigrations(databaseUrl: string, dir = './migrations'): Promise<string[]> {
  const client = await connectClient(databaseUrl);
  try {
    return await pendingAgainst(client, dir);
  } finally {
    await client.end();
  }
}

/** Apply the pending migrations. When `env.LW_MIGRATE_EXPECT` is set, refuse
 *  (before any DDL or lock) unless the pending set is exactly the expected one. */
export async function runMigrations(databaseUrl: string, dir = './migrations',
  env: Record<string, string | undefined> = process.env): Promise<string[]> {
  // A malformed expectation fails before any connection is opened.
  const expectation = parseMigrateExpect(env.LW_MIGRATE_EXPECT);
  const client = await connectClient(databaseUrl);
  const applied: string[] = [];
  // One transaction holding the migration lock. Two replicas booting together
  // serialize here: the loser waits, then finds the file already recorded. The
  // lock ends with the transaction, so nothing outlives it on a pooled
  // connection either.
  const locked = async <T>(work: () => Promise<T>): Promise<T> => {
    await client.query('begin');
    try {
      await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
      await client.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await client.query('select pg_advisory_xact_lock($1)', [MIGRATE_LOCK_KEY]);
      const result = await work();
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    }
  };
  try {
    // Read-only first: a current schema costs two queries and takes no lock.
    const pending = await pendingAgainst(client, dir);
    // The loop below applies only names from `pending`, so checking it here
    // means nothing outside the expected set is ever applied.
    const verified = expectation ? await assertExpectedPending(expectation, pending, dir) : null;
    if (!pending.length) return applied;
    try {
      await locked(() => client.query('create table if not exists schema_migrations (name text primary key, at timestamptz not null default now())'));
    } catch (err) {
      throw new Error(`migration setup failed: ${(err as Error).message}`);
    }
    for (const file of pending) {
      const bytes = await readFile(join(dir, file));
      if (verified && createHash('sha256').update(bytes).digest('hex') !== verified.get(file)) {
        throw new Error(`migration ${file} changed after LW_MIGRATE_EXPECT was checked; it was not applied`);
      }
      const sql = bytes.toString('utf8');
      try {
        const ran = await locked(async () => {
          // Re-read under the lock: another replica may have applied it meanwhile.
          const { rows } = await client.query('select 1 from schema_migrations where name = $1', [file]);
          if (rows.length) return false;
          await client.query(sql);
          await client.query('insert into schema_migrations (name) values ($1)', [file]);
          return true;
        });
        if (ran) applied.push(file);
      } catch (err) {
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}
