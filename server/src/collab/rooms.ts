// SPDX-License-Identifier: MPL-2.0
/**
 * Collab rooms - the live-session document authority (plans/14 §6, OSS
 * plans/100 §7). One room per session id; the room owns the converged document,
 * the roster, the presence relay, and the per-room edit counters the audit
 * rollup reads on close. The gateway (gateway.ts) owns sockets, auth, and
 * policy; this module owns state.
 *
 * DOCUMENT AUTHORITY - `ReferenceCanvasDoc`, from the pinned contract.
 * plans/14 §6 targets single-node rooms ("one node serves the org"), and for a
 * single doc the reference CRDT and the Yjs adapter are conformance-equivalent:
 * both resolve every register by the op's `(clock, client)` Lamport origin, and
 * both pass the SAME `runConvergenceSuite` bytes. The reference has no `yjs`
 * dependency and no update log to compact, so it is the correct v1 authority;
 * `yjs-canvas-adapter.ts` stays the multi-replica path (plans/14 §8 follow-up),
 * untouched by this wave. Both implement `CanvasSyncAdapter`, so the swap is a
 * constructor change here and nothing else.
 *
 * STRUCTURAL RULE (OSS plans/100 §7 item 5, plans/99 §5). This module imports
 * NOTHING from `../policy` or `../rbac`, and the ENTIRE presence path lives
 * inside it. Presence therefore cannot be policy-checked - not by convention or
 * by a reviewer remembering, but because the code that relays it has no way to
 * reach the policy engine. tests/collab/gateway.test.ts asserts the absence of
 * those imports, so re-introducing one is a test failure. Presence likewise
 * never reaches the store: the only copy is the in-memory `presence` map, which
 * dies with the room (it exists so a joiner gets the current set, plans/100 §4.7).
 * This module STILL has no store import after persistence landed - the room is
 * handed a `RoomPersistence` instance and hands it back only `toInputs()`, a
 * seam that can express a document and nothing else.
 *
 * PERSISTENCE (plans/100 §7 items 3 + 4, plans/14 §6) lives in persistence.ts;
 * this module owns the CADENCE and the LIFECYCLE. A room snapshots every
 * SNAPSHOT_EVERY_BATCHES batches or SNAPSHOT_EVERY_OPS ops, whichever lands
 * first; on disposal it quiesces into a normal session revision. Rooms are
 * therefore created and destroyed ASYNCHRONOUSLY (`Room.open`,
 * `RoomRegistry.acquire`/`releaseIfEmpty`), and the registry serializes the two
 * against each other: a room re-acquired while its predecessor is still writing
 * its revision waits for that write, or it would seed from pre-quiesce inputs and
 * silently undo the edit that just landed.
 */
import {
  DEFAULT_GEOMETRY_FIELDS,
  ReferenceCanvasDoc,
  damageToOps,
  isOpSendableTo,
  CANVAS_OP_VERSION,
} from '@lolly-tools/core/canvas-op-v1';
import type {
  BoxId,
  BoxRow,
  CanvasDocState,
  CanvasOp,
  OpOrigin,
  ParamValue,
  Presence,
  Scalar,
} from '@lolly-tools/core/canvas-op-v1';
import type { SessionRecord } from '../store/types.ts';
import {
  EMPTY_GRACE_MS, SNAPSHOT_EVERY_BATCHES, SNAPSHOT_EVERY_OPS, docToInputs,
} from './persistence.ts';
import type { QuiesceResult, RoomPersistence, RoomWriteback, RoomWriter } from './persistence.ts';

// ── caps + limits (OSS plans/100 §7 item 5, §11.21) ───────────────────────────

/** Writers per room; the next eligible joiner becomes an observer and is told
 *  why ("room full, view only" - plans/100 §7 item 5). */
export const WRITER_CAP = 10;
/** Writer seats ONE user may hold in one room. WRITER_CAP is per room, so without
 *  this a single account with several tabs (or a script) could take every seat and
 *  leave the room's actual collaborators view-only. */
export const WRITER_CAP_PER_USER = 3;
/** Presence frames per client per second before the socket is closed (§11.21). */
export const PRESENCE_FRAMES_PER_SEC = 40;
/** Ops accepted in one `ops` message before the socket is closed (§11.21). */
export const MAX_OPS_PER_MESSAGE = 200;
/** Longest string a single scalar may carry across the seam. */
export const MAX_SCALAR_CHARS = 32_768;
/** Most fields one box row may carry. */
export const MAX_ROW_FIELDS = 200;
/** Cursor-chat ceiling - the contract's own limit (plans/100 §3). */
export const MAX_CHAT_CHARS = 64;

// ── ceilings on the DOCUMENT, not the frame ──────────────────────────────────
//
// MAX_ROW_FIELDS and MAX_SCALAR_CHARS bound ONE row; nothing bounded the number of
// rows, collections or params, and `ReferenceCanvasDoc.ensure` mints a box for any
// (col, id) pair it has not seen. So an authorized writer could grow a room's
// document - and the whole-document jsonb the snapshot cadence serialises every 20
// batches - without limit. These are the ceilings that make a room's memory and its
// snapshot row a bounded quantity. Every one is far above a real tool session (a
// large deck is tens of rows), so tripping one means something is wrong, not busy.

/** Distinct scalar inputs one room's document may hold. */
export const MAX_PARAMS_PER_ROOM = 512;
/** Distinct collections (blocks input ids) one room's document may hold. */
export const MAX_COLLECTIONS_PER_ROOM = 64;
/** Distinct box ids one collection may hold, alive or removed (a tombstone is
 *  still a box the CRDT must remember). */
