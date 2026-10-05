create table document_agents (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  user_id text unique not null references users(id) on delete cascade,
  created_by text not null references users(id) on delete cascade,
  label text not null,
  role text not null check (role in ('viewer', 'editor')),
  token_hash text unique not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index document_agents_session on document_agents(session_id);
create index document_agents_creator on document_agents(created_by);
