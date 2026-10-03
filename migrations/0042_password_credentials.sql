-- lolly-work schema - email and password sign-in (plans/74).
--
-- password_credentials holds one password per email address (lowercased),
-- as the scrypt string server/src/iam/password.ts writes. The password itself
-- is never stored. id stays the same across resets and names the sign-in's
-- subject, 'password:<id>', in user_identities. failed_count counts wrong
-- passwords since the last success; the failure that reaches the limit sets
-- locked_until and starts the count again. A credential belongs to an email,
-- not to a users row, because the first sign-in creates (or links to) the
-- account through the same path every other sign-in takes.
--
-- password_links holds the one-time links an admin issues to set or reset a
-- password. Nothing is emailed: the console shows the link to pass on. Only
-- sha256(token) is stored. A link works once (used_at) and until expires_at;
-- issuing a new link for an email removes that email's unused ones.
--
-- Account erasure removes both for the address unless another account still
-- carries it.

create table password_credentials (
  id            text primary key,
  email         text not null unique check (email = lower(email)),
  hash          text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  failed_count  integer not null default 0 check (failed_count >= 0),
  locked_until  timestamptz
);

create table password_links (
  token_hash  text primary key,
  email       text not null check (email = lower(email)),
  purpose     text not null check (purpose in ('setup', 'reset')),
  created_by  text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index password_links_email on password_links (email);
create index password_links_expires_at on password_links (expires_at);
