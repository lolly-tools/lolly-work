-- lolly-work schema — content-credential detections (plans/27 §4). One row per
-- scanned asset, keyed by the catalog asset id (pack or federated 'ext/…'), no
-- foreign key since assets live in the pack mount / upstream DAM, not the
-- database. Records only WHETHER a C2PA manifest was found embedded in the
-- bytes and in which container — never claims, never a verdict (detection, not
-- verification). `source_updated_at` snapshots the upstream updatedAt at scan
-- time so a re-scan can tell the source has changed. The memory store mirrors
-- this shape.

create table catalog_credentials (
  asset_id          text primary key,
  status            text not null check (status in ('embedded', 'none')),
  container         text,
  sniffed_at        timestamptz not null,
  source_updated_at timestamptz
);
