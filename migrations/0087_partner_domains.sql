-- SPDX-License-Identifier: MPL-2.0
-- Partner domains (plans/82 M1 part 2b). One row per domain: how it was proved
-- (a DNS TXT record or an admin's say-so, with who and when), the last lookup,
-- and the programmes it feeds. Dropping this table stops new people joining
-- through a domain and leaves every account, group and membership as it is.
create table partner_domains (
  domain     text primary key,
  record     jsonb not null,
  updated_at timestamptz not null default now()
);
