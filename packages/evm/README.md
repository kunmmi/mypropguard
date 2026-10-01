# @mypropguard/evm

The TypeScript side of `packages/evm-guard`'s Solidity contracts - what `apps/api` will actually
call to provision a trader's Safe and keep its on-chain risk limits in sync with Postgres.

## What's here

- `SafeDeployer` — deploys a Safe for a trader with the risk Guard already attached, in one
  transaction, with **zero signature from the trader** (see
  `packages/evm-guard/README.md`'s "Deploying for a trader without their signature" section and
  `SafeGuardSetup.sol` for why this is possible and safe).
- `GmxGuardClient` — admin-only `setLimits` calls against a deployed `GmxPositionLimitGuard`.
- `SpotGuardClient` — admin-only `setTokenLimit`/`setMaxTradesPerDay`/`setRouterKind` calls
  against a deployed `PancakeSwapLimitGuard` or `UniswapLimitGuard` (identical ABI on both).

Every admin call here is signed by MyPropGuard's own backend wallet - never the trader's key,
matching each Guard contract's own `onlyAdmin` enforcement on the Solidity side.

## What's verified

`test/safeFlow.anvil.test.ts` drives these actual classes (not a mock) against a real local
Anvil chain: deploys the real compiled Safe/SafeProxyFactory/SafeGuardSetup/
GmxPositionLimitGuard bytecode (from `packages/evm-guard/out/`, built via `forge build` there),
then uses `SafeDeployer` to create a Safe for a test "trader" account and `GmxGuardClient` to
sync a rule onto it - confirming via direct contract reads (`getOwners`, `getThreshold`, the
Guard's own storage slot, the Guard's `limits` mapping) that both actually worked. This is the
TypeScript-side equivalent of `packages/evm-guard`'s own Foundry Safe-end-to-end tests - proving
the orchestration code apps/api will really run, not just the Solidity contracts in isolation.

Needs Foundry's `anvil` on PATH (`curl -L https://foundry.paradigm.xyz | bash && foundryup`) and
`packages/evm-guard`'s contracts already built (`cd ../evm-guard && forge build`).

## Not yet done

- Not wired into `apps/api` yet - no route calls `SafeDeployer`/`GmxGuardClient`/`SpotGuardClient`
  for real, and there's no Postgres column to persist a provisioned Safe's address against an
  account. See `packages/evm-guard/ROADMAP.md`.
- `SafeDeployerConfig`'s `safeProxyFactory`/`safeSingleton` addresses are meant to be Safe's own
  real canonical deployments (the same address across most EVM chains) - re-verify these against
  `github.com/safe-global/safe-deployments` for each real chain before using in production; this
  package doesn't hardcode or ship any default addresses itself.
- No retry/nonce-management for the admin wallet submitting rule-sync transactions - fine for a
  single backend process today, would need real queuing once rule updates can happen
  concurrently.
