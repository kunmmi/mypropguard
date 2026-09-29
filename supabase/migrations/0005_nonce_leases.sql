-- Durable nonce leases: InMemoryExecutionSequencer's in-memory counter loses
-- its high-water mark on every server restart, which risks handing out a
-- nonce Hyperliquid has already seen for that account (it enforces strictly
-- increasing, near-current-timestamp nonces - confirmed for real: a nonce
-- below its last-seen one is rejected outright with "nonce too low").
-- This table persists the same "last nonce issued" state across restarts.

create table nonce_leases (
  account_id text primary key references protected_accounts (account_id),
  last_nonce bigint not null,
  updated_at timestamptz not null default now()
);
