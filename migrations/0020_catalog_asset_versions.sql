-- lolly-work schema - instance asset versions (plans/31 section 6).
--
-- New bytes for an existing inst/* asset become version N+1 rather than a
-- second asset id: the id an org has already linked, collected, rendered and
-- sent to a printer stays the id, and what changes underneath it is a
-- SEQUENCE. Prior versions are kept, the feed serves the head, and a gated
-- ?v=N fetch keeps old bytes reachable for a session that pinned them.
--
-- One row per version, keyed (asset_id, version). The whole snapshot rides as
-- jsonb for the same reason the instance-asset record does: a version carries a
-- format SET (format name to blob id, size, checksum), and the set is what a
-- head move and a rollback swap whole.
--
-- The HEAD is deliberately NOT a flag on a row - it is `headVersion` on the
-- instance-asset record. "Exactly one head" is then a property of the shape
-- rather than an invariant two writes have to keep, and a rollback is one
-- record write instead of a two-row flip that can half-fail. An asset with no
-- headVersion has never been versioned and reads as version 1, which is why
-- this migration ships with no data backfill: version 1 is materialized from
-- the record itself the first time a second version arrives.
--
-- Version numbers are never reused. Deleting a version (retention, or an
-- explicit delete a hold can refuse) leaves a hole, because somebody may hold a
-- ?v=N URL for it and quietly handing them DIFFERENT bytes under the same
-- number would be worse than a 404.
--
-- No foreign key into instance_assets: the rest of the catalog schema keys on
-- the catalog asset id without one, and deleting an asset deletes its versions
-- through the same route that deletes its blobs.

create table catalog_asset_versions (
  asset_id   text not null,
  version    integer not null,
  record     jsonb not null,
  created_at timestamptz not null default now(),
  primary key (asset_id, version)
);
