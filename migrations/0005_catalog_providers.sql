-- lolly-work schema — catalog providers (plans/17). One row per federated
-- third-party source (Brandfolder, S3, git, …). Config columns are written by
-- the control plane; credential_* only via the write-only credential endpoint
-- (AES-256-GCM ciphertext, never returned by any API); the last_* / asset_count
-- / index_json state columns only by sync. The memory store mirrors this shape.
-- Lifecycle overlays for federated assets reuse catalog_lifecycle, keyed on the
-- namespaced id ('ext/<provider>/<remoteId>') — no FK, same as pack assets.

create table catalog_providers (
  id                     text primary key,
  kind                   text not null,
  label                  text not null,
  managed_by             text not null default 'db' check (managed_by in ('db', 'config')),
  enabled                boolean not null default false,
  options                jsonb not null default '{}',
  mapping                jsonb not null default '{}',
  exposure               jsonb not null default '{}',
  sync                   jsonb not null default '{}',
  credential_ciphertext  bytea,
  credential_fingerprint text,
  credential_updated_at  timestamptz,
  created_by             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  last_sync_at           timestamptz,
  last_error             text,
  asset_count            integer not null default 0,
  index_json             jsonb
);
