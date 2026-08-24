-- lolly-work schema - SCIM provisioning tokens (plans/31 section 8).
--
-- SCIM (System for Cross-domain Identity Management) lets an IdP push user
-- lifecycle at this instance: create a person, patch their attributes, and -
-- the operation that earns the wave - flip `active=false` when they leave, so
-- the account is disabled and every live session dies on its next request.
--
-- The users this manages are the SAME rows OIDC login upserts (users.sub is the
-- IdP subject; SCIM addresses a person by that externalId), and group
-- membership is the SAME localGroups the console edits. So there is no second
-- identity store here and no second membership model: SCIM is another writer of
-- the one that exists. The only new state this wave needs is the credential the
-- IdP presents - a bearer token per IdP connector, stored HASHED, shown once at
-- mint. That is this table; the external-id mapping rides users.sub, which is
-- exactly the linkage OIDC already uses, so a person SCIM provisions and the
-- same person signing in resolve to one row.
--
-- Deprovisioning composes what is already built (setUserDisabled bumps the
-- session epoch); membership composes setLocalGroups. Nothing here duplicates
-- either. SAML stays unbuilt: Keycloak (which id.suse.com runs) bridges a
-- SAML-only IdP to the OIDC this already speaks.

create table scim_tokens (
  id           text primary key,
  -- The operator's label for the IdP connector this token belongs to. Not a
  -- foreign key to anything: it is a name the admin chose, carried onto every
  -- audit event the token drives so "which connector did this" stays answerable
  -- after the token is revoked.
  idp          text not null,
  -- sha256 of the opaque secret. The secret is returned once, at mint, and is
  -- never recoverable - a leaked database yields hashes, not usable tokens, the
  -- same posture link passwords and the session secret take.
  token_hash   text not null unique,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  -- Set on revoke; a revoked token is kept (not deleted) so its audit trail and
  -- last-used time survive the revocation that a compromised-token response
  -- needs to reason about.
  revoked_at   timestamptz
);

create index scim_tokens_idp on scim_tokens (idp);
