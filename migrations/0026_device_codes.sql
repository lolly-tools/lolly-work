-- lolly-work schema - device sign-in codes (plans/35 wave 5).
--
-- The device-code flow shipped (plans/34 wave 4) on an in-memory registry,
-- the nearby precedent - which meant single-replica only, and 501 on
-- serverless. This table replaces that: codes are rows, so ANY replica can
-- answer the poll, HA needs no sticky sessions, and serverless deploys gain
-- the flow outright. The single-read claim - an approved code hands out its
-- session exactly once - becomes an atomic DELETE ... RETURNING instead of a
-- map delete; a replayed deviceCode then reads as expired, same contract as
-- before. `user_payload` is the approving person's session shape, written at
-- approve and consumed at claim; rows die at expiry either way.

create table device_codes (
  device_code  text primary key,
  user_code    text not null unique,
  client_tag   text,
  status       text not null default 'pending',
  user_payload jsonb,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
