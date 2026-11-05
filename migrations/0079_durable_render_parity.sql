-- SPDX-License-Identifier: MPL-2.0
-- Durable renders and render batches use the same callback outbox as automation
-- jobs: one table, one claim, one retry ladder. An entry names exactly one
-- subject. The store call that takes a render or a whole batch to a terminal
-- state also writes its entry.
alter table automation_callbacks alter column job_id drop not null;
alter table automation_callbacks add column render_id text unique references renders(id) on delete cascade;
alter table automation_callbacks add column render_batch_id text unique references render_batches(id) on delete cascade;
alter table automation_callbacks add constraint automation_callbacks_one_subject
  check (num_nonnulls(job_id, render_id, render_batch_id) = 1);
