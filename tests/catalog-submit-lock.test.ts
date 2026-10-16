// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

test('admission claims exclude concurrent copies, release on completion and permit independent sources', async () => {
  const store = createMemoryStore(), release = await store.claimCatalogSubmission('person:project:file:hash');
  assert.ok(release); assert.equal(await store.claimCatalogSubmission('person:project:file:hash'), null);
  const other = await store.claimCatalogSubmission('person:project:another:hash'); assert.ok(other); await other();
  await release(); const retry = await store.claimCatalogSubmission('person:project:file:hash'); assert.ok(retry); await retry();
});

test('Postgres admission claims serialize across separate pools and release their transaction lock', { skip: process.env.LW_TEST_DATABASE_URL ? false : 'set LW_TEST_DATABASE_URL to run' }, async () => {
  const first = await createPostgresStore(process.env.LW_TEST_DATABASE_URL!), second = await createPostgresStore(process.env.LW_TEST_DATABASE_URL!);
  const key = `test:${crypto.randomUUID()}`;
  try {
    const release = await first.claimCatalogSubmission(key); assert.ok(release);
    assert.equal(await second.claimCatalogSubmission(key), null);
    await release();
    const retry = await second.claimCatalogSubmission(key); assert.ok(retry); await retry();
  } finally { await first.close(); await second.close(); }
});

test('pending project admissions leave database reads available', { skip: process.env.LW_TEST_DATABASE_URL ? false : 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
    const releases: Array<() => Promise<void>> = [];
    try {
      // Ten admissions fill the default pg pool. Their work still needs record
      // queries before it can finish and release the claims.
      for (let i = 0; i < 10; i++) {
        const release = await store.claimCatalogSubmission(`pending:${crypto.randomUUID()}`);
        assert.ok(release);
        releases.push(release);
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          store.listInstanceAssets(),
          new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('admissions exhausted the record pool')), 3000); }),
        ]);
      } finally { clearTimeout(timeout); }
    } finally { await Promise.all(releases.map(release => release())); }
  });
});
