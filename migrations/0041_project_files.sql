-- Shared project uploads (plans/74). Bytes use the configured BlobStore in
-- bounded parts (`project-file/<id>/<n>`); this row holds the declared
-- metadata. An unfinished upload (ready = false) expires at expires_at and is
-- then swept, parts first. created_by has no cascade: account erasure removes
-- the person's unfinished uploads itself and is refused while a ready file
-- still names them.
create table project_files (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  name text not null,
  size bigint not null check (size > 0 and size <= 268435456),
  checksum text not null,
  content_type text not null,
  parts jsonb not null,
  asset jsonb not null default '{}',
  created_by text not null references users(id),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  ready boolean not null default false
);
create index project_files_project on project_files(project_id, created_at);
-- Erasure preview and the users FK check look files up by uploader.
create index project_files_created_by on project_files(created_by);
-- The sweep reads unfinished uploads by expiry.
create index project_files_unfinished on project_files(expires_at) where not ready;
