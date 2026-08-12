// SPDX-License-Identifier: LicenseRef-Lolly-Work-Proprietary
/**
 * Yjs-backed CanvasSyncAdapter — lolly-work's real implementation of the canvas-op
 * seam (OSS plans/99 + plans/100, lolly-work plans/14). The OSS shell emits/consumes the
 * ops; THIS is the control-plane transport+storage that drives a live room. It satisfies
 * the SHARED conformance suite shipped in `@lolly-tools/core/canvas-op-testkit`
 * (`runConvergenceSuite`) — the same bytes the OSS `ReferenceCanvasDoc` passes — so the
 * two implementations cannot drift on op semantics (plans/99 §8).
 *
 * Contract level: canvas-op **v1.1** (plans/100 §3) — every box op may carry a `col`,
 * the blocks-input collection it targets; absent `col` = the default canvas collection.
 *
 * Design (faithful to `ReferenceCanvasDoc`, with a `Y.Doc` as the store):
 *   - `boxes: Y.Map<BoxId, Y.Map<field, Reg>>` — plans/99 §3's "Y.Map per box". This is
 *     the DEFAULT canvas collection and it keeps its v1.0 root name and layout, so a doc
 *     written by the v1.0 adapter loads here unchanged and an op with no `col` still
 *     lands byte-identically where it always did.
 *   - `collections: Y.Map<"<col>\0<BoxId>", Y.Map<field, Reg>>` (v1.1) — every blocks
 *     collection's boxes in ONE root map under a composite key, not a nested store per
 *     collection. Semantically identical to `boxes` (same registers, same
 *     `__alive`/`__order`, same order model, the same BoxId in two collections is two
 *     unrelated boxes — plans/100 §3); `state()` groups by the key prefix. FLAT ON
 *     PURPOSE, and this is the load-bearing part: a nested `Y.Map` held as the VALUE of
 *     a key is resolved by Yjs's per-key LWW on MERGE, so two docs that concurrently
 *     materialize the same `col` keep one store and DELETE THE LOSER'S WHOLE SUBTREE —
 *     every row a peer wrote before the first sync, regardless of app clock. Flat keys
 *     make two peers adding different rows touch different keys of a root type, which
 *     merges structurally; a collection's worst-case cross-doc loss is then exactly the
 *     canvas's (below), not "the collection". Materialized on the first op that names
 *     it, never on a read: a v1.0 op log leaves the root empty and `state()` then emits
 *     no `collections` key at all.
 *   - Each field is an app-level LWW REGISTER `{ value, origin }` resolved by the op's
 *     `(clock, client)` — NOT Yjs's native per-key LWW. Membership is an `__alive`
 *     register; paint order an `__order` fractional-index register (plans/99 §3). They
 *     share the box's Y.Map with ordinary fields, so a field NAME that collides with one
 *     is escaped (`fieldKey`) — otherwise a `field` op could set `__alive` and delete a
 *     box no `remove` op authorized, while the reference (separate slots) kept it as an
 *     ordinary field. Storing app-registers keeps `apply()` order-independent for a
 *     single doc, which is what the conformance suite replays. **Production caveat
 *     (plans/14 follow-up):** true cross-doc concurrency (two rooms syncing) resolves
 *     each Y.Map key by YJS's clock, which can discard the higher-app-clock register —
 *     so before enabling multi-replica sync, either make the register comparison run on
 *     the Yjs merge, or move order to a real `Y.Array<BoxId>` and accept the §8
 *     within-model order divergence. Two docs that concurrently CREATE the same BoxId
 *     (in the canvas or in one collection) likewise keep one box map and lose the
 *     other's registers. What bounds that blast radius to one box is the structural rule
 *     above — every box hangs off a ROOT map at its own key — so a fix for the register
 *     comparison must not reintroduce a nested per-collection store. v1.1 changes the
 *     caveat's SCOPE (it now applies per collection) but not its size. Single-node rooms
 *     (plans/14 §6 "one node serves the org") are unaffected.
 *   - Awareness/presence is ephemeral — Yjs's awareness channel in the gateway, never the
 *     doc (plans/99 §5); here it is simply never written to `Y.Doc`.
 *
 * The op SHAPE + the reused `damageToOps`/`opsToDamage` come from the pinned
 * `@lolly-tools/core` (engine-pin.json) — we never re-declare them.
 */
