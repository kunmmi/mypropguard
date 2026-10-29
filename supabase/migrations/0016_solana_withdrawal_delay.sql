-- A changed withdrawal address waits 24 hours before it takes effect, so someone who gets into the owner's login cannot
-- point withdrawals at their own address and empty the wallet at once. Until then withdrawals keep going to the old address.
-- The first address is set straight away: until there is one, nothing can be withdrawn at all.

alter table sol_wallets
  -- The address the owner asked to change to, and when it takes effect. Both null when no change is waiting.
  add column if not exists pending_withdrawal_address text,
  add column if not exists pending_withdrawal_at timestamptz;
