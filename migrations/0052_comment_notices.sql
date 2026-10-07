-- One inbox notice per person per thread, updated as replies arrive (plan 76 M4).
-- Holds no comment text and no names: the inbox builds both when it is read, so an
-- edited or deleted message and an erased person's name never linger here.
create table comment_notices (
  id text primary key,                 -- cn_ + first 24 hex of sha256(user_id || ' ' || thread_id)
  user_id text not null references users(id) on delete cascade,
  thread_id text not null references canvas_comment_threads(id) on delete cascade,
  session_id text not null references sessions(id) on delete cascade,
  project_id text not null references projects(id) on delete cascade,
  kind text not null check (kind in ('mention', 'reply')),
  actor_id text not null,              -- free text; erasure deletes the actor's rows explicitly
  message_id text not null,
  count integer not null default 1 check (count between 1 and 1000),
  created_at timestamptz not null,
  unique (user_id, thread_id)
);
create index comment_notices_user on comment_notices(user_id, created_at desc);
create index comment_notices_actor on comment_notices(actor_id, created_at desc);
-- Who has ever been notified of a mention in a message, so edits never notify twice.
-- Message ids are unique only within their thread, so the thread is part of the key.
create table comment_mention_sends (
  thread_id text not null references canvas_comment_threads(id) on delete cascade,
  message_id text not null,
  user_id text not null references users(id) on delete cascade,
  at timestamptz not null,
  primary key (thread_id, message_id, user_id)
);
create index comment_mention_sends_user on comment_mention_sends(user_id);
