-- Hyperliquid accounts: which UTC day equity_start_of_day is anchored to, how far Hyperliquid's ledger
-- has been read, and the net USD value of deposits/withdrawals/transfers seen so far, so a deposit is
-- never profit and a withdrawal is never a loss. Null until an account's first reconcile.
alter table account_risk_heads add column if not exists venue_flow_state jsonb;
