-- A service token may ask for approval (automation API, approvals.request), and
-- it resolves to a `svc_<id>` principal that has no users row
-- (server/src/iam/service-tokens.ts). 0002's key on approvals.created_by
-- refused every such request on Postgres, after the request's bytes and
-- records were already written. The memory store never checked the key, so
-- the tests passed there.
--
-- The key is not simply dropped, because account erasure depends on it: a
-- person who asked for approvals is refused erasure (store.eraseUserAccount
-- maps the key's violation to `referenced`), even when the request was made
-- while the erasure ran. So the key moves to a generated column that holds the
-- requester's id when it is a person and null when it is a token. A person's
-- id is still checked against users; a token's id is not checked, as
-- uploads.owner (0075) does not check a token either. A person's id is
-- random, and the rest of the server already reads a `svc_` prefix as a token,
-- so this column draws the line in the same place.
alter table approvals drop constraint if exists approvals_created_by_fkey;
alter table approvals add column created_by_user text
  generated always as (case when created_by like 'svc\_%' then null else created_by end) stored
  references users(id);
-- The key's own lookups (erasure deleting a users row) read this column.
create index approvals_created_by_user on approvals (created_by_user);
