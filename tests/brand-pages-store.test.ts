// SPDX-License-Identifier: MPL-2.0
/** The brand page record store behaves the same in memory and in Postgres. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBrandPageStore } from '../server/src/brand-pages/store.ts';
import type { BrandPageManifest } from '../server/src/brand-pages/manifest.ts';
import type { BrandPageStore } from '../server/src/brand-pages/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const manifest = (id: string): BrandPageManifest => ({
  version: 1, id, name: `${id} brand`, revision: `sha256:${'a'.repeat(64)}`, generator: { name: 'lolly', engine: '1.308.0', designMd: 'alpha' },
  colourways: [{ id: 'day', name: 'Day', modes: ['light'] }], files: [{ path: 'index.html', role: 'page', mediaType: 'text/html', sha256: 'b'.repeat(64), size: 5 }], held: [],
  checks: { file: 'checks.json', variants: 0, pairs: 0, pairsBelow3: 0, rules: 0, rulesWithFindings: 0 }, digest: 'c'.repeat(64),
});
const stage = (store: BrandPageStore, slug: string, at: string, size = 10) =>
  store.stageBrandPageRevision({ slug, name: `${slug} brand`, digest: `${at.slice(0, 4)}${'d'.repeat(60)}`, manifest: manifest(slug), size, fileCount: 1, publishedBy: 'usr_a', at });

async function conformance(store: BrandPageStore): Promise<void> {
  assert.equal(await store.getBrandPage('acme'), null);
  const first = await stage(store, 'acme', '2026-11-05T00:00:00.000Z');
  assert.equal(first.n, 1);
  assert.equal(first.id, 'acme:1');
  assert.equal(first.state, 'staged');
  assert.equal(first.manifest.id, 'acme');
  const page = await store.getBrandPage('acme');
  assert.deepEqual({ current: page!.current, unpublishedAt: page!.unpublishedAt, createdAt: page!.createdAt }, { current: null, unpublishedAt: null, createdAt: '2026-11-05T00:00:00.000Z' });
  assert.deepEqual(await store.listLiveBrandPageRevisions(10), [], 'a staged revision is not live');

  assert.equal(await store.setBrandPageRevisionState('acme', 1, ['pending'], 'failed'), false, 'only from a stated state');
  assert.equal(await store.promoteBrandPageRevision('acme', 1, ['pending'], '2026-11-05T01:00:00.000Z'), false);
  assert.equal(await store.promoteBrandPageRevision('acme', 1, ['staged'], '2026-11-05T01:00:00.000Z'), true);
  assert.equal((await store.getBrandPage('acme'))!.current, 1);
  assert.equal((await store.getBrandPageRevision('acme', 1))!.liveAt, '2026-11-05T01:00:00.000Z');

  const second = await stage(store, 'acme', '2026-11-05T02:00:00.000Z');
  assert.equal(second.n, 2);
  assert.equal(await store.setBrandPageRevisionState('acme', 2, ['staged'], 'pending', { approvalId: 'apr_1' }), true);
  assert.equal((await store.getBrandPageRevision('acme', 2))!.approvalId, 'apr_1');
  assert.equal((await store.getBrandPage('acme'))!.current, 1, 'a pending revision changes nothing that is served');
  assert.equal(await store.promoteBrandPageRevision('acme', 2, ['pending'], '2026-11-05T03:00:00.000Z'), true);
  assert.equal((await store.getBrandPageRevision('acme', 1))!.state, 'superseded');
  assert.equal((await store.getBrandPage('acme'))!.current, 2);
  assert.deepEqual((await store.listBrandPageRevisions('acme', 10)).map(row => [row.n, row.state]), [[2, 'live'], [1, 'superseded']]);
  assert.equal('manifest' in (await store.listBrandPageRevisions('acme', 10))[0]!, false);

  await stage(store, 'beta', '2026-11-05T04:00:00.000Z');
  await store.promoteBrandPageRevision('beta', 1, ['staged'], '2026-11-05T04:00:00.000Z');
  assert.deepEqual((await store.listLiveBrandPageRevisions(10)).map(row => row.id), ['acme:2', 'beta:1']);
  assert.deepEqual((await store.listBrandPages(10)).map(row => row.slug), ['acme', 'beta']);
  assert.equal(await store.brandPageBytesHeld(), 30);
  assert.equal(await store.markBrandPageBytesRemoved('acme', 1, '2026-11-05T05:00:00.000Z'), true);
  assert.equal(await store.markBrandPageBytesRemoved('acme', 1, '2026-11-05T05:00:00.000Z'), false, 'once');
  assert.equal(await store.brandPageBytesHeld(), 20);

  const down = await store.unpublishBrandPage('acme', 'usr_b', '2026-11-05T06:00:00.000Z');
  assert.deepEqual({ current: down!.current, at: down!.unpublishedAt, by: down!.unpublishedBy }, { current: null, at: '2026-11-05T06:00:00.000Z', by: 'usr_b' });
  assert.equal((await store.getBrandPageRevision('acme', 2))!.state, 'unpublished');
  assert.deepEqual((await store.listLiveBrandPageRevisions(10)).map(row => row.id), ['beta:1']);
  const again = await store.unpublishBrandPage('acme', 'usr_c', '2026-11-05T07:00:00.000Z');
  assert.equal(again!.unpublishedBy, 'usr_b', 'a page with nothing live stays as it is');
  assert.equal(await store.unpublishBrandPage('missing', 'usr_b', '2026-11-05T07:00:00.000Z'), null);

  const third = await stage(store, 'acme', '2026-11-05T08:00:00.000Z');
  assert.equal(third.n, 3, 'numbers are never reused');
  assert.equal(await store.promoteBrandPageRevision('acme', 3, ['staged'], '2026-11-05T09:00:00.000Z'), true);
  const back = await store.getBrandPage('acme');
  assert.deepEqual({ current: back!.current, at: back!.unpublishedAt, by: back!.unpublishedBy }, { current: 3, at: null, by: null });
  assert.equal((await store.getBrandPageRevision('acme', 2))!.state, 'unpublished', 'a revision that was taken down stays that way');
}

test('memory: revisions, promotion, unpublish and bytes', () => conformance(createMemoryBrandPageStore()));

test('postgres: the same, and the manifest keeps its publisher\'s order', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  const url = process.env.LW_TEST_DATABASE_URL!;
  await withFreshPostgres(url, async (store) => {
    await conformance(store);
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query(`select manifest::text as text from brand_page_revisions where id = 'acme:1'`);
      const text = rows[0].text as string;
      assert.ok(text.indexOf('"version"') < text.indexOf('"checks"'), 'json, not jsonb, which would sort the keys');
      const check = await client.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'uploads_scope_check'`);
      assert.match(check.rows[0].def as string, /brand-page/);
    } finally { await client.end(); }
  });
});
