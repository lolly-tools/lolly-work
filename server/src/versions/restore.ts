// SPDX-License-Identifier: MPL-2.0
/**
 * Restoring a saved version (plan 76 milestone 4, R2): the write checks a
 * restore shares with a person's own live edits, the bridge the HTTP app uses to
 * reach the live room, and the compare-and-swap path for a host with no room.
 *
 * ONE WRITE RULE. `inputWriteRefusal` is the per-input decision the collab
 * gateway applies to every op a person sends (declared inputs, the input's lane,
 * the overlay's `inputAccess`). The gateway's veto calls it for every live op,
 * the room restore calls that veto for the restoring person, and the
 * compare-and-swap path below calls it per input. A version therefore cannot
 * write what its restorer could not have typed: a locked input keeps its
 * current value and is reported in `vetoed`.
 *
 * WHERE A RESTORE RUNS. With a collab gateway (the long-lived server) a restore
 * always goes through the session's room (`VersionRoomBridge`, built by
 * gateway.ts and injected as `AppDeps.versionRooms`, so this module and app.ts
 * never import the socket server). Without one (the Vercel function) no room can
 * be open on this host, so `restoreByCas` writes the session row with
 * `casSession`, which also refuses while another host's room holds the lease.
 */
import { isDeepStrictEqual } from 'node:util';
import { inputIsGoverned, resolveInputAccess, type ResolvedAccess, type ToolOverlay } from '../policy/overlay.ts';
import type { SessionVersion, Store, UserRecord } from '../store/types.ts';

/** The rows a write is judged against, read fresh for each write. */
export interface InputWritePolicy {
  /** The groups the overlay resolves against (a guest's is the synthetic one). */
  groups: string[];
  overlay: ToolOverlay | undefined;
  /** A guest gets no member fallback on an input that has any rule. */
  isGuest: boolean;
  /** Declared input ids; null when the tool's manifest could not be read. */
  declared: Set<string> | null;
  /** Declared input types, for the lane check. */
  types: Map<string, string>;
}

/** Why an input may not be written: undeclared, wrong lane, or the overlay. */
export type InputWriteRefusal = 'unknown' | 'wrong-lane' | 'locked' | 'hidden' | 'not-allowed';

/** Refusals that are policy (a person may not write it), as opposed to shape. */
export const VETO_REFUSALS: ReadonlySet<InputWriteRefusal> = new Set(['locked', 'hidden', 'not-allowed']);

/**
 * May this write reach `input`? `param` is a scalar write with its value; `box`
 * is any write to a blocks input's rows. Null means yes.
 *
 * The lane is part of the rule: a box write may only address a `blocks` input
 * and a param write only one that is not, so a governed scalar cannot be
 * re-scoped as a collection to walk past its rules. A `choice` input takes only
 * an allowed scalar. A guest that matches no rule of a governed input is locked
 * out of it rather than getting the member default (plans/02 §8).
 */
export function inputWriteRefusal(policy: InputWritePolicy, input: string, write: { lane: 'param'; value: unknown } | { lane: 'box' }): InputWriteRefusal | null {
  if (policy.declared && !policy.declared.has(input)) return 'unknown';
  const type = policy.types.get(input);
  if (type !== undefined && (write.lane === 'param') === (type === 'blocks')) return 'wrong-lane';
  const resolved = resolveInputAccess(policy.overlay, input, policy.groups);
  const access: ResolvedAccess = policy.isGuest && resolved.level === 'editable' && inputIsGoverned(policy.overlay, input)
    ? { level: 'locked' } : resolved;
  if (access.level === 'locked') return 'locked';
  if (access.level === 'hidden') return 'hidden';
  if (access.level === 'choice' && access.allow && (write.lane !== 'param' || !access.allow.some((allowed) => allowed === write.value))) return 'not-allowed';
  return null;
}

/** The person's write rights over a session, or null when they may not be in it. */
export type RestorePolicy = InputWritePolicy & { mayEdit: boolean };

/** Why a restore stopped; versions/routes.ts maps each to a status. */
export type RestoreFailure = 'FORBIDDEN' | 'READ_ONLY' | 'RESTORE_INCOMPLETE' | 'SESSION_CHANGED' | 'VERSION_SPACE' | 'SESSION_GONE' | 'REPEATED';

export class RestoreError extends Error {
  readonly code: RestoreFailure;
  /** For REPEATED: the 'before' row an earlier request with the same id wrote. */
  readonly beforeId?: string;
  constructor(code: RestoreFailure, message: string, beforeId?: string) {
    super(message);
    this.code = code;
    if (beforeId !== undefined) this.beforeId = beforeId;
  }
}

