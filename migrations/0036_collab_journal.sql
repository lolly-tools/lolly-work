-- The head is separate from the checkpoint so recovery can detect missing tails.
alter table collab_checkpoints add column head_revision bigint;
update collab_checkpoints set head_revision = revision;
alter table collab_checkpoints alter column head_revision set not null;
alter table collab_checkpoints add constraint collab_checkpoint_head_order check (head_revision >= revision);

create table collab_journal (
  session_id text not null references sessions(id) on delete cascade,
  revision bigint not null,
  ops jsonb not null,
  primary key (session_id, revision)
);
