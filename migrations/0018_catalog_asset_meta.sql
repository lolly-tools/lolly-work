-- lolly-work schema - org-defined asset metadata (plans/31 section 4).
--
-- Two tables, because the two halves have different owners and different
-- lifetimes.
--
-- catalog_field_defs holds the DEFINITIONS (id, label, kind, required,
-- options). They are policy: the policy-as-code document exports and applies
-- them beside grants, overlays, chains and flags, and the boot seeder writes
-- them here. The row is the store's copy of a document entry, which is why the
-- whole definition rides as jsonb rather than as one column per attribute - the
-- document is the schema, and a kind added there must not need a migration
-- here.
--
-- catalog_asset_meta holds the VALUES, keyed by CATALOG ASSET ID. Not by an
-- instance-asset id, and not as a column on instance_assets: an org has to be
-- able to file a federated `ext/*` asset (whose record belongs to an upstream
-- DAM) and a pack asset (whose record is a read-only file on disk) under its
-- own taxonomy, and neither of those can grow a column. All three id shapes
-- have an id, so an overlay keyed by id is the one storage that covers them
-- uniformly. There is no foreign key for the same reason: the id may name a row
-- this database does not hold.
--
-- An instance asset's own name, description and tags stay on its
-- instance_assets record - the submit pipeline already writes them there - so a
-- value has exactly one home and the asset editor and the submit review queue
-- cannot disagree about which copy is current.

create table catalog_field_defs (
  id         text primary key,
  def        jsonb not null,
  created_at timestamptz not null default now()
);

create table catalog_asset_meta (
  asset_id   text primary key,
  record     jsonb not null,
  updated_at timestamptz not null default now()
);
