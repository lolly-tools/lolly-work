-- lolly-work schema - invitations (plans/74 W-ID-2).
--
-- An invitation names one email address that may sign in here while
-- idp.admission is set, plus the local groups that person joins on their first
-- admitted sign-in. Emails are stored lowercased; the comparison at sign-in is
-- case-insensitive for the same reason.
--
-- "Active" means not revoked. An active invitation is either pending
-- (accepted_at null) or accepted; an accepted one keeps admitting its email at
-- every later sign-in until it is revoked, which is how revoking someone
-- blocks their next sign-in. expires_at bounds acceptance only.
--
-- One active invitation per email, enforced by the partial unique index below.
-- Inviting an address again returns the active row; a pending row that has
-- expired is revoked first so a fresh one can take its place. No email is
-- sent from here: the console shows the sign-in address to share.

create table invitations (
  id               text primary key,
  email            text not null check (email = lower(email)),
  groups           jsonb not null default '[]',
  invited_by       text not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz,
  accepted_at      timestamptz,
  accepted_user_id text,
  revoked_at       timestamptz
);

create unique index invitations_one_active_per_email on invitations (email) where revoked_at is null;
create index invitations_created_at on invitations (created_at desc);
