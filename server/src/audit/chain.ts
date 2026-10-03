/**
 * Append-only, hash-chained audit log (plans/11 §2).
 *
 * Each event's hash covers the previous event's hash + the canonical JSON of
 * the event body, so truncation or in-place tampering breaks the chain at a
 * detectable seq. Payloads must already be privacy-safe (digests, field
 * names - never raw input values); this module doesn't inspect them.
 */
import { canonicalJson, sha256Hex, hmac, macEquals, deriveKey } from '../lib/crypto.ts';

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
  /** HMAC of `hash` under the deployment's audit key (migration 0034). Absent
   *  on rows written before the key existed, and on unkeyed (demo) stores. */
  mac?: string;
}

export const GENESIS_HASH = sha256Hex('lolly-work-audit-genesis');

export function hashEvent(prevHash: string, seq: number, body: AuditEventBody): string {
  return sha256Hex(`${prevHash}\n${seq}\n${canonicalJson(body)}`);
}

/** The audit MAC key is derived from the session secret, never stored: a
 *  database holder who can recompute the public hash chain still cannot
 *  produce a MAC that verifies. */
export function deriveAuditMacKey(sessionSecret: string): string {
  return deriveKey(sessionSecret, 'lw/audit-mac');
}

export function macEvent(macKey: string, hash: string): string {
  return hmac(`lw/audit-mac\n${hash}`, macKey);
}

/** Build the next chain entry from the current tail (tail = null for an empty log). */
export function nextEvent(tail: AuditEvent | null, body: AuditEventBody, macKey?: string): AuditEvent {
  const seq = (tail?.seq ?? 0) + 1;
  const prevHash = tail?.hash ?? GENESIS_HASH;
  const hash = hashEvent(prevHash, seq, body);
  return { ...body, seq, prevHash, hash, ...(macKey ? { mac: macEvent(macKey, hash) } : {}) };
}

/** The retention trim's high-water mark (plans/35 wave 3): the last trimmed
 *  row's seq + hash, recorded BEFORE its rows are deleted so verification can
 *  start from it instead of genesis. Absent = never trimmed. */
export interface AuditAnchor { seq: number; hash: string }

/** The action of a retired-key boundary (audit/retire.ts). Rotating
 *  LW_SESSION_SECRET changes the MAC key, so every row written before the
 *  rotation stops verifying. When the old value is gone, the operator appends
 *  one of these, MAC'd under the NEW key; its payload pins the hash of the last
 *  row it covers. */
export const KEY_RETIRE_ACTION = 'audit.key.retire';

/** The payload of a KEY_RETIRE_ACTION row. `retiredThroughSeq` is always the
 *  row's own seq - 1 and `retiredHeadHash` its prevHash: a boundary covers
 *  everything before it, never a range in the middle. */
export interface KeyRetirePayload {
  retiredThroughSeq: number;
  retiredHeadHash: string;
  reason: string;
  /** Rows since the previous boundary whose MAC failed under the new key. */
  retiredRows: number;
  /** True when those rows were first checked against LW_SESSION_SECRET_PREVIOUS. */
  previousKeyChecked: boolean;
  /** The head recorded before the rotation (`--expect-head`), when one was
   *  given: that row still had that hash when the boundary was written. */
  expectedHead?: { seq: number; hash: string };
  /** Set when the operator overrode a refusal: `allowInterleaved` when a
   *  current-key row came before an old-key row, `noWitness` when no row after
   *  the old ones verified under the key the command used. */
  allowInterleaved?: true;
  noWitness?: true;
}

/** The newest boundary that holds: a KEY_RETIRE_ACTION row whose own hash is
 *  right, whose MAC verifies under `macKey`, and whose payload names the row
 *  directly before it. A boundary with a bad MAC is ignored, so a database
 *  holder without the session secret cannot write one. An older boundary MAC'd
 *  under a key that has since been retired is just a retired row itself: the
 *  newest valid boundary covers it. */
