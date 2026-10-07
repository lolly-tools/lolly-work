// SPDX-License-Identifier: MPL-2.0
/**
 * Automatic versions of a live document (plan 76 milestone 4, R2).
 *
 * A live room commits every accepted batch to the session row, so the row is
 * always current but says nothing about how it got there. This module turns that
 * stream into a few meaningful versions (store `putSessionVersion`):
 *
 *   - `auto`: written VERSION_IDLE_MS after the last accepted change, or
 *     VERSION_INTERVAL_MS after the first change since the last version while
 *     changes keep arriving, whichever comes first;
 *   - `close`: written when the room quiesces or drains with changes not yet in a
 *     version;
 *   - `save`: written by a REST save (`recordSaveVersion`), outside any room.
 *
 * Each version's content is read from the durable session row, never from the
 * room's memory, so a version always matches something the database holds. The
 * people who made the changes since the previous version ride along as
 * `contributors`: a member as `user`, an agent as `agent` and every guest
 * together as one `guest` entry with no link id (`SessionVersionContributor`).
 *
 * The store dedupes an automatic version whose content equals the latest
 * version, so an edit that was undone, or a room that closes right after an
 * automatic version, adds no row. Writes never throw to the room: a failure is
 * logged and its contributors are kept for the next version. Timers are unref'd
 * and cleared on `close` and `dispose`.
 */
import type { RoomWriter } from '../collab/persistence.ts';
import type { SessionRecord, SessionVersionContributor, SessionVersionKind, Store } from '../store/types.ts';

/** Quiet time after the last change before an automatic version. */
export const VERSION_IDLE_MS = 120_000;
/** Longest stretch of continuous changes without an automatic version. */
export const VERSION_INTERVAL_MS = 600_000;

/** The timer functions the recorder uses; injectable so tests own the clock. */
export interface RecorderTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: RecorderTimers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export interface VersionRecorder {
  /** One accepted batch by `writer`. Starts or extends the pending run. */
  touch(writer: RoomWriter, edits?: number): void;
  /** Write a `close` version when changes are pending, then stop. Idempotent. */
  close(): Promise<void>;
  /** Stop without writing (the room lost its lease). */
  dispose(): void;
  /** Resolve once every version write started so far has settled. */
  flush(): Promise<void>;
  /** Whether changes are waiting for a version (tests and introspection). */
  readonly pending: boolean;
}

export interface VersionRecorderOptions {
  store: Pick<Store, 'getSession' | 'putSessionVersion'>;
  sessionId: string;
  idleMs?: number;
  intervalMs?: number;
  timers?: RecorderTimers;
  onError?(error: unknown): void;
}

/** A contributor entry per principal: guests share the one id 'guest'. */
export function contributorOf(writer: RoomWriter): Pick<SessionVersionContributor, 'id' | 'kind'> {
  return writer.kind === 'member' ? { id: writer.userId, kind: 'user' }
    : writer.kind === 'agent' ? { id: writer.agentId, kind: 'agent' }
      : { id: 'guest', kind: 'guest' };
}

/** Most edits first, then by kind and id, so the stored order is stable. */
const byEdits = (a: SessionVersionContributor, b: SessionVersionContributor): number =>
  b.edits - a.edits || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function createVersionRecorder(options: VersionRecorderOptions): VersionRecorder {
  const { store, sessionId } = options;
  const idleMs = options.idleMs ?? VERSION_IDLE_MS;
  const intervalMs = options.intervalMs ?? VERSION_INTERVAL_MS;
  const timers = options.timers ?? realTimers;
  const onError = options.onError ?? ((error: unknown) => {
    console.error(`[lolly-work] version capture failed for ${sessionId}:`, (error as Error)?.message ?? error);
  });
  const contributors = new Map<string, SessionVersionContributor>();
  let pending = false;
  let stopped = false;
  let idle: unknown;
  let interval: unknown;
  let writes: Promise<void> = Promise.resolve();

  const clearTimers = (): void => {
    if (idle !== undefined) timers.clear(idle);
    if (interval !== undefined) timers.clear(interval);
    idle = interval = undefined;
  };

  const add = (entry: SessionVersionContributor): void => {
    const key = `${entry.kind}:${entry.id}`;
    const seen = contributors.get(key);
    contributors.set(key, seen ? { ...seen, edits: seen.edits + entry.edits } : { ...entry });
  };

  const write = (kind: Extract<SessionVersionKind, 'auto' | 'close'>): Promise<void> => {
    clearTimers();
    if (!pending) return writes;
    const taken = [...contributors.values()].sort(byEdits);
    contributors.clear();
    pending = false;
    writes = writes.then(async () => {
      try {
        const session = await store.getSession(sessionId);
        // A deleted document gets no new versions; its versions go with it.
        if (!session || session.deletedAt) return;
        await store.putSessionVersion({ sessionId, rev: session.rev, kind, inputs: session.inputs, meta: session.meta, contributors: taken });
      } catch (error) {
        // Keep who edited for the next version rather than losing them.
        for (const entry of taken) add(entry);
        if (!stopped) arm();
        onError(error);
      }
    });
    return writes;
  };

  /** Start (or extend) the pending run: the idle clock restarts on every
   *  change; the interval clock starts once per run. */
  function arm(): void {
    pending = true;
    if (idle !== undefined) timers.clear(idle);
    idle = timers.set(() => { idle = undefined; void write('auto'); }, idleMs);
    interval ??= timers.set(() => { interval = undefined; void write('auto'); }, intervalMs);
  }

  return {
    touch(writer, edits = 1) {
      if (stopped || !(edits > 0)) return;
      add({ ...contributorOf(writer), edits });
      arm();
    },
    async close() {
      if (stopped) return writes;
      const done = write('close');
      stopped = true;
      return done;
    },
    dispose() {
      stopped = true;
      pending = false;
      contributors.clear();
      clearTimers();
    },
    flush: () => writes,
    get pending() { return pending; },
  };
}

/**
 * The `save` version a REST save writes (plan 76 M4): the stored row just
 * written, attributed to the saver. Best effort: a failure is logged and never
 * fails the save itself, and the store's dedupe skips a save that changed
 * nothing since the latest version.
 */
export async function recordSaveVersion(
  store: Pick<Store, 'putSessionVersion'>, session: SessionRecord, createdBy: string, contributor: Pick<SessionVersionContributor, 'id' | 'kind'>,
): Promise<void> {
  try {
    await store.putSessionVersion({ sessionId: session.id, rev: session.rev, kind: 'save', inputs: session.inputs, meta: session.meta,
      contributors: [{ ...contributor, edits: 1 }], createdBy });
  } catch (error) {
    console.error(`[lolly-work] save version failed for ${session.id}:`, (error as Error)?.message ?? error);
  }
}
