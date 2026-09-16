-- Phase 2 addition: read-only venue state reconciliation checkpoints.
-- Records whenever an account's state was last verified against a live
-- venue read, and with what confidence — used by ProtectionGate to decide
-- whether it's safe to say "botCanOpenNewTrades: true".

create table state_checkpoints (
  id uuid primary key default gen_random_uuid(),
  account_id text not null references protected_accounts (account_id),
  confidence text not null check (confidence in ('VERIFIED', 'STALE', 'UNKNOWN')),
  verified_at timestamptz not null
);
create index state_checkpoints_account_verified_idx on state_checkpoints (account_id, verified_at desc);