/** The document a restore replaces, handed to `beforeCommit`. */
export interface RestoreBefore { inputs: Record<string, unknown>; meta: Record<string, unknown>; revision: number }

export interface VersionRestoreArgs {
  sessionId: string;
  /** The restoring person, already through the route's gate. */
  user: UserRecord;
  target: SessionVersion;
  /** Writes the 'before' version and returns its id; throws a RestoreError. */
  beforeCommit(before: RestoreBefore): Promise<string>;
}

export interface VersionRestoreResult {
  /** The session revision after the restore (unchanged when nothing differed). */
  revision: number;
  /** Whether other people were in the live room. */
  live: boolean;
  skipped: string[];
  vetoed: string[];
  beforeId: string;
  /** The stored row after the restore: what the 'restore' version records. */
  inputs: Record<string, unknown>;
  meta: Record<string, unknown>;
}

/** The live-room half, built by the collab gateway (`collab.versions`). */
export interface VersionRoomBridge {
  restore(args: VersionRestoreArgs): Promise<VersionRestoreResult>;
}

/** The input values a restore writes over `current`, under `policy`. An input
 *  the version lacks is removed, which a whole-row write can do. */
export function restoredInputs(current: Record<string, unknown>, target: Record<string, unknown>, policy: InputWritePolicy):
  { inputs: Record<string, unknown>; vetoed: string[]; skipped: string[] } {
  const inputs: Record<string, unknown> = { ...current };
  const vetoed: string[] = [];
  const skipped: string[] = [];
  for (const key of [...new Set([...Object.keys(current), ...Object.keys(target)])].sort()) {
    const kept = Object.hasOwn(target, key);
    if (kept ? isDeepStrictEqual(current[key], target[key]) : !Object.hasOwn(current, key)) continue;
    const value = kept ? target[key] : current[key];
    const refusal = inputWriteRefusal(policy, key, Array.isArray(value) ? { lane: 'box' } : { lane: 'param', value: kept ? value : undefined });
    if (refusal) { (VETO_REFUSALS.has(refusal) ? vetoed : skipped).push(key); continue; }
    if (kept) inputs[key] = target[key];
    else delete inputs[key];
  }
  return { inputs, vetoed, skipped };
}

/** Attempts before a compare-and-swap restore gives up with SESSION_CHANGED. */
export const RESTORE_CAS_ATTEMPTS = 3;

/**
 * Restore without a live room (plan 76 M4 2.8 step 5): read the row, apply the
 * same write rule per input (a vetoed input keeps its current value), write the
 * 'before' version from THIS row, then `casSession` at its rev. A lost race
 * deletes that attempt's 'before' row (no restore row points at it yet) and tries
 * again. The new revision is attributed to the restoring person.
 */
export async function restoreByCas(
  d: { store: Store; policy(user: UserRecord, sessionId: string): Promise<RestorePolicy | null> }, args: VersionRestoreArgs,
): Promise<VersionRestoreResult> {
  for (let attempt = 0; attempt < RESTORE_CAS_ATTEMPTS; attempt++) {
    const session = await d.store.getSession(args.sessionId);
    if (!session || session.deletedAt) throw new RestoreError('SESSION_GONE', 'this session was deleted');
    const policy = await d.policy(args.user, session.id);
    if (!policy) throw new RestoreError('FORBIDDEN', 'you cannot see this session');
    if (!policy.mayEdit) throw new RestoreError('READ_ONLY', 'you can view this session but not change it');
    const out = restoredInputs(session.inputs, args.target.inputs, policy);
    const beforeId = await args.beforeCommit({ inputs: session.inputs, meta: session.meta, revision: session.rev });
    if (isDeepStrictEqual(out.inputs, session.inputs)) {
      return { revision: session.rev, live: false, skipped: out.skipped, vetoed: out.vetoed, beforeId, inputs: session.inputs, meta: session.meta };
    }
    const at = new Date().toISOString();
    const next = { ...session, inputs: out.inputs, rev: session.rev + 1, updatedBy: args.user.id, updatedAt: at };
    if (await d.store.casSession(next, session.rev)) {
      await d.store.appendSessionRevision({ sessionId: session.id, rev: next.rev, inputs: next.inputs, meta: next.meta, actor: args.user.id, at });
      return { revision: next.rev, live: false, skipped: out.skipped, vetoed: out.vetoed, beforeId, inputs: next.inputs, meta: next.meta };
    }
    await d.store.deleteSessionVersion(session.id, beforeId);
  }
  throw new RestoreError('SESSION_CHANGED', 'The document changed while restoring.');
}
