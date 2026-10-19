-- Resumable uploads (docs/resumable-uploads.md). Every upload into this
-- instance travels as declared, checksummed 1 MiB parts (server/src/uploads/
-- parts.ts), so no request body or stored blob grows with the file. The hard
-- ceiling on one transfer moves from 0041's 256 MiB to 4 GiB; the configured
-- caps (policy.projectFiles.maxFileBytes, policy.uploads.maxFileBytes) can only
-- be lower, and still default to 25 MiB and 64 MiB.
alter table project_files drop constraint if exists project_files_size_check;
alter table project_files add constraint project_files_size_check check (size > 0 and size <= 4294967296);

-- Scoped uploads (server/src/uploads/scoped.ts): private bytes a person or a
-- service token uploads once and names by reference, as a catalog submission
-- original or an automation input. owner is the automation principal form
-- (user:<id> or service:svc_<id>), not a foreign key, because a service token
-- has no users row: account erasure removes a person's uploads itself. Parts
-- live in the BlobStore as upload/<id>/<n>. Every row expires: an unfinished
-- upload after it goes idle or reaches policy.uploads.uploadTtlHours, a
-- finished one policy.uploads.readyTtlHours after it finished. An expired row
-- counts toward no budget and is swept, parts first.
create table uploads (
  id text primary key,
  scope text not null check (scope in ('catalog-submission', 'automation-input')),
  owner text not null check (owner like 'user:%' or owner like 'service:%'),
  name text not null,
  size bigint not null check (size > 0 and size <= 4294967296),
  checksum text not null,
  content_type text not null,
  parts jsonb not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  ready boolean not null default false
);
-- An owner's list and budget, and erasure, read by owner.
create index uploads_owner on uploads(owner, created_at);
-- The budgets and the sweep read by expiry.
create index uploads_expiry on uploads(expires_at);
