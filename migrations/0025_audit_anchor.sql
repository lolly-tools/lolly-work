-- lolly-work schema - the audit trim anchor (plans/35 wave 3).
--
-- Retention meets tamper evidence. The audit chain verifies from genesis, so
-- deleting old rows would break verification - unless the boundary is
-- recorded first. This one-row table holds the last trimmed row's seq and
-- hash; verifyChain starts from it when present, and the anchor is written
-- BEFORE the delete, so a trim interrupted between the two leaves a chain
-- that still verifies (rows at or under the anchor are skipped, not
-- double-checked). The trim itself refuses to pass the SIEM cursor, so
-- nothing is ever deleted before it was forwarded.

create table audit_anchor (
  id         int primary key default 1 check (id = 1),
  seq        bigint not null,
  hash       text not null,
  updated_at timestamptz not null default now()
);
