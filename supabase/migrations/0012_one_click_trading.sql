-- One-click trading on BSC (and other Safe chains): the trader presses buy on an exchange's own website and the
-- trade goes through with no wallet popup. MyPropGuard holds a "session key" for the trader's Safe, made as a
-- Privy wallet. The Guard on the Safe lets that key trade and nothing else (no withdrawals, no owner changes).

-- The session key of one account. 'pending' = created but not yet added to the Safe by the trader's own wallet,
-- 'enabled' = on the Safe and recognised by the Guard, 'revoked' = switched off (the server stops signing at once).
create table if not exists evm_one_click (
  account_id text primary key references protected_accounts (account_id),
  session_wallet_id text not null,
  session_wallet_address text not null,
  status text not null check (status in ('pending', 'enabled', 'revoked')),
  created_at timestamptz not null default now(),
  enabled_at timestamptz
);
alter table evm_one_click enable row level security;

-- Exchanges linked to an account through WalletConnect (one row per link).
create table if not exists evm_wc_sessions (
  topic text primary key,
  account_id text not null references protected_accounts (account_id),
  dapp_name text,
  dapp_url text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);
create index if not exists evm_wc_sessions_account_idx on evm_wc_sessions (account_id);
alter table evm_wc_sessions enable row level security;

-- Every trade request that came in through a link, and what happened to it.
create table if not exists evm_one_click_trades (
  id bigserial primary key,
  account_id text not null references protected_accounts (account_id),
  created_at timestamptz not null default now(),
  dapp_name text,
  to_address text,
  value_wei text,
  tx_hash text,
  result text not null check (result in ('SENT', 'REFUSED', 'ERROR')),
  message text
);
create index if not exists evm_one_click_trades_account_idx on evm_one_click_trades (account_id, created_at desc);
alter table evm_one_click_trades enable row level security;

-- WalletConnect's own state (its links and relay keys). Kept here instead of on the server's disk, which is wiped
-- on every deploy, so the links survive a redeploy.
create table if not exists walletconnect_kv (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table walletconnect_kv enable row level security;
