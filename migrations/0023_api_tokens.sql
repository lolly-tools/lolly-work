-- lolly-work schema - service tokens (plans/35 wave 2).
--
-- Automation identity: the SCIM-token pattern (0021) generalized. A service
-- token lets CI run `lw export`, `lw apply`, provider syncs and audit reads
-- without a person's session cookie sitting in a secret store - which is the
-- thing IT policy rightly forbids. The secret is minted once, shown once,
-- stored only as its sha256; presenting it resolves to a synthetic principal
-- carrying the token's ROLE (no groups), so RBAC, grants and audit need no
-- second authorization model. `role` is a plain text column for the same
-- reason users.role is: the evaluator owns the vocabulary, the store does not.
--
-- Revocation is a database write (revoked_at), checked on every use; the
-- cleartext never round-trips and a leaked database yields hashes only.

create table api_tokens (
  id           text primary key,
  label        text not null,
  role         text not null,
  token_hash   text not null unique,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
