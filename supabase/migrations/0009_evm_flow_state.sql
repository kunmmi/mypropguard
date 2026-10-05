-- Per-account state for EVM (Safe) daily-loss accounting: which UTC day equity_start_of_day is
-- anchored to, how far the chain has been scanned for capital flows, the net USD value of deposits
-- and withdrawals seen so far, and the ERC-20s the Safe has acquired (so they can be valued).
-- Null for Hyperliquid accounts and for an EVM account that has not been reconciled yet.
alter table account_risk_heads add column if not exists evm_flow_state jsonb;
