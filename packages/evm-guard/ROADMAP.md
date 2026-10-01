# EVM expansion roadmap

Spot-trading risk enforcement first (fast to ship, no oracle dependency). Leveraged/perps risk
enforcement (max leverage, max daily loss) is deferred to its own later track - see "Deferred"
at the bottom for why, and what unlocks it.

## Done

| # | Chain | Exchange | Router(s) covered | Rules enforced | Proof |
|---|---|---|---|---|---|
| 1 | Arbitrum | GMX v2 (Classic Trading) | ExchangeRouter | max position size, max trades/day | 12 unit tests + 2 live-fork tests against real GMX contract |
| 2 | BSC | PancakeSwap | V2 Router + V3 SmartRouter | max $ per trade (per token), max trades/day | 18 unit tests + 4 live-fork tests, incl. 2 complete real swaps |
| 3 | Ethereum | Uniswap | V2 Router + V3 SwapRouter + SwapRouter02 | max $ per trade (per token), max trades/day | 18 unit tests + 4 live-fork tests, incl. 2 complete real swaps |

All three: one Guard contract per exchange, shared across every MyPropGuard Safe, admin-only
configuration (trader can't loosen their own limits), fail-closed if limits were never set.
Uniswap's Guard is near-identical code to PancakeSwap's, confirmed safe to duplicate rather than
share since PancakeSwap's routers are line-by-line forks of Uniswap's own.

Items 2 and 3 now cover V2 AND V3 (both struct generations - with/without a `deadline` field,
picked per registered router address via a `RouterKind` registry, since a Safe can only have one
Guard active and decoding the wrong struct shape silently misaligns every field after
`recipient`). The `amountIn == 0` "spend my whole balance" sentinel is rejected outright rather
than silently mis-checked as zero.

## Next: Universal Router (both chains) - currently blocked on real gaps, not just unstarted

Deliberately NOT built yet, and not simply because of time - real research gaps make it unsafe
to ship with confidence right now (see `research_notes/EVM on-chain trading risk enforcement/
v3_and_universal_router_abi.md`):

1. At least two live Ethereum Universal Router deployments decode the same command IDs into
   different tuple shapes (5-field vs. 6-field) - which one applies depends on which deployed
   address is the call target, and this needs to be gotten exactly right or a Guard would
   misread the real trade size.
2. The newest deployment has a third entry point, `executeSigned(...)`, whose
   authorization/attribution model (who can trigger it, whether it can relay someone else's
   pre-signed intent) is not understood yet - shipping without understanding this risks leaving
   an entire unblocked execution path.
3. PancakeSwap's Universal Router has its own extra command IDs beyond the ones shared with
   Uniswap's - these need explicit handling, not an "unknown command = assume safe" default.
4. PancakeSwap's exact `MulticallExtended` selectors (relevant to its V3 SmartRouter, separately
   from Universal Router) were only secondary-sourced, not confirmed against primary GitHub/BscScan
   source.

Before writing any Universal Router Guard code: close gaps 1-2 with direct Sourcify/Etherscan
bytecode reads (not just GitHub tags, since the research found real version drift), and get an
explicit answer on `executeSigned`'s authorization model. Shipping with these open would risk
the worst outcome for a security product: claiming a trade is blocked when it actually wasn't
decoded correctly, or claiming coverage of an execution path that was never actually blocked.

## Resolved: GMGN is out of scope for on-chain enforcement, confirmed

Previously left unresolved (see `research_notes/EVM on-chain trading risk enforcement/
gmgn_bsc_routing_confirmed.md`), now confirmed directly against a real GMGN account rather than
left as a guess. Connecting an external wallet (MetaMask) to GMGN is sign-in only - a message
signature, not a transaction. GMGN's own BSC "Wallet" screen then shows a separate, GMGN-generated
address ("Wallet1") with Deposit/Withdraw/Consolidate actions - the connected MetaMask address
never appears there. Trading requires depositing funds into that GMGN-controlled wallet; GMGN's
backend executes swaps from it, not from the trader's own wallet.

This means a MyPropGuard Safe can never be the wallet GMGN trades from - there is no flow where
GMGN signs a transaction from an externally-held smart contract wallet. The "which contract does
it call" question this item used to be framed around turns out not to matter: no Guard attached to
a trader's own Safe can ever see a GMGN trade, regardless of what GMGN's backend calls internally,
because the Safe is never the signer. No Guard work is possible or planned for GMGN.

