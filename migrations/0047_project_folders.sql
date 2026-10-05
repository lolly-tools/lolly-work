create table project_folders (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  parent_id text,
  name text not null,
  created_at timestamptz not null,
  created_by text not null,
  unique (id, project_id),
  foreign key (parent_id, project_id) references project_folders(id, project_id)
);
create index project_folders_project on project_folders(project_id);
create table project_folder_items (
  project_id text not null references projects(id) on delete cascade,
  folder_id text not null,
  kind text not null check (kind in ('session', 'file')),
  ref text not null,
  primary key (project_id, kind, ref),
  foreign key (folder_id, project_id) references project_folders(id, project_id) on delete cascade
);
