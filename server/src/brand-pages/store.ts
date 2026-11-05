// SPDX-License-Identifier: MPL-2.0
/** Brand page records, in memory and in Postgres. The files live in the BlobStore. */
import { inTransaction, type RenderDatabase } from '../renders/batch-postgres.ts';
import type { BrandPageManifest } from './manifest.ts';
import type { BrandPageRecord, BrandPageRevision, BrandPageRevisionSummary, BrandPageState, BrandPageStore } from './types.ts';

const summaryOf = ({ manifest: _manifest, ...summary }: BrandPageRevision): BrandPageRevisionSummary => summary;

export function createMemoryBrandPageStore(): BrandPageStore & { brandPageRevisionsBy(userId: string): BrandPageRevisionSummary[] } {
  const pages = new Map<string, BrandPageRecord & { next: number }>();
  const revisions = new Map<string, BrandPageRevision>();
  const clone = structuredClone;
  const publicRecord = ({ next: _next, ...record }: BrandPageRecord & { next: number }): BrandPageRecord => clone(record);
  const of = (slug: string): BrandPageRevision[] => [...revisions.values()].filter(row => row.slug === slug);
  return {
    brandPageRevisionsBy: (userId) => [...revisions.values()].filter(row => row.publishedBy === userId).map(row => clone(summaryOf(row))),
    async getBrandPage(slug) {
      const page = pages.get(slug);
      return page ? publicRecord(page) : null;
    },
    async listBrandPages(limit) {
      return [...pages.values()].sort((a, b) => a.slug.localeCompare(b.slug, 'en')).slice(0, limit).map(publicRecord);
    },
    async listBrandPageRevisions(slug, limit) {
      return of(slug).sort((a, b) => b.n - a.n).slice(0, limit).map(row => clone(summaryOf(row)));
    },
    async getBrandPageRevision(slug, n) {
      const row = revisions.get(`${slug}:${n}`);
      return row ? clone(row) : null;
    },
    async stageBrandPageRevision(input) {
      const page = pages.get(input.slug) ?? { slug: input.slug, name: input.name, current: null, unpublishedAt: null, unpublishedBy: null, createdAt: input.at, updatedAt: input.at, next: 1 };
      const n = page.next++;
      page.updatedAt = input.at;
      pages.set(input.slug, page);
      const row: BrandPageRevision = {
        id: `${input.slug}:${n}`, slug: input.slug, n, name: input.name, digest: input.digest, manifest: clone(input.manifest), size: input.size, fileCount: input.fileCount,
        publishedBy: input.publishedBy, state: 'staged', approvalId: null, createdAt: input.at, liveAt: null, bytesRemovedAt: null,
      };
      revisions.set(row.id, row);
      return clone(row);
    },
    async setBrandPageRevisionState(slug, n, from, to, patch) {
      const row = revisions.get(`${slug}:${n}`);
      if (!row || !from.includes(row.state)) return false;
      row.state = to;
      if (patch?.approvalId) row.approvalId = patch.approvalId;
      return true;
    },
    async promoteBrandPageRevision(slug, n, from, at) {
      const row = revisions.get(`${slug}:${n}`), page = pages.get(slug);
      if (!row || !page || !from.includes(row.state)) return false;
      for (const other of of(slug)) if (other.state === 'live') other.state = 'superseded';
      row.state = 'live';
      row.liveAt = at;
      Object.assign(page, { name: row.name, current: n, unpublishedAt: null, unpublishedBy: null, updatedAt: at });
      return true;
    },
    async unpublishBrandPage(slug, by, at) {
      const page = pages.get(slug);
      if (!page) return null;
      if (page.current !== null) {
        for (const other of of(slug)) if (other.state === 'live') other.state = 'unpublished';
        Object.assign(page, { current: null, unpublishedAt: at, unpublishedBy: by, updatedAt: at });
      }
      return publicRecord(page);
    },
    async markBrandPageBytesRemoved(slug, n, at) {
      const row = revisions.get(`${slug}:${n}`);
      if (!row || row.bytesRemovedAt) return false;
      row.bytesRemovedAt = at;
      return true;
    },
    async brandPageBytesHeld() {
      return [...revisions.values()].filter(row => !row.bytesRemovedAt).reduce((sum, row) => sum + row.size, 0);
    },
    async listLiveBrandPageRevisions(limit) {
      return [...revisions.values()].filter(row => row.state === 'live').sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)).slice(0, limit).map(row => clone(summaryOf(row)));
    },
  };
}

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);
const recordFrom = (row: Record<string, unknown>): BrandPageRecord => ({
  slug: row.slug as string, name: row.name as string, current: row.current_n === null ? null : Number(row.current_n),
  unpublishedAt: iso(row.unpublished_at), unpublishedBy: (row.unpublished_by as string | null) ?? null,
  createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
});
const summaryFrom = (row: Record<string, unknown>): BrandPageRevisionSummary => ({
  id: row.id as string, slug: row.slug as string, n: Number(row.n), name: row.name as string, digest: row.digest as string, size: Number(row.size), fileCount: Number(row.file_count),
  publishedBy: row.published_by as string, state: row.state as BrandPageState, approvalId: (row.approval_id as string | null) ?? null,
  createdAt: iso(row.created_at)!, liveAt: iso(row.live_at), bytesRemovedAt: iso(row.bytes_removed_at),
});
const SUMMARY = 'id, slug, n, name, digest, size, file_count, published_by, state, approval_id, created_at, live_at, bytes_removed_at';

