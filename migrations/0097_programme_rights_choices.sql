-- SPDX-License-Identifier: MPL-2.0
-- Share anyway choices (plans/82 M4). One row per asset per audience group
-- (programme-<id> or company-<id>): an admin chose to send that one file,
-- which the licence gate holds back, to that one audience. Each record holds
-- the fingerprint of the facts it was made about, so a new version of the
-- file, a changed licence record or a new rules version retires it. Dropping
-- this table withdraws every choice; the files stay held until chosen again.
create table programme_rights_choices (
  asset_id        text not null,
  audience_group  text not null,
  programme_id    text not null,
  record          jsonb not null,
  updated_at      timestamptz not null default now(),
  primary key (asset_id, audience_group)
);
create index programme_rights_choices_programme on programme_rights_choices (programme_id);
