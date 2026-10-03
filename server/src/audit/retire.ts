/**
 * Retiring the audit MAC key after a session-secret rotation (docs/audit.md,
 * "Rotating the session secret").
 *
 * Every audit row carries an HMAC of its hash under a key derived from
 * LW_SESSION_SECRET (chain.ts deriveAuditMacKey). A new secret means a new key,
 * so every row written before the rotation stops verifying and the chain reads
 * as broken. When the old value is still known it can be checked first
 * (LW_SESSION_SECRET_PREVIOUS); when it is gone, nothing can re-check those
 * MACs. Either way the operator appends ONE boundary row (KEY_RETIRE_ACTION),
 * MAC'd under the current key, that records the hash of the last row before
 * it. Verification then counts the older rows as retired-key rows instead of
 * failing them, while still checking their hash links, which that recorded hash
 * pins. Rows after the boundary must verify under the current key as before.
 *
 * Without the old value, a row that fails its MAC could be an old-key row or
 * an edit that a database holder re-chained. A boundary marks a key change and
 * must never cover an edit, so the command writes one only when the rows since
 * the last boundary look like a key change and nothing else:
 *
 *  - every hash link holds (an edit that was not re-chained);
 *  - no row lacks a MAC once an earlier row has one (a stripped MAC);
 *  - old-key rows come first and current-key rows after them, never a
 *    current-key row before an old-key one (an edit re-chained from there on,
 *    or a host still writing with the old secret);
 *  - at least one row after the old ones verifies under the key the command
 *    was given (a "witness"), which shows the running server uses that key;
 *  - with `--expect-head`, the row recorded before the rotation still has the
 *    recorded hash, which pins every row up to it.
 *
 * The second-to-last check and the last can be overridden; the boundary then
 * records that they were. Nothing is written when the chain already verifies.
 */
import { macEquals } from '../lib/crypto.ts';
import {
  KEY_RETIRE_ACTION, findKeyRetireBoundary, macEvent, verifyChain,
  type AuditAnchor, type AuditEvent, type ChainVerdict, type KeyRetirePayload,
} from './chain.ts';
import type { Store } from '../store/types.ts';

/** The longest reason kept on the boundary row. It is operator text in the
 *  audit log, so it should say why ("secret rotation 2026-10-04"), not who. */
export const RETIRE_REASON_MAX = 200;

export interface PlanOptions {
  /** deriveAuditMacKey(LW_SESSION_SECRET_PREVIOUS), when that value is known. */
  previousMacKey?: string;
  /** The head recorded before the rotation, while the old key still verified. */
  expectHead?: { seq: number; hash: string };
  /** Accept a current-key row before an old-key row (an old-key host that was
   *  switched last). */
  allowInterleaved?: boolean;
  /** Accept that no row after the old ones verifies under the key given. */
  noWitness?: boolean;
}

export interface RetirePlan {
  /**
   * retire  - rows since the last boundary fail only their MAC, in the order a
   *           key change leaves them: write a boundary.
   * current - the chain verifies under the current key: nothing to retire.
   * broken  - a hash link is broken at badSeq: an edit, not a key change.
   * head-mismatch - row badSeq (the --expect-head seq) is gone or has another hash.
   * stripped - row badSeq has no MAC although an earlier row has one.
   * interleaved - row currentSeq verifies under the current key and the later
   *           row badSeq does not.
   * no-witness - no row after the old ones verifies under the key given.
   * previous-mismatch - LW_SESSION_SECRET_PREVIOUS was given and the row at
   *           badSeq verifies under neither key.
   */
  status: 'retire' | 'current' | 'broken' | 'head-mismatch' | 'stripped' | 'interleaved' | 'no-witness' | 'previous-mismatch';
  /** The last row; the boundary would record it. Null for an empty log. */
  tail: { seq: number; hash: string; at: string } | null;
  /** Rows after the newest valid boundary whose MAC fails under the current key. */
  staleRows: number;
  firstStaleSeq?: number;
  lastStaleSeq?: number;
  /** Rows after the last stale one that verify under the current key. */
  witnessRows: number;
  /** The first current-key row that comes before a stale row, if any. With
   *  status 'retire' it is set only when --allow-interleaved accepted it. */
  currentSeq?: number;
  /** With expectHead: stale rows after the recorded head, written between the
   *  check and the moment every host ran the new secret. Nothing pins them. */
  staleAfterHead?: number;
  /** With a refusal: the first row at fault. */
  badSeq?: number;
  /** True when the stale rows were checked against the previous key. */
  previousKeyChecked: boolean;
  /** Verification under the current key, before any write. */
  verdict: ChainVerdict;
}

/** Parse `--expect-head <seq>:<hash>`; throws on anything else. */
export function parseExpectHead(text: string): { seq: number; hash: string } {
  const m = /^(\d{1,15}):([0-9a-f]{64})$/.exec(text.trim());
  if (!m || Number(m[1]) < 1) throw new Error('--expect-head takes <seq>:<hash>, as `lw audit head` or scripts/audit-head.ts prints them');
  return { seq: Number(m[1]), hash: m[2]! };
}

