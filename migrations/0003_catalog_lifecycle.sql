-- lolly-work schema — catalog content lifecycle (plans/06 §3). One row per
-- asset, keyed by the catalog's own asset id (e.g. 'suse/tokens/brand') — no
-- foreign key, since assets live in the pack mount, not the database. The
-- memory store mirrors this shape.

create table catalog_lifecycle (
  asset_id    text primary key,
  valid_from  timestamptz,
  valid_until timestamptz,
  revoked_at  timestamptz,
  on_expiry   text not null default 'hide' check (on_expiry in ('hide', 'warn'))
);
