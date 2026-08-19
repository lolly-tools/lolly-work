-- lolly-work schema - catalog submissions + submit quota (plans/31 section 3).
--
-- An instance asset that arrived by SUBMIT (a member uploading a file through
-- POST /api/v1/catalog/submit) carries a `submission` object on the jsonb
-- record: state, submitter, checksum, sniffed type/dimensions, and the approval
-- id when a chain gates it. The record stays the single source of truth - these
-- two columns are GENERATED from it, so the write path cannot make the column
-- and the jsonb disagree, and the review queue still gets a real index instead
-- of a full scan plus a filter in Node. A materialized (exit) asset carries no
-- submission object at all, so both columns are null for it, which is exactly
-- "not a submission" and never "a pending one".
--
-- Generated columns need Postgres 12+; the supported floor is 17 (CI, Compose
-- and the Helm chart all run postgres:17).

alter table instance_assets
  add column submission_state text
    generated always as (record -> 'submission' ->> 'state') stored,
  add column submitted_by text
    generated always as (record -> 'submission' ->> 'by') stored;

create index instance_assets_submission_state on instance_assets (submission_state);

-- Per-group submit quota counters (plans/31 section 3 step 1). One row per
-- SCOPE, where a scope is a group name, or '*' for a submitter who belongs to
-- no group at all. A submission is charged to EVERY group its submitter is in
-- and refused when ANY of them is over its cap, so extra memberships can only
-- ever tighten a member's budget, never buy more of it.
--
-- Counters are cumulative for everything that was kept: a returned submission
-- still spent the bytes it was stored with. The one decrement is a charge being
-- released - submit adds first and reads the post-add row to decide, because a
-- check made by an earlier read is a window every concurrent submission walks
-- through, so a refused submission gives back the charge it just made. Both
-- caps default to 0 in policy, which means unlimited, so an unconfigured
-- instance counts without refusing.

create table catalog_submit_quota (
  scope      text primary key,
  bytes      bigint not null default 0,
  count      integer not null default 0,
  updated_at timestamptz not null default now()
);
