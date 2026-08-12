-- lolly-work schema — approvals engine (plans/05). Chains are named, versioned
-- objects; an approval carries a snapshot of the chain it was raised under plus
-- its full action trail, stored as one jsonb doc. The scalar columns are lifted
-- out only for the cheap inbox/mine query paths; the memory store mirrors this.

create table chains (
  id   text primary key,
  name text not null,
  spec jsonb not null                  -- the whole Chain: id/name/version?/steps/onReject
);

create table approvals (
  id         text primary key,
  state      text not null check (state in ('submitted', 'in_review', 'approved', 'rejected', 'withdrawn')),
  step_index integer not null default 0,
  created_by text not null references users(id),
  created_at timestamptz not null,
  doc        jsonb not null            -- the whole Approval, incl. the chain snapshot + action trail
);
create index approvals_created_by on approvals (created_by);
create index approvals_state on approvals (state);
