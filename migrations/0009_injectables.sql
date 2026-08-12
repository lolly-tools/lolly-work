-- Injectables registry (plans/19) — the governed rail through which the control
-- plane injects capability into the OSS deploy it governs: tools, feature flags,
-- typed catalog resources, and declarative UI chrome. Everything it carries is
-- DATA the shell renders, never code it runs.
--
-- One row per injectable, keyed by its permanent slug id. The kind-specific
-- descriptor is stored as jsonb so a new kind (or a richer payload) needs no
-- migration; groups is a jsonb string array (['*'] = every caller). A revoke stamps
-- state='revoked' + revoked_at rather than deleting, so the audit trail and the
-- console listing keep the history. version bumps on each replace.

create table injectables (
  id         text primary key,
  kind       text not null,
  title      text not null,
  payload    jsonb not null,
  groups     jsonb not null,
  state      text not null default 'live',
  version    integer not null default 1,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index injectables_kind_idx on injectables (kind);