export const MAX_BOXES_PER_COLLECTION = 2_000;
/** Distinct `origin.client` ids whose Lamport high-water mark a room tracks. The
 *  key is peer-chosen and unbounded in cardinality, so the replay filter needs a
 *  ceiling of its own. */
export const MAX_TRACKED_CLIENTS = 512;

/** Keys that must never index a plain object, refused at the boundary - the
 *  enum/prototype-key discipline (plans/100 §11.21).
 *
 *  This is a NARROWING, not the defence. A deny-list can only name the keys
 *  somebody thought of, and `Object.prototype` has more of them than three:
 *  `toString`, `valueOf` and `hasOwnProperty` are inherited members too, and each
 *  would have turned `overlay.inputAccess[inputId]` into a truthy, non-iterable
 *  function. The lookup itself is what had to be fixed, and was - `resolveInputAccess`
 *  reads its table through an own-property check (policy/overlay.ts). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeKey(key: string): boolean {
  return key.length > 0 && key.length <= 256 && !UNSAFE_KEYS.has(key);
}

// ── the wire protocol (JSON) ──────────────────────────────────────────────────
//
// Frame types live here rather than in gateway.ts because the room is what emits
// most of them. `error` carries a code string; the codes themselves are the
// gateway's (it is the only side that can produce them) - a union of strings is
// data, not a policy import.

export type MemberRole = 'writer' | 'observer';

/** Why a would-be writer was seated as an observer. */
export type JoinNotice = 'room-full-view-only' | 'op-version-observer' | 'no-edit-grant';

export interface RosterEntry {
  id: string;
  userId: string;
  name: string;
  role: MemberRole;
  opVersion: string;
  /** Their last presence frame, when they have sent one. Ephemeral - see the
   *  structural rule above. */
  presence?: Presence;
}

/** The document as JSON - `CanvasDocState` uses Maps, which JSON cannot carry. */
export interface WireDocState {
  order: BoxId[];
  boxes: Record<BoxId, BoxRow>;
  params: Record<string, ParamValue>;
  collections?: Record<string, { order: BoxId[]; boxes: Record<BoxId, BoxRow> }>;
}

export type ServerFrame =
  | {
      t: 'join-ack';
      roster: RosterEntry[];
      docState: WireDocState;
      serverClock: number;
      opVersion: string;
      you: RosterEntry;
      notice?: JoinNotice;
      /** Input ids in the stored session that v1.1 cannot sync (see
       *  `seedOpsFromInputs`) - declared so a client shows them read-only
       *  instead of silently diverging. */
      unsynced?: string[];
    }
  | { t: 'peer-join'; member: RosterEntry }
  | { t: 'peer-leave'; id: string }
  | { t: 'ops'; ops: CanvasOp[]; from: string }
  | { t: 'presence'; frame: Presence; from: string }
  | { t: 'error'; code: string; message: string; inputs?: string[] };

export interface RoomMember {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly role: MemberRole;
  /** The client's CANVAS_OP_VERSION, negotiated at join (plans/99 §9). Used
   *  per-peer on broadcast so a v1.0 peer never receives a collection-scoped op
   *  it would mis-route (`isOpSendableTo`). */
  readonly opVersion: string;
  /** Set when this seat is a GUEST admitted by a guest-edit link (plans/02 §8,
   *  plans/14 §6) rather than a signed-in member, and carrying the link id - 
   *  which IS a guest's principal id (`iam/sessions.ts` `guestActor`).
   *
   *  The room needs it for exactly one thing: attribution on the write-back. A
   *  guest is not a row in `users`, and `sessions.updated_by` is a foreign key to
   *  one, so the ABSENCE of this field is what keeps a guest's edit out of that
   *  column - and its presence is what puts an honest `guest:<linkId>` on the
   *  revision instead of letting the room fall back to something that reads as a
   *  member (see persistence.ts `RoomWriter`). Nothing else here branches on it:
   *  a guest is seated, counted, capped, relayed and broadcast exactly like a
   *  member, because that is the whole point of "the same room, not a separate
   *  mechanism". */
  readonly guestLinkId?: string;
  readonly send: (frame: ServerFrame) => void;
}

/** One seated member, as exposed to admin introspection: display name, role,
 *  and when they joined. No `userId`, no `opVersion`, no `send` - the admin
 *  console's Rooms panel (OSS plans/100 §7, plans/14 §6) needs "who's in here
 *  and can they write", not an identity to correlate against, and never the
 *  live closure that could be used to push a frame from outside the room. */
export interface RoomMemberSnapshot {
  name: string;
  role: MemberRole;
  joinedAt: number;
}

/** A room's live state, COPIED out for admin introspection - counters, roles
 *  and display names, never a presence payload or an input value
 *  (keys-never-values, plans/100 §7 item 5 / §11.21). `Room.snapshotForAdmin`
 *  builds one of these; `RoomRegistry.list` is the whole registry's worth. */
export interface RoomSnapshot {
  sessionId: string;
  toolId: string;
  memberCount: number;
  writerCount: number;
  observerCount: number;
  members: RoomMemberSnapshot[];
  opsApplied: number;
  startedAt: number;
}

