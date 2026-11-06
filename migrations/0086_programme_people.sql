-- SPDX-License-Identifier: MPL-2.0
-- Partner companies and programme memberships (plans/82 M1 part 2). A company
-- is a partner organisation inside a programme; it wraps the reserved local
-- group company-<id>. A membership holds only what a group cannot: the end
-- date, the company and who added the person, keyed by address so it also
-- covers someone invited who has not signed in yet. Dropping these tables
-- removes end dates and company records and leaves every group and account.
create table partner_companies (
  id           text primary key,
  programme_id text not null,
  record       jsonb not null,
  updated_at   timestamptz not null default now()
);
create index partner_companies_programme on partner_companies (programme_id);
create table programme_memberships (
  programme_id text not null,
  email        text not null,
  record       jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (programme_id, email)
);
