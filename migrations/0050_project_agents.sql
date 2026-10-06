create table project_agents (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  created_by text not null references users(id) on delete cascade,
  label text not null,
  role text not null check (role in ('viewer', 'editor')),
  token_hash text unique not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (user_id = created_by)
);
create index project_agents_project on project_agents(project_id);
create index project_agents_creator on project_agents(created_by);

create table agent_session_creations (
  agent_id text not null references project_agents(id) on delete cascade,
  request_id text not null,
  digest text not null,
  session_id text not null,
  primary key (agent_id, request_id)
);
