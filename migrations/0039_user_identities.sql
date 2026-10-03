-- lolly-work schema - linked sign-ins (plans/74, "One person, many sign-ins").
--
-- One row per sign-in (an IdP subject) and the user it belongs to. A person
-- who signs in with Google and with GitHub holds two rows pointing at one
-- users row. identity_sub is the namespaced subject the callback builds:
-- '<idp id>:<sub>' for an additional IdP, the raw sub for the primary IdP,
-- 'proxy:<user>' for the reverse proxy and 'dev:<email>' for dev sign-in.
--
-- users.sub stays the subject the session cookie carries, whichever sign-in
-- was used, so every users(id) reference and getUserBySub keep working.
--
-- email_verified records whether the IdP vouched for the address at the
-- latest sign-in. Sign-in links a new identity to an existing user by email
-- only through a verified row, and the backfilled rows below start false:
-- an address nobody has proven since this migration never links anything.
-- The next sign-in through that identity refreshes the flag.
--
-- groups holds the IdP groups this sign-in asserted at its latest sign-in
-- (with any bootstrap owner group it earned). Each IdP speaks only for its
-- own groups: the account's IdP groups are what its sign-ins seen within the
-- standing window asserted, so a deleted work account's groups lapse even
-- while a linked personal sign-in keeps working. Backfilled from the
-- account's stored IdP groups, which its own sign-in wrote.
--
-- A row goes with its user (erasure): a sign-in mapping is the person's own
-- data, not shared work.

create table user_identities (
  identity_sub   text primary key,
  user_id        text not null references users(id) on delete cascade,
  idp            text not null,
  email          text check (email is null or email = lower(email)),
  email_verified boolean not null default false,
  linked_at      timestamptz not null default now(),
  last_login_at  timestamptz,
  groups         jsonb not null default '[]'
);

create index user_identities_user_id on user_identities (user_id);
create index user_identities_email on user_identities (lower(email));

-- Backfill: every existing user keeps signing in through the sub it was
-- created with. The idp is the prefix before the first ':' when it looks like
-- an IdP id (lowercase slug, the idp.additional id rule, plus proxy and dev),
-- otherwise 'primary', whose subs carry no prefix.
insert into user_identities (identity_sub, user_id, idp, email, email_verified, linked_at, last_login_at, groups)
select
  u.sub,
  u.id,
  case when u.sub ~ '^[a-z0-9][a-z0-9-]*:' then split_part(u.sub, ':', 1) else 'primary' end,
  nullif(lower(trim(u.email)), ''),
  false,
  u.created_at,
  u.last_seen_at,
  coalesce(u.idp_groups, '[]'::jsonb)
from users u
on conflict (identity_sub) do nothing;
