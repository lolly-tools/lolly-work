-- SPDX-License-Identifier: MPL-2.0
-- Brand pages: a folder a shell or the CLI made, stored here and served at
-- /brand/<slug>/ once an administrator turns the feature on. One record per
-- address, immutable revisions under it, and at most one current. The files live
-- in the BlobStore under brand-page/<slug>/<n>/<sha256>. The manifest stays as
-- json, not jsonb, so brand.json keeps the order its publisher wrote.
create table brand_pages (
  slug            text primary key,
  name            text not null,
  next_n          integer not null default 1,
  current_n       integer,
  unpublished_at  timestamptz,
  unpublished_by  text,
  created_at      timestamptz not null,
  updated_at      timestamptz not null
);
create table brand_page_revisions (
  id               text primary key,
  slug             text not null references brand_pages (slug),
  n                integer not null,
  name             text not null,
  digest           text not null,
  manifest         json not null,
  size             bigint not null,
  file_count       integer not null,
  published_by     text not null,
  state            text not null check (state in ('staged', 'pending', 'live', 'superseded', 'unpublished', 'rejected', 'withdrawn', 'failed')),
  approval_id      text,
  created_at       timestamptz not null,
  live_at          timestamptz,
  bytes_removed_at timestamptz,
  unique (slug, n)
);
create index brand_page_revisions_publisher on brand_page_revisions (published_by, id);
-- A fifth scope on the uploads table: the bundle, which goes when it is stored.
alter table uploads drop constraint if exists uploads_scope_check;
alter table uploads add constraint uploads_scope_check check (scope in ('catalog-submission', 'automation-input', 'file', 'approval-artifact', 'brand-page'));
