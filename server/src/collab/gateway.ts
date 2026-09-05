// SPDX-License-Identifier: MPL-2.0
/**
 * The collab WebSocket gateway - `/ws/collab/:sessionId` (OSS plans/100 §7
 * items 1/5/6/7, lolly-work plans/14 §6).
 *
 * This is the half of live collaboration that only a control plane can offer:
 * every write is checked against the SAME RBAC + input-lock policy engine the
 * render path uses, server-side, for everyone, regardless of client. A P2P pair
 * enforces input locks cooperatively; a room enforces them or drops the op.
 *
 * SHAPE. Nothing in the HTTP app handles `upgrade`, so the gateway hooks
 * `server.on('upgrade')` in main.ts beside the router and path-matches like a
 * route (plans/100 §7 item 1). It deliberately does NOT live inside `buildApp`:
 * app.ts is also bundled into a Vercel function, and that platform's WebSocket
 * story is unverified (plans/100 §11.31) - keeping the gateway out of that
 * import graph means the trial host is unaffected either way.
 *
 * AUTH HAPPENS BEFORE THE HANDSHAKE. `readPrincipal` runs on the upgrade
 * request's cookies (the HMAC cookie works verbatim on an upgrade), and a
 * refusal is a plain HTTP response written to the raw socket - no WebSocket is
 * ever created for an unauthenticated caller.
 *
 * THE FOUR GATES, in the order `GET /api/v1/sessions/:id` applies them:
 *   1. a live member (`resolveMember` - the route's own `memberOf` logic)
 *   2. the session exists, its project is VISIBLE (`canSeeProject` - the route's
 *      own helper, now shared), and it is not tombstoned
 *   3. `mayJoinCollab(…)` (rbac/evaluate.ts, = `evaluate(…, 'collab.join')`) - 
 *      the room-entry action itself. A real action with its own grants, so an
 *      operator who denies `collab.join` to a group turns rooms OFF for them
 *      here, at the socket, not merely in the advertised `can[]` bit
 *   4. `mayEditCollab(…)` (rbac/evaluate.ts, = `evaluate(…, 'session.edit')`)
 *      decides writer vs OBSERVER - an eligible reader always gets in, just
 *      read-only (plans/14 §6). The SAME function backs the org-config
 *      `can['collab.edit']` bit, so a room's writer seat and the shell's
 *      advertised edit affordance can never disagree (OSS plans/100 §7 item 7)
 *
 * ALL FOUR ARE RE-RUN PER GESTURE, not just at the handshake - see
 * `authorizeOps`. A room lives for hours; every gate that only ran once would be
 * a gate that stops existing the moment a socket is open.
 *
 * GUESTS ARE THE SAME ROOM, NOT A SECOND MECHANISM (plans/14 §6, plans/02 §8).
 * A guest principal (`readPrincipal`'s guest branch) reaches all of the above
 * through `admitGuest`, which asks the same four questions of the only authority
 * a guest has - its guest-edit LINK:
 *
 *   1. instead of "a live member": the link is live (exists, not revoked, not
 *      expired), guest links are enabled on this instance, and the inviter is
 *      still a live member who STILL HOLDS `link.create-guest` over this
 *      link's own target (accountability rides on them, plans/02 §8 - both
 *      halves of that sentence, re-checked on the same per-gesture and
 *      per-keepalive cadence everything else here is, via
 *      `guestInviterStanding`; corrected 2026-08-09, see its own doc comment)
 *   2. instead of project visibility: THE LINK BINDS TO THIS SESSION. A
 *      guest-edit link names one `target.sessionId`, and that is the whole of a
 *      guest's reach. Any other id is refused 403 - the same refusal an
 *      unauthorized member gets, and issued BEFORE the session is read, so a
 *      guest cannot use the 404/403/410 spread as an existence oracle for
 *      sessions it was never invited to
 *   3. `collab.join` is not evaluated, because a guest is in no role table
 *      (`ROLE_ACTIONS.guest` is `[]`) - the link IS the grant
 *   4. writer vs observer comes from the link's KIND (`guests.ts`
 *      `guestLinkRole`), never from RBAC
 *
 * Everything AFTER the handshake is deliberately identical: one roster, one set
 * of room caps, one presence relay, one veto, one audit shape, one write-back.
 * What differs is only how the seat was authorized - see `SeatIdentity`. THE
 * VETO ITSELF is not quite byte-identical, and deliberately so (corrected
 * 2026-08-09): a guest carries only the synthetic `guests` group, so it is the
 * operator's real lever, but ALSO means an `inputAccess` rule scoped to a
 * tool's real editing groups never matches one - `vetoOps` therefore refuses a
 * guest outright on any input that is GOVERNED at all (some rule exists) but
 * matched by none of them, rather than falling through to the member-side
 * EDITABLE default (`inputIsGoverned`, `OpsAuthz.isGuest`). A member's own
 * fallback is completely unchanged.
 *
 * WHAT THE PRESENCE PATH DOES NOT DO. It is not checked here at all: this file
 * hands the raw frame to `room.relayPresence`, and rooms.ts imports no policy
 * module, so presence structurally cannot be authorized (plans/100 §7 item 5).
 *
 * THE DESIGN-SYSTEM GATE (OSS plans/186 §3.10, which calls it the fourth gate
 * beside the three policy ones). A room hosted here runs under exactly ONE
 * design system: the one this deployment governs. Two people editing the same
 * session with different brands loaded would each see their own colours, fonts
 * and logos on the same document, and neither would be wrong about what they
 * saw - so the room refuses the mismatch at the door instead of rendering two
 * truths. THE CARRIER IS THE UPGRADE URL, `?ds=<profile>&dsi=<instance base>`,
 * because everything else the gates read (the cookie, the Origin header, the
 * session id) is on the upgrade request too, and a refusal here has to be an
 * HTTP status written to the raw socket like every other refusal in this file.
 * The `join` frame is too late: by then the WebSocket exists and the client is
 * about to be handed the document.
 *
 * It is ADDITIVE AND TOLERANT, which is what matters for a shell that ships on
 * its own schedule: a client that sends neither param is an older client and
 * joins exactly as it did before, and a client that sends only one of them has
 * only that half checked. What is refused is a client that STATES a design
 * system this instance does not govern. See `designSystemClaim` (the parse) and
 * `designSystemRefusal` (the rule).
 *
 * VALIDATION IS HAND-ROLLED, deliberately. `@lolly-tools/core` exports an ajv
 * `validateCanvasOp`, but only from its package ROOT, whose module graph
 * references DOM globals this project's tsconfig excludes on purpose (the house
 * rule stated in server/src/render/contract.ts). `parseOp` below is the same
 * shape check as the bundled canvas-op schema, plus the caps and key discipline
 * a schema does not express (plans/100 §11.21) - and it REBUILDS each op from
 * known fields, so nothing unexpected rides into the document or out to peers.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';

import { isCompatibleOpVersion, CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import type { BoxRow, CanvasOp, GeometryField, OpOrigin, ParamValue, Scalar } from '@lolly-tools/core/canvas-op-v1';

import { sessionKeys, type InstanceConfig, type Secrets } from '../config/instance.ts';
import type { ProjectRecord, SessionRecord, Store, UserRecord } from '../store/types.ts';
import { displayName, resolveMember } from '../iam/member.ts';
import { guestActor, readPrincipal, type GuestSession } from '../iam/sessions.ts';
import { linkResourceSelectors, type LinkRecord } from '../links/sign.ts';
import { canSeeProject } from '../rbac/project-access.ts';
import { listBrandProfiles } from '../brand/profiles.ts';
import { mayCreateGuestLinks, mayEditCollab, mayJoinCollab, type Grant, type Role } from '../rbac/evaluate.ts';
import { resolveInputAccess, type ResolvedAccess, type ToolOverlay, inputIsGoverned } from '../policy/overlay.ts';
import { readToolInputs } from '../policy/tool-inputs.ts';
import { randomId } from '../lib/crypto.ts';
import {
  MAX_OPS_PER_MESSAGE, MAX_ROW_FIELDS, MAX_SCALAR_CHARS, PRESENCE_FRAMES_PER_SEC,
  WRITER_CAP, WRITER_CAP_PER_USER,
  Room, RoomRegistry, isSafeKey,
  type JoinNotice, type MemberRole, type RoomMember, type RoomSnapshot, type ServerFrame,
} from './rooms.ts';
import { createRoomPersistence } from './persistence.ts';
import {
  GUEST_GROUP, guestDisplayName, guestSeatOf, resolveInviter, type GuestSeat,
} from './guests.ts';

/** Every collab socket lives under this prefix; the rest of the path is the
 *  session id. Exported so main.ts and the tests share one literal. */
export const COLLAB_WS_PREFIX = '/ws/collab/';

/** Largest frame accepted off the wire. Ops are tiny and a full 200-op batch is
 *  a few KB; the ceiling exists so a peer cannot buffer megabytes. `ws` closes
 *  an oversize frame itself (1009). */
export const MAX_MESSAGE_BYTES = 256 * 1024;

/** A socket that completes the handshake and never sends `join` is closed. */
export const JOIN_TIMEOUT_MS = 10_000;

/** How often the empty-room sweeper runs (rooms.ts `RoomRegistry.sweep`, which
 *  owns the grace period itself). Unref'd, so it never holds the process open. */
export const SWEEP_INTERVAL_MS = 10_000;

