-- lolly-work schema - the sharing ladder (lolly plan 299 M1, lolly-work plan 79).
--
-- Commenter joins the project roles, between viewer and editor: a commenter
-- reads and comments but never changes artwork. A membership may end on a
-- date (expires_at); a row past its date gives no access and is kept so the
-- people panel can offer "Extend".
--
-- projects.sharing holds what a manager sets in the share dialog: general
-- access (restricted, or everyone signed in to this instance at a capped
-- role), group grants with their own roles and end dates, and per-share
-- settings. Null means "as before": restricted, visibility groups as editors.
--
-- share_groups are groups that members make themselves ("Agency reviewers").
-- They are kept apart from IdP and local groups on purpose: users.groups feeds
-- RBAC grants, so a group anyone can create and join must never appear there,
-- or naming one after a privileged directory group would grant its actions.
-- Membership sits on the user row (users.share_groups, ids only), the same way
-- local groups do, so every user read carries it with no extra query. A group
-- is a shared record: removing its owner keeps the group and its managers.

alter table project_members drop constraint if exists project_members_role_check;
alter table project_members add constraint project_members_role_check
  check (role in ('viewer', 'commenter', 'editor', 'manager'));
alter table project_members add column expires_at timestamptz;

alter table access_requests drop constraint if exists access_requests_role_check;
alter table access_requests add constraint access_requests_role_check
  check (role in ('viewer', 'commenter', 'editor', 'manager'));
alter table access_requests drop constraint if exists access_requests_answer_role_check;
alter table access_requests add constraint access_requests_answer_role_check
  check (answer_role in ('viewer', 'commenter', 'editor', 'manager'));
alter table access_requests drop constraint if exists access_requests_current_access_check;
alter table access_requests add constraint access_requests_current_access_check
  check (current_access in ('none', 'viewer', 'commenter', 'editor', 'manager', 'owner'));

alter table projects add column sharing jsonb;

alter table users add column share_groups jsonb not null default '[]';
create index users_share_groups on users using gin (share_groups jsonb_path_ops);

create table share_groups (
  id          text primary key,
  name        text not null,
  description text,
  owner_id    text references users(id) on delete set null,
  managers    jsonb not null default '[]',
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
create index share_groups_owner on share_groups (owner_id);
