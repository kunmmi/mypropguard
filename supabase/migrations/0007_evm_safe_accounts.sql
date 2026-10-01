-- EVM-chain account fields (e.g. venue = 'arbitrum-gmx' / 'bsc-pancakeswap' / 'ethereum-uniswap').
-- Nullable: Hyperliquid accounts (and any account predating this column) never set these.
--
-- Unlike agent_wallet_id/agent_wallet_address (a Privy wallet MyPropGuard fully controls),
-- evm_owner_wallet_address is the TRADER's own wallet - it becomes the sole owner of the
-- provisioned Safe at evm_safe_address, and MyPropGuard never holds its key. See
-- packages/evm-guard/README.md and packages/evm/README.md for the provisioning mechanism
-- (SafeGuardSetup.sol + SafeDeployer) this supports.

alter table protected_accounts add column evm_owner_wallet_address text;
alter table protected_accounts add column evm_safe_address text;
alter table protected_accounts add column evm_chain_id integer;
