import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { checkBrandState } from './brand-state-conformance.ts';

test('memory brand decisions use a fenced revision and one audit commit', async () => {
  await checkBrandState(createMemoryStore());
});
const url = process.env.LW_TEST_DATABASE_URL;
test('Postgres brand decisions survive restart and are shared between replicas', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url!, async store => {
    await checkBrandState(store);
    const replica = await createPostgresStore(url!);
    try {
      const saved = await replica.getBrandState();
      assert.equal(saved.download.suppressed, true);
      assert.equal(saved.activeSource, 'profile:alpha');
      assert.equal(saved.revision, 1);
      assert.deepEqual(saved.retired, ['profile:beta']);
      const { default: pg } = await import('pg');
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      try {
        await admin.query(`create function fail_brand_audit() returns trigger language plpgsql as $$
          begin raise exception 'synthetic audit failure'; end $$;
          create trigger fail_brand_audit before insert on audit_log for each row execute function fail_brand_audit();`);
        await assert.rejects(replica.casBrandState(1, { ...saved, activeSource: 'profile:beta' }, {
          at: new Date().toISOString(), actor: 'test:owner', action: 'brand.select', subject: 'profile:beta',
        }), /synthetic audit failure/);
        assert.equal((await store.getBrandState()).revision, 1, 'state rolls back when audit fails');
      } finally { await admin.end(); }
    } finally { await replica.close(); }
  });
});