import * as Y from 'yjs';
import {
  DEFAULT_GEOMETRY_FIELDS,
  damageToOps,
  opsToDamage,
} from '@lolly-tools/core/canvas-op-v1';
import type {
  CanvasSyncAdapter,
  CanvasOp,
  CanvasDocState,
  Damage,
  Awareness,
  BoxId,
  BoxRow,
  ParamValue,
  Scalar,
  OpOrigin,
  GeometryField,
} from '@lolly-tools/core/canvas-op-v1';

/** An app-level last-writer-wins register, resolved by the op's Lamport origin. */
interface Reg<T> {
  value: T;
  origin: OpOrigin;
}

/** One box: its fields plus the `__alive`/`__order` registers, all in one Y.Map. */
type BoxMap = Y.Map<Reg<Scalar>>;
/** One collection's boxes as an ordinary (BoxId → box) map. The canvas root is one
 *  already; a blocks collection's is grouped out of the flat `collections` root by key
 *  prefix. Every read runs against this, which is what makes a collection an ordinary
 *  boxes document rather than a special case. */
type BoxView = Map<BoxId, BoxMap>;

/** Higher clock wins; on a tie the higher `client` id wins. Strict, so re-applying an
 *  identical op is a no-op (idempotent) — mirrors core's private `beats`. */
function beats(a: OpOrigin, b: OpOrigin): boolean {
  return a.clock !== b.clock ? a.clock > b.clock : a.client > b.client;
}

const ALIVE = '__alive';
const ORDER = '__order';
const SEP = '\u0000';

/** The flat `collections` key for one box: `<encoded col>\0<BoxId>`. The collection id
 *  is percent-encoded (which escapes NUL as `%00`), so the separator can only be the one
 *  we wrote and the BoxId is the untouched remainder — the split is unambiguous for ANY
 *  pair of strings, including a BoxId containing a NUL. */
function colKey(col: string, id: BoxId): string {
  return `${encodeURIComponent(col)}${SEP}${id}`;
}

/** The collection id a flat key belongs to, or null if the key is not one of ours.
 *  Decoding is guarded because the doc is a MERGE TARGET: a malformed key from a peer
 *  must not throw out of `state()`. */
