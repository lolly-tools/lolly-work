-- lolly-work schema - project members and project invitations (plans/74,
-- "Invite from inside Lolly").
--
-- project_members names one person's role on one project: viewer (read only),
-- editor (create, save and delete their own sessions) or manager (also rename,
-- share, archive and manage the people on the project). The project's owner is
-- projects.owner_id and never has a row here. Group visibility keeps working
-- as before: a member of a project's visibility group acts as an editor.
--
-- added_by is the 'user:<id>' or principal that added the row and is kept as
-- plain text, like invitations.invited_by, so it never blocks erasure. A row
-- goes with its user (erasure) and with its project.
--
-- invitations.projects carries [{ "projectId": "...", "role": "...",
-- "invitedBy": "user:..." }] for an address that has no account yet. The
-- memberships are applied when the invitation is accepted at sign-in, each
-- only while the person who added it can still manage that project.
--
-- projects.updated_at / updated_by record the last rename, visibility or
-- archive change, so a project list can say who changed what and when.

create table project_members (
  project_id text not null references projects(id) on delete cascade,
  user_id    text not null references users(id) on delete cascade,
  role       text not null check (role in ('viewer', 'editor', 'manager')),
  added_by   text not null,
  added_at   timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_id on project_members (user_id);

alter table invitations add column projects jsonb not null default '[]';
-- Which route wrote the invitation. Only a project-made one is withdrawn when
-- a manager takes its last project off it; a console invitation, which may
-- be what admits the person at all, stays for an admin to revoke.
alter table invitations add column created_via text not null default 'console'
  check (created_via in ('console', 'project'));
-- Open invitations by project, for the people panel: jsonb containment on the
-- rows still waiting for their person, so the read never scans the history.
create index invitations_open_projects on invitations using gin (projects jsonb_path_ops)
  where revoked_at is null and accepted_at is null;

alter table projects add column updated_at timestamptz;
alter table projects add column updated_by text;
