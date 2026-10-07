-- Per-person read state for review threads (plan 76 milestone 4). Private to each
-- person: removed with the account and never shown to anyone else.
create table canvas_comment_reads (
  user_id text not null references users(id) on delete cascade,
  thread_id text not null references canvas_comment_threads(id) on delete cascade,
  session_id text not null references sessions(id) on delete cascade,
  read_at timestamptz not null,
  primary key (user_id, thread_id)
);
create index canvas_comment_reads_session on canvas_comment_reads(user_id, session_id);
-- The first time a person lists a document's comments; older messages count as read.
create table canvas_comment_read_floors (
  user_id text not null references users(id) on delete cascade,
  session_id text not null references sessions(id) on delete cascade,
  floor_at timestamptz not null,
  primary key (user_id, session_id)
);
