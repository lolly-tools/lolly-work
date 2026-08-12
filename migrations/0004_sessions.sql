-- lolly-work schema — shared workspaces: projects, sessions, revisions
-- (plans/08 §6b). A project is a folder over sessions; visibility rides as
-- jsonb (the string "private" or a { groups: [...] } object). A session is the
-- client's {toolId, toolVersion, inputs, meta} record plus server bookkeeping
-- (rev for optimistic CAS, updated_by, deleted_at tombstone). session_revisions
-- is a bounded, restorable edit history. The memory store mirrors this shape.

create table projects (
  id          text primary key,
  name        text not null,
  visibility  jsonb not null,                 -- "private" | { "groups": [...] }
  owner_id    text not null references users(id),
  created_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index projects_owner_id on projects (owner_id);

create table sessions (
  id           text primary key,
  project_id   text not null references projects(id),
  tool_id      text not null,
  tool_version text not null default '',
  inputs       jsonb not null default '{}',
  meta         jsonb not null default '{}',
  created_by   text not null references users(id),
  updated_by   text not null references users(id),
  rev          integer not null default 1,    -- optimistic concurrency token
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz                    -- tombstone; never hard-deleted
);
create index sessions_project_id on sessions (project_id);
create index sessions_tool_id on sessions (tool_id);

create table session_revisions (
  session_id text not null references sessions(id),
  rev        integer not null,
  inputs     jsonb not null,
  meta       jsonb not null,
  actor      text not null,
  at         timestamptz not null default now(),
  primary key (session_id, rev)                -- idempotent replay of the same op
);
create index session_revisions_session on session_revisions (session_id);