/**
 * The SIZE of the maps a room grows PER CONNECTION/PER GESTURE as members and
 * clients come and go - numbers only, never a key, an id, a name or a value. A
 * room lives for hours and every one of these is fed by something a peer
 * controls (a connection, a presence frame, a peer-chosen `origin.client`), so
 * "does it come back down when everyone leaves" is a property worth asserting
 * rather than reading.
 *
 * NOT every map: `seenUsers`/`opsByUser` (below `highestClock` in the class)
 * are deliberately absent. They feed `rollup()`'s audit accounting at room
 * close ("distinct users", "ops per user") and are never evicted - eviction
 * there would silently under-report the audit trail, the opposite trade
 * `noteClock`'s eviction makes for a map that is correctness-neutral. They are
 * bounded by distinct PRINCIPALS seen in one room's life (real users, or for a
 * guest room, link ids) rather than by an explicit ceiling, so they are not
 * "unbounded" in the sense `trackedClients` guards against, but they also do
 * not "come back to baseline" the way the fields below do - a churn assertion
 * over this type proves only what it names.
 *
 * Introspection for tests (tests/collab/gateway-soak.test.ts's churn case), not
 * an admin surface: `RoomSnapshot` is what the console sees, and this is
 * deliberately not part of it.
 */
export interface RoomInternals {
  /** Seated members. */
  members: number;
  /** Join timestamps held - must track `members` exactly. */
  joinedAt: number;
  /** Last-presence frames held - one per member that has sent one. */
  presence: number;
  /** Clients in the replay filter. Bounded by MAX_TRACKED_CLIENTS, and by
   *  eviction rather than by leave: see `noteClock`. */
  trackedClients: number;
  /** Distinct param keys the document holds. */
  paramKeys: number;
  /** Distinct collections the document holds. */
  collections: number;
}

/** What the audit rollup reports when a room closes (plans/14 §6 - counters,
 *  never keystrokes; input KEYS, never values). */
export interface RoomRollup {
  sessionId: string;
  projectId: string;
  toolId: string;
  /** Distinct users seen in the room over its lifetime. */
  users: number;
  /** Ops accepted (after the policy veto) over the room's lifetime. */
  ops: number;
  /** Accepted ops per userId. */
  byUser: Record<string, number>;
  /** Input ids touched, sorted. Keys only. */
  keys: string[];
  /** Room lifetime in ms. */
  ms: number;
}

// ── seeding the document from a stored session ────────────────────────────────

/**
 * Seed ops carry clock 0 and a reserved client id, so ANY real client op (whose
 * Lamport clock starts at 1) beats the seed on every key. The room's document is
 * therefore a floor, never a competitor.
 */
export const SEED_ORIGIN: OpOrigin = { client: 'lw:seed', clock: 0 };

export interface SeedResult {
  ops: CanvasOp[];
  /** Input ids left OUT of the document - see the mapping note below. */
  unsynced: string[];
}

function isScalar(v: unknown): v is Scalar {
  return v === null || typeof v === 'string' || typeof v === 'boolean'
    || (typeof v === 'number' && Number.isFinite(v));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `SessionRecord.inputs` → canvas-op v1.1 document ops.
 *
 * THE MAPPING (plans/100 §3, "a tool session is scalars + block collections,
 * and both shapes exist in the doc model"). `inputs` is the tool's input model
 * keyed by declared input id, values as the shell saved them:
 *
 *   scalar value (string | finite number | boolean | null)
 *       → one `ParamOp`, `key` = the input id. Per-input LWW, the `params` lane.
 *
 *   array of objects (a `blocks` input - slides, rows, boxes …)
 *       → one COLLECTION scoped by `col` = the input id, one `AddOp` per row,
 *         minted through the contract's own `damageToOps` so the fractional
 *         order keys come from the same generator clients use (no second copy
 *         of `keyAfter` to drift). A row's BoxId is its stored `id` when that is
 *         a safe non-empty string, else the deterministic `"<inputId>#<index>"`
 * - deterministic so re-seeding the same stored bytes yields the same
 *         ids. Stable ULIDs at row creation are the shell's job (plans/100 §3
 *         "hard prerequisite"); this fallback only keeps legacy rows joinable.
 *         Row fields are the row's own SCALAR properties; a nested object or
 *         array inside a row is dropped (the contract's `BoxRow` is flat and
 *         `Scalar`-valued by design, plans/99 §7).
 *
 *   anything else (nested object, array of non-objects, `file` bytes, …)
 *       → NOT synced. Reported in `unsynced` and echoed to clients in the
 *         join-ack, because "we silently dropped this input" is the one outcome
 *         a governed instance must never produce. plans/100 §3 excludes `file`
 *         inputs from Track B by name; everything else here is the honest v1.1
 *         syncable subset.
 *
 * NOTE the deliberate absence of the DEFAULT (unscoped) canvas collection: every
 * blocks input becomes a NAMED collection, because the input id is the only
 * thing the policy overlay can govern. The gateway refuses unscoped box ops for
 * exactly that reason (see `governedInputId`).
 */
export function seedOpsFromInputs(inputs: Record<string, unknown>): SeedResult {
  const ops: CanvasOp[] = [];
  const unsynced: string[] = [];
  for (const inputId of Object.keys(inputs).sort()) {
    if (!isSafeKey(inputId)) {
      unsynced.push(inputId);
      continue;
    }
    const value = inputs[inputId];
    if (isScalar(value)) {
      if (typeof value === 'string' && value.length > MAX_SCALAR_CHARS) {
        unsynced.push(inputId);
        continue;
      }
      ops.push({ k: 'param', key: inputId, value, origin: SEED_ORIGIN });
      continue;
    }
    const rows = blockRows(inputId, value);
    if (rows) {
      ops.push(...damageToOps(new Map(), rows, SEED_ORIGIN, DEFAULT_GEOMETRY_FIELDS, inputId));
      continue;
    }
    unsynced.push(inputId);
  }
  return { ops, unsynced };
}

/** An array of plain objects → the collection's rows, in stored order. Anything
 *  else → null (the caller records it as unsynced). */
function blockRows(inputId: string, value: unknown): Map<BoxId, BoxRow> | null {
  if (!Array.isArray(value)) return null;
  if (!value.every(isPlainObject)) return null;
  const rows = new Map<BoxId, BoxRow>();
  value.forEach((raw, i) => {
    const stored = raw['id'];
    const fallback = `${inputId}#${i}`;
    const id = typeof stored === 'string' && stored.length > 0 && stored.length <= 256
      && isSafeKey(stored) && !rows.has(stored)
      ? stored
      : fallback;
    if (rows.has(id)) return; // duplicate synthetic id - cannot happen, but never overwrite
    const row: BoxRow = {};
    let fields = 0;
    for (const [key, v] of Object.entries(raw)) {
      if (!isSafeKey(key) || !isScalar(v)) continue;
      if (typeof v === 'string' && v.length > MAX_SCALAR_CHARS) continue;
      if (++fields > MAX_ROW_FIELDS) break;
      row[key] = v;
    }
    rows.set(id, row);
  });
  return rows;
}

// ── presence sanitation (NO policy - see the structural rule) ─────────────────

function clampString(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  // Strip C0/C1 controls so a relayed frame cannot smuggle terminal escapes.
  const clean = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, max);
  return clean.length ? clean : undefined;
}

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(-1e6, Math.min(1e6, v)) : fallback;
}

