/**
 * Gated: needs a disposable Postgres. Run with e.g.
 *   docker run --rm -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:17-alpine
 *   LW_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres npm test
 * The suite creates its own schema per run (drops first) via the migrations
 * runner - see tests/pg-test-schema.ts, which also keeps the several gated pg
 * suites from dropping the schema out from under each other.
 */
import { test } from 'node:test';
import { withFreshPostgres } from './pg-test-schema.ts';
import { runStoreConformance } from './store-conformance.ts';

const url = process.env.LW_TEST_DATABASE_URL;

test('postgres store passes the conformance suite', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(url as string, runStoreConformance);
});
