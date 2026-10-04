alter table links drop constraint links_kind_check;
alter table links add constraint links_kind_check
  check (kind in ('share', 'embed', 'download', 'guest-edit', 'project-invite'));
