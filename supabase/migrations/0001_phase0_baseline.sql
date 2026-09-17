-- Phase 0 baseline schema for MyPropGuard Onchain.
-- Only the tables needed for Phase 0 (frozen contracts) and Phase 1
-- (offline deterministic risk engine, no live venue/signing) are created
-- here. Venue-ingestion/signing tables (venue_events, state_checkpoints,
-- nonce_leases, agent_leases, authority_epochs, ...) are deferred to the
-- Phase 2/3 migration.

create extension if not exists pgcrypto;

create table protected_accounts (
  account_id text primary key,
  owner_user_id text not null,
  venue text not null default 'hyperliquid',
  protection_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- The per-account serialization root. `SELECT ... FOR UPDATE` on this row
-- is what makes concurrent order reservations for the same account safe
-- (see packages/risk-ledger PgRiskLedgerStore).
create table account_risk_heads (
  account_id text primary key references protected_accounts (account_id),
  equity_start_of_day numeric(38, 18) not null,
  current_equity numeric(38, 18) not null,
  realized_pnl_today numeric(38, 18) not null default 0,
  peak_equity numeric(38, 18) not null,
  current_drawdown numeric(38, 18) not null default 0,
  open_notional numeric(38, 18) not null default 0,
  leverage numeric(38, 18) not null default 0,
  trade_count_today integer not null default 0,
  last_trade_at timestamptz,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

create table rule_versions (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references protected_accounts (account_id),
  rule_type text not null check (
    rule_type in (
      'MAX_DAILY_LOSS',
      'MAX_DRAWDOWN',
      'MAX_LEVERAGE',
      'MAX_POSITION_SIZE',
      'MAX_EXPOSURE',
      'MAX_TRADE_FREQUENCY',
      'COOLDOWN'
    )
  ),
  param numeric(38, 18) not null,
  effective_from timestamptz not null default now(),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index rule_versions_account_active_idx on rule_versions (account_id, is_active);

-- Per-account, per-UTC-day rollover record for daily-loss accounting.
create table risk_days (
  account_id text not null references protected_accounts (account_id),
  risk_date date not null,
  start_of_day_equity numeric(38, 18) not null,
  realized_pnl numeric(38, 18) not null default 0,
  trade_count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, risk_date)
);

create table decision_artifacts (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references protected_accounts (account_id),
  client_intent_id text not null,
  outcome text not null check (outcome in ('ALLOW', 'RESIZE', 'BLOCK')),
  approved_size numeric(38, 18),
  reason_code text not null,
  message text not null,
  rule_type text,
  evaluated_at timestamptz not null default now()
);
create index decision_artifacts_account_idx on decision_artifacts (account_id, evaluated_at desc);

create table order_reservations (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references protected_accounts (account_id),
  client_intent_id text not null,
  reserved_amount numeric(38, 18) not null,
  status text not null default 'HELD' check (status in ('HELD', 'CONSUMED', 'RELEASED')),
  created_at timestamptz not null default now(),
  released_at timestamptz
);
create index order_reservations_account_status_idx on order_reservations (account_id, status);
