// SPDX-License-Identifier: MPL-2.0
/**
 * Live collaboration limits, each with the reason it exists. The gateway, rooms, guests,
 * tickets and nearby list read them from here, and so does the Limits and quotas panel,
 * which must not load the collaboration server to show them.
 */

// ── the gateway's size and rate ceilings (OSS plans/100 §11.21) ────────────────

/** Largest frame accepted off the wire. Ops are tiny and a full 200-op batch is
 *  a few KB; the ceiling exists so a peer cannot buffer megabytes. `ws` closes
 *  an oversize frame itself (1009). */
export const MAX_MESSAGE_BYTES = 256 * 1024;
/** A socket that completes the handshake and never sends `join` is closed. */
export const JOIN_TIMEOUT_MS = 10_000;
/** Ops accepted per socket per second, summed across messages. The op COUNT cap
 *  (`MAX_OPS_PER_MESSAGE`) bounds one message; this bounds the stream. */
export const OPS_PER_SEC = 200;
/** `ops` MESSAGES per socket per second. Capped independently of the op count
 *  because the cost of a message is not its ops: every one runs `authorizeOps`,
 *  which is five UNCACHED store reads (`getUserBySub`, `listGrants`,
 *  `listOverlays`, `getSession`, `getProject` - issued as one parallel batch).
 *  The re-read is deliberate - a revocation must not wait for a room to close - 
 *  so the message rate is what has to be bounded instead. 40/s is a gesture
 *  commit every 25 ms, well above what a human hand produces. */
export const OPS_MESSAGES_PER_SEC = 40;
/** Handlers queued behind one connection's serialized chain before the socket is
 *  closed. `queue = queue.then(…)` preserves arrival order but bounds nothing on
 *  its own, so a client that outruns the store would otherwise grow the heap. */
export const MAX_QUEUED_MESSAGES = 64;
/** Live sockets across the whole gateway. */
export const MAX_SOCKETS = 512;
/** Live sockets ONE user may hold. Also the bound on how many WRITER_CAP seats a
 *  single account can occupy in one room, together with `WRITER_CAP_PER_USER`. */
export const MAX_SOCKETS_PER_USER = 8;
/** Upgrades one user may complete per minute. Each connect/disconnect cycle
 *  writes 2–3 hash-chained audit rows, and `appendAudit` takes an instance-global
 *  advisory lock - so an unthrottled reconnect loop from one authenticated member
 *  serialises audit writes for the entire instance. */
export const CONNECTS_PER_USER_PER_MIN = 30;
/** Outbound bytes allowed to sit in one socket's send buffer. A peer that stopped
 *  reading must not be able to buffer a whole room in server memory. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
/** Longest `ds`/`dsi` value read off the upgrade URL. A brand profile name is a
 *  short path segment and an instance base is a URL; anything past this is not
 *  one of ours, and keeping the read bounded means a silly-length query cannot
 *  be carried around by the gate. */
export const MAX_DESIGN_SYSTEM_CHARS = 256;

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

/** Longest name part rendered into a roster/presence entry. Matches the cap
 *  `GET /l/:id` applies when minting the cookie; re-applied here because the
 *  inviter's display name comes from a different place and a name is relayed to
 *  every peer in the room. */
export const MAX_GUEST_NAME_CHARS = 60;

export const SOCKET_TICKET_TTL_MS = 30_000;
export const MAX_TICKETS = 1024;

/** 12 hours: long enough to span a working session, short enough that a stale entry
 *  from a closed laptop ages off the same day. */
export const NEARBY_TTL_MS = 12 * 60 * 60 * 1000;
