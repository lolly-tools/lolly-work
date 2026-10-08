-- lolly-work schema - hidden catalog tags (plan 299, track B).
--
-- One row per scope: `*` hides a label on every served entry, and
-- `provider:<id>` hides it on one provider's entries only. The rule rides as
-- jsonb for the reason catalog_field_defs does: it is the store's copy of a
-- policy-document entry, so a key added there must not need a migration here.
--
-- The rules are applied when the asset index is served, never when a provider
-- syncs, so no fragment, instance asset or pack file is rewritten and showing
-- a tag again is one row write.

create table catalog_tag_rules (
  scope      text primary key,
  rule       jsonb not null,
  updated_at timestamptz not null default now()
);