// ── the abuse ceilings (OSS plans/100 §11.21 "size + rate caps, disconnect-on-
//    abuse"). `maxPayload` is the SIZE half; everything below is the RATE half.

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
/** How often each socket is pinged - and, on the same tick, how often a SEATED
 *  connection is re-authorized (`seatValid`). A half-open TCP connection is
 *  invisible to `close`, and a member who never leaves keeps a WRITER_CAP seat
 *  forever AND stops the room ever emptying - so its document never quiesces and
 *  its edits never become a revision. The seat re-check rides this timer because
 *  a revocation must reach a connection that never sends anything, and an
 *  observer never does. Overridable per gateway (`CollabGatewayDeps`) for tests. */
export const PING_INTERVAL_MS = 30_000;
/** Consecutive unanswered pings before the socket is terminated. */
export const PONG_MISSES = 2;
/** Outbound bytes allowed to sit in one socket's send buffer. A peer that stopped
 *  reading must not be able to buffer a whole room in server memory. */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** Application close codes (4000–4999 is the private range). A client can tell
 *  "you were disconnected for flooding" from "the server is shutting down". */
export const CLOSE = {
  /** The caller stopped being a live member while the socket was open - 
   *  disabled, session-epoch bumped, or the cookie expired. */
  UNAUTHORIZED: 4001,
  /** No `join` frame within JOIN_TIMEOUT_MS. */
  JOIN_TIMEOUT: 4003,
  /** Unparseable frame, unknown type, or a second `join`. */
  PROTOCOL: 4004,
  /** More than PRESENCE_FRAMES_PER_SEC presence frames in a second. */
  PRESENCE_RATE: 4008,
  /** More than MAX_OPS_PER_MESSAGE ops in one message, more than OPS_PER_SEC ops
   *  or OPS_MESSAGES_PER_SEC messages in a second, or more than
   *  MAX_QUEUED_MESSAGES handlers waiting on the store. */
  OPS_RATE: 4009,
  /** The gateway is shutting down. */
  GOING_AWAY: 4010,
} as const;

/** Typed error frames - sender-only, never broadcast. */
export const ERR = {
  NOT_JOINED: 'NOT_JOINED',
  OBSERVER_READ_ONLY: 'OBSERVER_READ_ONLY',
  INVALID_OP: 'INVALID_OP',
  COLLECTION_REQUIRED: 'COLLECTION_REQUIRED',
  UNKNOWN_INPUT: 'UNKNOWN_INPUT',
  INPUT_LOCKED: 'INPUT_LOCKED',
  INPUT_HIDDEN: 'INPUT_HIDDEN',
  INPUT_NOT_ALLOWED: 'INPUT_NOT_ALLOWED',
  /** The op addressed a declared input through the wrong lane - a `param` on a
   *  `blocks` input, or a collection-scoped box op on a scalar one. */
  WRONG_LANE: 'WRONG_LANE',
  /** The room's document is at one of its own ceilings (rooms.ts `admits`). */
  DOC_FULL: 'DOC_FULL',
  UNKNOWN_FRAME: 'UNKNOWN_FRAME',
} as const;

export interface CollabGatewayDeps {
  config: InstanceConfig;
  store: Store;
  secrets: Secrets;
  /** Keepalive period, which is ALSO the seat re-authorization period (see
   *  `onConnection`'s heartbeat). Injectable for tests, exactly as
   *  `RoomRegistry`'s `graceMs` is; production always takes the default. */
  pingIntervalMs?: number;
}

export interface CollabGateway {
  /** Returns false when the path is not ours - the caller destroys the socket.
   *  True means the gateway has taken ownership (auth continues async). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Live room count (tests + a future gauge). */
  rooms(): number;
  /** A live snapshot of every room - the admin console's Rooms panel (OSS
   *  plans/100 §7, plans/14 §6). Wired into `buildApp`'s `listCollabRooms` by
   *  main.ts; never imported by app.ts itself, so the Vercel bundle stays free
   *  of `ws` (see this file's own header). Copies only - see
   *  `RoomRegistry.list`. */
  snapshot(): RoomSnapshot[];
  /** Quiesce every live room into a session revision and audit its rollup - 
   *  orderly shutdown (plans/14 §6). `close()` starts this best-effort; a host
   *  that wants the writes to LAND awaits this before exiting. */
  drain(): Promise<void>;
  /** Close every socket and the underlying server. */
  close(): void;
}

/**
 * `/ws/collab/<id>` → `<id>`; anything else → null.
 *
 * EVERY step is inside the try, and that is essential rather than tidy.
 * `handleUpgrade` is called SYNCHRONOUSLY from the `server.on('upgrade')`
 * listener (main.ts), so a throw here does not fail one request - it escapes
 * through `Server.emit` into node's HTTP parser as an uncaught exception and
 * takes the whole control plane down. WHATWG `new URL` does not validate
 * percent-escapes in a path, so `/ws/collab/%` parses cleanly and only
 * `decodeURIComponent` rejects it (`URIError: URI malformed`) - which is why
 * that call, not just the URL parse, has to be guarded. No cookie, no session
 * and no membership are needed to reach this line.
 */
export function collabSessionId(rawUrl: string | undefined): string | null {
  try {
    const pathname = new URL(rawUrl ?? '/', 'http://local').pathname;
    if (!pathname.startsWith(COLLAB_WS_PREFIX)) return null;
    const rest = pathname.slice(COLLAB_WS_PREFIX.length);
    if (!rest || rest.includes('/')) return null;
    const id = decodeURIComponent(rest);
    return id.length > 0 && id.length <= 128 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Cross-site WebSocket hijacking is not blocked by the same-origin policy: a
 * page on evil.example may open `ws://your-instance/ws/collab/<id>` and the
 * browser attaches the session cookie, because a ws handshake is not a fetch and
 * CORS never applies to it. Until this check the ONLY barrier was `SameSite=Lax`
 * on the session cookie (iam/sessions.ts) - a browser-behaviour assumption, in a
 * file that is otherwise explicit about every ceiling it holds, guarding the full
 * `docState` plus every subsequent op and presence frame.
 *
 * The rule, deliberately narrow:
 *   - NO `Origin` header → allowed. Non-browser clients (the CLI, the Tauri
 *     shells, `ws` in this repo's own tests) send none, and a header a caller
 *     controls is not an authorization signal anyway - the cookie is. What the
 *     header IS good for is the one case it cannot be forged in: a real browser
 *     stamps it, so a hostile PAGE cannot hide where it came from.
 *   - an `Origin` whose HOST is the host this request was made to (the `Host`
 *     header) → allowed. This is the same-origin case, and it is checked against
 *     the request rather than the config on purpose: an instance behind a
 *     reverse proxy, on a vanity domain, or reached by IP must not lose collab
 *     because `baseUrl` was written for link-building. A browser cannot forge
 *     `Host` - it is the server it actually connected to - so "Origin host ==
 *     Host" is exactly the classic CSWSH check. Scheme is ignored for this leg:
 *     TLS is routinely terminated in front of us, so the browser says https
 *     while we serve http.
 *   - an `Origin` that matches this instance's configured `baseUrl` or `appUrl`
 *     (a split deploy: the shell on one host, the control plane on another) →
 *     allowed.
 *   - dev.enabled additionally allows localhost, matching `devCors` in app.ts
 *     exactly, so `npm run dev:web` on :5173 keeps working.
 *   - anything else → refused before the handshake.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  instance: { baseUrl?: string; appUrl?: string },
  devEnabled: boolean,
  host?: string,
): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // a malformed Origin is a browser that is not one
  }
  const value = url.origin;
  if (host && url.host === host) return true;
  if (devEnabled && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(value)) return true;
  for (const candidate of [instance.baseUrl, instance.appUrl]) {
    if (!candidate) continue;
    try {
      if (new URL(candidate).origin === value) return true;
    } catch {
      /* a misconfigured URL simply matches nothing */
    }
  }
  return false;
}

// ── the design-system claim (OSS plans/186 §3.10) ─────────────────────────────

/** Longest `ds`/`dsi` value read off the upgrade URL. A brand profile name is a
 *  short path segment and an instance base is a URL; anything past this is not
 *  one of ours, and keeping the read bounded means a silly-length query cannot
 *  be carried around by the gate. */
const MAX_DESIGN_SYSTEM_CHARS = 256;

/** What a client says it is rendering with. Either half may be absent, and an
 *  absent half is simply not checked - see `designSystemRefusal`. */
export interface DesignSystemClaim {
  /** The brand profile name the client believes it has active, from `ds=`. */
  id: string | null;
  /** The instance base the client believes that design system came from, from
   *  `dsi=`. */
  instance: string | null;
}

/**
 * `?ds=<profile>&dsi=<instance base>` off the upgrade URL, or `null` when the
 * client named neither - an older shell, which must keep working.
 *
 * An EMPTY value counts as absent rather than as a claim of "". A client that
 * has no design system loaded and fills the template in anyway is not making a
 * statement about this room, and refusing it would be refusing a blank.
 *
 * Total, like `collabSessionId` and for the same reason: it runs on the
 * synchronous upgrade path, where a throw takes the process down.
 */
export function designSystemClaim(rawUrl: string | undefined): DesignSystemClaim | null {
  let params: URLSearchParams;
  try {
    params = new URL(rawUrl ?? '/', 'http://local').searchParams;
  } catch {
    return null;
  }
  const read = (key: string): string | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const value = raw.trim().slice(0, MAX_DESIGN_SYSTEM_CHARS);
    return value.length > 0 ? value : null;
  };
  const id = read('ds');
  const instance = read('dsi');
  return id === null && instance === null ? null : { id, instance };
}

