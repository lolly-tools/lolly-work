-- lolly-work schema - personal invitation links and one-link password setup
-- (plans/74, plans/75 J4).
--
-- link_version is signed into every invitation link (server/src/access/invite-token.ts).
-- "New link" bumps it, so every link copied earlier answers "This link no longer works".
-- opened_at is set the first time someone starts a sign-in from the invite page (a POST),
-- never by the GET a chat preview or mail scanner makes. password_setup lets the invite
-- page set a password for the invited address, once, while the address has none; whoever
-- holds the link can then sign in as the address, so only an admin or owner sets it.
-- created_via gains 'request': an invitation an approved join or switch request wrote.
alter table invitations add column link_version integer not null default 1 check (link_version >= 1);
alter table invitations add column opened_at timestamptz;
alter table invitations add column password_setup boolean not null default false;
alter table invitations drop constraint if exists invitations_created_via_check;
alter table invitations add constraint invitations_created_via_check
  check (created_via in ('console', 'project', 'request'));
create index invitations_accepted_user on invitations (accepted_user_id)
  where revoked_at is null and accepted_user_id is not null;
