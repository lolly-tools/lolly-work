-- Plan 40: requests and leased attempts survive the HTTP/worker process.
create table renders (
  id text primary key,
  principal text not null,
  request jsonb not null,
  request_hash text not null,
  idempotency_key text,
  retry_of text,
  state text not null check (state in ('queued','running','succeeded','failed','cancelled')),
  priority integer not null check (priority between 0 and 9),
  max_attempts integer not null check (max_attempts between 1 and 5),
  attempt integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  lease_token text,
  lease_until timestamptz,
  output jsonb,
  error jsonb,
  unique (principal, idempotency_key),
  unique (id, principal),
  foreign key (retry_of, principal) references renders(id, principal),
  check ((state = 'running') = (lease_token is not null and lease_until is not null)),
  check ((state = 'succeeded') = (output is not null))
);
create index renders_claim on renders(priority desc, created_at, id) where state in ('queued','running');
create index renders_principal_created on renders(principal, created_at desc, id desc);
