/**
 * Migration runner - applies migrations/*.sql in filename order, tracked in a
 * schema_migrations table, each file in its own transaction. Boring by design.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

// Advisory-lock key for the migration critical section - distinct from
// postgres.ts's AUDIT_LOCK_KEY (0x1011_0001) so the two never collide.
const MIGRATE_LOCK_KEY = 0x1011_0002;

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

/** Read-only pending-migration check over its own short-lived connection - the
 *  boot guard (LW_AUTO_MIGRATE=false) and `lw migrate --check` use this. */
export async function pendingMigrations(databaseUrl: string, dir = './migrations'): Promise<string[]> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl }) as unknown as Queryable & {
    connect(): Promise<void>;
    end(): Promise<void>;
  };
  await client.connect();
  try {
    return await pendingAgainst(client, dir);
  } finally {
    await client.end();
  }
}

export async function runMigrations(databaseUrl: string, dir = './migrations'): Promise<string[]> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: databaseUrl }) as unknown as Queryable & {
    connect(): Promise<void>;
    end(): Promise<void>;
  };
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('create table if not exists schema_migrations (name text primary key, at timestamptz not null default now())');
    // Serialize concurrent auto-migrate boots (two replicas racing the same DDL):
    // the loser waits here, then finds the files already applied. Released with
    // the session on client.end() in the finally.
    await client.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    const done = new Set(
      (await client.query('select name from schema_migrations')).rows.map((r) => r.name as string),
    );
    const files = await readMigrationFiles(dir);
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}
