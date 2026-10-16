-- A name or pin added to a version after it was written (plan 221). Only these
-- columns and `label` change; the content and the rest of the row stay as written.
-- A version with a name or a pin is kept: retention and space eviction never
-- remove it, and it counts against the named limits.
alter table session_versions
  add column pinned boolean not null default false,
  -- The person a version named or pinned later counts against; null for a version
  -- saved with a name (its creator) and for one that is not kept.
  add column kept_by text,
  -- One more on each change of the name or pin, so a change made against an older
  -- reading is refused.
  add column annotation_rev integer not null default 0 check (annotation_rev >= 0);
