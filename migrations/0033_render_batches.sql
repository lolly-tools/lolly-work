-- Immutable batch membership over independently leased renders.
create table render_batches (
  id text primary key,
  principal text not null,
  request jsonb not null,
  request_hash text not null,
  idempotency_key text,
  retry_of text,
  created_at timestamptz not null default clock_timestamp(),
  unique (principal, idempotency_key),
  unique (id, principal),
  foreign key (retry_of, principal) references render_batches(id, principal)
);
create table render_batch_rows (
  batch_id text not null,
  principal text not null,
  row_key text not null,
  position integer not null check (position between 0 and 199),
  render_id text not null,
  primary key (batch_id, row_key),
  unique (batch_id, position),
  unique (batch_id, render_id),
  foreign key (batch_id, principal) references render_batches(id, principal),
  foreign key (render_id, principal) references renders(id, principal)
);
create index render_batches_principal_created on render_batches(principal, created_at desc, id desc);
create index render_batch_rows_render on render_batch_rows(render_id);