/**
 * Do two instance bases name the same deployment? Normalised the way plans/186
 * asks: a trailing slash is not a difference, and the comparison is on the
 * ORIGIN, case-insensitively, so `https://Brand.Example/` and
 * `https://brand.example` are one instance.
 *
 * A value that is not a URL at all (or an opaque one, whose origin is the string
 * "null") falls back to a trimmed, lowercased, slash-stripped string compare -
 * so a client that sends a bare name gets an honest mismatch rather than an
 * accidental match against every other opaque value.
 */
export function sameInstanceBase(a: string | undefined, b: string | undefined): boolean {
  const normalise = (value: string | undefined): string | null => {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return null;
    try {
      const { origin } = new URL(trimmed);
      if (origin && origin !== 'null') return origin.toLowerCase();
    } catch {
      /* not a URL - fall through to the string form */
    }
    return trimmed.replace(/\/+$/, '').toLowerCase();
  };
  const left = normalise(a);
  return left !== null && left === normalise(b);
}

// ── op parsing + hardening ────────────────────────────────────────────────────

const GEOM_FIELDS: readonly GeometryField[] = ['x', 'y', 'w', 'h', 'rot'];

function scalarOf(v: unknown): { ok: true; value: Scalar } | { ok: false } {
  if (v === null || typeof v === 'boolean') return { ok: true, value: v };
  if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, value: v } : { ok: false };
  if (typeof v === 'string') return v.length <= MAX_SCALAR_CHARS ? { ok: true, value: v } : { ok: false };
  return { ok: false };
}

function boxIdOf(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 256 && isSafeKey(v) ? v : null;
}

function originOf(v: unknown): OpOrigin | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const client = o['client'];
  const clock = o['clock'];
  if (typeof client !== 'string' || client.length === 0 || client.length > 128) return null;
  // A Lamport clock is a small, steadily-incrementing per-client counter - never
  // anywhere near float precision limits in honest use (canvas-op-testkit mints
  // it by `+1` per op). `Number.isFinite` alone let an out-of-range value like
  // `1e308` through, and that op's clock becomes BOTH `Room.serverClock` and
  // this client's replay high-water mark forever: floats saturate
  // (`1e308 + 1 === 1e308`), so no later, honest clock from that `origin.client`
  // can ever beat it again - every future op from whoever the attacker named is
  // dropped by the replay filter, silently, for the room's whole life, and the
  // register that op wrote is permanently un-overwritable. `isSafeInteger`
  // closes it at the parsing boundary, before the value ever reaches
  // `Room.applyOps`/`noteClock`.
  if (typeof clock !== 'number' || !Number.isSafeInteger(clock) || clock < 0) return null;
  return { client, clock };
}

/** The optional v1.1 collection scope. `undefined` = absent (a canvas-collection
 *  op, which the gateway refuses later); `null` = present but malformed. */
function colOf(o: Record<string, unknown>): string | null | undefined {
  const col = o['col'];
  if (col === undefined) return undefined;
  return typeof col === 'string' && col.length > 0 && col.length <= 256 && isSafeKey(col) ? col : null;
}

function paramValueOf(v: unknown): { ok: true; value: ParamValue } | { ok: false } {
  const scalar = scalarOf(v);
  if (scalar.ok) return { ok: true, value: scalar.value };
  // A binding descriptor `{bind: {provider, query?, version?}}` - the data plane
  // syncs WHICH dataset, never the resolved datum (plans/99 §6).
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false };
  const bind = (v as Record<string, unknown>)['bind'];
  if (typeof bind !== 'object' || bind === null || Array.isArray(bind)) return { ok: false };
  const b = bind as Record<string, unknown>;
  const provider = b['provider'];
  if (typeof provider !== 'string' || provider.length === 0 || provider.length > 256) return { ok: false };
  const out: { provider: string; query?: string; version?: string } = { provider };
  for (const key of ['query', 'version'] as const) {
    const raw = b[key];
    if (raw === undefined) continue;
    if (typeof raw !== 'string' || raw.length > MAX_SCALAR_CHARS) return { ok: false };
    out[key] = raw;
  }
  return { ok: true, value: { bind: out } };
}

/**
 * One untrusted frame → one `CanvasOp`, or null. Rebuilt field by field: an op
 * that reaches the document carries exactly the contract's properties and
 * nothing a sender bolted on.
 */
export function parseOp(raw: unknown): CanvasOp | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const origin = originOf(o['origin']);
  if (!origin) return null;
  const col = colOf(o);
  if (col === null) return null;
  const scope: { col?: string } = col === undefined ? {} : { col };

  switch (o['k']) {
    case 'param': {
      const key = o['key'];
      if (typeof key !== 'string' || !isSafeKey(key)) return null;
      const value = paramValueOf(o['value']);
      if (!value.ok) return null;
      // The params lane is collection-blind (canvas-op-v1) - a `col` on a param
      // op is not a v1.1 op at all.
      if (col !== undefined) return null;
      return { k: 'param', key, value: value.value, origin };
    }
    case 'geom': {
      const id = boxIdOf(o['id']);
      if (!id) return null;
      const raws = o['fields'];
      if (typeof raws !== 'object' || raws === null || Array.isArray(raws)) return null;
      const src = raws as Record<string, unknown>;
      const fields: Partial<Record<GeometryField, number>> = {};
      let n = 0;
      for (const f of GEOM_FIELDS) {
        const v = src[f];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !Number.isFinite(v)) return null;
        fields[f] = v;
        n++;
      }
      if (n === 0 || Object.keys(src).length !== n) return null;
      return { k: 'geom', id, fields, origin, ...scope };
    }
    case 'field': {
      const id = boxIdOf(o['id']);
      const field = o['field'];
      if (!id || typeof field !== 'string' || !isSafeKey(field)) return null;
      const value = scalarOf(o['value']);
      if (!value.ok) return null;
      return { k: 'field', id, field, value: value.value, origin, ...scope };
    }
    case 'add': {
      const id = boxIdOf(o['id']);
      const orderKey = o['orderKey'];
      const rowRaw = o['row'];
      if (!id || typeof orderKey !== 'string' || orderKey.length > 256) return null;
      if (typeof rowRaw !== 'object' || rowRaw === null || Array.isArray(rowRaw)) return null;
      const entries = Object.entries(rowRaw as Record<string, unknown>);
      if (entries.length > MAX_ROW_FIELDS) return null;
      const row: BoxRow = {};
      for (const [key, v] of entries) {
        if (!isSafeKey(key)) return null;
        const value = scalarOf(v);
        if (!value.ok) return null;
        row[key] = value.value;
      }
      return { k: 'add', id, row, orderKey, origin, ...scope };
    }
    case 'remove': {
      const id = boxIdOf(o['id']);
      if (!id) return null;
      return { k: 'remove', id, origin, ...scope };
    }
    case 'order': {
      const id = boxIdOf(o['id']);
      const orderKey = o['orderKey'];
      if (!id || typeof orderKey !== 'string' || orderKey.length > 256) return null;
      return { k: 'order', id, orderKey, origin, ...scope };
    }
    default:
      return null;
  }
}

/**
 * The input id an op is GOVERNED BY - the only thing an overlay can resolve.
 *
 *   `param`  → its `key`, which IS the input id (plans/100 §3).
 *   box ops  → their `col`, the blocks-input id the collection belongs to.
 *
 * A box op with no `col` targets the contract's default canvas collection, which
 * names no input - so a governed room REFUSES it rather than applying an
 * ungovernable write. That is why `seedOpsFromInputs` seeds every blocks input
 * as a NAMED collection: there is nothing for an unscoped op to be about.
 */
export function governedInputId(op: CanvasOp): string | null {
  return op.k === 'param' ? op.key : (op.col ?? null);
}

// ── the gateway ───────────────────────────────────────────────────────────────

interface Rejection {
  code: string;
  input: string;
}

/** A fixed-size ring of hit timestamps - exact "N per second", no fixed-window
 *  double-rate straddle. */
class RateWindow {
  private readonly stamps: number[];
  private readonly limit: number;
  private readonly windowMs: number;
  private i = 0;
  constructor(limit: number, windowMs = 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.stamps = new Array<number>(limit).fill(0);
  }
  /** False when this hit exceeds the limit. */
  hit(now: number): boolean {
    const oldest = this.stamps[this.i] ?? 0;
    if (oldest !== 0 && now - oldest < this.windowMs) return false;
    this.stamps[this.i] = now;
    this.i = (this.i + 1) % this.limit;
    return true;
  }
}

/**
 * A fixed window over a COUNT, for lanes that arrive in batches (an `ops` message
 * carries up to MAX_OPS_PER_MESSAGE ops, so a per-hit ring cannot express it).
 *
 * Fixed rather than sliding, and that is the same deliberate bias `RateWindow`'s
 * neighbour in the shell's op-guard documents: a burst can straddle a boundary and
 * reach 2× the limit across two adjacent windows, and since the penalty is
 * DISCONNECTION the guard would rather let a brief overshoot through than accuse a
 * peer wrongly. A clock that steps backwards opens a fresh window rather than
 * locking the peer out until it catches up.
 */
