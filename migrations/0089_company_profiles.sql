-- SPDX-License-Identifier: MPL-2.0
-- Partner company profiles (plans/82 M3). One row per company: its current
-- profile (logos as instance asset ids, website, contact, address, currency
-- and tax note), the revision exported files cite, and the settings for who
-- else may edit it. The history keeps every revision, so a revision a file
-- cites can be read back. Deleting a company deletes both. Dropping these
-- tables loses the profiles and their history and leaves every company, group
-- and logo asset as it is.
create table partner_company_profiles (
  company_id text primary key,
  revision   integer not null,
  profile    jsonb not null,
  settings   jsonb not null default '{}'::jsonb,
  updated_by text not null,
  updated_at timestamptz not null default now()
);
create table partner_company_profile_history (
  company_id text not null,
  revision   integer not null,
  profile    jsonb not null,
  updated_by text not null,
  updated_at timestamptz not null,
  primary key (company_id, revision)
);
