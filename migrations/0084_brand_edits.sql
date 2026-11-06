-- SPDX-License-Identifier: MPL-2.0
-- Brand edits: a manager's change to the active design system's colours, colour
-- roles or brand page address, served on top of the mounted pack with no rebuild.
-- One immutable row per sent document. The bytes live in the BlobStore under
-- brand-edit/<source hash>/<n>/<sha256>. Which revision is live is not here: that
-- is a pointer in brand_state, so going live and rolling back commit with their
-- audit event. Dropping this table loses history and nothing else.
create table brand_edit_revisions (
  id            text primary key,
  source_id     text not null,
  n             integer not null,
  digest        text not null,
  base_checksum text not null,
  changes       jsonb not null,
  size          integer not null,
  sent_by       text not null,
  state         text not null,
  approval_id   text,
  restored_from integer,
  created_at    timestamptz not null,
  live_at       timestamptz,
  ended_at      timestamptz,
  ended_by      text
);
create index brand_edit_revisions_source on brand_edit_revisions (source_id, n);
create index brand_edit_revisions_sender on brand_edit_revisions (sent_by, id);
