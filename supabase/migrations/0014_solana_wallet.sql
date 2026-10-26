-- The MyPropGuard Solana wallet, for sites like pump.fun that log in with a Solana wallet. Like the BNB Chain wallet, the
-- key is held at Privy and the server decides what gets signed. This first version links a site, signs its login and
-- records every transaction the site asks for WITHOUT signing it, so what pump.fun really sends can be read before
-- trading is switched on (packages/solana).

-- One Solana wallet per protected account. The key lives at Privy; only its id and public address are kept here.
create table if not exists sol_wallets (
  account_id text primary key references protected_accounts (account_id),
  wallet_id text not null,
  wallet_address text not null,
  -- 'off' = the owner switched it off: the server stops answering at once and the links are dropped.
  status text not null default 'active' check (status in ('active', 'off')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table sol_wallets enable row level security;

-- Every request that reached the Solana wallet from a linked site, and what happened to it.
create table if not exists sol_requests (
  id bigserial primary key,
  account_id text not null references protected_accounts (account_id),
  created_at timestamptz not null default now(),
  dapp_name text,
  -- 'login' = a message to sign; 'transaction' = a transaction to sign (and maybe send); 'other' = anything else.
  kind text not null check (kind in ('login', 'transaction', 'other')),
  method text not null,
  result text not null check (result in ('SIGNED', 'REFUSED', 'ERROR')),
  -- A stable reason code for a refusal, and the sentence the owner was shown.
  code text,
  message text,
  -- What was asked, readable: the login text, or a decoded transaction (programs, signers, accounts, data).
  detail jsonb
);
create index if not exists sol_requests_account_idx on sol_requests (account_id, created_at desc);
alter table sol_requests enable row level security;

-- A WalletConnect link is to the account's Safe, its BNB Chain wallet, or its Solana wallet.
alter table evm_wc_sessions drop constraint if exists evm_wc_sessions_kind_check;
alter table evm_wc_sessions add constraint evm_wc_sessions_kind_check check (kind in ('safe', 'float', 'solana'));
