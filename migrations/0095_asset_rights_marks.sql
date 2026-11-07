-- SPDX-License-Identifier: MPL-2.0
-- Owner-published marks and licence records (plans/82 M4). A mark is a brand
-- team's statement that the files in one scope (one asset, a provider folder,
-- a whole provider or a pack id prefix) are its own, on its own terms. A
-- licence record is an admin's own record of one file's licence. Both reach
-- only a file whose own record declares nothing, and neither is written back
-- to a provider. Dropping these tables returns every file to what its own
-- record says, which for an unrecorded file means held back from partners
-- once the licence gate is on.
create table asset_rights_marks (
  scope       text primary key,
  record      jsonb not null,
  updated_at  timestamptz not null default now()
);
create table asset_licence_records (
  asset_id    text primary key,
  record      jsonb not null,
  updated_at  timestamptz not null default now()
);
