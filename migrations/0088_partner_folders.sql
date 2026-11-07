-- SPDX-License-Identifier: MPL-2.0
-- Provider folders per programme or company (plans/82 M1 part 2c). One row
-- per rule: a connected provider's folder (and everything below it) given to a
-- programme, or to one company in it, until an optional end date. Kept apart
-- from the provider row so editing a provider's settings never drops a rule.
-- Dropping this table takes the folders away from the partners they were
-- given to and leaves every provider and asset as it is.
create table partner_folders (
  provider     text not null,
  path         text not null,
  programme_id text not null,
  company_id   text not null default '',
  record       jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (provider, path, programme_id, company_id)
);
create index partner_folders_programme on partner_folders (programme_id);
