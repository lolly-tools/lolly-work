-- SPDX-License-Identifier: MPL-2.0
update fleet_installs set user_id_last_seen = null
where user_id_last_seen is not null
  and not exists (select 1 from users where users.id = fleet_installs.user_id_last_seen);