class CountWindow {
  private readonly limit: number;
  private readonly windowMs: number;
  private start = Number.NEGATIVE_INFINITY;
  private count = 0;
  constructor(limit: number, windowMs = 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  /** False when this batch takes the window past its limit. */
  add(now: number, n: number): boolean {
    if (!(now - this.start < this.windowMs) || now < this.start) {
      this.start = now;
      this.count = n;
    } else {
      this.count += n;
    }
    return this.count <= this.limit;
  }
}

/**
 * "May this principal be in this room at all?" - gates 1–3 of `admit()`
 * (`resolveMember` having already answered gate 1 by returning a user or null),
 * as a pure decision over rows the caller has already read.
 *
 * Pure, and the ONE expression of that decision for both re-checks - the
 * per-gesture one in `authorizeOps` and the per-heartbeat one in `seatValid`.
 * `admit()` runs the same three checks in longhand rather than calling this,
 * because it is the only caller that must tell them apart: an upgrade answers
 * 404 / 403 / 410 the way `GET /api/v1/sessions/:id` does, and collapsing that
 * to one boolean would collapse the statuses with it. Once the socket exists
 * there is nothing to distinguish - every one of them closes it.
 *
 * Excludes the writer/observer split, which is gate 4: a different question,
 * with a different answer per batch.
 */
function seatAllows(
  user: UserRecord,
  session: SessionRecord | null,
  project: ProjectRecord | null,
  grants: Grant[],
): boolean {
  if (!session || session.deletedAt) return false;
  if (!project || !canSeeProject(user, project)) return false;
  return mayJoinCollab({ userId: user.id, groups: user.groups, role: user.role as Role }, grants);
}

/**
 * WHO a socket is, once the handshake has decided - the one shape everything
 * after it reads. A member and a guest differ in how they were AUTHORIZED, never
 * in what a seat IS, so the room, the ceilings, the audit trail and the roster
 * take this and branch on nothing.
 */
type SeatIdentity =
  | { kind: 'member' } & SeatCommon
  | { kind: 'guest'; linkId: string; inviter: string } & SeatCommon;

interface SeatCommon {
  /** The AUDIT actor: `user:<id>` for a member, `guest:<linkId>` for a guest
   *  (`iam/sessions.ts` `guestActor` - the same string `GET /l/:id` already
   *  writes for `guest.admit`, so a guest reads as ONE principal across the log
   *  rather than as a link on one line and a room seat on the next). */
  actor: string;
  /** The per-principal ceiling key (MAX_SOCKETS_PER_USER,
   *  CONNECTS_PER_USER_PER_MIN) AND the room seat's `userId` - which is what
   *  makes WRITER_CAP / WRITER_CAP_PER_USER count a guest exactly like a member,
   *  with no cap arithmetic anywhere in this file knowing guests exist.
   *
   *  A guest's is its LINK, not the human holding it, and that is deliberate: a
   *  guest is pseudonymous, so the only identity worth budgeting is the invite.
   *  Everyone who arrives through one link therefore shares one WRITER_CAP_PER_USER
   *  allowance - a link forwarded around a group cannot fill a room the inviter's
   *  colleagues are trying to work in. */
  principalId: string;
  /** What the roster, the peer-join broadcast and every relayed presence frame
   *  show. For a guest: `"<name> (guest of <inviter>)"` (plans/02 §8), built
   *  server-side in `guests.ts` - the shell renders whatever name it is sent. */
  name: string;
}

export function createCollabGateway(deps: CollabGatewayDeps): CollabGateway {
  const { config, store, secrets } = deps;
  // Dual-key rotation (plans/35 wave 4): verification takes the key list.
  const sessionVerify = sessionKeys(secrets);
  const pingIntervalMs = deps.pingIntervalMs ?? PING_INTERVAL_MS;
  // The room owns its document; persistence owns the snapshot cadence, the
  // quiesce→revision write, and crash recovery (persistence.ts, plans/14 §6).
  const registry = new RoomRegistry(createRoomPersistence({ store }));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const sockets = new Set<WebSocket>();
  let closing = false;

  const audit = (actor: string, action: string, subject: string, payload: Record<string, unknown>) =>
    store.appendAudit({ at: new Date().toISOString(), actor, action, subject, payload });

  /** The one disposal path - quiesce + drop the room, then audit its rollup. A
   *  room nobody ever joined (a socket that died mid-`acquire`, swept later) has
   *  nothing to report, so it gets no event; every room a member sat in does. */
  const disposeIfEmpty = async (room: Room): Promise<void> => {
    if (!(await registry.releaseIfEmpty(room))) return;
    const rollup = room.rollup();
    if (rollup.users === 0) return;
    // The per-session edit rollup (plans/14 §6): counters and input KEYS, never
    // keystrokes and never values.
    await audit('system', 'collab.rollup', `session:${room.sessionId}`, { ...rollup });
  };

  const sweeper = setInterval(() => {
    void registry.sweep().then(async (swept) => {
      for (const room of swept) {
        const rollup = room.rollup();
        if (rollup.users > 0) await audit('system', 'collab.rollup', `session:${room.sessionId}`, { ...rollup });
      }
    }).catch(onHandlerError);
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  /** Everything one ops message is judged against: who the sender is RIGHT NOW,
   *  whether they may still write, the tool's overlay, and its declared input ids
   *  acting as an own-property whitelist (plans/100 §11.21). When the tool is not
   *  in this instance's pack the id list is unavailable and the whitelist is
   *  skipped - the overlay veto still applies. */
  interface OpsAuthz {
    /** The groups the overlay veto resolves against. A member's effective
     *  membership; for a guest, the synthetic `[GUEST_GROUP]` of plans/02 §8 - 
     *  which is the operator's real lever over what a guest may touch, and the
     *  reason the veto is not skipped for guests. */
    groups: string[];
    mayEdit: boolean;
    overlay: ToolOverlay | undefined;
    /** Corrected 2026-08-09: a guest carries ONLY the synthetic `guests` group
     *  (never a tool's real editing groups), so an `inputAccess` rule an operator
     *  wrote for the population that actually edits a tool - 'team-eng',
     *  'admin', whatever - never matches a guest and `resolveInputAccess` falls
     *  through to its member-side default, EDITABLE. That inverts plans/02 §8's
     *  "narrowest input surface of anyone": a guest ends up STRICTLY WIDER than
     *  a member the rule was written to restrict. `vetoOps` reads this to apply
     *  a stricter fallback for a guest specifically - see `inputIsGoverned`. */
    isGuest: boolean;
    /** Declared input ids, or null when the manifest could not be read at all.
     *  An EMPTY set is a real answer ("this tool declares no inputs"), not a
     *  missing one - collapsing the two would make the whitelist fail OPEN for a
     *  tool that legitimately declares nothing. */
    declared: Set<string> | null;
    /** input id → declared `InputType`, for the lane check. An id absent from
     *  this map has no declared type in the manifest. */
    types: Map<string, string>;
  }

  /**
   * Re-read per ops MESSAGE, deliberately NOT cached. A room lives for hours; a
   * revocation must not wait for it. An HTTP route re-authorizes every request,
   * and a socket that authorized itself once at 09:00 would otherwise let a
   * since-disabled account, a since-removed group member, or a since-locked input
   * keep writing all day - the exact opposite of the one promise rooms make
   * ("live collab is the one place input locking stops being cooperative",
   * plans/14 §6). The cost is a handful of small reads per GESTURE COMMIT, not
   * per op; `readToolInputs` keeps its own mtime cache, so the manifest side is
   * free.
   *
   * EVERY gate `admit()` opens is re-run here, INCLUDING the ones that are
   * properties of the session rather than of the caller. That is not symmetry
   * for its own sake: `admit`'s `Admitted` record captures the session and
   * project rows as they were at the handshake, so re-reading only the identity
   * half would leave the two revocations an operator is most likely to reach for
   * - removing someone from the project's visibility group, and deleting the
   * session - enforced exactly once, at 09:00, on a socket that then writes into
   * the room all day AND commits it as a session revision on quiesce. The
   * project is re-fetched by the session's OWN `projectId` (a session never
   * moves between projects - no route writes that field), so the read stays one
   * parallel batch rather than a chain.
   *
   * Returns null when the caller may no longer be in this room AT ALL - a dead
   * account, a revoked `collab.join`, a project they can no longer see, a
   * tombstoned session. The socket closes rather than degrading to observer,
   * matching the 401/403/410 an HTTP route would answer. Losing only the WRITE
   * right is the other case, and it stays a refusal of the batch (`mayEdit`).
   */
  const authorizeOps = (ctx: Admitted): Promise<OpsAuthz | null> =>
    ctx.identity.kind === 'guest' ? authorizeGuestOps(ctx, ctx.identity.linkId) : authorizeMemberOps(ctx);

  /** Shared tail of both branches: the tool manifest half of `OpsAuthz`, which is
   *  a property of the TOOL and so identical whoever is asking. */
  const declaredOf = (inputs: Array<{ id: string; type?: unknown }> | null): Pick<OpsAuthz, 'declared' | 'types'> => ({
    declared: inputs ? new Set(inputs.map((i) => i.id)) : null,
    types: new Map(
      (inputs ?? [])
        .filter((i): i is { id: string; type: string } => typeof i.type === 'string')
        .map((i) => [i.id, i.type]),
    ),
  });

  const authorizeMemberOps = async (ctx: Admitted): Promise<OpsAuthz | null> => {
    const { id: sessionId, projectId, toolId } = ctx.session;
    const [user, overlays, grants, inputs, session, project] = await Promise.all([
      resolveMember(store, ctx.cookie, sessionVerify),
      store.listOverlays(),
      store.listGrants(),
      readToolInputs(config.instance.pack, toolId),
      store.getSession(sessionId),
      store.getProject(projectId),
    ]);
    // Gate 1 (a live member) is `resolveMember` answering at all; gates 2–3 are
    // `seatAllows`, the same decision `admit()` and the heartbeat re-check make.
    if (!user || !seatAllows(user, session, project, grants)) return null;
    return {
      groups: user.groups,
      mayEdit: mayEditCollab({ userId: user.id, groups: user.groups, role: user.role as Role }, grants),
      overlay: overlays.get(toolId),
      isGuest: false,
      ...declaredOf(inputs),
    };
  };

  /**
   * The guest half of the per-gesture re-authorization - the SAME discipline
   * (nothing cached, every gate re-read), over the gates a guest actually has.
   *
   * `store.listGrants()` and `store.getProject()` are absent by intent, not by
   * economy. A guest holds no grants and no role row, and its visibility is the
   * link rather than the project's group - so reading either would mean asking a
   * question whose only possible answer comes from a rule somebody wrote for
   * members. What IS re-read is the link: that is plans/02 §8's promise that
   * "revoking the link kills all its live guest sessions immediately" made true
   * of an already-open socket, landing on the next gesture exactly as a grant
   * revocation lands for a member.
   *
   * The overlay veto is NOT skipped: the returned `groups` is the synthetic
   * `guests` group, so an `inputAccess` rule scoped to it locks, hides or
   * choice-restricts an input for every guest without naming one (plans/02 §8's
   * "a guest can be given the narrowest input surface of anyone").
   */
  const authorizeGuestOps = async (ctx: Admitted, linkId: string): Promise<OpsAuthz | null> => {
    const { id: sessionId, toolId } = ctx.session;
    const [link, overlays, inputs, session] = await Promise.all([
      store.getLink(linkId),
      store.listOverlays(),
      readToolInputs(config.instance.pack, toolId),
      store.getSession(sessionId),
    ]);
    const seat = liveGuestSeat(ctx.cookie, link, linkId, sessionId);
    if (!seat || !session || session.deletedAt) return null;
    // The inviter's own standing - plans/02 §8's second revocation lever, re-run
    // here exactly as the link's own liveness is (see `guestInviterStanding`).
    if ((await guestInviterStanding(seat.link)) === null) return null;
    return {
      groups: [GUEST_GROUP],
      mayEdit: seat.role === 'writer',
      overlay: overlays.get(toolId),
      isGuest: true,
      ...declaredOf(inputs),
    };
  };

  /**
   * "Is this still the guest that was admitted, and may it still be here?" - the
   * pure decision, over rows the caller has already read. The guest-side dual of
   * `seatAllows`, and the ONE expression of it for both re-checks.
   *
   * The cookie is re-verified rather than trusted from the handshake (it expires
   * on the link's own clock), and it must still name the SAME link: a second
   * guest cookie arriving on a live socket must not inherit the seat the first
   * one opened.
   */
  const liveGuestSeat = (
    cookie: string | undefined, link: LinkRecord | null, linkId: string, sessionId: string,
  ): GuestSeat | null => {
    // The instance-wide kill switch. An operator who turns guest links off has
    // turned them off for the sockets already open too, not merely for minting.
    if (!config.policy.guestLinks.enabled) return null;
    const principal = readPrincipal(cookie, sessionVerify);
    if (principal?.kind !== 'guest' || principal.guest.linkId !== linkId) return null;
    if (!link) return null;
    return guestSeatOf(link, principal.guest, sessionId);
  };

  /**
   * "Is the inviter still someone who could mint THIS link today?" - the
   * second half of plans/02 §8's revocation promise: "revoking the link (or
   * the inviter losing `link.create-guest`) kills all its live guest sessions
   * immediately." Corrected 2026-08-09: the FIRST clause (the link itself) was
   * always re-checked per gesture and per keepalive (`liveGuestSeat`); this
   * one - the inviter's own standing - was checked ONLY at admit, so disabling
   * an inviter (the standard offboarding lever) or revoking their
   * `link.create-guest` grant left every already-open guest socket writing
   * (and reading) for up to the link's own TTL. Both halves now ride the same
   * three call sites `liveGuestSeat` does.
   *
   * Two checks, both against the LINK's own authority, never the guest's:
   *   1. the inviter is a live member at all (`resolveInviter` - disabled or
   *      deleted admits nobody, same as `admitGuest` always required);
   *   2. the inviter still holds `link.create-guest` over the selectors this
   *      link's OWN target satisfies (`linkResourceSelectors` - the identical
   *      selectors `POST /api/v1/links` authorized the mint against, via the
   *      shared `mayCreateGuestLinks`, so a tool-scoped grant cannot silently
   *      disagree between the mint and the re-check).
   *
   * Returns the inviter's display name on success (so a caller need not
   * re-derive it) or null on either failure - one more O(users) scan plus one
   * grants read, on the same per-gesture/per-keepalive cadence a member's own
   * standing is re-read on, not a new store surface.
   */
  const guestInviterStanding = async (link: LinkRecord): Promise<string | null> => {
    const [inviter, grants] = await Promise.all([resolveInviter(store, link.createdBy), store.listGrants()]);
    if (!inviter) return null;
    const ctx = { userId: inviter.id, groups: inviter.groups, role: inviter.role as Role };
    if (!mayCreateGuestLinks(ctx, linkResourceSelectors(link.target), grants)) return null;
    return displayName(inviter);
  };

  /**
   * "May this connection still be in this room at all?" - gates 1–3 of `admit`,
   * without gate 4 (writer vs observer, which is a per-batch decision) and
   * without the overlay/manifest reads that only a WRITE needs.
   *
   * Driven by the heartbeat, so a seat that never sends anything is still
   * re-authorized. Deliberately the same four store reads `admit` made, in the
   * same order, resolved through the same shared functions - a second reading of
   * "may this person be here" is exactly the drift this file keeps refusing to
   * introduce. A guest observer is re-checked on the same tick and for the same
   * reason: a revoked link must reach the seat that never sends anything.
   */
  const seatValid = async (ctx: Admitted): Promise<boolean> => {
    const { id: sessionId, projectId } = ctx.session;
    if (ctx.identity.kind === 'guest') {
      const { linkId } = ctx.identity;
      const [link, session] = await Promise.all([store.getLink(linkId), store.getSession(sessionId)]);
      if (!session || session.deletedAt) return false;
      const seat = liveGuestSeat(ctx.cookie, link, linkId, sessionId);
      if (!seat) return false;
      // An idle guest observer has no gesture to lose the seat on - the inviter
      // check has to ride the same keepalive the link's own liveness does.
      return (await guestInviterStanding(seat.link)) !== null;
    }
    const [user, grants, session, project] = await Promise.all([
      resolveMember(store, ctx.cookie, sessionVerify),
      store.listGrants(),
      store.getSession(sessionId),
      store.getProject(projectId),
    ]);
    if (!user) return false;
    return seatAllows(user, session, project, grants);
  };

  /**
   * The veto. Every op - not just `field`/`param` - is resolved to its governed
   * input id and checked; a locked `blocks` input whose ADD/REMOVE ops sailed
   * through would be locked in name only.
   *
   * THE LANE CHECK IS PART OF THE VETO, not a tidiness rule. `governedInputId`
   * returns `op.col` for every box op, so WITHOUT it an attacker could re-scope a
   * governed scalar input as a collection (`{k:'add', col:'accent', …}`) and walk
   * straight past the rules written for it: `choice` only ever compared `op.value`
   * on a `param`, and `ReferenceCanvasDoc.ensure` materialises a collection for any
   * `col` string. `docToInputs` would then write the attacker's rows into that
   * input on quiesce - silently converting a scalar input into an array of
   * attacker-chosen objects. So a `blocks` input is the ONLY thing a box op may
   * scope to, and a `param` may only address an input that is not one.
   */
  const vetoOps = (
    ops: CanvasOp[],
    policy: OpsAuthz,
    live: Room,
  ): { accepted: CanvasOp[]; rejected: Rejection[] } => {
    const groups = policy.groups;
    const accepted: CanvasOp[] = [];
    const rejected: Rejection[] = [];
    for (const op of ops) {
      const input = governedInputId(op);
      if (input === null) {
        rejected.push({ code: ERR.COLLECTION_REQUIRED, input: '' });
        continue;
      }
      if (policy.declared && !policy.declared.has(input)) {
        rejected.push({ code: ERR.UNKNOWN_INPUT, input });
        continue;
      }
      // The declared type is the lane. It is only checked when the manifest states
      // one; an input with no declared type keeps the pre-lane behaviour rather
      // than being refused, because a pack that predates this is not an attack.
      const type = policy.types.get(input);
      if (type !== undefined && (op.k === 'param') === (type === 'blocks')) {
        rejected.push({ code: ERR.WRONG_LANE, input });
        continue;
      }
      const resolved = resolveInputAccess(policy.overlay, input, groups);
      // A guest that matches no rule for this input does NOT inherit the
      // member-side fallback when the input is visibly GOVERNED (some rule
      // exists for it, just not one naming `guests` or `*`): plans/02 §8 sold
      // guests as capable of "the narrowest input surface of anyone", and an
      // operator's ordinary authoring pattern - scoping a lock to the groups
      // who actually edit the tool - must not silently open that same field to
      // the one principal outside every group on the instance. An input with
      // NO rules at all is unaffected: a genuinely ungoverned field stays
      // editable for a guest exactly as it does for anyone else.
      const access: ResolvedAccess = (policy.isGuest && resolved.level === 'editable'
        && inputIsGoverned(policy.overlay, input))
        ? { level: 'locked' }
        : resolved;
      if (access.level === 'locked') {
        rejected.push({ code: ERR.INPUT_LOCKED, input });
        continue;
      }
      if (access.level === 'hidden') {
        // 'hidden' behaves at least as strictly as 'locked' (overlay.ts §checkParams):
        // naming an input you cannot see is probing.
        rejected.push({ code: ERR.INPUT_HIDDEN, input });
        continue;
      }
      if (access.level === 'choice' && access.allow) {
        // The render path already refuses an out-of-set param (INPUT_NOT_ALLOWED);
        // a live room must not be the way around it. A box op scoped to a
        // choice-governed input is refused OUTRIGHT rather than value-checked:
        // an allow-list is a set of scalar values, so there is no reading of it
        // under which a collection write is inside the set.
        if (op.k !== 'param' || !access.allow.some((a) => a === op.value)) {
          rejected.push({ code: ERR.INPUT_NOT_ALLOWED, input });
          continue;
        }
      }
      // Last, because it is the only check that depends on room STATE: an op that
      // would grow the document past one of its ceilings is refused rather than
      // applied (rooms.ts `admits`).
      if (!live.admits(op)) {
        rejected.push({ code: ERR.DOC_FULL, input });
        continue;
      }
      accepted.push(op);
    }
    return { accepted, rejected };
  };

  /** A refusal BEFORE the handshake: a plain HTTP response on the raw socket, so
   *  a `ws` client surfaces the real status instead of a mystery disconnect. The
   *  machine code is both the reason phrase and the first line of the body; an
   *  optional second line carries a sentence a person can act on, for the one
   *  refusal where "403" alone would not tell anyone what to change (the
   *  design-system gate). Every message written here is server-authored - none
   *  of it echoes what the client sent. */
  const refuse = (socket: Duplex, status: number, code: string, message?: string): void => {
    const body = message ? `${code}\n${message}\n` : `${code}\n`;
    socket.write(
      `HTTP/1.1 ${status} ${code}\r\n`
      + 'connection: close\r\n'
      + 'content-type: text/plain; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    socket.destroy();
  };

  /**
   * The design-system gate (OSS plans/186 §3.10; see this file's header for why
   * the carrier is the upgrade URL). Returns the sentence to refuse with, or
   * `null` to let the upgrade through.
   *
   * THE RULE, in the order the plan states it:
   *   - no claim at all → allow. An older client says nothing and keeps working.
   *   - `dsi` present → it must name THIS deployment (`sameInstanceBase` against
   *     `config.instance.baseUrl`). A design system copied from another host is
   *     not the one this room is governed by, whatever it happens to be called.
   *   - `ds` present AND the pack is profile-aware → it must be the ACTIVE brand
   *     profile. On a pack with no `brands/` dir there is only one design system
   *     here and nothing to compare a name against, so the instance check is the
   *     whole gate. A profile-aware pack whose active profile cannot be resolved
   *     at all (no marker, no readable symlink) is the same situation and is
   *     treated the same way rather than refusing everyone.
   *
   * The message names what to switch TO, never what the client sent. The brand
   * LABEL lives inside `buildApp`'s pack-index read and is not reachable from
   * here without a second read of the same file, so the active profile name is
   * what this says when there is one, and a plain phrase when there is not.
   *
   * NOT AUDITED, deliberately, and matching every other gate in this file: a
   * refused upgrade writes no audit row (the audit calls here are `collab.join`,
   * `collab.leave` and the rollups, all of them AFTER a seat exists). A gate
   * that logged its refusals would also be a way for an unseated caller to write
   * to the audit chain behind its instance-global lock.
   */
  const designSystemRefusal = async (req: IncomingMessage): Promise<string | null> => {
    const claim = designSystemClaim(req.url);
    if (!claim) return null;
    // One read, on the path where a client actually made a claim. The active
    // profile can be switched while the server runs (brand/profiles.ts), so it
    // is read per upgrade rather than cached - the same thing the HTTP brand
    // routes do.
    const profiles = await listBrandProfiles(config.instance.pack);
    const active = profiles.available ? profiles.active : null;
    const instanceOk = claim.instance === null
      || sameInstanceBase(claim.instance, config.instance.baseUrl);
    const idOk = claim.id === null || active === null || claim.id === active;
    if (instanceOk && idOk) return null;
    const target = active ? `the "${active}" design system` : "this instance's design system";
    return `this room runs ${target} at ${config.instance.baseUrl}; switch to it to join`;
  };

  /** Live sockets per PRINCIPAL id, and their upgrade rate. Both are
   *  per-principal rather than per-IP: the gateway has already authenticated by
   *  this point, so the account is the honest subject, and a shared office NAT
   *  must not throttle a whole floor because one laptop is looping. A guest's
   *  principal is its link (`SeatIdentity.principalId`), so one invite gets one
   *  budget however many people were forwarded it. */
  const socketsPerUser = new Map<string, number>();
  const connectRate = new Map<string, CountWindow>();

  const connectRateFor = (userId: string): CountWindow => {
    // Bounded by eviction rather than by a timer: a window nobody has used in a
    // minute is indistinguishable from a fresh one, so wholesale clearing is
    // correct and costs nothing but a brief reset of the counters.
    if (connectRate.size > 4096) connectRate.clear();
    let w = connectRate.get(userId);
    if (!w) {
      w = new CountWindow(CONNECTS_PER_USER_PER_MIN, 60_000);
      connectRate.set(userId, w);
    }
    return w;
  };

  const admit = async (req: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string): Promise<void> => {
    // 0. a browser-stamped Origin must be ours (see `isAllowedOrigin`). First,
    //    because it costs nothing and refuses a cross-site hijack before the
    //    cookie is even read.
    if (!isAllowedOrigin(req.headers.origin, config.instance, config.dev.enabled, req.headers.host)) {
      return refuse(socket, 403, 'FORBIDDEN_ORIGIN');
    }

    // 1. authenticate the UPGRADE itself - no socket exists for an anonymous
    //    caller. The principal is read first so the GUEST branch can take over
    //    before any member-shaped gate runs; `readPrincipal` prefers a member
    //    cookie when both are present, exactly as every HTTP route does, so a
    //    signed-in user with a stale guest cookie is still judged as a member.
    const who = readPrincipal(req.headers.cookie, sessionVerify);
    if (!who) return refuse(socket, 401, 'UNAUTHORIZED');
    if (who.kind === 'guest') return admitGuest(req, socket, head, sessionId, who.guest);

    const user = await resolveMember(store, req.headers.cookie, sessionVerify);
    if (!user) return refuse(socket, 401, 'UNAUTHORIZED');

    // 1b. the connection ceilings, applied BEFORE the store reads the read gate
    //     needs - a reconnect loop must not be able to buy three queries a cycle,
    //     nor two audit rows behind the instance-global audit lock.
    if (sockets.size >= MAX_SOCKETS) return refuse(socket, 503, 'BUSY');
    if ((socketsPerUser.get(user.id) ?? 0) >= MAX_SOCKETS_PER_USER) {
      return refuse(socket, 429, 'TOO_MANY_CONNECTIONS');
    }
    if (!connectRateFor(user.id).add(Date.now(), 1)) {
      return refuse(socket, 429, 'TOO_MANY_CONNECTIONS');
    }

    // 2. the read gate, in GET /api/v1/sessions/:id's own order
    const session = await store.getSession(sessionId);
    if (!session) return refuse(socket, 404, 'NOT_FOUND');
    const project = await store.getProject(session.projectId);
    if (!project || !canSeeProject(user, project)) return refuse(socket, 403, 'FORBIDDEN');
    if (session.deletedAt) return refuse(socket, 410, 'SESSION_DELETED');

    const principal = { userId: user.id, groups: user.groups, role: user.role as Role };
    const grants = await store.listGrants();

    // 3. the ROOM gate - `collab.join` itself. It is a real RBAC action with its
    //    own grants (rbac/evaluate.ts), it is offered in the console's grants
    //    editor, and org-config advertises it to the shell; a gateway that never
    //    consulted it would make the one control an operator reaches for to
    //    switch rooms off for a group purely cosmetic - the denied principal
    //    would still be admitted, as a WRITER, holding the whole document.
    //    Refused 403 like any other visibility refusal, so a client cannot tell
    //    "not for you" from "not for anyone".
    if (!mayJoinCollab(principal, grants)) return refuse(socket, 403, 'FORBIDDEN');

    // 4. the write gate - the same `mayEditCollab` the PUT route's session.edit
    //    check and org-config's can['collab.edit'] both call (evaluate.ts). No
    //    grant is not a refusal: the member joins as an observer (plans/14 §6).
    const mayEdit = mayEditCollab(principal, grants);

    // 5. the DESIGN-SYSTEM gate (OSS plans/186 §3.10). Last of the gates on
    //    purpose: the message names this instance's active brand profile, and
    //    that is a thing about the deployment nobody who was going to be refused
    //    anyway should be told. A member who reaches this line was joining.
    const wrongDesignSystem = await designSystemRefusal(req);
    if (wrongDesignSystem) return refuse(socket, 403, 'DESIGN_SYSTEM_MISMATCH', wrongDesignSystem);

    if (closing) return refuse(socket, 503, 'SHUTTING_DOWN');
    // The cookie is carried forward so every ops message can re-authorize; see
    // `authorizeOps`. It is the same bearer the client would send on an HTTP
    // request, and it expires on the same schedule.
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, {
      identity: {
        kind: 'member',
        actor: `user:${user.id}`,
        principalId: user.id,
        // `displayName`, not a second copy of the join - the same function the
        // directory, the approver nominations and the collab invite copy all
        // render, so a colleague's roster entry and their invite cannot read
        // differently (iam/member.ts).
        name: displayName(user),
      },
      session,
      mayEdit,
      cookie: req.headers.cookie,
    }));
  };

  /**
   * A GUEST's upgrade (plans/14 §6, plans/02 §8) - the same four gates over the
   * only authority a guest has, its guest-edit link. See this file's header for
   * the mapping; the ORDER is what matters here:
   *
   *   `guestSeatOf` FIRST, before the session is read, because it is the binding
   *   check. A guest asking for any session other than the one its link names is
   *   refused 403 - the identical refusal an unauthorized member gets - and the
   *   refusal happens without the store ever being asked whether that session
   *   exists, so the 404/403/410 spread the member path deliberately preserves
   *   cannot be used by a guest as an existence oracle for other people's work.
   *
   * There is no `canSeeProject` and no `mayJoinCollab` here, and their absence is
   * the design: a guest is in no project group and no role table, so both would
   * be questions with only one honest answer. The link is the grant.
   */
  const admitGuest = async (
    req: IncomingMessage, socket: Duplex, head: Buffer, sessionId: string, guest: GuestSession,
  ): Promise<void> => {
    const link = await store.getLink(guest.linkId);
    const seat = config.policy.guestLinks.enabled && link ? guestSeatOf(link, guest, sessionId) : null;
    if (!seat) return refuse(socket, 403, 'FORBIDDEN');

    // The connection ceilings, keyed on the LINK - same placement as the member
    // path (after auth, before the reads the gate needs).
    if (sockets.size >= MAX_SOCKETS) return refuse(socket, 503, 'BUSY');
    if ((socketsPerUser.get(seat.principalId) ?? 0) >= MAX_SOCKETS_PER_USER) {
      return refuse(socket, 429, 'TOO_MANY_CONNECTIONS');
    }
    if (!connectRateFor(seat.principalId).add(Date.now(), 1)) {
      return refuse(socket, 429, 'TOO_MANY_CONNECTIONS');
    }

    // The inviter must still be a live member AND still hold `link.create-guest`
    // over this link's own target - accountability rides on them (plans/02 §8),
    // so a guest cannot outlive the account that vouched for it, and there is no
    // "(guest of <an id nobody can resolve>)" to render. Read off the LINK
    // (`createdBy`), not the cookie's copy of it, for the same reason the bound
    // session is: the stored record is the authority. Behind the ceilings
    // deliberately - it is the one O(users) read on this path (the Store has no
    // by-id user getter; `api/app.ts` scans the same way), so a reconnect loop
    // must not be able to buy it. The SAME check (`guestInviterStanding`) runs
    // again on every gesture and every keepalive, so this is not a one-time gate.
    const inviterId = seat.link.createdBy;
    const inviterName = await guestInviterStanding(seat.link);
    if (!inviterName) return refuse(socket, 403, 'FORBIDDEN');

    const session = await store.getSession(sessionId);
    if (!session) return refuse(socket, 404, 'NOT_FOUND');
    if (session.deletedAt) return refuse(socket, 410, 'SESSION_DELETED');

    // The design-system gate applies to a guest for the same reason it applies
    // to a member: one room, one design system, and a guest renders the document
    // with whatever it has loaded. Same placement (last, after the seat is
    // otherwise settled) and the same tolerance for a client that claims nothing.
    const wrongDesignSystem = await designSystemRefusal(req);
    if (wrongDesignSystem) return refuse(socket, 403, 'DESIGN_SYSTEM_MISMATCH', wrongDesignSystem);

    if (closing) return refuse(socket, 503, 'SHUTTING_DOWN');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, {
      identity: {
        kind: 'guest',
        actor: guestActor(seat.link.id),
        principalId: seat.principalId,
        name: guestDisplayName(guest.name, inviterName),
        linkId: seat.link.id,
        inviter: inviterId,
      },
      session,
      mayEdit: seat.role === 'writer',
      cookie: req.headers.cookie,
    }));
  };

