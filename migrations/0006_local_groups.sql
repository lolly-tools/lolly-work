-- Local groups + the IdP/local split on users (plans/02 §4).
--
-- IdP groups mirror the identity provider and are re-synced (clobbered) each
-- login; local groups are console-editable and login-durable. The effective
-- membership stored in users.groups stays the union of the two, so every
-- downstream reader keeps consuming users.groups unchanged.

alter table users add column idp_groups   jsonb not null default '[]';
alter table users add column local_groups jsonb not null default '[]';

-- Backfill: everything a pre-split user had was IdP-sourced.
update users set idp_groups = groups;

-- The registry of console-defined local groups. IdP groups are NOT registered
-- here — they're discovered from users' idp_groups.
create table local_groups (
  name        text primary key,
  description text,
  created_at  timestamptz not null default now()
);