/** Decide what a retire would do, without writing anything. */
export function planKeyRetire(
  events: AuditEvent[], anchor: AuditAnchor | null, macKey: string, opts: PlanOptions = {},
): RetirePlan {
  const verdict = verifyChain(events, anchor, macKey);
  const last = events[events.length - 1];
  const tail = last ? { seq: last.seq, hash: last.hash, at: last.at } : null;
  const base = { tail, staleRows: 0, witnessRows: 0, previousKeyChecked: false, verdict };
  if (verdict.ok) return { ...base, status: 'current' };
  const links = verifyChain(events, anchor);
  if (!links.ok) return { ...base, status: 'broken', badSeq: links.badSeq! };

  const live = anchor ? events.filter((e) => e.seq > anchor.seq) : events;
  const { expectHead } = opts;
  if (expectHead) {
    const pinned = anchor && anchor.seq === expectHead.seq ? anchor : live.find((e) => e.seq === expectHead.seq);
    if (pinned?.hash !== expectHead.hash) return { ...base, status: 'head-mismatch', badSeq: expectHead.seq };
  }
  let keyed = false;
  for (const e of live) {
    if (e.mac !== undefined) keyed = true;
    else if (keyed) return { ...base, status: 'stripped', badSeq: e.seq };
  }

  const boundary = findKeyRetireBoundary(live, macKey);
  const since = live
    .filter((e) => e.seq > (boundary?.seq ?? 0) && e.mac !== undefined)
    .map((e) => ({ e, current: macEquals(e.mac!, macEvent(macKey, e.hash)) }));
  const stale = since.filter((r) => !r.current).map((r) => r.e);
  const lastStale = stale[stale.length - 1];
  // Unreachable while verifyChain fails only on links, MACs and stripped MACs,
  // all handled above; refuse rather than write a boundary that covers nothing.
  if (!lastStale) return { ...base, status: 'broken', badSeq: verdict.badSeq! };
  const firstCurrent = since.find((r) => r.current && r.e.seq < lastStale.seq)?.e;
  const plan: RetirePlan = {
    ...base, status: 'retire', staleRows: stale.length,
    firstStaleSeq: stale[0]!.seq, lastStaleSeq: lastStale.seq,
    witnessRows: since.filter((r) => r.current && r.e.seq > lastStale.seq).length,
    ...(firstCurrent ? { currentSeq: firstCurrent.seq } : {}),
    ...(expectHead ? { staleAfterHead: stale.filter((e) => e.seq > expectHead.seq).length } : {}),
  };
  if (firstCurrent && !opts.allowInterleaved) {
    return { ...plan, status: 'interleaved', badSeq: stale.find((e) => e.seq > firstCurrent.seq)!.seq };
  }
  if (plan.witnessRows === 0 && !opts.noWitness) return { ...plan, status: 'no-witness' };
  if (opts.previousMacKey) {
    plan.previousKeyChecked = true;
    const bad = stale.find((e) => !macEquals(e.mac!, macEvent(opts.previousMacKey!, e.hash)));
    if (bad) return { ...plan, status: 'previous-mismatch', badSeq: bad.seq };
  }
  return plan;
}

export interface RetireOptions extends PlanOptions {
  /** The CURRENT audit key: deriveAuditMacKey(LW_SESSION_SECRET). */
  macKey: string;
  reason: string;
  dryRun?: boolean;
  now?: () => Date;
}

export type RetireResult =
  | (RetirePlan & { written: false })
  | (RetirePlan & { written: true; event: AuditEvent; after: ChainVerdict });

/** Throws on an empty or oversized reason; returns it trimmed. */
export function checkRetireReason(reason: string | undefined): string {
  const text = (reason ?? '').trim();
  if (!text) throw new Error('a reason is required, e.g. --reason "secret rotation 2026-10-04"');
  if (text.length > RETIRE_REASON_MAX) throw new Error(`the reason is longer than ${RETIRE_REASON_MAX} characters`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error('the reason must be one line of plain text');
  return text;
}

/**
 * Append the boundary. It must directly follow the row its payload names, so
 * it goes through the store's conditional append: when another writer appends
 * between the read and this write, nothing is written and the plan is made
 * again against the new tail.
 */
export async function retireAuditKey(store: Store, opts: RetireOptions): Promise<RetireResult> {
  const reason = checkRetireReason(opts.reason);
  if (!store.setAuditMacKey || !store.appendAuditIfTail) {
    throw new Error('this store cannot MAC audit rows or append on a known tail, so it cannot hold a retired-key boundary');
  }
  store.setAuditMacKey(opts.macKey);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const [events, anchor] = await Promise.all([store.listAudit(), store.getAuditAnchor()]);
    const plan = planKeyRetire(events, anchor, opts.macKey, opts);
    if (plan.status !== 'retire' || opts.dryRun || !plan.tail) return { ...plan, written: false };
    const payload: KeyRetirePayload = {
      retiredThroughSeq: plan.tail.seq,
      retiredHeadHash: plan.tail.hash,
      reason,
      retiredRows: plan.staleRows,
      previousKeyChecked: plan.previousKeyChecked,
      ...(opts.expectHead ? { expectedHead: { seq: opts.expectHead.seq, hash: opts.expectHead.hash } } : {}),
      ...(plan.currentSeq !== undefined ? { allowInterleaved: true as const } : {}),
      ...(plan.witnessRows === 0 ? { noWitness: true as const } : {}),
    };
    const event = await store.appendAuditIfTail({ seq: plan.tail.seq, hash: plan.tail.hash }, {
      at: (opts.now?.() ?? new Date()).toISOString(),
      actor: 'system',
      action: KEY_RETIRE_ACTION,
      subject: 'audit:chain',
      payload: { ...payload },
    });
    if (!event) continue;
    if (!event.mac || !macEquals(event.mac, macEvent(opts.macKey, event.hash))) {
      throw new Error(`the boundary at #${event.seq} was not MAC'd under the current key`);
    }
    const after = verifyChain(await store.listAudit(), await store.getAuditAnchor(), opts.macKey);
    return { ...plan, written: true, event, after };
  }
  throw new Error('other writers kept appending between the read and the boundary, and nothing was written; run the command again');
}