export function createPostgresBrandPageStore(pool: RenderDatabase): BrandPageStore {
  return {
    async getBrandPage(slug) {
      const { rows } = await pool.query('select * from brand_pages where slug = $1', [slug]);
      return rows[0] ? recordFrom(rows[0]) : null;
    },
    async listBrandPages(limit) {
      const { rows } = await pool.query('select * from brand_pages order by slug collate "C" limit $1', [limit]);
      return rows.map(recordFrom);
    },
    async listBrandPageRevisions(slug, limit) {
      const { rows } = await pool.query(`select ${SUMMARY} from brand_page_revisions where slug = $1 order by n desc limit $2`, [slug, limit]);
      return rows.map(summaryFrom);
    },
    async getBrandPageRevision(slug, n) {
      const { rows } = await pool.query(`select ${SUMMARY}, manifest from brand_page_revisions where slug = $1 and n = $2`, [slug, n]);
      return rows[0] ? { ...summaryFrom(rows[0]), manifest: rows[0].manifest as BrandPageManifest } : null;
    },
    async stageBrandPageRevision(input) {
      return inTransaction(pool, async (db) => {
        const page = await db.query(
          `insert into brand_pages (slug, name, next_n, created_at, updated_at) values ($1, $2, 2, $3, $3)
           on conflict (slug) do update set next_n = brand_pages.next_n + 1, updated_at = $3 returning next_n - 1 as n`, [input.slug, input.name, input.at]);
        const n = Number(page.rows[0]!.n);
        const { rows } = await db.query(
          `insert into brand_page_revisions (id, slug, n, name, digest, manifest, size, file_count, published_by, state, created_at)
           values ($1, $2, $3, $4, $5, $6::json, $7, $8, $9, 'staged', $10) returning ${SUMMARY}`,
          [`${input.slug}:${n}`, input.slug, n, input.name, input.digest, JSON.stringify(input.manifest), input.size, input.fileCount, input.publishedBy, input.at]);
        return { ...summaryFrom(rows[0]!), manifest: structuredClone(input.manifest) };
      });
    },
    async setBrandPageRevisionState(slug, n, from, to, patch) {
      const { rowCount } = await pool.query(
        'update brand_page_revisions set state = $4, approval_id = coalesce($5, approval_id) where slug = $1 and n = $2 and state = any($3::text[])',
        [slug, n, [...from], to, patch?.approvalId ?? null]);
      return (rowCount ?? 0) > 0;
    },
    async promoteBrandPageRevision(slug, n, from, at) {
      return inTransaction(pool, async (db) => {
        const page = await db.query('select slug from brand_pages where slug = $1 for update', [slug]);
        if (!page.rows.length) return false;
        const row = await db.query('select state from brand_page_revisions where slug = $1 and n = $2', [slug, n]);
        if (!row.rows[0] || !from.includes(row.rows[0].state as BrandPageState)) return false;
        await db.query(`update brand_page_revisions set state = 'superseded' where slug = $1 and state = 'live'`, [slug]);
        await db.query(`update brand_page_revisions set state = 'live', live_at = $3 where slug = $1 and n = $2`, [slug, n, at]);
        await db.query(
          `update brand_pages set name = (select name from brand_page_revisions where slug = $1 and n = $2), current_n = $2, unpublished_at = null, unpublished_by = null, updated_at = $3 where slug = $1`,
          [slug, n, at]);
        return true;
      });
    },
    async unpublishBrandPage(slug, by, at) {
      return inTransaction(pool, async (db) => {
        const page = await db.query('select * from brand_pages where slug = $1 for update', [slug]);
        if (!page.rows[0]) return null;
        if (page.rows[0].current_n === null) return recordFrom(page.rows[0]);
        await db.query(`update brand_page_revisions set state = 'unpublished' where slug = $1 and state = 'live'`, [slug]);
        const { rows } = await db.query('update brand_pages set current_n = null, unpublished_at = $2, unpublished_by = $3, updated_at = $2 where slug = $1 returning *', [slug, at, by]);
        return recordFrom(rows[0]!);
      });
    },
    async markBrandPageBytesRemoved(slug, n, at) {
      const { rowCount } = await pool.query('update brand_page_revisions set bytes_removed_at = $3 where slug = $1 and n = $2 and bytes_removed_at is null', [slug, n, at]);
      return (rowCount ?? 0) > 0;
    },
    async brandPageBytesHeld() {
      const { rows } = await pool.query('select coalesce(sum(size), 0) as total from brand_page_revisions where bytes_removed_at is null');
      return Number(rows[0]!.total);
    },
    async listLiveBrandPageRevisions(limit) {
      const { rows } = await pool.query(`select ${SUMMARY} from brand_page_revisions where state = 'live' order by slug collate "C" limit $1`, [limit]);
      return rows.map(summaryFrom);
    },
  };
}
