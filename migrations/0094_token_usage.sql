-- SPDX-License-Identifier: MPL-2.0
-- Limits and use on service tokens (plans/82 M7). `api_tokens.limits` holds
-- the figures a token states (calls a minute, renders a day and renders a
-- month); null means it states none and takes its programme's or the
-- instance's. `token_usage` holds one row per token and UTC day: calls counted
-- on the automation surface, renders accepted, the busiest minute, and the
-- calls and requests a limit turned away. Counts only, never an input or
-- anything a caller says about itself. Dropping the table loses the counts and
-- every render budget starts again at zero; dropping the column returns every
-- token to its programme's and the instance's figures.
alter table api_tokens add column limits jsonb;
create table token_usage (
  token_id          text not null,
  day               text not null,
  calls             integer not null default 0,
  renders           integer not null default 0,
  minute_at         text,
  minute_calls      integer not null default 0,
  busiest_minute    integer not null default 0,
  rate_limited      integer not null default 0,
  budget_refused    integer not null default 0,
  last_refused_at   timestamptz,
  last_refused_code text,
  primary key (token_id, day)
);
create index token_usage_by_day on token_usage (day);
