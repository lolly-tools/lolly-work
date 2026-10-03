/**
 * Migration runner - applies migrations/*.sql in filename order, tracked in a
 * schema_migrations table, each file in its own transaction. Boring by design.
 */
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

export async function runMigrations(databaseUrl: string, dir = './migrations'): Promise<string[]> {
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
    if (!pending.length) return applied;
    try {
      await locked(() => client.query('create table if not exists schema_migrations (name text primary key, at timestamptz not null default now())'));
    } catch (err) {
      throw new Error(`migration setup failed: ${(err as Error).message}`);
    }
    for (const file of pending) {
      const sql = await readFile(join(dir, file), 'utf8');
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
