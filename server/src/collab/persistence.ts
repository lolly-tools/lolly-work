// SPDX-License-Identifier: MPL-2.0
/**
 * Room persistence - snapshot cadence, quiesce, and crash recovery for live
 * collab rooms (lolly-work plans/14 §6 "Persistence", OSS plans/100 §7 items 3
 * and 4).
 *
 * ONE HISTORY, NOT TWO. plans/14 §6 is explicit that a room's work lands as a
 * NORMAL session revision, so L0 async share and L2 live editing read the same
 * `session_revisions` table. Nothing here invents a parallel timeline: a quiesce
 * is a `putSession` rev bump plus one `appendSessionRevision`, byte-identical in
 * shape to what `PUT /api/v1/sessions/:id` writes. The only difference is the
 * revision's `actor`, which is `'collab'` rather than a user id - a room's
 * converged document has no single author, and claiming one would be a lie in
 * the audit trail. (`SessionRecord.updatedBy` is a different matter: it is a
 * FOREIGN KEY to `users(id)` in Postgres, so it keeps a real user - the room's
 * last accepted writer, else whoever the record already named.) A GUEST's
 * write-back is the one case where those two diverge: it lands on the revision as
 * `guest:<linkId>` and leaves `updated_by` alone - see `RoomWriter` below.
 *
 * WHAT IS SNAPSHOTTED IS THE SESSION'S INPUTS. plans/14 §6 reached for a
 * "periodic snapshot + update log", the y-leveldb algorithm plans/100 §7 item 3
 * pins the cadence from. The snapshot half is here; the LOG half is deliberately
 * absent, and this is the one place this module departs from the plan's letter:
 * an update log pays off when replaying deltas is cheaper than rewriting
 * the document, and a Lolly session document is a few KB of input model - the
 * exact case plans/14 §4 calls out ("inputs for even a huge deck are tens of
 * KB"). Writing the whole converged state every 20 batches is cheaper than
 * writing 20 op batches and then compacting them, and it removes compaction as a
 * thing that can be wrong. The stored form is `SessionRecord.inputs` rather than
 * a doc-shaped blob for the same reason it must be: the room document and the
 * session inputs are the same information in two shapes (rooms.ts
 * `seedOpsFromInputs` maps one way, `docToInputs` below the other), so storing
 * inputs means crash recovery is a plain revision write, re-seeding reuses the
 * ordinary seed path, and exactly ONE mapping is under test instead of two.
 *
 * THE SNAPSHOT ROW IS TRANSIENT, AND THAT IS THE RECOVERY SIGNAL. It exists only
 * while a room holds unpersisted edits; the quiesce that writes the revision
 * deletes it in the same pass. So a row that survives a process restart MEANS a
 * crash lost that room's quiesce - there is no separate "was it clean?" flag to
 * get out of sync. `baseRev` guards the replay: recovery happens only while the
 * stored session is still at the rev the snapshot was taken against. A higher rev
 * means an ordinary PUT has since superseded the room, and replaying stale room
 * state over newer work is worse than losing it, so the row is dropped instead.
 *
 * NO PRESENCE REACHES THIS MODULE. rooms.ts keeps the whole presence path
 * (sanitize → remember → relay) to itself and hands this module only the
 * converged DOCUMENT, through the `RoomWriteback` seam below - a one-method
 * interface that can express a document and nothing else. Presence has no route
 * to the store, by shape rather than by discipline (plans/100 §7 item 5).
 */
import { isDeepStrictEqual } from 'node:util';

import type { BoxId, BoxRow, CanvasDocState, ParamValue } from '@lolly-tools/core/canvas-op-v1';
import { guestActor } from '../iam/sessions.ts';
import type { SessionRecord, Store } from '../store/types.ts';

// ── cadence + lifetime constants (plans/100 §7 item 3) ────────────────────────

/** Snapshot after this many applied op BATCHES (one `ops` message = one batch).
 *  plans/100 §7 item 3's "every 20 revisions", read as gesture commits - the unit
 *  a client actually produces. */
export const SNAPSHOT_EVERY_BATCHES = 20;
/** …or this many accumulated ops, whichever comes first. A drag gesture can put
 *  hundreds of ops in a handful of batches, so the batch counter alone would let
 *  a lot of work sit unpersisted. */
export const SNAPSHOT_EVERY_OPS = 500;
/** How long a room may sit with no members before the sweeper quiesces and
 *  disposes it. The ORDINARY path does not wait for this: the last member's
 *  leave quiesces immediately, which is what keeps `rooms()` honest and the
 *  `collab.rollup` audit event contemporaneous with the room closing. This grace
 *  exists for rooms that never pass through a leave at all - a socket that dies
 *  between `acquire` and `join`, or a leave handler that threw - which would
 *  otherwise hold a document (and its unwritten edits) forever. */
