-- SPDX-License-Identifier: MPL-2.0
-- Lease tokens fence old workers; a restart reclaims only expired executions.
alter table automation_jobs add column lease_owner text;
alter table automation_jobs add column lease_until timestamptz;
alter table automation_jobs add column lease_token integer not null default 0;
create index automation_jobs_claim on automation_jobs (priority desc, created_at)
  where state in ('queued', 'running');
