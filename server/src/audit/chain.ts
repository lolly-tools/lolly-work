/**
 * Append-only, hash-chained audit log (plans/11 §2).
 *
 * Each event's hash covers the previous event's hash + the canonical JSON of
 * the event body, so truncation or in-place tampering breaks the chain at a
 * detectable seq. Payloads must already be privacy-safe (digests, field
 * names — never raw input values); this module doesn't inspect them.
 */
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';

export interface AuditEventBody {
  at: string; // ISO timestamp
  actor: string; // 'user:<id>' | 'guest:<linkId>' | 'system'
  action: string; // e.g. 'auth.login', 'link.create', 'policy.edit'
  subject: string; // e.g. 'tool:event-badge', 'link:<id>'
  payload?: Record<string, unknown>;
}

export interface AuditEvent extends AuditEventBody {
  seq: number;
  prevHash: string;
  hash: string;
}

export const GENESIS_HASH = sha256Hex('lolly-work-audit-genesis');

export function hashEvent(prevHash: string, seq: number, body: AuditEventBody): string {
  return sha256Hex(`${prevHash}\n${seq}\n${canonicalJson(body)}`);
}

/** Build the next chain entry from the current tail (tail = null for an empty log). */
export function nextEvent(tail: AuditEvent | null, body: AuditEventBody): AuditEvent {
  const seq = (tail?.seq ?? 0) + 1;
  const prevHash = tail?.hash ?? GENESIS_HASH;
  return { ...body, seq, prevHash, hash: hashEvent(prevHash, seq, body) };
}

/** Walk the chain; report the first seq whose linkage or hash fails. */
export function verifyChain(events: AuditEvent[]): { ok: boolean; badSeq?: number } {
  let prevHash = GENESIS_HASH;
  let prevSeq = 0;
  for (const evt of events) {
    const { seq, prevHash: claimedPrev, hash, ...body } = evt;
    if (seq !== prevSeq + 1 || claimedPrev !== prevHash || hashEvent(prevHash, seq, body) !== hash) {
      return { ok: false, badSeq: seq };
    }
    prevHash = hash;
    prevSeq = seq;
  }
  return { ok: true };
}
