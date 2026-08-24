-- lolly-work schema - the SIEM forwarding cursor (plans/35 wave 2).
--
-- The audit log IS the outbox: rows are append-only and carry seq numbers,
-- so loss-free forwarding needs exactly one durable fact - how far delivery
-- got. The forwarder (observability/siem.ts, long-lived server only) reads
-- past this cursor, POSTs a signed batch, and advances it only on a 2xx; a
-- crash or an unreachable receiver replays from the cursor rather than
-- dropping anything. One row by construction (the check), because there is
-- one receiver; fan-out to several belongs to the receiver's side.

create table siem_cursor (
  id         int primary key default 1 check (id = 1),
  seq        bigint not null default 0,
  updated_at timestamptz not null default now()
);
