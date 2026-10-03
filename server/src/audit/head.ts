/**
 * The audit-chain HEAD - a small, shared summary of where the hash-chained log
 * currently ends (plan Rec 5). In-place hash-chaining is tamper-evident but not
 * truncation-proof against someone who holds the DB; publishing the head hash
 * somewhere external (a signed commit, a ticket, a monitoring sink) turns
 * truncation into a detectable divergence. This helper is the single source of
 * the head shape, reused by the API route, the `lw audit head` CLI, and the
 * optional boot/interval logging in main.ts.
 */
import { GENESIS_HASH, verifyChain, type AuditAnchor, type AuditEvent } from './chain.ts';
import type { Store } from '../store/types.ts';

export interface AuditHead {
  /** Sequence of the last event; 0 for an empty log. */
  seq: number;
  /** Hash of the last event; GENESIS_HASH for an empty log. */
  hash: string;
  /** Timestamp of the last event; null for an empty log. */
  at: string | null;
  count: number;
  chainIntact: boolean;
  /** Present only when chainIntact === false. */
  badSeq?: number;
  /** With an audit key configured: rows that predate it and carry no MAC. */
  unkeyed?: number;
  /** Rows before a retired-key boundary whose MAC was made under a key since
   *  retired (audit/chain.ts KEY_RETIRE_ACTION); with it, the boundary's last
   *  covered seq and when it was written. Present only when there are some. */
  retiredKeyRows?: number;
  retiredThroughSeq?: number;
  retiredBefore?: string;
}

export async function auditHead(store: Store, macKey?: string): Promise<AuditHead> {
  const [events, anchor] = await Promise.all([store.listAudit(), store.getAuditAnchor()]);
  return headOf(events, anchor, macKey);
}

/** The head of rows already read (scripts/audit-head.ts reads them once). */
export function headOf(events: AuditEvent[], anchor: AuditAnchor | null, macKey?: string): AuditHead {
  // Anchor-aware (plans/35 wave 3): after a retention trim, verification and
  // the empty-log head both stand on the recorded boundary, not on genesis.
  const chain = verifyChain(events, anchor, macKey);
  const tail = events[events.length - 1];
  return {
    seq: tail?.seq ?? anchor?.seq ?? 0,
    hash: tail?.hash ?? anchor?.hash ?? GENESIS_HASH,
    at: tail?.at ?? null,
    count: events.length,
    chainIntact: chain.ok,
    ...(chain.ok ? {} : { badSeq: chain.badSeq }),
    ...(chain.unkeyed !== undefined ? { unkeyed: chain.unkeyed } : {}),
    ...(chain.retiredKeyRows ? { retiredKeyRows: chain.retiredKeyRows, retiredThroughSeq: chain.retiredThroughSeq!, retiredBefore: chain.retiredBefore! } : {}),
  };
}
