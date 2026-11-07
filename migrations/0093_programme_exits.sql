-- SPDX-License-Identifier: MPL-2.0
-- Partnership exit receipts (plans/82 M5). One jsonb record per exit of a
-- programme, a company, a domain or a list: the selection, the choices, who
-- asked and when, and what was done per account, token, template, folder rule,
-- domain rule and share-anyway choice. The ended page and Reopen read it, and
-- a scheduled end waits here in state 'scheduled' until its date. The ended
-- state itself lives on the programme and company records. Dropping this table
-- removes the receipts and scheduled ends and leaves every account, group and
-- programme as the exits left them.
create table programme_exits (
  id           text primary key,
  programme_id text not null default '',
  company_id   text not null default '',
  state        text not null,
  record       jsonb not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index programme_exits_programme on programme_exits (programme_id);
create index programme_exits_company on programme_exits (company_id);
create index programme_exits_state on programme_exits (state);
