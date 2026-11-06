// SPDX-License-Identifier: MPL-2.0
/** History of a manager's edits, in memory and in Postgres. The documents live in the
 *  BlobStore, and which revision is live is a pointer in the brand state. */
import { inTransaction, type RenderDatabase } from '../renders/batch-postgres.ts';
import type { BrandEditChange } from './edit-document.ts';

/** `staged` while its bytes are stored. `pending` waits on an approval chain. `live` is
 *  in force. `superseded` was replaced and `rolled-back` was dropped by a person.
 *  `rejected` and `withdrawn` never went live. `failed` never finished. */
export type BrandEditState = 'staged' | 'pending' | 'live' | 'superseded' | 'rolled-back' | 'rejected' | 'withdrawn' | 'failed';

export interface BrandEditRevisionSummary {
  id: string;
  sourceId: string;
  n: number;
  digest: string;
  baseChecksum: string;
  changeCount: number;
  size: number;
  sentBy: string;
  state: BrandEditState;
  approvalId: string | null;
  restoredFrom: number | null;
  createdAt: string;
  liveAt: string | null;
  endedAt: string | null;
  endedBy: string | null;
}
export interface BrandEditRevision extends BrandEditRevisionSummary { changes: BrandEditChange[] }
export interface BrandEditPatch { approvalId?: string; liveAt?: string; endedAt?: string; endedBy?: string }

export interface BrandEditStore {
  /** Newest first. */
  listBrandEditRevisions(sourceId: string, limit: number): Promise<BrandEditRevisionSummary[]>;
  getBrandEditRevision(sourceId: string, n: number): Promise<BrandEditRevision | null>;
  /** Assigns the next number for the source. */
  addBrandEditRevision(input: { sourceId: string; digest: string; baseChecksum: string; changes: BrandEditChange[]; size: number; sentBy: string; restoredFrom?: number; at: string }): Promise<BrandEditRevision>;
  /** Moves a revision between states; false when it was not in one of `from`. */
  setBrandEditRevisionState(sourceId: string, n: number, from: readonly BrandEditState[], to: BrandEditState, patch?: BrandEditPatch): Promise<boolean>;
}

const rowId = (sourceId: string, n: number): string => `${sourceId}#${n}`;

export function createMemoryBrandEditStore(): BrandEditStore & { brandEditRevisionsBy(userId: string): BrandEditRevisionSummary[] } {
  const rows = new Map<string, BrandEditRevision>();
  const summary = ({ changes: _changes, ...row }: BrandEditRevision): BrandEditRevisionSummary => structuredClone(row);
  return {
    brandEditRevisionsBy: userId => [...rows.values()].filter(row => row.sentBy === userId).map(summary),
    async listBrandEditRevisions(sourceId, limit) {
      return [...rows.values()].filter(row => row.sourceId === sourceId).sort((a, b) => b.n - a.n).slice(0, limit).map(summary);
    },
    async getBrandEditRevision(sourceId, n) {
      const row = rows.get(rowId(sourceId, n));
      return row ? structuredClone(row) : null;
    },
    async addBrandEditRevision(input) {
      const n = Math.max(0, ...[...rows.values()].filter(row => row.sourceId === input.sourceId).map(row => row.n)) + 1;
      const row: BrandEditRevision = {
        id: rowId(input.sourceId, n), sourceId: input.sourceId, n, digest: input.digest, baseChecksum: input.baseChecksum, changes: structuredClone(input.changes), changeCount: input.changes.length,
        size: input.size, sentBy: input.sentBy, state: 'staged', approvalId: null, restoredFrom: input.restoredFrom ?? null, createdAt: input.at, liveAt: null, endedAt: null, endedBy: null,
      };
      rows.set(row.id, row);
      return structuredClone(row);
    },
    async setBrandEditRevisionState(sourceId, n, from, to, patch = {}) {
      const row = rows.get(rowId(sourceId, n));
      if (!row || !from.includes(row.state)) return false;
      row.state = to;
      if (patch.approvalId) row.approvalId = patch.approvalId;
      if (patch.liveAt) row.liveAt = patch.liveAt;
      if (patch.endedAt) row.endedAt = patch.endedAt;
      if (patch.endedBy) row.endedBy = patch.endedBy;
      return true;
    },
  };
}

const iso = (value: unknown): string | null => value ? new Date(value as string).toISOString() : null;
const SUMMARY = 'id, source_id, n, digest, base_checksum, jsonb_array_length(changes) as change_count, size, sent_by, state, approval_id, restored_from, created_at, live_at, ended_at, ended_by';
const summaryFrom = (row: Record<string, unknown>): BrandEditRevisionSummary => ({
  id: row.id as string, sourceId: row.source_id as string, n: Number(row.n), digest: row.digest as string, baseChecksum: row.base_checksum as string,
  changeCount: Number(row.change_count), size: Number(row.size), sentBy: row.sent_by as string, state: row.state as BrandEditState,
  approvalId: (row.approval_id as string | null) ?? null, restoredFrom: row.restored_from === null ? null : Number(row.restored_from),
  createdAt: iso(row.created_at)!, liveAt: iso(row.live_at), endedAt: iso(row.ended_at), endedBy: (row.ended_by as string | null) ?? null,
});

export function createPostgresBrandEditStore(pool: RenderDatabase): BrandEditStore {
  return {
    async listBrandEditRevisions(sourceId, limit) {
      const { rows } = await pool.query(`select ${SUMMARY} from brand_edit_revisions where source_id = $1 order by n desc limit $2`, [sourceId, limit]);
      return rows.map(summaryFrom);
    },
    async getBrandEditRevision(sourceId, n) {
      const { rows } = await pool.query(`select ${SUMMARY}, changes from brand_edit_revisions where source_id = $1 and n = $2`, [sourceId, n]);
      return rows[0] ? { ...summaryFrom(rows[0]), changes: rows[0].changes as BrandEditChange[] } : null;
    },
    async addBrandEditRevision(input) {
      return inTransaction(pool, async (db) => {
        // One number per source: the primary key refuses a repeat, and this waits instead of failing.
        await db.query('select pg_advisory_xact_lock(hashtext($1))', [`brand-edit:${input.sourceId}`]);
        const next = await db.query('select coalesce(max(n), 0) + 1 as n from brand_edit_revisions where source_id = $1', [input.sourceId]);
        const n = Number(next.rows[0]!.n);
        const { rows } = await db.query(
          `insert into brand_edit_revisions (id, source_id, n, digest, base_checksum, changes, size, sent_by, state, restored_from, created_at)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'staged', $9, $10) returning ${SUMMARY}`,
          [rowId(input.sourceId, n), input.sourceId, n, input.digest, input.baseChecksum, JSON.stringify(input.changes), input.size, input.sentBy, input.restoredFrom ?? null, input.at]);
        return { ...summaryFrom(rows[0]!), changes: structuredClone(input.changes) };
      });
    },
    async setBrandEditRevisionState(sourceId, n, from, to, patch = {}) {
      const { rowCount } = await pool.query(
        `update brand_edit_revisions set state = $4, approval_id = coalesce($5, approval_id), live_at = coalesce($6, live_at), ended_at = coalesce($7, ended_at), ended_by = coalesce($8, ended_by)
         where source_id = $1 and n = $2 and state = any($3::text[])`,
        [sourceId, n, [...from], to, patch.approvalId ?? null, patch.liveAt ?? null, patch.endedAt ?? null, patch.endedBy ?? null]);
      return (rowCount ?? 0) > 0;
    },
  };
}