function idList(v: unknown, max: number): BoxId[] {
  if (!Array.isArray(v)) return [];
  const out: BoxId[] = [];
  for (const item of v) {
    if (out.length >= max) break;
    const s = clampString(item, 256);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Rebuild an untrusted presence frame as a known-shaped `Presence`, stamping the
 * SERVER's identity over whatever the client claimed. A relayed frame is shown to
 * other people, so `userId`/`name` are the authenticated ones or nothing - a peer
 * must not be able to appear as a colleague. Everything else is clamped, never
 * rejected: a dropped cursor frame is invisible, a refused one is a stutter.
 *
 * This is shape hardening, not authorization: it consults no overlay, no grant,
 * no store, and it lives in the module that cannot reach any of them.
 */
export function sanitizePresence(raw: unknown, member: RoomMember): Presence {
  const src = isPlainObject(raw) ? raw : {};
  const cursor = isPlainObject(src['cursor']) ? src['cursor'] : {};
  const viewport = isPlainObject(src['viewport']) ? src['viewport'] : null;
  const drag = isPlainObject(src['drag']) ? src['drag'] : null;
  const frame: {
    -readonly [K in keyof Presence]: Presence[K];
  } = {
    userId: member.userId,
    name: member.name,
    color: clampString(src['color'], 32) ?? '',
    cursor: { x: finite(cursor['x'], 0), y: finite(cursor['y'], 0) },
    selection: idList(src['selection'], 200),
  };
  if (drag) {
    const dxy = Array.isArray(drag['dxy']) ? drag['dxy'] : [];
    frame.drag = { ids: idList(drag['ids'], 200), dxy: [finite(dxy[0], 0), finite(dxy[1], 0)] };
  }
  const focus = clampString(src['focus'], 256);
  if (focus) frame.focus = focus;
  const location = clampString(src['location'], 256);
  if (location) frame.location = location;
  const following = clampString(src['following'], 256);
  if (following) frame.following = following;
  if (viewport) {
    frame.viewport = {
      x: finite(viewport['x'], 0),
      y: finite(viewport['y'], 0),
      zoom: finite(viewport['zoom'], 1),
    };
  }
  const chat = clampString(src['chat'], MAX_CHAT_CHARS);
  if (chat) frame.chat = chat;
  return frame;
}

// ── the room ──────────────────────────────────────────────────────────────────

export class Room implements RoomWriteback {
  readonly sessionId: string;
  readonly projectId: string;
  readonly toolId: string;
  /** Input ids the seed could not express - surfaced in every join-ack. */
  readonly unsynced: string[];
  readonly openedAt = Date.now();
  /** The session rev this room's document was seeded from. Carried into the
   *  quiesce audit so a write-back that had to merge with a concurrent PUT is
   *  visible as such rather than looking like clean succession. */
  readonly baseRev: number;
  /** True when the seed came from a snapshot a crashed process left behind. */
  readonly recovered: boolean;

  private readonly doc: ReferenceCanvasDoc;
  private readonly members = new Map<string, RoomMember>();
  /** When each currently-seated member joined - `snapshotForAdmin`'s only use.
   *  Cleared on leave, same as `presenceOf`: an admin snapshot is about who is
   *  in the room NOW, not a join-history log this module has no business
   *  keeping. */
  private readonly joinedAtOf = new Map<string, number>();
  /** Last presence per member id. In-memory only; dies with the room. */
  private readonly presenceOf = new Map<string, Presence>();
  private readonly seenUsers = new Set<string>();
  private readonly opsByUser = new Map<string, number>();
  private readonly touchedKeys = new Set<string>();
  private opTotal = 0;
  private serverClock = 0;

  /** Highest Lamport clock accepted per client - the outbox-replay filter
   *  (plans/100 §7 item 10). Bounded: see `noteClock`. */
  private readonly highestClock = new Map<string, number>();
  /** Param keys the document holds, and the box ids per collection - the counters
   *  `admits` reads. They shadow what the document already stores rather than
   *  reaching into it, because the pinned contract exposes its state only as a
   *  freshly-built snapshot and admission is a per-op question. */
  private readonly paramKeys = new Set<string>();
  private readonly boxIds = new Map<string, Set<BoxId>>();
  /** The last principal whose ops were accepted. A MEMBER becomes
   *  `SessionRecord.updatedBy` on quiesce, because that column is a FK to a real
   *  user and 'collab' is not one; a GUEST cannot be (it is not a user row) and is
   *  attributed on the revision instead. persistence.ts `RoomWriter` owns that
   *  split - the room only has to remember which kind of writer it saw. */
  private lastWriter: RoomWriter | null = null;

  private readonly persistence: RoomPersistence | undefined;
  private batchesSinceSnapshot = 0;
  private opsSinceSnapshot = 0;
  /** Snapshot writes, serialized - two overlapping writes could land out of
   *  order and leave the older document as the recovery row. Quiesce awaits this
   *  chain so a late snapshot cannot rewrite the row quiesce just deleted. */
  private writes: Promise<void> = Promise.resolve();
  private closed = false;

  /** Construct through `Room.open` / `RoomRegistry.acquire` - seeding is async
   *  (it may have to recover and commit a crash-lost quiesce first). */
  private constructor(session: SessionRecord, persistence: RoomPersistence | undefined, hydrated: {
    inputs: Record<string, unknown>; rev: number; recovered: boolean;
  }) {
    this.sessionId = session.id;
    this.projectId = session.projectId;
    this.toolId = session.toolId;
    this.persistence = persistence;
    this.baseRev = hydrated.rev;
    this.recovered = hydrated.recovered;
    this.doc = new ReferenceCanvasDoc('lw:room');
    const seed = seedOpsFromInputs(hydrated.inputs);
    for (const op of seed.ops) {
      this.doc.apply(op);
      this.note(op);
    }
    this.unsynced = seed.unsynced;
  }

  /**
   * Open a room for a session. With persistence attached this is where crash
   * recovery happens: a snapshot row that outlived its process is committed as a
   * revision and becomes the seed, so the first joiner after a restart sees the
   * work the crash swallowed rather than the last clean save.
   */
  static async open(session: SessionRecord, persistence?: RoomPersistence): Promise<Room> {
    if (!persistence) return Room.create(session);
    const hydrated = await persistence.hydrate(session);
    return new Room(session, persistence, hydrated);
  }

  /**
   * A room with NO persistence, seeded synchronously from the session's stored
   * inputs - `open` minus the hydrate step it only has when there is a store to
   * hydrate from (the branch this replaces was already synchronous in all but
   * type). Behaviour is identical; `open` still returns a promise, and is still
   * the only way to get a persisted room.
   *
   * It exists as its own entry point because two callers need a room WITHOUT
   * awaiting: the `CanvasSyncAdapter` factory the shared conformance suite takes
   * is synchronous by contract (`() => CanvasSyncAdapter`, plans/99 §8), and
   * rooms.ts's own in-memory cases have no reason to be async at all.
   */
  static create(session: SessionRecord): Room {
    return new Room(session, undefined, { inputs: session.inputs, rev: session.rev, recovered: false });
  }

  get size(): number {
    return this.members.size;
  }

  writerCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.role === 'writer') n++;
    return n;
  }

  /** Writer seats this user already holds - the per-user half of WRITER_CAP. */
  writerCountFor(userId: string): number {
    let n = 0;
    for (const m of this.members.values()) if (m.role === 'writer' && m.userId === userId) n++;
    return n;
  }

  /**
   * May this op be applied without taking the document past one of its ceilings?
   * Asked by the gateway as the LAST veto, because it is the only one that depends
   * on room state rather than on policy. A refusal is reported to the sender like
   * any other veto; it is never silent.
   *
   * Note that every box op is counted, not just `add`: the contract's `ensure`
   * materialises a box for any `(col, id)` it has not seen, so a `geom`, `field`,
   * `order` or even a `remove` naming a fresh id mints one just as an `add` does.
   */
  admits(op: CanvasOp): boolean {
    if (op.k === 'param') {
      return this.paramKeys.has(op.key) || this.paramKeys.size < MAX_PARAMS_PER_ROOM;
    }
    const col = op.col;
    // An unscoped box op targets the default canvas collection, which names no
    // input; the gateway refuses those before this is ever asked.
    if (col === undefined) return true;
    const ids = this.boxIds.get(col);
    if (ids === undefined) return this.boxIds.size < MAX_COLLECTIONS_PER_ROOM;
    return ids.has(op.id) || ids.size < MAX_BOXES_PER_COLLECTION;
  }

  /** Record what an applied op added to the document. */
  private note(op: CanvasOp): void {
    if (op.k === 'param') {
      this.paramKeys.add(op.key);
      return;
    }
    const col = op.col;
    if (col === undefined) return;
    let ids = this.boxIds.get(col);
    if (ids === undefined) {
      ids = new Set<BoxId>();
      this.boxIds.set(col, ids);
    }
    ids.add(op.id);
  }

  /**
   * Record a client's Lamport high-water mark, evicting the oldest entry when the
   * map is full. Eviction rather than refusal, deliberately: this map is a REPLAY
   * filter, not correctness - the CRDT converges under a replay either way - so the
   * cost of forgetting a client is one re-broadcast, while an unbounded map keyed
   * by a peer-chosen string is a leak for the whole life of the room.
   */
  private noteClock(client: string, clock: number): void {
    if (!this.highestClock.has(client) && this.highestClock.size >= MAX_TRACKED_CLIENTS) {
      const oldest = this.highestClock.keys().next();
      if (!oldest.done) this.highestClock.delete(oldest.value);
    }
    this.highestClock.set(client, clock);
  }

  /** Seat a member and tell the peers. Returns the join-ack payload minus the
   *  bits only the gateway knows (notice). Roster EXCLUDES the joiner - a new
   *  arrival that sees itself in the roster renders an orphan ghost of itself
   *  (plans/100 §4.7). */
  join(member: RoomMember): {
    roster: RosterEntry[];
    docState: WireDocState;
    serverClock: number;
    opVersion: string;
    you: RosterEntry;
    unsynced?: string[];
  } {
    const roster = this.roster();
    this.members.set(member.id, member);
    this.joinedAtOf.set(member.id, Date.now());
    this.seenUsers.add(member.userId);
    const you = this.entry(member);
    this.broadcast({ t: 'peer-join', member: you }, member.id);
    return {
      roster,
      docState: this.snapshot(),
      serverClock: this.serverClock,
      opVersion: CANVAS_OP_VERSION,
      you,
      ...(this.unsynced.length ? { unsynced: this.unsynced } : {}),
    };
  }

  leave(memberId: string): void {
    if (!this.members.delete(memberId)) return;
    this.joinedAtOf.delete(memberId);
    this.presenceOf.delete(memberId);
    this.broadcast({ t: 'peer-leave', id: memberId });
  }

  /**
   * Apply already-authorized ops to the document, then fan them out to every
   * OTHER member. Ops arrive here only after the gateway's policy veto, so this
   * method never decides anything - it applies and relays.
   *
   * REPLAY DEDUP first (plans/100 §7 item 10). A client that lost the connection
   * replays its IDB outbox on rejoin, so the room must be able to see the same op
   * twice. The document already converges under a replay - the reference CRDT's
   * LWW comparison is strict, so re-applying an op is a no-op - but the COUNTERS
   * and the BROADCAST are not idempotent on their own: a replay would inflate the
   * audit rollup and re-deliver ops peers already applied. Dedup is per client by
   * highest accepted Lamport clock, and the whole batch is filtered against the
   * PRE-BATCH high-water mark before any of it is recorded: one gesture mints one
   * origin for all of its ops, so recording as we went would let an op's own
   * clock cancel the rest of its gesture.
   *
   * Per-peer send gating is the contract's own `isOpSendableTo`: a v1.0 peer must
   * not receive a collection-scoped op, which it would mis-route as a canvas-box
   * write (canvas-op-v1's note on `col` changing an op's ROUTING, not just its
   * payload).
   */
  applyOps(from: RoomMember, ops: readonly CanvasOp[]): void {
    const fresh = ops.filter((op) => {
      const seen = this.highestClock.get(op.origin.client);
      return seen === undefined || op.origin.clock > seen;
    });
    if (!fresh.length) return; // a pure replay: converged already, and nobody needs to hear it again
    for (const op of fresh) this.ingestOp(op, from.userId);
    this.lastWriter = from.guestLinkId
      ? { kind: 'guest', linkId: from.guestLinkId }
      : { kind: 'member', userId: from.userId };
    for (const peer of this.members.values()) {
      if (peer.id === from.id) continue;
      const sendable = fresh.filter((op) => isOpSendableTo(op, peer.opVersion));
      if (sendable.length) peer.send({ t: 'ops', ops: sendable, from: from.id });
    }
    this.noteBatch(fresh.length);
  }

  /**
   * THE DOCUMENT DOOR: apply ONE already-authorized op to this room's document
   * and record what it did to the room's counters. Lifted verbatim out of
   * `applyOps`'s loop - that method is now exactly "the replay filter, then this
   * per op, then the fan-out and the snapshot cadence", and nothing else in the
   * server calls this directly.
   *
   * It is its own method so the document authority can be driven WITHOUT a
   * socket and without the replay filter in front of it, which is what the
   * shared conformance suite needs (tests/collab/room-conformance.test.ts runs
   * `runConvergenceSuite` through here). That is not a loophole around the
   * filter: the filter is a per-`origin.client` high-water mark, i.e. a
   * TRANSPORT-level dedup that is deliberately order-SENSITIVE, while the
   * property the suite asserts is that the DOCUMENT is order-INDEPENDENT. Both
   * are true at once, and driving the suite through the filter would assert
   * something the filter never promised.
   */
  ingestOp(op: CanvasOp, userId: string): void {
    this.doc.apply(op);
    this.note(op);
    const seen = this.highestClock.get(op.origin.client);
    if (seen === undefined || op.origin.clock > seen) this.noteClock(op.origin.client, op.origin.clock);
    if (op.origin.clock > this.serverClock) this.serverClock = op.origin.clock;
    this.opTotal++;
    this.opsByUser.set(userId, (this.opsByUser.get(userId) ?? 0) + 1);
    const key = op.k === 'param' ? op.key : op.col;
    if (key !== undefined) this.touchedKeys.add(key);
  }

  /**
   * THE PRESENCE PATH, in full. Sanitize (shape only), remember for the next
   * joiner, relay to peers. It touches no policy, no grant, no overlay, and no
   * store - and it cannot, because this module imports none of them. Observers
   * relay presence exactly like writers: the lane is structurally unauthorized
   * (plans/100 §7 item 5).
   */
  relayPresence(from: RoomMember, raw: unknown): void {
    const frame = sanitizePresence(raw, from);
    this.presenceOf.set(from.id, frame);
    this.broadcast({ t: 'presence', frame, from: from.id }, from.id);
  }

  /** The converged document as JSON. Every joiner gets the WHOLE thing in its
   *  join-ack - plans/100 §7 item 4 chose Figma's blunt full-refetch over a
   *  clock-diff, because an input-model document is KBs and "all of the
   *  complexity is in updates to already connected documents". */
  snapshot(): WireDocState {
    return toWire(this.doc.state());
  }

  /** The `RoomWriteback` seam: the converged document expressed as session
   *  inputs, over the inputs currently stored. Scoped to the input ids this room
   *  actually accepted ops for - the same key set the audit rollup reports - so a
   *  room never writes back an input nobody in it touched (see persistence.ts
   *  `docToInputs` for why that matters). */
  toInputs(base: Record<string, unknown>): Record<string, unknown> {
    return docToInputs(this.doc.state(), base, this.touchedKeys);
  }

  /** Ops accepted over the room's lifetime - the cadence and "is there anything
   *  to recover" counter. */
  get acceptedOps(): number {
    return this.opTotal;
  }

  /**
   * Land the room as a normal session revision and stop persisting. Idempotent:
   * a second call writes nothing, because the first cleared the snapshot row and
   * a `closed` room accepts no further ops.
   */
  async quiesce(): Promise<QuiesceResult | null> {
    this.closed = true;
    const persistence = this.persistence;
    if (!persistence) return null;
    // Let any in-flight snapshot land first - otherwise it could rewrite the
    // recovery row that quiesce is about to delete, and the next join would
    // "recover" work that is already a revision.
    await this.writes;
    return persistence.quiesce(this.sessionId, this, {
      ops: this.opTotal, actor: this.lastWriter, baseRev: this.baseRev,
    });
  }

  /** Resolve once every snapshot write enqueued so far has settled. The cadence
   *  is deliberately fire-and-forget, so this is how a caller observes it without
   *  forcing a quiesce. Never rejects - a failed snapshot is logged, not thrown. */
  async flush(): Promise<void> {
    await this.writes;
  }

  /** The cadence, evaluated once per accepted batch (plans/100 §7 item 3). */
  private noteBatch(ops: number): void {
    const persistence = this.persistence;
    if (!persistence || this.closed) return;
    this.batchesSinceSnapshot += 1;
    this.opsSinceSnapshot += ops;
    if (this.batchesSinceSnapshot < SNAPSHOT_EVERY_BATCHES && this.opsSinceSnapshot < SNAPSHOT_EVERY_OPS) return;
    this.batchesSinceSnapshot = 0;
    this.opsSinceSnapshot = 0;
    // Fire-and-forget onto the write chain: a snapshot must never block or fail
    // an edit. The document is authoritative in memory; a failed snapshot costs
    // crash recovery, not correctness.
    this.writes = this.writes
      .then(() => (this.closed ? undefined : persistence.snapshot(this.sessionId, this, this.opTotal)))
      .catch((err: unknown) => {
        console.error(`[lolly-work] collab snapshot failed for ${this.sessionId}:`, (err as Error)?.message ?? err);
      });
  }

  rollup(): RoomRollup {
    return {
      sessionId: this.sessionId,
      projectId: this.projectId,
      toolId: this.toolId,
      users: this.seenUsers.size,
      ops: this.opTotal,
      byUser: Object.fromEntries([...this.opsByUser.entries()].sort()),
      keys: [...this.touchedKeys].sort(),
      ms: Date.now() - this.openedAt,
    };
  }

  /**
   * A COPY of this room's live state for admin introspection (OSS plans/100
   * §7, plans/14 §6) - the console's Rooms panel. Built from `roster()`, which
   * already excludes nothing here matters about (no presence field is read),
   * so this is a projection, not a second traversal of room internals.
   *
   * Never returns a `RoomMember` (it carries the live `send` closure), never a
   * `userId` (a name and a role are what "is someone stuck in here" needs),
   * and never touches `presenceOf` or the document - counters, roles and
   * display names only (keys-never-values, §11.21).
   */
  snapshotForAdmin(): RoomSnapshot {
    const members: RoomMemberSnapshot[] = this.roster().map((r) => ({
      name: r.name,
      role: r.role,
      joinedAt: this.joinedAtOf.get(r.id) ?? this.openedAt,
    }));
    const writerCount = members.filter((m) => m.role === 'writer').length;
    return {
      sessionId: this.sessionId,
      toolId: this.toolId,
      memberCount: members.length,
      writerCount,
      observerCount: members.length - writerCount,
      members,
      opsApplied: this.opTotal,
      startedAt: this.openedAt,
    };
  }

  /** The sizes of this room's own maps - see `RoomInternals`. A fresh object of
   *  plain numbers; nothing here can be held onto or written through. */
  internals(): RoomInternals {
    return {
      members: this.members.size,
      joinedAt: this.joinedAtOf.size,
      presence: this.presenceOf.size,
      trackedClients: this.highestClock.size,
      paramKeys: this.paramKeys.size,
      collections: this.boxIds.size,
    };
  }

  /** Everyone currently seated, with their last presence. `join()` snapshots it
   *  BEFORE seating the joiner, which is how the joiner stays out of its own
   *  roster. */
  roster(): RosterEntry[] {
    const out: RosterEntry[] = [];
    for (const m of this.members.values()) out.push(this.entry(m));
    return out;
  }

  broadcast(frame: ServerFrame, exceptId?: string): void {
    for (const m of this.members.values()) {
      if (m.id === exceptId) continue;
      m.send(frame);
    }
  }

  private entry(m: RoomMember): RosterEntry {
    const presence = this.presenceOf.get(m.id);
    return {
      id: m.id,
      userId: m.userId,
      name: m.name,
      role: m.role,
      opVersion: m.opVersion,
      ...(presence ? { presence } : {}),
    };
  }
}

