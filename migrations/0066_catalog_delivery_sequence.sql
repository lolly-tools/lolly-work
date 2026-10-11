-- One durable catalog observation sequence, shared by filtered visibility scopes
-- and all serving replicas. A state returning to older bytes still advances.
create table catalog_delivery_sequence (
  singleton boolean primary key default true check (singleton),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  seq bigint not null check (seq > 0 and seq <= 9007199254740991),
  publication_generation bigint not null check (publication_generation >= 0 and publication_generation <= 9007199254740991),
  publication_digest text not null check (publication_digest ~ '^[0-9a-f]{64}$')
);

-- Private filtered snapshots survive restarts and are shared by serving replicas.
-- Reads still recompose current rights and licensing; these rows are not grants.
create table catalog_delivery_snapshots (
  scope text not null check (scope ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('tools', 'assets', 'slim')),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  bytes bytea not null,
  until_ms bigint not null check (until_ms > 0),
  tool_ids jsonb not null check (jsonb_typeof(tool_ids) = 'array'),
  asset_ids jsonb not null check (jsonb_typeof(asset_ids) = 'array'),
  primary key (scope, kind, hash)
);
create index catalog_delivery_snapshots_lookup on catalog_delivery_snapshots(scope, kind, left(hash, 16));
create index catalog_delivery_snapshots_expiry on catalog_delivery_snapshots(until_ms);
