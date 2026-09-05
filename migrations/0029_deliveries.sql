-- Organization-owned outbound delivery (plan 48). The export facts and target
-- version are immutable; upserts update lifecycle/receipt columns only.
create table deliveries (
  id                   text primary key,
  principal            text not null,
  destination_id       text not null,
  destination_version  text not null,
  name                 text not null,
  format               text not null,
  content_type         text not null,
  size                 bigint not null check (size > 0),
  sha256               text not null,
  request_hash         text not null,
  source_ref           text not null,
  source_job_id        text references automation_jobs(id) on delete restrict,
  state                text not null check (state in ('awaiting-approval','queued','delivering','delivered','failed','rejected','cancelled')),
  attempt              integer not null default 0 check (attempt >= 0),
  approval_id          text,
  idempotency_key      text,
  remote_id            text,
  url                  text,
  delivered_sha256     text,
  transformation       text check (transformation in ('none','provider-managed','unknown')),
  error                text,
  created_at           timestamptz not null,
  updated_at           timestamptz not null,
  delivered_at         timestamptz,
  unique (principal, idempotency_key)
);

create index deliveries_principal_created on deliveries(principal, created_at desc);
create index deliveries_state_updated on deliveries(state, updated_at);
create index deliveries_source_job on deliveries(source_job_id) where source_job_id is not null;
