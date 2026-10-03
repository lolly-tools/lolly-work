-- lolly-work schema - access requests (plans/75 G13, J4 step 6, J5 step 7, J7 step 5).
--
-- One table for every "ask": a member asking for a project (kind 'project', which is also
-- "ask to edit" when they already view it), a signed-in but not admitted person asking to
-- join (kind 'join'), and a person holding an invite link who signed in with another
-- account (kind 'switch'). Kind 'invite' (a manager asking an admin to invite an address)
-- is reserved for SHOULD item S2.
--
-- email is always a verified address from a sign-in this server just finished, never one
-- typed into a form (except kind 'invite', which records the member who typed the address
-- in requested_by). One open request per (kind, email, project, invitation): the partial
-- unique index. An open row whose expires_at has passed reads as expired, and the store
-- marks it 'expired' before writing a new one for the same key.
--
-- current_access is the requester's project access when they asked (none, viewer, editor,
-- manager or owner). It is not called current_role because CURRENT_ROLE is reserved in SQL.
create table access_requests (
  id                   text primary key,
  kind                 text not null check (kind in ('project', 'join', 'switch', 'invite')),
  status               text not null default 'open'
                         check (status in ('open', 'approved', 'declined', 'withdrawn', 'superseded', 'expired')),
  email                text not null check (email = lower(email)),
  user_id              text references users(id) on delete cascade,
  identity_sub         text,
  idp                  text,
  name                 text check (char_length(name) <= 120),
  project_id           text references projects(id) on delete cascade,
  via_session_id       text,
  invitation_id        text references invitations(id) on delete cascade,
  role                 text check (role in ('viewer', 'editor', 'manager')),
  current_access       text check (current_access in ('none', 'viewer', 'editor', 'manager', 'owner')),
  note                 text check (char_length(note) <= 280),
  requested_by         text,
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null,
  answered_at          timestamptz,
  answered_by          text,
  answer_role          text check (answer_role in ('viewer', 'editor', 'manager')),
  result_invitation_id text
);
create unique index access_requests_one_open on access_requests
  (kind, email, coalesce(project_id, ''), coalesce(invitation_id, '')) where status = 'open';
create index access_requests_open_created on access_requests (created_at) where status = 'open';
create index access_requests_open_project on access_requests (project_id) where status = 'open';
create index access_requests_user on access_requests (user_id);
create index access_requests_email on access_requests (email);
