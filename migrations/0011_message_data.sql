-- lolly-work schema — machine-readable payload on a bridge message
-- (server/src/inbox/target.ts `Message.data`, plans/10 §2).
--
-- System-generated messages need to say WHAT they are about, not only what they
-- read like. The first case is the live-collab invite (plans/14 §6, OSS
-- plans/100 §7 item 9): the shell has to open the invited session, and the
-- server has no shell route to bake into `cta.url` — so the session id travels
-- here and the client builds its own deep link.
--
-- Nullable, so every message written before this migration stays valid and the
-- console composer (which sets no data) needs no change.

alter table messages add column if not exists data jsonb;