  /** What the handshake resolved. `session` is a SNAPSHOT of the moment of
   *  admission, kept for the ids and the seed document only - never re-read as
   *  policy. Anything that could be revoked is re-resolved from the store per
   *  gesture in `authorizeOps`; treating these rows as still true is precisely
   *  the bug that let a removed group member keep writing. `identity` is the ONE
   *  place the member/guest difference survives the handshake. */
  interface Admitted {
    identity: SeatIdentity;
    session: SessionRecord;
    mayEdit: boolean;
    cookie: string | undefined;
  }

  /** The guest half of a collab audit payload: the LINK that admitted them and
   *  the member accountable for it - plans/02 §8's "every guest action is audited
   *  with inviter + linkId". Ids only, exactly like the rest of the collab audit
   *  surface: never the guest's chosen name, never an input value. Empty for a
   *  member, so the member row's shape is byte-identical to what it always was. */
  const guestAudit = (identity: SeatIdentity): Record<string, string> =>
    identity.kind === 'guest' ? { linkId: identity.linkId, inviter: identity.inviter } : {};

  const onConnection = (ws: WebSocket, ctx: Admitted): void => {
    sockets.add(ws);
    socketsPerUser.set(ctx.identity.principalId, (socketsPerUser.get(ctx.identity.principalId) ?? 0) + 1);
    const connId = `cm_${randomId(8)}`;
    const presenceRate = new RateWindow(PRESENCE_FRAMES_PER_SEC);
    const opsRate = new CountWindow(OPS_PER_SEC);
    const opsMessageRate = new CountWindow(OPS_MESSAGES_PER_SEC);
    // Handling is async (policy + audit), so serialize per connection: ops must
    // apply in arrival order even when a handler awaits.
    let queue: Promise<void> = Promise.resolve();
    let queued = 0;
    let room: Room | null = null;
    let member: RoomMember | null = null;
    let joinedAt = 0;

    const send = (frame: ServerFrame): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // A peer that stopped READING is not visible to `close` - the frames simply
      // pile up in this process. Drop the socket rather than the room's memory.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify(frame));
    };

