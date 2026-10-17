-- SPDX-License-Identifier: MPL-2.0
-- Durable outbox for automation job callbacks. The statement that settles a job
-- with a callback URL also inserts its entry, so no committed result can lose
-- its callback. Dispatchers claim due entries with a lease token; an entry whose
-- lease expired is claimed again after a restart and sent with the same id.
-- The id is the idempotency key every attempt sends. Jobs settled before this
-- migration keep their stored callback_failed flag and are not sent again.
create table automation_callbacks (
  id               text primary key,
  job_id           text not null unique references automation_jobs(id) on delete cascade,
  principal        text not null,
  url              text not null,
  state            text not null check (state in ('pending','acknowledged','failed')),
  attempt          integer not null default 0 check (attempt >= 0),
  next_attempt_at  timestamptz not null,
  lease_owner      text,
  lease_until      timestamptz,
  lease_token      integer not null default 0,
  last_outcome     text check (last_outcome in ('acknowledged','refused','uncertain','not-sent')),
  last_status      integer,
  last_error       text,
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  settled_at       timestamptz
);
create index automation_callbacks_due on automation_callbacks (next_attempt_at) where state = 'pending';
