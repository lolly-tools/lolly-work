-- SPDX-License-Identifier: MPL-2.0
alter table users add column scim_idp text;
alter table local_groups add column scim_idp text;
alter table scim_tokens add column expires_at timestamptz;
create index users_scim_idp on users (scim_idp);
create index local_groups_scim_idp on local_groups (scim_idp);
