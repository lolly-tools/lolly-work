/**
 * The audit-chain HEAD - a small, shared summary of where the hash-chained log
 * currently ends (plan Rec 5). In-place hash-chaining is tamper-evident but not
 * truncation-proof against someone who holds the DB; publishing the head hash
 * somewhere external (a signed commit, a ticket, a monitoring sink) turns
 * truncation into a detectable divergence. This helper is the single source of
 * the head shape, reused by the API route, the `lw audit head` CLI, and the
 * optional boot/interval logging in main.ts.
 */
import { GENESIS_HASH, verifyChain } from './chain.ts';
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
}

export async function auditHead(store: Store): Promise<AuditHead> {
  const events = await store.listAudit();
  const chain = verifyChain(events);
  const tail = events[events.length - 1];
  return {
    seq: tail?.seq ?? 0,
    hash: tail?.hash ?? GENESIS_HASH,
    at: tail?.at ?? null,
    count: events.length,
    chainIntact: chain.ok,
    ...(chain.ok ? {} : { badSeq: chain.badSeq }),
  };
}