    // KEEPALIVE. Without it a half-open connection leaves a RoomMember seated
    // forever: it holds a WRITER_CAP seat, keeps `room.size` above zero - so the
    // sweeper skips the room and its document never quiesces - and receives every
    // broadcast into a buffer nobody drains. `ws` performs no keepalive of its own.
    let pongMisses = 0;
    ws.on('pong', () => {
      pongMisses = 0;
    });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (pongMisses >= PONG_MISSES) {
        ws.terminate();
        return;
      }
      pongMisses++;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
      // …and, on the same tick, RE-AUTHORIZE THE SEAT. `authorizeOps` covers a
      // writer's next gesture, but an OBSERVER has no next gesture: they sit and
      // receive the whole document, every op and every presence frame. Without
      // this, "a revocation lands on the next gesture" would be silent about the
      // one seat that never makes one - a member removed from the project's
      // group, or denied `collab.join`, would keep reading a live room until they
      // chose to leave. An idle writer is the same shape. Cheaper than
      // `authorizeOps` (no overlay, no manifest - this decides membership of the
      // room, not what may be written), and it rides a timer that already exists.
      if (member) {
        void seatValid(ctx)
          .then((ok) => {
            if (!ok) ws.close(CLOSE.UNAUTHORIZED, 'this session is no longer valid');
          })
          .catch(onHandlerError);
      }
    }, pingIntervalMs);
    heartbeat.unref();
    const fail = (code: string, message: string, inputs?: string[]): void =>
      send({ t: 'error', code, message, ...(inputs && inputs.length ? { inputs } : {}) });

    /** Append to this connection's serialized chain. Returns false when the
     *  backlog is already at MAX_QUEUED_MESSAGES - `ws` keeps reading regardless of
     *  how slowly handlers drain, so without this bound a client could enqueue
     *  arbitrarily many pending handlers and grow the heap without limit. */
    const enqueue = (fn: () => Promise<void>): boolean => {
      if (queued >= MAX_QUEUED_MESSAGES) return false;
      queued++;
      queue = queue
        .then(fn)
        .catch(onHandlerError)
        .finally(() => {
          queued--;
        });
      return true;
    };

    const joinTimer = setTimeout(() => {
      if (!member) ws.close(CLOSE.JOIN_TIMEOUT, 'join expected');
    }, JOIN_TIMEOUT_MS);
    joinTimer.unref();

    const doJoin = async (raw: Record<string, unknown>): Promise<void> => {
      if (member) return void ws.close(CLOSE.PROTOCOL, 'already joined');
      const opVersion = typeof raw['opVersion'] === 'string' ? raw['opVersion'].slice(0, 32) : '';
      // Version negotiation (plans/99 §9): a major mismatch joins observer-only
      // rather than corrupting state.
      const compatible = opVersion.length > 0 && isCompatibleOpVersion(opVersion);

      // Opening a room can await a store read (and, after a crash, a recovery
      // revision), so the socket may be gone by the time it resolves. Seating a
      // member on a dead socket would leave a roster entry no close handler can
      // ever remove.
      const live = await registry.acquire(ctx.session);
      if (ws.readyState !== WebSocket.OPEN) return;
      let role: MemberRole = 'writer';
      let notice: JoinNotice | undefined;
      if (!ctx.mayEdit) {
        role = 'observer';
        notice = 'no-edit-grant';
      } else if (!compatible) {
        role = 'observer';
        notice = 'op-version-observer';
      } else if (
        live.writerCount() >= WRITER_CAP
        || live.writerCountFor(ctx.identity.principalId) >= WRITER_CAP_PER_USER
      ) {
        // WRITER_CAP is per ROOM, so without the per-user half one account with
        // several tabs open could occupy every seat and make the room view-only
        // for its actual collaborators. Both refusals carry the same notice: from
        // the joiner's side the situation is identical - the room is full. Guests
        // are counted by both, on their link (see `SeatIdentity.principalId`):
        // "temporary external collaboration is the same room" has to mean the
        // same ceilings, or an invite would be a way around them.
        role = 'observer';
        notice = 'room-full-view-only';
      }

      const me: RoomMember = {
        id: connId,
        userId: ctx.identity.principalId,
        name: ctx.identity.name,
        role,
        opVersion: compatible ? opVersion : CANVAS_OP_VERSION,
        ...(ctx.identity.kind === 'guest' ? { guestLinkId: ctx.identity.linkId } : {}),
        send,
      };
      const ack = live.join(me);
      room = live;
      member = me;
      joinedAt = Date.now();
      send({ t: 'join-ack', ...ack, ...(notice ? { notice } : {}) });
      await audit(ctx.identity.actor, 'collab.join', `session:${ctx.session.id}`, {
        projectId: ctx.session.projectId, toolId: ctx.session.toolId, role, opVersion: me.opVersion,
        ...guestAudit(ctx.identity),
      });
    };

    const doOps = async (raw: Record<string, unknown>): Promise<void> => {
      const live = room;
      const me = member;
      if (!live || !me) return fail(ERR.NOT_JOINED, 'join before sending ops');
      if (me.role !== 'writer') {
        return fail(ERR.OBSERVER_READ_ONLY, 'this room seat is read-only');
      }
      const list = raw['ops'];
      if (!Array.isArray(list)) return fail(ERR.INVALID_OP, 'ops must be an array');
      if (list.length > MAX_OPS_PER_MESSAGE) {
        return void ws.close(CLOSE.OPS_RATE, `at most ${MAX_OPS_PER_MESSAGE} ops per message`);
      }
      const parsed: CanvasOp[] = [];
      for (const item of list) {
        const op = parseOp(item);
        // A malformed op is a broken or hostile client, not a user mistake: drop
        // the whole batch rather than applying an arbitrary prefix of it.
        if (!op) return fail(ERR.INVALID_OP, 'op failed contract validation');
        parsed.push(op);
      }
      if (!parsed.length) return;
      // The op-COUNT ceiling, charged before the three store reads below. The
      // message rate is charged synchronously on arrival (see the dispatch), so a
      // flood is refused without ever reaching the queue.
      if (!opsRate.add(Date.now(), parsed.length)) {
        return void ws.close(CLOSE.OPS_RATE, `at most ${OPS_PER_SEC} ops/s`);
      }

      // Re-authorize before every batch: identity, grants, project visibility,
      // the session's own liveness, and the overlay are all read fresh, so a
      // revocation lands on the next gesture rather than the next reconnect. For
      // a guest the same sentence holds with the link in place of the grants.
      const authz = await authorizeOps(ctx);
      if (!authz) {
        return void ws.close(CLOSE.UNAUTHORIZED, 'this session is no longer valid');
      }
      if (!authz.mayEdit) {
        // Demoted mid-room. The roster role stays as joined (a live demotion
        // broadcast is a shell-side decision, plans/100 wave 3.1); the write is
        // refused now, which is the part that must not wait.
        return fail(ERR.OBSERVER_READ_ONLY, 'session.edit was revoked for this room');
      }
      const { accepted, rejected } = vetoOps(parsed, authz, live);
      if (rejected.length) {
        // Sender-only, always. A vetoed op never existed as far as peers are
        // concerned (plans/14 §6, plans/100 §7 item 5).
        const byCode = new Map<string, string[]>();
        for (const r of rejected) {
          const bucket = byCode.get(r.code) ?? [];
          if (r.input) bucket.push(r.input);
          byCode.set(r.code, bucket);
        }
        for (const [code, inputs] of byCode) {
          fail(code, 'this input is not writable in this room', [...new Set(inputs)].sort());
        }
      }
      if (accepted.length) live.applyOps(me, accepted);
    };

    const doPresence = (raw: Record<string, unknown>): void => {
      const live = room;
      const me = member;
      if (!live || !me) return fail(ERR.NOT_JOINED, 'join before sending presence');
      if (!presenceRate.hit(Date.now())) {
        return void ws.close(CLOSE.PRESENCE_RATE, `at most ${PRESENCE_FRAMES_PER_SEC} presence frames/s`);
      }
      // Straight to the room. No policy, no store, no await - see the module
      // header and rooms.ts's structural rule.
      live.relayPresence(me, raw['frame']);
    };

    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        ws.close(CLOSE.PROTOCOL, 'frames are JSON');
        return;
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        ws.close(CLOSE.PROTOCOL, 'frames are objects');
        return;
      }
      const msg = raw as Record<string, unknown>;
      switch (msg['t']) {
        case 'join':
          enqueue(() => doJoin(msg));
          break;
        case 'ops':
          // Charged HERE rather than inside the handler: the handler runs behind
          // the queue, so a client that outruns the store would otherwise be rate-
          // checked at the pace the store drains rather than the pace it sends.
          if (!opsMessageRate.add(Date.now(), 1)) {
            ws.close(CLOSE.OPS_RATE, `at most ${OPS_MESSAGES_PER_SEC} ops messages/s`);
            break;
          }
          if (!enqueue(() => doOps(msg))) {
            ws.close(CLOSE.OPS_RATE, `at most ${MAX_QUEUED_MESSAGES} messages may await the store`);
          }
          break;
        case 'presence':
          // Presence is synchronous and unqueued on purpose: it must never wait
          // behind an op batch's policy read, and it carries no ordering promise.
          try {
            doPresence(msg);
          } catch {
            /* a presence frame can never take the socket down */
          }
          break;
        case 'leave':
          ws.close(1000, 'left');
          break;
        default:
          // Answered, not closed: a client on a newer build that sends a frame
          // type this gateway predates must not be disconnected by a rolling
          // upgrade (plans/100 §11.19 - version skew is routine, not exotic).
          fail(ERR.UNKNOWN_FRAME, `unknown frame type '${String(msg['t'])}'`);
      }
    });

    ws.on('error', () => ws.terminate());

    ws.on('close', () => {
      clearTimeout(joinTimer);
      clearInterval(heartbeat);
      sockets.delete(ws);
      const mine = (socketsPerUser.get(ctx.identity.principalId) ?? 1) - 1;
      if (mine > 0) socketsPerUser.set(ctx.identity.principalId, mine);
      else socketsPerUser.delete(ctx.identity.principalId);
      const live = room;
      const me = member;
      room = null;
      member = null;
      if (!live || !me) return;
      const lifetimeMs = Date.now() - joinedAt;
      // Ordered behind this connection's pending work: an op batch still waiting
      // on its policy read must land BEFORE the leave, or its edits would apply
      // to a room the rollup has already counted and closed.
      queue = queue
        .then(async () => {
          // Presence dies with the socket - the gateway evicts the peer and the
          // room broadcasts the leave (plans/100 §7 item 4: awareness TTL is the
          // client's business, eviction is ours).
          live.leave(me.id);
          // `ctx.identity.actor`, not a string rebuilt from the seat: a guest's
          // seat carries `guest:<linkId>` as its `userId`, so `user:${me.userId}`
          // would have written `user:guest:lnk…` and split one principal's join
          // and leave across two actor shapes.
          await audit(ctx.identity.actor, 'collab.leave', `session:${live.sessionId}`, {
            projectId: live.projectId, toolId: live.toolId, role: me.role, ms: lifetimeMs,
            ...guestAudit(ctx.identity),
          });
          // `releaseIfEmpty` re-checks occupancy at call time, so a join that
          // landed while we awaited keeps its room - and its rollup then covers
          // the whole life of the room rather than a torn half of it. Disposal
          // now also QUIESCES: the room's document lands as a normal session
          // revision before the rollup says the room closed (plans/14 §6).
          if (live.size === 0) await disposeIfEmpty(live);
        })
        .catch(onHandlerError);
    });
  };

  const onHandlerError = (err: unknown): void => {
    console.error('[lolly-work] collab handler failed:', (err as Error)?.message ?? err);
  };

  const drain = async (): Promise<void> => {
    closing = true;
    for (const ws of sockets) ws.close(CLOSE.GOING_AWAY, 'server closing');
    sockets.clear();
    // Every room still standing after the sockets went - including any whose
    // close handler has not run yet - quiesces here, so no shutdown loses a
    // document. Double disposal is safe: the registry re-checks identity, and a
    // quiesced room's snapshot row is already gone.
    for (const room of await registry.drain()) {
      const rollup = room.rollup();
      if (rollup.users > 0) await audit('system', 'collab.rollup', `session:${room.sessionId}`, { ...rollup });
    }
  };

  return {
    handleUpgrade(req, socket, head) {
      // The WHOLE body is guarded, not just the async half. main.ts calls this
      // synchronously from `server.on('upgrade')`, so anything that throws here
      // escapes into node's HTTP parser as an uncaught exception and exits the
      // process - an unauthenticated remote kill switch. `collabSessionId` is
      // already total; this is the belt that keeps a future edit from undoing it.
      let sessionId: string | null;
      try {
        sessionId = collabSessionId(req.url);
      } catch (err) {
        onHandlerError(err);
        socket.destroy();
        return true;
      }
      if (sessionId === null) return false;
      try {
        // The socket is ours from here; auth is async, so guard it against an
        // error in the gap (an unhandled 'error' on a raw socket kills the process).
        socket.on('error', () => undefined);
        void admit(req, socket, head, sessionId).catch((err) => {
          onHandlerError(err);
          try {
            refuse(socket, 500, 'INTERNAL');
          } catch {
            socket.destroy();
          }
        });
      } catch (err) {
        onHandlerError(err);
        socket.destroy();
      }
      return true;
    },
    rooms: () => registry.size(),
    snapshot: () => registry.list(),
    drain,
    close() {
      clearInterval(sweeper);
      // Sockets go, then every room quiesces. The registry is NOT cleared here,
      // because clearing it would make every `releaseIfEmpty` fail and silently
      // swallow both the rollup audit and the revision write. `drain()` is the
      // AWAITED form for a host that needs those writes to have landed; this one
      // is best-effort by design, so a test teardown stays synchronous.
      void drain().catch(onHandlerError);
      wss.close();
    },
  };
}
