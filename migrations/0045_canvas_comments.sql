-- Review is durable independently of live-room attendance and document revisions.
create table canvas_comment_threads (
  id text primary key,
  session_id text not null references sessions(id) on delete cascade,
  revision integer not null check (revision > 0),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null
);
create index canvas_comment_threads_session on canvas_comment_threads(session_id, updated_at, id);