## Done: real Safe + execTransaction end-to-end proof (all three exchanges)

Closed a gap this roadmap used to list as outstanding. `test/GmxSafeEndToEnd.t.sol`,
`test/PancakeSwapSafeEndToEnd.t.sol`, and `test/UniswapSafeEndToEnd.t.sol` each deploy a genuine,
unmodified Safe (real `SafeProxyFactory` + `Safe` singleton, same bytecode Safe ships) on the
relevant live mainnet fork, attach the Guard via the Safe's own `setGuard` (a real
`execTransaction`, not a shortcut), then drive further real `execTransaction` calls signed via
Safe's native approved-hash scheme - not `vm.prank`-ing straight into `checkTransaction` the way
every earlier test in this package did. PancakeSwap and Uniswap's within-limit cases complete a
full, successful real swap through the real Safe (trader's real token balance increases); GMX's
within-limit case proves the Guard let it through (confirmed by the revert NOT carrying the
Guard's own error selector) before GMX's own logic rejects it deeper in for lack of real
collateral - the same limitation the plain fork-integration tests already had.

## Done: wired into the actual MyPropGuard product (provisioning + dashboard)

1. **Provisioning - done, real, wired in.** `packages/evm`'s `SafeDeployer` (verified against a
   real local Anvil chain) is now called from `POST /v1/accounts` via the new
   `EvmSafeProvisioner` domain port and `EvmChainSafeProvisioner` adapter, opt-in per chain via
   `AppDeps.evmSafeProvisioners` - `server.ts` wires one concrete example (Arbitrum/GMX) behind
   `ENABLE_EVM_ARBITRUM_PROVISIONING`. `protected_accounts` gained
   `evm_owner_wallet_address`/`evm_safe_address`/`evm_chain_id` columns
   (`supabase/migrations/0007_evm_safe_accounts.sql`) to persist the result. A request with
   `venue="arbitrum-gmx"` + `evmOwnerWalletAddress` + `evmChainId=42161` now deploys a real Safe
   and returns its address - 2 new apps/api tests prove this is actually called when configured
   and skipped when it isn't.
2. **Dashboard - done.** A Venue selector (Hyperliquid vs GMX on Arbitrum) in the "provision a
   new account" form reveals a "Your wallet address" field for EVM venues, and shows the
   provisioned Safe address afterward with instructions to connect it directly on GMX's own UI -
   mirroring the existing Hyperliquid agent-wallet-approval callout. Verified live in the browser.

## Done: on-chain rule sync for the spot Guards (PancakeSwap/Uniswap)

The schema decision this used to be blocked on: `rule_versions` gained a nullable `token_address`
column (`supabase/migrations/0008_rule_token_address.sql`) rather than a new rule type - null for
every rule except MAX_POSITION_SIZE on an EVM spot venue, where it names which ERC-20 the limit
applies to. `POST /v1/accounts/:accountId/rules` now rejects a MAX_POSITION_SIZE rule missing
`tokenAddress` on an EVM Safe account, and otherwise pushes MAX_POSITION_SIZE/MAX_TRADE_FREQUENCY
changes straight to that account's Guard via the new `EvmChainGuardRuleSyncer`
(`packages/evm/src/evmGuardRuleSyncer.ts`) - built from the same admin wallet/RPC config that
already provisions Safes (`apps/api/src/server.ts`'s `configureEvmChainProvisioning`, now also
wired to `AppDeps.evmGuardSyncers`), so no new env vars. Token decimals are resolved live via the
ERC-20's own `decimals()` call rather than stored, so a dollar-denominated rule param converts to
the correct raw on-chain amount regardless of the token. If the on-chain push fails, the
just-created rule is deactivated and the request fails - a rule the Guard never actually received
can't sit in Postgres looking active. The dashboard's "Add a rule" form now shows a token-address
field whenever MAX_POSITION_SIZE is picked for an EVM Safe account, with inline copy explaining
the limit is enforced for every trade on that token, not just ones placed through the dashboard.

GMX is deliberately excluded from this: its Guard's `setLimits` sets `maxPositionSizeUsd` and
`maxTradesPerDay` together in one call, so pushing just one rule change would need to first read
the other current limit to avoid clobbering it - a separate, still-undone piece of design, not
covered by this change.

**Proof:** 5 new `packages/evm` unit tests (mocked viem clients, no live chain) cover the
decimals-conversion math, the native-token sentinel, the missing-tokenAddress rejection, and the
unsupported-rule-type rejection; 5 new `apps/api` tests cover the full HTTP path with a fake
syncer - successful push, missing-tokenAddress 400, no-op for non-EVM accounts, no-op when no
syncer is configured for the chain, and the deactivate-on-failure rollback. All 56 `apps/api`
tests and all `packages/risk-ledger` in-memory tests still pass.

**Still needs, before this is live**: migration 0008 applied to the production database (not done
from this environment - direct Postgres access to the production pooler isn't reachable from
here), and a funded admin wallet per EVM chain to pay the gas these calls cost, same operational
requirement Hyperliquid's gas-free signing never had.

## Deliberately not done yet (real decisions needed, not just more time)

1. **Real funded proof**: the same bar as the Hyperliquid mainnet proof - a real Safe, real
   funds, a real trade through the real exchange UI, with a rule violation genuinely reverting
   on-chain. The *mechanism* is proven on forks (see above); this step is specifically about
   doing it with real money on real mainnet, which needs the account owner's own funded wallet -
   prepare it, have them run it, same pattern as the Hyperliquid mainnet proof.

## Deferred: max leverage (not applicable to the spot Guards)

Still explicitly out of scope. PancakeSwap/Uniswap are spot AMMs - there is no leverage concept in
a plain token swap, so this only matters if/when a leveraged venue beyond GMX is added. No change
here.

## Done: max daily loss freeze mechanism for PancakeSwap/Uniswap Guards (decision made: backend attestation)

The three-option decision from this roadmap's earlier revision is resolved: **backend attestation**
was chosen over an owned on-chain accounting contract or a keeper/automation hybrid, since it
reuses the existing Postgres risk ledger and risk engine almost entirely rather than building new
on-chain accounting infrastructure. In practice this is implemented as a simple admin-controlled
freeze flag rather than a per-trade cryptographic signature - functionally the same trust tradeoff
(the backend's admin key decides), but far simpler for traders: nothing changes about how they
submit a trade, no extra signature needs to be attached to anything.

`PancakeSwapLimitGuard`/`UniswapLimitGuard` gained a `frozen` mapping and admin-only `setFrozen`;
`_enforce` reverts with `AccountIsFrozen` for any registered router while frozen, but a frozen
account can still call untracked addresses (e.g. withdrawing its own funds elsewhere) - freezing
only stops further trades. `packages/evm`'s `SpotGuardClient.setFrozen` and
`EvmChainGuardRuleSyncer.setFrozen` wire this into the existing per-chain admin wallet config, and
`packages/risk-ledger`'s new `checkAndEnforceDailyLossFreeze` reuses the *exact* same
`equityStartOfDay - currentEquity >= maxDailyLossParam` comparison the risk engine already uses for
Hyperliquid accounts, so an EVM account is frozen/unfrozen under the identical rule a Hyperliquid
account would be blocked under. `apps/api`'s rule routes call this automatically whenever a
MAX_DAILY_LOSS rule is added or deactivated, so changing the limit re-evaluates the freeze state
immediately rather than waiting for the next trade attempt.

**Proof:** 4 new Foundry tests per Guard contract (frozen accounts revert, unfreezing restores
normal enforcement, freezing doesn't block calls to untracked addresses, only the admin can
freeze/unfreeze - not run against a live chain from this environment since Foundry isn't installed
here; written to the exact same style as the existing passing test suite and should be run before
deployment) plus 6 new `packages/risk-ledger` unit tests and 4 new `apps/api` tests (all passing)
covering the breach/no-breach/no-rule/non-EVM/no-syncer cases and the route-level wiring.

**The real remaining gap - this mechanism has nothing live to act on yet**: `currentEquity` for an
EVM account only reflects reality once something feeds the Safe's live on-chain USD value into
`account_risk_heads`, the same way `reconcileAccountFromVenue` already does for Hyperliquid by
reading its Info API. No such reconciliation exists for EVM accounts, because it needs pricing
arbitrary ERC-20 holdings - the exact oracle/P&L problem this roadmap has flagged since the
original research (`reports/EVM on-chain trading risk enforcement.md`). Until an EVM equity feed is
built, `checkAndEnforceDailyLossFreeze` is correct and fully tested, but will only ever see an
EVM account's equity frozen at whatever it was when the account was created - it cannot yet detect
a real loss happening from real EVM trades. That EVM price-oracle/reconciliation piece is now the
single remaining prerequisite before max daily loss is actually live for PancakeSwap/Uniswap
accounts, not a decision to make, but a build to do.