function colOf(key: string): string | null {
  const i = key.indexOf(SEP);
  if (i < 0) return null;
  const raw = key.slice(0, i);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Field name → Y.Map key. `__alive`/`__order` live in the same map as ordinary fields,
 *  so a field literally NAMED one of them would be the register: a `field` op would
 *  delete the box (or blank paint order) with no `remove` op ever authorized, and the
 *  reference — which keeps alive/order in their own slots — would keep it as a plain
 *  field. Any `__`-prefixed name takes one extra `_`, so the two reserved keys are the
 *  only two-underscore keys that can exist and the mapping stays a bijection. */
function fieldKey(name: string): string {
  return name.startsWith('__') ? `_${name}` : name;
}

/** The inverse of `fieldKey` (`___x` → `__x`); reserved keys are filtered by the caller. */
function fieldName(key: string): string {
  return key.startsWith('___') ? key.slice(1) : key;
}

export class YjsCanvasAdapter implements CanvasSyncAdapter {
  readonly doc: Y.Doc;
  /** The default canvas collection (v1.0 root name + layout, unchanged). */
  private readonly boxes: Y.Map<BoxMap>;
  /** v1.1: EVERY blocks collection's boxes, flat, under `colKey(col, id)`. One root
   *  type rather than a nested store per collection — see the header's FLAT ON PURPOSE. */
  private readonly collections: Y.Map<BoxMap>;
  private readonly params: Y.Map<Reg<ParamValue>>;
  private readonly clientId: string;
  private clock = 0;
  private lastPresence: Awareness | null = null;

  constructor(clientId = 'yjs', doc: Y.Doc = new Y.Doc()) {
    this.doc = doc;
    // getMap()'s value generic is version-dependent; cast at the boundary and keep the
    // internal register logic strongly typed. An untouched root type contributes no
    // items to an update, so naming `collections` here costs a v1.0 doc nothing.
    this.boxes = doc.getMap('boxes') as unknown as Y.Map<BoxMap>;
    this.collections = doc.getMap('collections') as unknown as Y.Map<BoxMap>;
    this.params = doc.getMap('params') as unknown as Y.Map<Reg<ParamValue>>;
    this.clientId = clientId;
  }

  onLocalChange(_damage: Damage, rows: Map<BoxId, BoxRow>, col?: string): CanvasOp[] {
    // v1.1: `col` scopes BOTH the diff base and the emitted ops to one collection, so a
    // gesture on a blocks input never diffs against the canvas (and vice versa).
    const origin: OpOrigin = { client: this.clientId, clock: ++this.clock };
    const ops = damageToOps(this.currentRows(col), rows, origin, DEFAULT_GEOMETRY_FIELDS, col);
    this.doc.transact(() => { for (const op of ops) this.apply(op); });
    return ops;
  }

  apply(op: CanvasOp): void {
    // Lamport rule: absorb the origin's clock so a subsequently-minted local op is
    // causally after anything we have applied (mirrors core's ReferenceCanvasDoc).
    if (op.origin.clock > this.clock) this.clock = op.origin.clock;
    switch (op.k) {
      case 'geom': {
        const m = this.boxMap(op.id, op.col);
        for (const f of Object.keys(op.fields)) {
          const v = op.fields[f as GeometryField];
          if (v !== undefined) this.putReg(m, f, v, op.origin);
        }
        break;
      }
      case 'field':
        this.putReg(this.boxMap(op.id, op.col), op.field, op.value, op.origin);
        break;
      case 'add': {
        const m = this.boxMap(op.id, op.col);
        this.putRes(m, ALIVE, true, op.origin);
        this.putRes(m, ORDER, op.orderKey, op.origin);
        for (const f of Object.keys(op.row)) this.putReg(m, f, op.row[f] as Scalar, op.origin);
        break;
      }
      case 'remove':
        this.putRes(this.boxMap(op.id, op.col), ALIVE, false, op.origin);
        break;
      case 'order':
        this.putRes(this.boxMap(op.id, op.col), ORDER, op.orderKey, op.origin);
        break;
      case 'param': {
        // The params lane is collection-BLIND by contract (plans/100 §3) — ParamOp
        // carries no `col` and there is nothing to scope.
        const cur = this.params.get(op.key);
        if (!cur || beats(op.origin, cur.origin)) this.params.set(op.key, { value: op.value, origin: op.origin });
        break;
      }
    }
  }

  applyRemotePatch(ops: readonly CanvasOp[]): Damage {
    this.doc.transact(() => { for (const op of ops) this.apply(op); });
    // The CANVAS collection's damage, per the contract: a caller presenting a blocks
    // collection computes its own with `opsToDamage(ops, col)`.
    return opsToDamage(ops);
  }

  presence(a: Awareness): void {
    // Ephemeral — never written to the doc (plans/99 §5). The gateway broadcasts this
    // over Yjs awareness; here it is inspection-only.
    this.lastPresence = a;
  }

  state(): CanvasDocState {
    const params = new Map<string, ParamValue>();
    for (const key of [...this.params.keys()].sort()) {
      const reg = this.params.get(key);
      if (reg !== undefined) params.set(key, reg.value);
    }
    const canvas = this.view();
    const state: CanvasDocState = {
      order: this.order(canvas),
      boxes: this.snapshot(canvas),
      params,
    };
    // v1.1: collection ids sorted (the testkit's canonical form), each snapshotted the
    // same canonical way — and the key stays ABSENT when no collection-scoped op has
    // ever applied, so a v1.0 op log yields a v1.0-shaped state.
    const colIds = this.colIds();
    if (colIds.length > 0) {
      const collections = new Map<string, { order: BoxId[]; boxes: Map<BoxId, BoxRow> }>();
      for (const colId of colIds) {
        const view = this.view(colId);
        collections.set(colId, { order: this.order(view), boxes: this.snapshot(view) });
      }
      state.collections = collections;
    }
    return state;
  }

  // — internals —

  /** The box an op targets, created on first write. WRITE path: a collection is
   *  materialized by its first box landing under the collection's key prefix — there is
   *  no separate store to create, which is exactly what keeps a concurrent creation of
   *  the SAME collection in two docs a structural merge (header, FLAT ON PURPOSE). */
  private boxMap(id: BoxId, col?: string): BoxMap {
    const root = col === undefined ? this.boxes : this.collections;
    const key = col === undefined ? id : colKey(col, id);
    let m = root.get(key);
    if (m === undefined) {
      m = new Y.Map();
      root.set(key, m);
    }
    return m;
  }

  /** The app-level LWW write, on a storage key. */
  private putKey(m: BoxMap, key: string, value: Scalar, origin: OpOrigin): void {
    const cur = m.get(key);
    if (!cur || beats(origin, cur.origin)) m.set(key, { value, origin });
  }

  /** A FIELD write — escaped, so no field name can land on a reserved register. */
  private putReg(m: BoxMap, field: string, value: Scalar, origin: OpOrigin): void {
    this.putKey(m, fieldKey(field), value, origin);
  }

  /** A RESERVED register write (`__alive`/`__order`) — same rule, no escaping, because
   *  these two keys ARE the escape target rather than a field. */
  private putRes(m: BoxMap, key: typeof ALIVE | typeof ORDER, value: Scalar, origin: OpOrigin): void {
    this.putKey(m, key, value, origin);
  }

  /** One collection's boxes as an ordinary (BoxId → box) map. Pure READ — grouping the
   *  flat root by key prefix materializes nothing, so an untouched collection simply
   *  yields an empty view and `state()` stays v1.0-shaped. */
  private view(col?: string): BoxView {
    const view: BoxView = new Map();
    if (col === undefined) {
      for (const [id, m] of this.boxes) view.set(id, m);
      return view;
    }
    const prefix = `${encodeURIComponent(col)}${SEP}`;
    for (const [key, m] of this.collections) {
      if (key.startsWith(prefix)) view.set(key.slice(prefix.length), m);
    }
    return view;
  }

  /** Every materialized collection id, sorted — a collection exists exactly when at
   *  least one box key carries its prefix. */
  private colIds(): string[] {
    const ids = new Set<string>();
    for (const key of this.collections.keys()) {
      const col = colOf(key);
      if (col !== null) ids.add(col);
    }
    return [...ids].sort();
  }

  private aliveIds(view: BoxView): BoxId[] {
    const ids: BoxId[] = [];
    for (const [id, m] of view) {
      const a = m.get(ALIVE);
      if (a && a.value === true) ids.push(id);
    }
    return ids;
  }

  /** Alive boxes, stable-sorted by (orderKey, BoxId) — the reference's order model,
   *  applied per collection. */
  private order(view: BoxView): BoxId[] {
    return this.aliveIds(view).sort((a, b) => {
      const ka = String(view.get(a)?.get(ORDER)?.value ?? '');
      const kb = String(view.get(b)?.get(ORDER)?.value ?? '');
      return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
  }

  private rowOf(view: BoxView, id: BoxId): BoxRow {
    const m = view.get(id);
    const row: BoxRow = {};
    if (m) {
      // Sorted keys so the row serialization is canonical — field insertion order
      // depends on apply order, which must not leak into state(). Sorted on the FIELD
      // NAME, not the storage key, so an escaped `__`-prefixed name sorts where the
      // reference puts it.
      const fields = [...m.keys()].filter((k) => k !== ALIVE && k !== ORDER).map(fieldName).sort();
      for (const field of fields) {
        const reg = m.get(fieldKey(field));
        if (reg !== undefined) row[field] = reg.value;
      }
    }
    return row;
  }

  /** Alive rows keyed by id, in canonical (sorted-id) order. */
  private snapshot(view: BoxView): Map<BoxId, BoxRow> {
    const boxes = new Map<BoxId, BoxRow>();
    for (const id of this.aliveIds(view).sort()) boxes.set(id, this.rowOf(view, id));
    return boxes;
  }

  private currentRows(col?: string): Map<BoxId, BoxRow> {
    const view = this.view(col);
    const rows = new Map<BoxId, BoxRow>();
    for (const id of this.order(view)) rows.set(id, this.rowOf(view, id));
    return rows;
  }
}