export const EMPTY_GRACE_MS = 30_000;
/** The `SessionRevision.actor` a room's own writes carry. Not a user id: a
 *  converged document has no single author. */
export const COLLAB_ACTOR = 'collab';

/**
 * The last principal whose ops a room accepted, in the only two shapes a room
 * can hold one. It exists as a UNION rather than a string because the two halves
 * land in different columns and one of them is a foreign key:
 *
 *   - `sessions.updated_by` REFERENCES `users(id)` (migrations/0004), so only a
 *     member id may ever go in it. A guest's write leaves whatever the record
 *     already named - which is the honest answer, not a fallback: the guest is
 *     not a user, and writing the INVITER there would claim an edit they did not
 *     make in the one column the console reads as "who last touched this".
 *   - `session_revisions.actor` is free text, so that is where a guest's write is
 *     attributed - as its own principal id (`guest:<linkId>`), the same string
 *     the audit log uses for `guest.admit` and for the room's join/leave events.
 */
export type RoomWriter =
  | { kind: 'member'; userId: string }
  | { kind: 'guest'; linkId: string };

/**
 * The `SessionRevision.actor` for one write-back. `'collab'` for a member-written
 * room (a converged document has no single author) and for a crash recovery with
 * no writer at all; the GUEST principal id when the last accepted writer was a
 * guest, because plans/02 §8 asks for a guest to be identifiable "everywhere - 
 * presence, revisions, audit", and a room whose only writer was a guest would
 * otherwise land in history indistinguishable from one its members wrote.
 */
export function roomRevisionActor(writer: RoomWriter | null | undefined): string {
  return writer?.kind === 'guest' ? guestActor(writer.linkId) : COLLAB_ACTOR;
}

// ── document → session inputs (the inverse of rooms.ts `seedOpsFromInputs`) ───

/** A BoxId this collection MINTED for a legacy row that carried no id of its own
 *  (`seedOpsFromInputs` → `blockRows`: `"<inputId>#<index>"`). Synthetic ids are
 *  a seeding artefact and must never be written back as data. */
function isSyntheticId(col: string, id: BoxId): boolean {
  return id.startsWith(`${col}#`) && /^\d+$/.test(id.slice(col.length + 1));
}

/** One converged box row → the stored block object. The BoxId is the row's
 *  identity in the room, so it is stamped back as `id` (this is plans/14 work
 *  item 3, "stable block ids in the session format", falling out of collab for
 *  free) - but never when the id was synthesised, because that would invent data
 *  the user never had, and a subsequent seed would then treat the invention as
 *  authoritative. */
function rowToBlock(col: string, id: BoxId, row: BoxRow): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  if (!isSyntheticId(col, id)) out['id'] = id;
  return out;
}

/** A param value as an input value. A binding descriptor (`{bind:{provider…}}`)
 *  is stored verbatim: plans/99 §6 syncs WHICH dataset, never the resolved datum,
 *  so the descriptor is the input's value and each client resolves it locally. */
function paramToInput(value: ParamValue): unknown {
  return value;
}

/**
 * The room's converged document, expressed as `SessionRecord.inputs`.
 *
 * `base` is the CURRENTLY STORED inputs and it is the floor, not a formality: the
 * document deliberately cannot express every input (a `file` input's bytes, a
 * nested object - rooms.ts reports those as `unsynced` in every join-ack), so
 * every key the document cannot hold must survive the write-back verbatim.
 *
 * `touched` narrows that further, and this is the essential part. A room seeds
 * its document from EVERY syncable input, so "what the document says" covers
 * inputs nobody in the room ever went near. Writing all of them back would let a
 * room that changed one headline silently revert an ordinary
 * `PUT /api/v1/sessions/:id` that landed on an unrelated input while it was open
 * - a clobber with no edit behind it, which is the worst kind. So the write-back
 * is scoped to the input ids the room ACCEPTED ops for (the same key set the
 * audit rollup reports), and the overlap with L0 resolves per input id: the room
 * wins what it edited, the PUT keeps everything else.
 */
export function docToInputs(
  state: CanvasDocState,
  base: Record<string, unknown>,
  touched: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of state.params) {
    if (touched.has(key)) out[key] = paramToInput(value);
  }
  for (const [col, collection] of state.collections ?? []) {
    if (!touched.has(col)) continue;
    out[col] = collection.order.map((id) => rowToBlock(col, id, collection.boxes.get(id) ?? {}));
  }
  return out;
}

