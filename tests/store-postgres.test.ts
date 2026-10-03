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

test('a REST save keeps at most SESSION_REVISION_LIMIT revision rows on disk', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  // listSessionRevisions reads with a limit, so the bound has to be checked on
  // the table itself: without pruning on write, every PUT kept another row.
  const { SESSION_REVISION_LIMIT } = await import('../server/src/store/types.ts');
  await withFreshPostgres(url!, async (store) => {
    const owner = await store.upsertUserBySub({ sub: 'rev-bound', email: 'rev-bound@example.invalid', groups: [], role: 'member' });
    const at = new Date().toISOString();
    await store.putProject({ id: 'prj_rev', name: 'Revisions', visibility: 'private', ownerId: owner.id, createdAt: at });
    await store.putSession({
      id: 'ses_rev', projectId: 'prj_rev', toolId: 'poster', toolVersion: '1.0.0',
      inputs: {}, meta: {}, createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: at,
    });
    const total = SESSION_REVISION_LIMIT + 7;
    for (let rev = 2; rev <= total; rev++) {
      await store.appendSessionRevision({ sessionId: 'ses_rev', rev, inputs: { n: rev }, meta: {}, actor: owner.id, at });
    }
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const { rows } = await admin.query('select rev from session_revisions where session_id = $1 order by rev desc', ['ses_rev']);
      assert.equal(rows.length, SESSION_REVISION_LIMIT, 'older revisions are pruned on write');
      assert.equal(Number(rows[0].rev), total, 'the newest revision is kept');
      assert.equal(Number(rows.at(-1).rev), total - SESSION_REVISION_LIMIT + 1);
    } finally { await admin.end(); }
  });
});
