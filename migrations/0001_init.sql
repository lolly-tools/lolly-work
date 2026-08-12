-- lolly-work schema v0 (plans/01 §5). The memory store mirrors this shape;
-- the Postgres driver binds to it. One instance = one org — no org_id.

create table users (
  id            text primary key,
  sub           text unique not null,
  email         text not null,
  firstname     text,
  lastname      text,
  title         text,
  groups        jsonb not null default '[]',
  role          text not null default 'member',
  telemetry_consent boolean,
  disabled_at   timestamptz,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table groups (
  id     text primary key,
  name   text unique not null,
  source text not null check (source in ('idp', 'local'))
);

create table grants (
  id        bigserial primary key,
  principal text not null,           -- 'group:<name>' | 'user:<id>' | '*'
  action    text not null,
  resource  text not null,           -- selector: 'tool:<id>' | 'tool:tag/<t>' | '*'
  effect    text not null check (effect in ('allow', 'deny'))
);

create table tools_policy (
  tool_id  text primary key,
  overlay  jsonb not null,
  version  integer not null default 1,
  state    text not null default 'published' check (state in ('draft', 'review', 'published'))
);

create table links (
  id         text primary key,
  kind       text not null check (kind in ('share', 'embed', 'download', 'guest-edit')),
  target     jsonb not null,
  exp        bigint not null,        -- unix seconds; signature-enforced too
  pw_hash    text,
  project_id text,
  created_by text not null references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index links_created_by on links (created_by);

create table audit_log (
  seq       bigint primary key,
  at        timestamptz not null,
  actor     text not null,
  action    text not null,
  subject   text not null,
  payload   jsonb,
  prev_hash text not null,
  hash      text not null
);

create table telemetry_events (
  id      bigserial primary key,
  at      timestamptz not null,
  user_id text,                      -- null = aggregate (stripped at ingest)
  event   text not null,
  attrs   jsonb not null default '{}'
);
create index telemetry_events_at on telemetry_events (at);

create table telemetry_rollups (
  period    text not null,           -- 'YYYY-MM-DD'
  dimension text not null,
  key       text not null,
  count     bigint not null default 0,
  primary key (period, dimension, key)
);

create table messages (
  id        text primary key,
  kind      text not null,
  severity  text not null,
  audience  jsonb not null,
  title     text not null,
  body      text,
  cta       jsonb,
  starts_at timestamptz,
  ends_at   timestamptz,
  dismissible boolean not null default true,
  created_by text
);

create table message_acks (
  message_id text not null references messages(id),
  user_id    text not null references users(id),
  at         timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table fleet_clients (
  bucket       text primary key,     -- shell|shellVersion|engine|platform
  info         jsonb not null,
  count        bigint not null default 0,
  last_seen_at timestamptz not null default now()
);
