-- lolly-work schema - a keyed MAC on every audit row, and an append-only guard.
--
-- The hash chain (0001) is computable by anyone who can read the rows, so a
-- database holder could rewrite history and recompute it. Each row now also
-- carries an HMAC of its hash under a key the database never sees (derived
-- from LW_SESSION_SECRET at boot); verification checks the MAC for every row
-- that has one and reports how many rows predate it. Rows written before this
-- migration have no MAC and stay verifiable by chain alone.
--
-- The trigger refuses UPDATE and DELETE on audit_log from the application
-- role. The retention trim is the one legitimate delete and announces itself
-- with `set local lolly_work.audit_trim = 'on'` inside its transaction, after
-- writing the anchor (0025). A superuser can drop the trigger, which the
-- anchor and the externally logged head still make visible.

alter table audit_log add column if not exists mac text;

create or replace function audit_log_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('lolly_work.audit_trim', true) = 'on' then
    return old;
  end if;
  raise exception 'audit_log is append-only: % refused', tg_op
    using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists audit_log_append_only on audit_log;
create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function audit_log_append_only();
