-- lolly-work schema — catalog holds (plans/27 §3). A hold is a permissioned
-- block on making an asset go away: while set, the asset refuses revocation,
-- expiry-into-the-past, scheduling-into-the-future and (once plans/26 lands)
-- blob deletion, until an owner/admin releases it. It rides on the existing
-- lifecycle row rather than a second table — one row per asset, still keyed by
-- the catalog asset id — and stores {by, at, note?} as jsonb.
--
-- Nullable, so every lifecycle row written before this migration stays valid
-- and an asset with no hold reads exactly as before. The memory store mirrors
-- this shape.

alter table catalog_lifecycle add column if not exists hold jsonb;
