-- Discoverable passkeys belong to existing accounts. Only public key material is stored.
create table passkeys (
  id text primary key check (length(id)<=1024), user_id text not null references users(id) on delete cascade,
  public_key text not null check (length(public_key)<=8192), counter bigint not null check(counter>=0),
  transports text[] not null default '{}', label text not null check(length(label) between 1 and 80),
  backed_up boolean not null, device_type text not null check(device_type in ('singleDevice','multiDevice')),
  created_at timestamptz not null default now(), last_used_at timestamptz
);
create index passkeys_user on passkeys(user_id);
create table passkey_challenges (
  id text primary key, nonce_hash text not null, user_id text references users(id) on delete cascade,
  expires_at timestamptz not null, payload jsonb not null
);
create index passkey_challenges_expiry on passkey_challenges(expires_at);
