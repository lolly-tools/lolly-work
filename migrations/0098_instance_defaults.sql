-- SPDX-License-Identifier: MPL-2.0
-- Defaults an instance decides once and keeps (plans/82 M4). The first is the
-- licence gate's mode for partner programmes when the configuration does not
-- set one: the server records 'gate' on its first start with no accounts in
-- the database (a fresh install) and 'report' when accounts are already there
-- (an upgrade), and never changes the row afterwards, so re-applying a
-- configuration template cannot change what partners receive. A value in the
-- configuration always wins over the row. Dropping this table makes the next
-- start decide again from the accounts it finds.
create table instance_defaults (
  key         text primary key,
  record      jsonb not null,
  decided_at  timestamptz not null default now()
);
