-- lolly-work schema - catalog collections (plans/31 section 5).
--
-- A collection is a named, ORDERED set of catalog asset ids with group
-- visibility. One table, one jsonb record, for the same reason the asset-meta
-- overlay is keyed by id: a member may be an `inst/*` asset this database
-- holds, an `ext/*` asset whose record belongs to an upstream DAM, or a pack id
-- that is a read-only file on disk. Only the first of those three could carry a
-- foreign key, so a join table would quietly make collections an
-- instance-assets-only feature - and it would also lose the ORDER, which is the
-- curator's and is half of what a collection is (a lookbook is a sequence, not
-- a set).
--
-- Nothing here dereferences a member. Every surface that serves a collection
-- re-asks the per-asset gates for each id at the moment it serves, so a member
-- that is later revoked, expired or deleted simply stops appearing - the
-- collection needs no cascade and no repair.
--
-- `curator` is generated from the record so the console can list "sets I
-- curate" against an index instead of a full scan plus a filter in Node, the
-- same shape migration 0017 uses for a submission's state.

create table catalog_collections (
  id         text primary key,
  record     jsonb not null,
  curator    text generated always as (record ->> 'curator') stored,
  updated_at timestamptz not null default now()
);

create index catalog_collections_curator on catalog_collections (curator);
