-- Lets a MAX_POSITION_SIZE rule specify which ERC-20 token its limit applies to, for EVM spot
-- venues (bsc-pancakeswap, ethereum-uniswap) whose Guard contracts enforce limits per-token.
-- Null for every other rule type/venue (Hyperliquid and GMX have no per-token concept here).
alter table rule_versions add column token_address text;
