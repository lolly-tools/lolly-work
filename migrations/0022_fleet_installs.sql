-- lolly-work schema - the fleet install registry (plans/34 wave 3).
--
-- From histogram to registry: fleet_clients (0001) buckets anonymous version
-- tags and stays exactly as it is; THIS table records installs - devices that
-- sent an `install/<id>` token on an AUTHENTICATED request. The distinction is
-- the enrollment covenant made schema: an anonymous or guest request can never
-- mint a row here, an install only ever speaks when its person already talks
-- to the instance (no heartbeat, no phone-home), and forgetting an install is
-- a DELETE on this table and nothing else - there is no remote action, no
-- seat, no license anywhere in this schema.
--
-- `info` is the parsed X-Lolly-Client tag (shell, versions, platform) as
-- jsonb, the same shape fleet_clients carries, so the two surfaces read the
-- same vocabulary. `name` is operator bookkeeping set in the console and
-- deliberately survives the device's own refreshes. `user_id_last_seen` is a
-- pointer for the fleet table ("whose laptop is that"), never a login binding
-- and never authorization - which is why it is a plain text column with no
-- foreign key: a forgotten or departed user must not cascade a device row
-- away, and a device row must never hold a user row hostage.

create table fleet_installs (
  install_id        text primary key,
  info              jsonb not null,
  name              text,
  user_id_last_seen text,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);