// ── the seam rooms.ts is handed ──────────────────────────────────────────────

/** All this module can ask a room for: its converged document over a given base.
 *  A one-method interface, so a future edit cannot quietly start persisting
 *  presence, the roster, or anything else the room happens to know. */
export interface RoomWriteback {
  toInputs(base: Record<string, unknown>): Record<string, unknown>;
}

/** What the room seeds itself from on first join. */
export interface HydrateResult {
  /** The inputs to seed the document with - the stored session's, or a recovered
   *  snapshot's when a crash lost that room's quiesce. */
  inputs: Record<string, unknown>;
  /** The session rev those inputs correspond to (AFTER any recovery revision). */
  rev: number;
  /** True when a crash-lost quiesce was recovered and its revision written. */
  recovered: boolean;
}

export interface QuiesceResult {
  /** False when nothing changed, the session vanished, or it was tombstoned
   *  mid-room - all cases where writing a revision would be noise or a
   *  resurrection. */
  written: boolean;
  /** The rev written, or the untouched current rev when `written` is false. */
  rev: number;
}

export interface RoomPersistence {
  /** First-join hydration, including crash recovery. */
  hydrate(session: SessionRecord): Promise<HydrateResult>;
  /** Cadence write - replaces this session's snapshot row. */
  snapshot(sessionId: string, doc: RoomWriteback, ops: number): Promise<void>;
  /** Final write: the room lands as a normal session revision, and its snapshot
   *  row (the crash-recovery signal) is cleared. `actor` is the room's last
   *  accepted writer - see `RoomWriter` for why it is not simply a string. */
  quiesce(
    sessionId: string,
    doc: RoomWriteback,
    opts: { ops: number; actor: RoomWriter | null; baseRev: number },
  ): Promise<QuiesceResult>;
}

export interface RoomPersistenceDeps {
  store: Store;
}

/** How many times a room's write-back re-reads and re-merges before giving up. A
 *  loss means an ordinary PUT landed in the microseconds between the read and the
 *  CAS; two in a row means something is hammering the session, and a room that
 *  spun here would hold its disposal open. */
export const COMMIT_ATTEMPTS = 3;

/** What one write-back attempt did. `unchanged` and `gone` are ordinary outcomes;
 *  `contended` means COMMIT_ATTEMPTS races were all lost. */
type CommitOutcome =
  | { ok: true; rev: number; session: SessionRecord }
  | { ok: false; why: 'gone' | 'unchanged' | 'contended'; rev: number };

