-- The MyPropGuard wallet. For sites that log in with a signature (four.meme) a Safe cannot be used, so the trader
-- keeps their trading money in a wallet MyPropGuard holds, and the server judges every trade the site proposes before
-- anything is signed (packages/evm floatPolicy). Limits are shares of what the wallet holds, so they follow deposits
-- and withdrawals. Money can only leave it back to the owner's own account.

-- One trading wallet per protected account. The key lives at Privy; only its id and public address are kept here.
create table if not exists evm_float_wallets (
  account_id text primary key references protected_accounts (account_id),
  wallet_id text not null,
  wallet_address text not null,
  chain_id integer not null,
  -- 'off' = the owner switched it off: the server stops signing at once and the links are dropped.
  status text not null default 'active' check (status in ('active', 'off')),
  -- One buy may use at most this share of the BNB in the wallet.
  max_buy_pct integer not null default 25 check (max_buy_pct between 1 and 100),
  max_buys_per_day integer not null default 10 check (max_buys_per_day >= 0),
  -- A day's buys may use at most this share of the BNB the wallet started the day with.
  daily_spend_pct integer not null default 50 check (daily_spend_pct between 1 and 100),
  cooldown_sec integer not null default 0 check (cooldown_sec >= 0),
  -- When true no buy is allowed (selling still is).
  frozen boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table evm_float_wallets enable row level security;

-- Every request that reached the trading wallet from a linked site, and what happened to it. The day's counters
-- (buys so far, BNB spent so far) are computed from this table, so they survive a restart.
create table if not exists evm_float_trades (
  id bigserial primary key,
  account_id text not null references protected_accounts (account_id),
  created_at timestamptz not null default now(),
  dapp_name text,
  kind text not null check (kind in ('buy', 'sell', 'approve', 'login', 'sweep', 'other')),
  to_address text,
  token_address text,
  value_wei numeric(78, 0),
  tx_hash text,
  result text not null check (result in ('SENT', 'REFUSED', 'ERROR')),
  -- A stable reason code for a refusal (MAX_BUY, DAILY_SPEND, ...), and the sentence the trader was shown.
  code text,
  message text,
  -- How long the server took, for finding slow steps: check / dry-run / sign+send, and the total.
  check_ms integer,
  estimate_ms integer,
  send_ms integer,
  total_ms integer
);
create index if not exists evm_float_trades_account_idx on evm_float_trades (account_id, created_at desc);
create index if not exists evm_float_trades_usage_idx on evm_float_trades (account_id, kind, result, created_at);
alter table evm_float_trades enable row level security;

-- A WalletConnect link is either to the account's Safe (one-click trading) or to its trading wallet.
alter table evm_wc_sessions add column if not exists kind text not null default 'safe' check (kind in ('safe', 'float'));
