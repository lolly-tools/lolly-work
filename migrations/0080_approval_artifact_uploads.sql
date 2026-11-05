-- SPDX-License-Identifier: MPL-2.0
-- A fourth scope on the uploads table: the exported file a person sends with an
-- approval request (server/src/approvals/export-review.ts). The bytes travel by
-- the parts protocol, then move to approval-artifact/<id>/<n> in the BlobStore
-- when the request is created, and the upload row goes. The approval's own
-- jsonb doc holds the frozen subject, so approvals needs no new column.
alter table uploads drop constraint if exists uploads_scope_check;
alter table uploads add constraint uploads_scope_check check (scope in ('catalog-submission', 'automation-input', 'file', 'approval-artifact'));
