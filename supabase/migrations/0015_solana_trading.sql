-- The Solana wallet starts trading on pump.fun: the owner's limits, a record of each trade (what it cost, what it
-- returned), the figures the loss and drawdown rules need, and where withdrawals go (packages/solana).

-- Limits are shares of what the wallet holds, so they follow deposits and withdrawals.
alter table sol_wallets
  add column if not exists max_buy_pct integer not null default 25 check (max_buy_pct between 1 and 100),
  add column if not exists daily_spend_pct integer not null default 50 check (daily_spend_pct between 1 and 100),
  add column if not exists max_buys_per_day integer not null default 10 check (max_buys_per_day >= 0),
  add column if not exists cooldown_sec integer not null default 0 check (cooldown_sec >= 0),
  -- When true no buy is signed (selling still is).
  add column if not exists frozen boolean not null default false,
  -- The one address withdrawals go to, chosen by the signed-in owner. The server sends money nowhere else.
  add column if not exists withdrawal_address text;

-- What each request was, now including the trade it carried.
alter table sol_requests drop constraint if exists sol_requests_kind_check;
alter table sol_requests add constraint sol_requests_kind_check check (kind in ('login', 'transaction', 'sweep', 'other'));
alter table sol_requests
  add column if not exists trade_kind text check (trade_kind in ('buy', 'sell')),
  add column if not exists mint text,
  -- For a buy: the most SOL it could cost, in lamports (priority fee included).
  add column if not exists lamports numeric(40, 0),
  -- For a sale (or a token handed back to the owner): what it returned in lamports, estimated from the quote taken just
  -- before. With what each buy cost, this is how the wallet's trading result is worked out.
  add column if not exists proceeds_lamports numeric(40, 0),
  add column if not exists signature text,
  -- How long the server took: check / simulate / sign(+send), and the total.
  add column if not exists check_ms integer,
  add column if not exists simulate_ms integer,
  add column if not exists sign_ms integer,
  add column if not exists total_ms integer;
create index if not exists sol_requests_usage_idx on sol_requests (account_id, trade_kind, result, created_at);

-- Where the wallet stood at the start of the UTC day and at its highest, for the loss and drawdown rules.
create table if not exists sol_risk (
  account_id text primary key references protected_accounts (account_id),
  day date,
  -- The wallet's cumulative trading result (lamports) when that day began. Can be negative.
  day_start_pnl_lamports numeric(40, 0) not null default 0,
  -- The most the wallet (SOL plus holdings) has ever been worth, in lamports.
  peak_equity_lamports numeric(40, 0) not null default 0,
  updated_at timestamptz not null default now()
);
alter table sol_risk enable row level security;
