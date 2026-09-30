-- Per-account signing wallet, provisioned automatically at account
-- creation. Nullable: the offline scaffold (no AgentWalletProvisioner
-- configured) never sets these, and existing accounts predate this column.
-- Not yet used by the actual signing pipeline (still one server-wide
-- wallet) - this is the address a user needs to go approve as a
-- Hyperliquid agent, stored so the product can show it to them.

alter table protected_accounts add column agent_wallet_id text;
alter table protected_accounts add column agent_wallet_address text;
