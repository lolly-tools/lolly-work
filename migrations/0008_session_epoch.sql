-- Pre-expiry session revocation (plans/02 §5): a per-user epoch, embedded in
-- every session token at mint. Bumping it kills all earlier tokens on their
-- next request — sessions stay stateless cookies, no token store appears.
-- Bumped by "sign out everywhere" and automatically on disable.
--
-- Additive with a default, so it applies with zero downtime. Tokens minted
-- before this change carry no epoch and are read as 0 — matching this default,
-- so existing sessions stay valid until an actual bump.

alter table users add column session_epoch integer not null default 0;
