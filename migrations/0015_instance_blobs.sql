-- lolly-work schema — BlobStore, PG driver (plans/26 §2, plans/27 §5). Opaque
-- byte content addressed by a caller-chosen blob_id: instance-owned catalog
-- assets materialized out of a DAM (the exit), and later plans/26's collab
-- staging. Content is a single bytea per blob (a blob is buffered whole on
-- write); size + sha256 checksum ride alongside so a read can report integrity
-- without re-hashing. The memory + S3 drivers mirror these semantics.

create table instance_blobs (
  blob_id      text primary key,
  content      bytea not null,
  size         bigint not null,
  checksum     text not null,
  content_type text not null,
  created_at   timestamptz not null default now()
);
