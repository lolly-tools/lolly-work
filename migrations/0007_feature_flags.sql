-- Feature-flag governance (plans/04) — the control plane's default state and
-- toggle visibility for the shell's per-user feature flags.
--
-- One row per governed flag id; the row exists only while the control plane has
-- an opinion (a non-inherited default and/or hidden). The full governance record
-- is stored as JSON so the shape can grow (e.g. a future scheduled `revealAt`)
-- without a migration. Flags with no row inherit the shell's built-in default
-- and stay visible.

create table feature_flags (
  flag_id    text primary key,
  governance jsonb not null,
  updated_at timestamptz not null default now()
);
