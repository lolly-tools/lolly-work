-- SPDX-License-Identifier: MPL-2.0
-- The migration API for people moving off a hosted render API. One row is one
-- vendor request, which may own one durable render per output format. The renders
-- stay in the render store; deleting a row stops its result URLs working and leaves
-- their history in place. `seq` is the numeric id Placid's docs show for an image.
create table render_api_records (
  id              text primary key,
  seq             bigserial unique,
  source          text not null check (source in ('bannerbear-v5', 'bannerbear-v2', 'placid')),
  template        text not null,
  principal       text not null,
  formats         jsonb not null,
  renders         jsonb not null default '{}'::jsonb,
  metadata        jsonb,
  echo            jsonb not null default '{}'::jsonb,
  webhook_url     text,
  filename        text,
  idempotency_key text,
  created_at      timestamptz not null,
  unique (principal, idempotency_key)
);
create index render_api_records_owner on render_api_records (principal, source, seq desc);
