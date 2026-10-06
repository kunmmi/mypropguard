-- Hyperliquid watcher. The trader's own Hyperliquid address (the account the agent wallet trades for),
-- so the watcher can read it without being told each time.
alter table protected_accounts add column if not exists venue_address text;

-- Per-account enforcement state: whether the account is locked for the UTC day, the exposure ceilings that
-- apply while locked, and the last positions that broke no rule.
alter table account_risk_heads add column if not exists enforcement_state jsonb;

-- Audit log: every cancel/trim the watcher decided on (or would have, in log-only mode) and what happened.
create table if not exists enforcement_actions (
  id bigserial primary key,
  account_id text not null references protected_accounts (account_id),
  created_at timestamptz not null default now(),
  mode text not null,
  kind text not null,
  coin text,
  detail jsonb not null default '{}'::jsonb,
  result text not null,
  error text
);
create index if not exists enforcement_actions_account_idx on enforcement_actions (account_id, created_at desc);
alter table enforcement_actions enable row level security;