function toWire(state: CanvasDocState): WireDocState {
  const wire: WireDocState = {
    order: state.order,
    boxes: Object.fromEntries(state.boxes),
    params: Object.fromEntries(state.params),
  };
  if (state.collections && state.collections.size > 0) {
    wire.collections = Object.fromEntries(
      [...state.collections.entries()].map(([col, c]) => [
        col,
        { order: c.order, boxes: Object.fromEntries(c.boxes) },
      ]),
    );
  }
  return wire;
}

// ── the registry ──────────────────────────────────────────────────────────────

/**
 * One room instance per session id. Rooms are created on the first join and
 * disposed when the last member leaves - at which point the document QUIESCES
 * into a session revision (plans/14 §6), so a dropped room's work is in history
 * and the next join re-seeds from the stored session.
 *
 * Both halves are async now, which introduces exactly one race worth naming: a
 * session re-joined while its previous room is still writing that revision must
 * not seed from the pre-quiesce record, or the rejoin would silently undo the
 * edits that just landed. `acquire` therefore waits on any in-flight disposal for
 * the same session before it looks for (or opens) a room, and `hydrate` re-reads
 * the session rather than trusting the caller's copy.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  /** In-flight `open` per session - two simultaneous first joins must not build
   *  two documents for one session. */
  private readonly opening = new Map<string, Promise<Room>>();
  /** In-flight disposal per session - the barrier described above. */
  private readonly closing = new Map<string, Promise<void>>();
  /** When each currently-empty room became empty (the sweeper's clock). */
  private readonly emptySince = new Map<string, number>();
  private readonly persistence: RoomPersistence | undefined;
  private readonly graceMs: number;

  /** The gateway always passes persistence; it stays optional so a room can be
   *  exercised as pure in-memory state. `graceMs` is injectable for tests. */
  constructor(persistence?: RoomPersistence, graceMs: number = EMPTY_GRACE_MS) {
    this.persistence = persistence;
    this.graceMs = graceMs;
  }

  /** The live room for this session, opening (and seeding) it on first join. */
  async acquire(session: SessionRecord): Promise<Room> {
    const disposing = this.closing.get(session.id);
    if (disposing) await disposing;
    const existing = this.rooms.get(session.id);
    if (existing) {
      this.emptySince.delete(session.id);
      return existing;
    }
    const inflight = this.opening.get(session.id);
    if (inflight) return inflight;
    const opening = this.open(session);
    this.opening.set(session.id, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(session.id);
    }
  }

  /**
   * Quiesce and drop the room IF it is still empty. Occupancy is re-checked at
   * call time so a join that lands between "the room emptied" and "we got around
   * to closing it" is never destroyed under the new member's feet, and identity
   * is re-checked so a double dispose (leave racing the sweeper) writes once.
   */
  async releaseIfEmpty(room: Room): Promise<boolean> {
    if (room.size > 0) return false;
    if (this.rooms.get(room.sessionId) !== room) return false;
    return this.dispose(room);
  }

  /**
   * Quiesce and drop EVERY room, occupied or not - orderly shutdown. Returns the
   * rooms it disposed so the caller can audit their rollups.
   */
  async drain(): Promise<Room[]> {
    const disposed: Room[] = [];
    for (const room of [...this.rooms.values()]) {
      if (await this.dispose(room)) disposed.push(room);
    }
    return disposed;
  }

  /**
   * Dispose rooms that have been empty for the grace period. The ordinary
   * last-leave path does NOT wait for this - it disposes immediately, so
   * `size()` and the `collab.rollup` audit stay contemporaneous with the room
   * closing. This catches rooms that never pass through a leave at all: a socket
   * that dies during `acquire`, or a leave handler that threw. Without it such a
   * room would hold its document - and its unwritten edits - forever.
   */
  async sweep(now: number = Date.now()): Promise<Room[]> {
    const disposed: Room[] = [];
    for (const room of [...this.rooms.values()]) {
      if (room.size > 0) {
        this.emptySince.delete(room.sessionId);
        continue;
      }
      const since = this.emptySince.get(room.sessionId);
      if (since === undefined) {
        this.emptySince.set(room.sessionId, now);
        continue;
      }
      if (now - since < this.graceMs) continue;
      if (await this.releaseIfEmpty(room)) disposed.push(room);
    }
    return disposed;
  }

  size(): number {
    return this.rooms.size;
  }

  /** A live snapshot of every room this registry holds - the admin console's
   *  Rooms panel (OSS plans/100 §7, plans/14 §6). Each entry is a COPY
   *  (`Room.snapshotForAdmin`); nothing here exposes a room, a member, or the
   *  registry's own maps. */
  list(): RoomSnapshot[] {
    return [...this.rooms.values()].map((r) => r.snapshotForAdmin());
  }

  private async open(session: SessionRecord): Promise<Room> {
    const room = await Room.open(session, this.persistence);
    this.rooms.set(session.id, room);
    this.emptySince.delete(session.id);
    return room;
  }

  private async dispose(room: Room): Promise<boolean> {
    if (this.rooms.get(room.sessionId) !== room) return false;
    this.rooms.delete(room.sessionId);
    this.emptySince.delete(room.sessionId);
    // Published BEFORE the await so a concurrent `acquire` sees the barrier.
    const done = room.quiesce().then(
      () => undefined,
      (err: unknown) => {
        console.error(`[lolly-work] collab quiesce failed for ${room.sessionId}:`, (err as Error)?.message ?? err);
      },
    );
    this.closing.set(room.sessionId, done);
    try {
      await done;
    } finally {
      if (this.closing.get(room.sessionId) === done) this.closing.delete(room.sessionId);
    }
    return true;
  }
}
