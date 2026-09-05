-- Durable automation/render resources (plans/39, 40).
create table automation_jobs (
  id                 text primary key,
  principal          text not null,
  verb               text not null,
  request            jsonb not null,
  state              text not null check (state in ('queued','running','done','failed','cancelled')),
  created_at         timestamptz not null,
  updated_at         timestamptz not null,
  finished_at        timestamptz,
  result_ref         text,
  result_mime        text,
  error              text,
  callback_url       text,
  callback_failed    boolean not null default false,
  progress           jsonb,
  idempotency_key    text,
  priority           integer not null default 0 check (priority between 0 and 9),
  attempt            integer not null default 0,
  unique (principal, idempotency_key)
);
create index automation_jobs_principal_created on automation_jobs(principal, created_at desc);
create index automation_jobs_state_created on automation_jobs(state, created_at);
