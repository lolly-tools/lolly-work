-- lolly-work schema — instance assets + catalog aliases (plans/26 §4,
-- plans/27 §5). An instance asset is a catalog asset the instance OWNS the bytes
-- of (in instance_blobs / the S3 BlobStore), as opposed to a pack file or a
-- federated ext/* reference. The whole record — served entry, format→blobId map,
-- exposure groups, and materialization origin — rides as jsonb; the id is the
-- 'inst/<opaque>' catalog id.
--
-- catalog_aliases keeps an old id resolving to a new one after the exit's
-- cutover moves an asset's identity from ext/<p>/<r> to inst/<id>: already-
-- rendered SVGs and live sessions reference the old /catalog/ext/... path and
-- must not break.

create table instance_assets (
  id         text primary key,
  record     jsonb not null,
  created_at timestamptz not null default now()
);

create table catalog_aliases (
  from_id    text primary key,
  to_id      text not null,
  created_at timestamptz not null default now()
);
