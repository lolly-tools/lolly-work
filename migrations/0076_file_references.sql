-- File references (docs/api.md "File references", server/src/uploads/files.ts):
-- a third scope on the uploads table. A finished upload in scope 'file' is an
-- account-scoped reference its owner reads back, names in the document verbs
-- and deletes. It keeps the owner, budgets, expiry, sweep and erasure rules of
-- every other scoped upload; only the owner ever reads it.
--
-- role says whether the bytes came from the client ('original') or from an
-- operation ('output'). derived_from is { id, checksum } of the owner's own
-- reference the bytes were made from. report is { by, report }: the
-- FileOperationReportV1 that made the bytes, and whether the owner supplied it
-- or this instance wrote it. All three are null on the other scopes.
--
-- metadata_bytes is the size of derived_from and report as JSON, worked out
-- when the row is written. The budgets charge it on top of size and the fixed
-- row overhead, so a report takes room like the bytes do. It is 0 on the other
-- scopes.
alter table uploads drop constraint if exists uploads_scope_check;
alter table uploads add constraint uploads_scope_check check (scope in ('catalog-submission', 'automation-input', 'file'));
alter table uploads add column role text check (role in ('original', 'output'));
alter table uploads add column derived_from jsonb;
alter table uploads add column report jsonb;
alter table uploads add column metadata_bytes integer not null default 0 check (metadata_bytes >= 0);
alter table uploads add constraint uploads_file_role check ((scope = 'file') = (role is not null));
alter table uploads add constraint uploads_file_only check (scope = 'file' or (derived_from is null and report is null and metadata_bytes = 0));
