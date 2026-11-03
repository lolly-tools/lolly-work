-- SPDX-License-Identifier: MPL-2.0
-- Edge (CDN) purge outbox. A change to public bytes writes one row per
-- configured provider; a worker claims due rows with a lease, sends them within
-- the provider's purge budget, and records the provider's receipt. A purge never
-- blocks or reverses the change that asked for it.
create table edge_purge_outbox (
  id               text primary key,
  provider_id      text not null,
  kind             text not null check (kind in ('tags','urls')),
  items            text[] not null,
  reason           text not null,
  state            text not null check (state in ('pending','done','failed')),
  attempt          integer not null default 0 check (attempt >= 0),
  next_attempt_at  timestamptz not null,
  lease_owner      text,
  lease_until      timestamptz,
  lease_token      integer not null default 0,
  last_error       text,
  receipt          jsonb,
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  settled_at       timestamptz
);
create index edge_purge_outbox_due on edge_purge_outbox (provider_id, kind, next_attempt_at) where state = 'pending';

-- An edge provider API credential stored from the console or CLI, sealed with
-- the instance credential key (AES-256-GCM, context edge-provider:<id>:api).
-- Only the fingerprint is ever shown. A credentialRef in instance.json wins.
create table edge_provider_credentials (
  provider_id  text primary key,
  ciphertext   bytea not null,
  fingerprint  text not null,
  updated_at   timestamptz not null
);
