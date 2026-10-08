-- lolly-work schema - each person's own view of shared projects (lolly plan 299).
--
-- A project shared with everyone on the instance is open to every member, but it
-- belongs in a person's Projects list only when it is theirs (owner, member, a
-- group they are in) or when they chose it: they opened it recently or pinned it.
-- `listed` records that choice: 'pinned' keeps it in their list, 'hidden' keeps it
-- out even after they open it again, and null follows the default rule.
--
-- Private per-person state, so the row goes with the person and with the project.
-- Nothing here is shown to anyone else, and it is never used to work out who
-- viewed what.

create table project_user_state (
  user_id        text not null references users(id) on delete cascade,
  project_id     text not null references projects(id) on delete cascade,
  listed         text check (listed in ('pinned', 'hidden')),
  last_opened_at timestamptz,
  primary key (user_id, project_id)
);
