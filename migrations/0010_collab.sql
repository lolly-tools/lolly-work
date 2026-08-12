-- lolly-work schema — live collaboration room persistence (plans/14 §6, OSS
-- plans/100 §7 item 3). ONE row per live room, keyed by the session it edits.
--
-- WHAT IS STORED IS THE SESSION'S INPUTS, not a CRDT update log. The room's
-- converged document and `sessions.inputs` are the same information in two
-- shapes (scalars → params, blocks inputs → collections — server/src/collab/
-- rooms.ts `seedOpsFromInputs` maps one way, persistence.ts `docToInputs` the
-- other), so the cheapest honest snapshot is "what this session would be if the
-- room quiesced right now". That makes crash recovery a plain
-- write of `inputs` as a revision, keeps ONE mapping under test instead of two,
-- and means this table never needs compaction: a snapshot REPLACES its
-- predecessor rather than appending to a log. (plans/14 §6 reached for y-leveldb's
-- snapshot+log algorithm; the log half only earns its keep when the document is
-- bigger than the update stream, which is never true for an input model.)
--
-- The row is TRANSIENT: it exists only while a room has unpersisted edits, and
-- the quiesce that writes the real session revision deletes it in the same pass.
-- A row surviving a process restart therefore MEANS "a crash lost this room's
-- quiesce" — that is the entire recovery signal.
--
-- base_rev is the `sessions.rev` the snapshot was taken against. On the next
-- join we recover ONLY when the stored session is still at that rev; a higher rev
-- means an ordinary PUT superseded the room and the snapshot is stale, so it is
-- dropped rather than replayed over newer work.
--
-- on delete cascade: a session hard-deleted by an operator (tombstones never
-- reach here — the app soft-deletes) must not leave a dangling recovery row that
-- would resurrect it.

create table collab_room_snapshots (
  session_id text primary key references sessions(id) on delete cascade,
  inputs     jsonb not null,
  base_rev   integer not null,
  ops        integer not null default 0,   -- accepted ops behind this snapshot
  updated_at timestamptz not null default now()
);
