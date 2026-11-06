-- SPDX-License-Identifier: MPL-2.0
-- Partner programmes (plans/82 M1). One jsonb record per programme: its name,
-- the local group it wraps, and the tools and collections its people may use.
-- Membership is that local group, so nothing here names a person. Dropping
-- this table removes the programme scopes and leaves every group and account.
create table partner_programmes (
  id         text primary key,
  record     jsonb not null,
  updated_at timestamptz not null default now()
);
