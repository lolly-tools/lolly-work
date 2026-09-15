-- Durable collaboration, fenced by an expiring per-session owner.
alter table sessions add column collab_owner text;
alter table sessions add column collab_lease_until timestamptz;
create table collab_checkpoints (
  session_id text primary key references sessions(id) on delete cascade,
  revision bigint not null,
  checkpoint jsonb not null
);
create table collab_receipts (
  session_id text not null references sessions(id) on delete cascade,
  principal text not null,
  id text not null,
  digest text not null,
  accepted boolean not null,
  revision bigint not null,
  primary key (session_id, principal, id)
);
