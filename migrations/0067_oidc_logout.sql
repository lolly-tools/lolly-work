-- Revocation targets and replay records contain hashes, not raw IdP identifiers.
create table oidc_logout_events (key text primary key, issued_at double precision not null);
create index oidc_logout_events_issued on oidc_logout_events (issued_at);
create table oidc_logout_targets (key text primary key, issued_at double precision not null);
create index oidc_logout_targets_issued on oidc_logout_targets (issued_at);