export function createRoomPersistence(deps: RoomPersistenceDeps): RoomPersistence {
  const { store } = deps;

  const audit = (action: string, subject: string, payload: Record<string, unknown>) =>
    store.appendAudit({ at: new Date().toISOString(), actor: 'system', action, subject, payload });

  /**
   * Write the room's document as the next revision of a session. The shape `PUT
   * /api/v1/sessions/:id` writes, with `actor: 'collab'` and `updatedBy` kept a
   * real user (it is a FK in Postgres).
   *
   * IT IS A CAS, AND IT RE-DERIVES ON A LOSS - which is what makes the merge
   * documented on `docToInputs` ("the room wins what it edited, the PUT keeps
   * everything else") true rather than merely intended. `derive` is called with the
   * base that was ACTUALLY read this attempt, so a PUT that lands mid-write-back is
   * merged with rather than overwritten; the CAS then refuses if that base moved
   * again, and the whole thing repeats. An un-CAS'd read-modify-write here would
   * instead: discard the PUT's inputs AND its `meta` wholesale, leave
   * `session_revisions` recording the user's revision while `sessions.inputs` holds
   * the room's (the revision PK is `(session_id, rev)`, so the room's row is the one
   * `on conflict do nothing` drops) - a silent divergence in an audited control
   * plane - and, when the racing request was a DELETE, write `deleted_at` back as
   * NULL and resurrect a tombstoned session. `casSession` cannot do any of those.
   */
  const commit = async (
    sessionId: string,
    derive: (base: SessionRecord) => Record<string, unknown>,
    writer: RoomWriter | null,
  ): Promise<CommitOutcome> => {
    let lastRev = 0;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      const session = await store.getSession(sessionId);
      if (!session || session.deletedAt) return { ok: false, why: 'gone', rev: session?.rev ?? 0 };
      lastRev = session.rev;
      const inputs = derive(session);
      if (isDeepStrictEqual(inputs, session.inputs)) return { ok: false, why: 'unchanged', rev: session.rev };
      const now = new Date().toISOString();
      const rev = session.rev + 1;
      const next: SessionRecord = {
        ...session,
        inputs,
        rev,
        // A guest is not a `users(id)` row, so it can only ever be attributed on
        // the revision below - see `RoomWriter`.
        updatedBy: writer?.kind === 'member' ? writer.userId : session.updatedBy,
        updatedAt: now,
      };
      if (!(await store.casSession(next, session.rev))) continue; // somebody moved it - re-read and re-merge
      await store.appendSessionRevision({
        sessionId, rev, inputs, meta: session.meta, actor: roomRevisionActor(writer), at: now,
      });
      return { ok: true, rev, session: next };
    }
    return { ok: false, why: 'contended', rev: lastRev };
  };

  return {
    async hydrate(passed) {
      // Re-read rather than trusting the caller's copy. The gateway's record was
      // read at UPGRADE time, and a room re-opened straight after its predecessor
      // quiesced is handed the pre-quiesce record by construction - seeding from
      // either would silently undo work that is already a revision.
      const session = (await store.getSession(passed.id)) ?? passed;
      const snap = await store.getCollabSnapshot(session.id);
      const plain: HydrateResult = { inputs: session.inputs, rev: session.rev, recovered: false };
      if (!snap) return plain;

      // Three ways a surviving row is NOT a lost quiesce, all of which mean "drop
      // it and seed normally": the stored session has moved on under it (an
      // ordinary PUT superseded the room), the room never accepted an op, or the
      // snapshot says exactly what the session already says.
      if (snap.baseRev !== session.rev || snap.ops <= 0 || isDeepStrictEqual(snap.inputs, session.inputs)) {
        await store.deleteCollabSnapshot(session.id);
        return plain;
      }

      // A crash lost this room's quiesce. Land it as a revision NOW rather than
      // only on the next quiesce: the recovering join might be a reader who never
      // writes, and the recovered work must not depend on someone else's gesture
      // to become durable.
      const out = await commit(session.id, () => snap.inputs, null);
      await store.deleteCollabSnapshot(session.id);
      if (!out.ok) {
        // Lost the race the `baseRev` check was guarding: something moved the
        // session between the two reads. Same verdict as a stale row - seed from
        // whatever is stored NOW, never from a base we know has moved.
        const fresh = (await store.getSession(session.id)) ?? session;
        return { inputs: fresh.inputs, rev: fresh.rev, recovered: false };
      }
      await audit('collab.recover', `session:${session.id}`, {
        rev: out.rev, basedOnRev: snap.baseRev, ops: snap.ops, snapshotAt: snap.updatedAt,
        projectId: session.projectId, toolId: session.toolId,
      });
      return { inputs: snap.inputs, rev: out.rev, recovered: true };
    },

    async snapshot(sessionId, doc, ops) {
      const session = await store.getSession(sessionId);
      // Vanished or tombstoned mid-room: there is nothing to recover INTO, and a
      // surviving row would resurrect a deleted session on the next join.
      if (!session || session.deletedAt) {
        await store.deleteCollabSnapshot(sessionId);
        return;
      }
      const inputs = doc.toInputs(session.inputs);
      // Nothing to recover - including the ops-that-cancelled-out case, where the
      // room is busy but has converged back onto what is already stored.
      if (ops <= 0 || isDeepStrictEqual(inputs, session.inputs)) {
        await store.deleteCollabSnapshot(sessionId);
        return;
      }
      await store.putCollabSnapshot({
        sessionId, inputs, baseRev: session.rev, ops, updatedAt: new Date().toISOString(),
      });
    },

    async quiesce(sessionId, doc, opts) {
      if (opts.ops <= 0) {
        // A room that read but never changed anything writes NO revision. History
        // is bounded at SESSION_REVISION_LIMIT, so a revision per join/leave churn
        // would evict real history to record that nothing happened.
        await store.deleteCollabSnapshot(sessionId);
        return { written: false, rev: (await store.getSession(sessionId))?.rev ?? 0 };
      }
      // The "nothing actually changed" test lives INSIDE the commit loop, because
      // it is a question about the base that is finally written against, not about
      // the one first read.
      const out = await commit(sessionId, (base) => doc.toInputs(base.inputs), opts.actor);
      await store.deleteCollabSnapshot(sessionId);
      if (!out.ok) return { written: false, rev: out.rev };
      await audit('collab.quiesce', `session:${sessionId}`, {
        rev: out.rev,
        // When these differ, an ordinary PUT landed while the room was live and
        // the write-back was a per-input-id merge rather than a clean succession.
        basedOnRev: opts.baseRev,
        supersededRev: out.rev - 1,
        ops: opts.ops,
        projectId: out.session.projectId,
        toolId: out.session.toolId,
      });
      return { written: true, rev: out.rev };
    },
  };
}
