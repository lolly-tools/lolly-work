-- Meaningful document versions, kept apart from the 20-row revision window (plan 76 M4).
-- Content is stored once per session and digest, so repeated states cost no extra bytes.
-- Versions are shared records of a document: they go with the session, never with a
-- person, so no column here references users.
create table session_version_contents (
  session_id text not null references sessions(id) on delete cascade,
  digest text not null,                -- sha256 of canonical inputs JSON
  inputs jsonb not null check (jsonb_typeof(inputs) = 'object'),
  bytes integer not null check (bytes >= 0),
  primary key (session_id, digest)
);
create table session_versions (
  id text primary key,                 -- ver_ + 16 base32 characters
  session_id text not null references sessions(id) on delete cascade,
  rev integer not null check (rev >= 0),
  kind text not null check (kind in ('auto', 'close', 'save', 'named', 'restore', 'before')),
  label text check (label is null or length(label) between 1 and 120),
  digest text not null,
  meta jsonb not null check (jsonb_typeof(meta) = 'object'),
  contributors jsonb not null default '[]'::jsonb check (jsonb_typeof(contributors) = 'array'),
  created_by text,                     -- user id for named/restore/before/save; null for auto/close
  restored_from text references session_versions(id) on delete set null,
  before_id text references session_versions(id) on delete set null, -- restore row -> its 'before' row
  request_id text,
  at timestamptz not null,
  foreign key (session_id, digest) references session_version_contents(session_id, digest)
);
create index session_versions_session on session_versions(session_id, at desc, id);
create unique index session_versions_request on session_versions(session_id, created_by, kind, request_id)
  where request_id is not null;
-- Only restore rows carry these two references. Without an index, every deleted
-- version would scan the whole table to clear them.
create index session_versions_restored_from on session_versions(restored_from) where restored_from is not null;
create index session_versions_before on session_versions(before_id) where before_id is not null;
