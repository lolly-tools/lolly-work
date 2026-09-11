/**
 * Gated: needs a disposable Postgres. Run with e.g.
 *   docker run --rm -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:17-alpine
 *   LW_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres pnpm test
 * The suite creates its own schema per run (drops first) via the migrations
 * runner - see tests/pg-test-schema.ts, which also keeps the several gated pg
 * suites from dropping the schema out from under each other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withFreshPostgres } from './pg-test-schema.ts';
import { runStoreConformance } from './store-conformance.ts';

const url = process.env.LW_TEST_DATABASE_URL;

test('postgres store passes the conformance suite', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url as string, runStoreConformance);
});

test('account erasure rolls identity deletion back if telemetry scrubbing fails', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url!, async (store) => {
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const target = await store.upsertUserBySub({ sub: 'rollback-subject', email: 'synthetic@example.invalid', groups: [], role: 'member' });
      await store.putEvents([{ at: new Date().toISOString(), event: 'tool.open', attrs: {}, userId: target.id }]);
      await admin.query(`create function fail_test_telemetry_update() returns trigger language plpgsql as $$
        begin raise exception 'synthetic scrub failure'; end $$;
        create trigger fail_test_telemetry before update on telemetry_events for each row execute function fail_test_telemetry_update();`);
      await assert.rejects(store.eraseUserAccount(target.id), /synthetic scrub failure/);
      assert.ok(await store.getUser(target.id), 'identity deletion rolled back');
      assert.equal((await store.listEvents())[0]?.userId, target.id, 'attribution preserved');
    } finally { await admin.end(); }
  });
});