export function findKeyRetireBoundary(events: AuditEvent[], macKey: string): AuditEvent | null {
  let found: AuditEvent | null = null;
  for (const evt of events) {
    if (evt.action !== KEY_RETIRE_ACTION || evt.mac === undefined) continue;
    const p = evt.payload as Partial<KeyRetirePayload> | undefined;
    if (!p || p.retiredThroughSeq !== evt.seq - 1 || p.retiredHeadHash !== evt.prevHash) continue;
    const { seq, prevHash, hash, mac, ...body } = evt;
    if (hashEvent(prevHash, seq, body) !== hash || !macEquals(mac!, macEvent(macKey, hash))) continue;
    found = evt;
  }
  return found;
}

/** Walk the chain; report the first seq whose linkage or hash fails. With an
 *  anchor, verification starts from it - rows at or below the anchor (still
 *  present after a trim interrupted between anchor-write and delete) are
 *  skipped rather than double-checked, so a half-finished trim is safe. */
export interface ChainVerdict {
  ok: boolean;
  badSeq?: number;
  /** With a key: how many rows carried no MAC (written before the key existed).
   *  Only leading rows count: once a row carries a MAC, every later row must
   *  too, since every writer installs the key (main.ts, api/_lib/bootstrap.ts)
   *  and a missing MAC after that is a stripped one. */
  unkeyed?: number;
  /** With a key: rows before a retired-key boundary whose MAC was made under a
   *  key since retired. Present only when there are some. The hash chain
   *  still runs through them, and the boundary's MAC pins its head. */
  retiredKeyRows?: number;
  /** With retiredKeyRows: the last seq the boundary covers. */
  retiredThroughSeq?: number;
  /** With retiredKeyRows: when the boundary was written (its `at`). */
  retiredBefore?: string;
}

export function verifyChain(events: AuditEvent[], anchor?: AuditAnchor | null, macKey?: string): ChainVerdict {
  let prevHash = anchor?.hash ?? GENESIS_HASH;
  let prevSeq = anchor?.seq ?? 0;
  let unkeyed = 0;
  let keyedSeen = false;
  let retired = 0;
  if (anchor) events = events.filter((e) => e.seq > anchor.seq);
  // Rows before the boundary may carry a retired key's MAC. The walk below
  // still checks their linkage and hashes, which is what pins them: the
  // boundary's MAC covers its prevHash, the hash of the last row it retires.
  const boundary = macKey ? findKeyRetireBoundary(events, macKey) : null;
  const retiredFields = (): Partial<ChainVerdict> => (retired > 0 && boundary
    ? { retiredKeyRows: retired, retiredThroughSeq: boundary.seq - 1, retiredBefore: boundary.at }
    : {});
  for (const evt of events) {
    const { seq, prevHash: claimedPrev, hash, mac, ...body } = evt;
    if (seq !== prevSeq + 1 || claimedPrev !== prevHash || hashEvent(prevHash, seq, body) !== hash) {
      return { ok: false, badSeq: seq, ...(macKey ? { unkeyed } : {}), ...retiredFields() };
    }
    if (macKey) {
      if (mac === undefined) {
        if (keyedSeen) return { ok: false, badSeq: seq, unkeyed, ...retiredFields() };
        unkeyed++;
      } else {
        keyedSeen = true;
        if (!macEquals(mac, macEvent(macKey, hash))) {
          if (boundary && seq < boundary.seq) retired++;
          else return { ok: false, badSeq: seq, unkeyed, ...retiredFields() };
        }
      }
    }
    prevHash = hash;
    prevSeq = seq;
  }
  return { ok: true, ...(macKey ? { unkeyed } : {}), ...retiredFields() };
}

/** The retired-key note shown beside "intact" in logs, the CLI and the
 *  console: '' when no rows carry a retired key. */
export function retiredKeyNote(v: Pick<ChainVerdict, 'retiredKeyRows' | 'retiredBefore'>): string {
  if (!v.retiredKeyRows) return '';
  const rows = v.retiredKeyRows === 1 ? '1 row' : `${v.retiredKeyRows} rows`;
  return ` (${rows} signed with a retired key before ${v.retiredBefore ?? 'the boundary'})`;
}
